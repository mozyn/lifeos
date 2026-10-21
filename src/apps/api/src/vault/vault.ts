/**
 * The vault: index (full scan at startup + debounced watcher, spec §5) and line-anchored writes.
 *
 * The index stores path + line + content hash for every item. A write re-reads the file, finds the
 * line by its hash (the nearest match to the recorded line number when the hash moved), replaces
 * only that line, and writes atomically (fsio.ts). When the hash is gone, the write fails visibly
 * (LineNotFound → HTTP 409) and that file is re-indexed.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { parse as parseYaml } from 'yaml';
import {
  BRIDGE_SECTIONS,
  codeMask,
  findGroups,
  frontmatterRange,
  headings,
  joinLines,
  parseLibrary,
  parseLinkLine,
  parseTaskLine,
  type ParsedTask,
  parseWeekly,
  type RawLine,
  readBullets,
  readCheckins,
  readLog,
  readMoods,
  sectionOfLines,
  sectionText,
  splitLines,
} from '@lifeos/shared';
import { type DB, nowIso, resetIndex } from '../db.js';
import { mutateFile, type MutateOptions, type MutateResult, readText, type Transform } from './fsio.js';
import { absPath, classify, type FileKind, isReadable, isListedNote, NO_TASK_KINDS, safeRel } from './paths.js';

export class LineNotFound extends Error {
  constructor(
    public path: string,
    public current: string | null = null,
  ) {
    super('This line changed in the vault since it was loaded. The view has been refreshed.');
  }
}

export const lineHash = (text: string): string => createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 16);
const itemId = (path: string, raw: string, nth: number): string => createHash('sha1').update(`${path}\n${raw}\n${nth}`, 'utf8').digest('hex').slice(0, 16);

export interface Anchor {
  line: number;
  hash: string;
}

/** Find a line by hash; when it moved, the match nearest to where it was. */
export function locate(lines: RawLine[], a: Anchor): number {
  if (a.line >= 0 && a.line < lines.length && lineHash(lines[a.line].text) === a.hash) return a.line;
  let best = -1;
  let dist = Infinity;
  for (let i = 0; i < lines.length; i++) {
    if (lineHash(lines[i].text) !== a.hash) continue;
    const d = Math.abs(i - a.line);
    if (d < dist) {
      dist = d;
      best = i;
    }
  }
  return best;
}

export type ChangeListener = (paths: string[], reason: 'watch' | 'write' | 'scan') => void;

export interface VaultOptions {
  /** debounce of watcher events */
  debounceMs?: number;
  /** poll instead of inotify (tests on tmpfs don't need it) */
  usePolling?: boolean;
}

export class Vault {
  private watcher: FSWatcher | null = null;
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<ChangeListener>();
  lastScan: { at: string; ms: number; files: number; tasks: number } | null = null;

  constructor(
    public readonly root: string,
    private readonly db: DB,
    private readonly opts: VaultOptions = {},
  ) {}

  onChange(fn: ChangeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(paths: string[], reason: 'watch' | 'write' | 'scan') {
    for (const l of this.listeners) {
      try {
        l(paths, reason);
      } catch {
        /* a listener's failure is its own */
      }
    }
  }

  /** Tell live clients something changed that is not a note (a draft finished, for example). */
  notify(): void {
    this.emit([], 'write');
  }

  abs(rel: string): string {
    return absPath(this.root, rel);
  }

  // ---------------------------------------------------------------- scanning

  async listMarkdown(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string) => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const abs = join(dir, e.name);
        const rel = relative(this.root, abs).split(sep).join('/');
        if (!isReadable(rel)) continue;
        if (e.isDirectory()) await walk(abs);
        else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(rel);
      }
    };
    await walk(this.root);
    return out.sort();
  }

  /** Drop the index and rescan everything (startup, POST /api/index/rebuild). */
  async fullScan(reason = 'startup'): Promise<{ files: number; tasks: number; ms: number }> {
    const t0 = performance.now();
    const files = await this.listMarkdown();
    const contents: { rel: string; text: string; mtime: number; size: number }[] = [];
    await Promise.all(
      files.map(async (rel) => {
        try {
          const abs = this.abs(rel);
          const [text, st] = await Promise.all([fs.readFile(abs, 'utf8'), fs.stat(abs)]);
          contents.push({ rel, text, mtime: st.mtimeMs, size: st.size });
        } catch {
          /* vanished between listing and reading */
        }
      }),
    );
    const tx = this.db.transaction(() => {
      resetIndex(this.db);
      for (const c of contents) this.indexContent(c.rel, c.text, c.mtime, c.size);
    });
    tx();
    const ms = Math.round(performance.now() - t0);
    const tasks = (this.db.prepare('SELECT count(*) n FROM tasks').get() as { n: number }).n;
    this.db.prepare('INSERT INTO index_runs (at, ms, files, tasks, reason) VALUES (?, ?, ?, ?, ?)').run(nowIso(), ms, contents.length, tasks, reason);
    this.lastScan = { at: nowIso(), ms, files: contents.length, tasks };
    this.emit([], 'scan');
    return { files: contents.length, tasks, ms };
  }

  /** Re-read one file into the index (or drop it when gone). */
  async reindex(rel: string): Promise<void> {
    const abs = this.abs(rel);
    let text: string | null = null;
    let st: import('node:fs').Stats | null = null;
    try {
      [text, st] = await Promise.all([fs.readFile(abs, 'utf8'), fs.stat(abs)]);
    } catch {
      text = null;
    }
    const tx = this.db.transaction(() => {
      this.removeFromIndex(rel);
      if (text !== null && st) this.indexContent(rel, text, st.mtimeMs, st.size);
    });
    tx();
  }

  private removeFromIndex(rel: string): void {
    for (const t of ['files', 'tasks', 'events', 'habit_logs', 'daily_entries', 'links', 'hadith', 'notes_fts']) {
      this.db.prepare(`DELETE FROM ${t} WHERE path = ?`).run(rel);
    }
  }

  /** Parse one note into the index tables. */
  private indexContent(rel: string, text: string, mtime: number, size: number): void {
    const kind = classify(rel);
    const lines = splitLines(text);
    const fmRange = frontmatterRange(lines);
    let fm: Record<string, unknown> = {};
    if (fmRange) {
      try {
        // template notes carry {{date:...}} placeholders: no warnings for those
        const parsed = parseYaml(lines.slice(fmRange.start + 1, fmRange.end).map((l) => l.text).join('\n'), { schema: 'core', logLevel: 'error' });
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fm = parsed as Record<string, unknown>;
      } catch {
        fm = {};
      }
    }
    const hs = headings(lines);
    const h1 = hs.find((h) => h.level === 1)?.text;
    const base = rel.split('/').pop()!.replace(/\.md$/i, '');
    const title = str(fm.title) ?? h1 ?? base;
    const date = isoDate(fm.date) ?? (/^\d{4}-\d{2}-\d{2}/.exec(base)?.[0] ?? null);
    const tags = toTags(fm.tags);
    const status = str(fm.status);
    const bodyStart = fmRange ? fmRange.end + 1 : 0;
    const body = lines
      .slice(bodyStart)
      .map((l) => l.text)
      .join('\n');
    const preview = body
      .split('\n')
      .filter((l) => l.trim() && !/^#{1,6}\s/.test(l) && !/^>\s*$/.test(l))
      .map((l) => l.replace(/^>\s?/, '').replace(/^[-*]\s+/, ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .slice(0, 240);
    this.db
      .prepare(
        `INSERT INTO files (path, kind, mtime, size, sha, title, date, status, tags, fm, preview, lifeos, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(rel, kind, mtime, size, createHash('sha1').update(text).digest('hex'), title, date, status, JSON.stringify(tags), JSON.stringify(jsonSafe(fm)), preview, str(fm.lifeos), nowIso());

    const mask = codeMask(lines);
    const sections = sectionOfLines(lines, hs);

    if (!NO_TASK_KINDS.includes(kind)) {
      const ins = this.db.prepare(
        `INSERT OR REPLACE INTO tasks (id, path, line, hash, raw, status, title, due, due_inferred, reminder, priority, recur, done, slugs, tags, capture, section, readonly, list, file_kind, parent_id, due_inherited)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const seen = new Map<string, number>();
      const found: { i: number; t: ParsedTask; id: string }[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (mask[i]) continue;
        const t = parseTaskLine(lines[i].text);
        if (!t) continue;
        const nth = seen.get(t.raw) ?? 0;
        seen.set(t.raw, nth + 1);
        found.push({ i, t, id: itemId(rel, t.raw, nth) });
      }
      // task groups (round-2 brief §10): a child links to its parent and inherits its due date and goal
      const parentOf = new Map<number, number>();
      for (const g of findGroups(lines, mask)) for (const c of g.children) if (!parentOf.has(c)) parentOf.set(c, g.parent);
      const at = new Map(found.map((f) => [f.i, f]));
      const inherited = (i: number): { due: string | null; slugs: string[] } => {
        const p = parentOf.get(i);
        const pt = p === undefined ? undefined : at.get(p);
        if (!pt || p === undefined) return { due: null, slugs: [] };
        const up = inherited(p);
        return { due: pt.t.due ?? up.due, slugs: [...new Set([...pt.t.slugs, ...up.slugs])] };
      };
      for (const { i, t, id } of found) {
        const section = sections[i];
        const readonly = kind === 'capture' || BRIDGE_SECTIONS.includes(section.toLowerCase()) ? 1 : 0;
        const list = kind === 'shopping' ? 'shopping' : kind === 'wishlist' ? 'wishlist' : 'tasks';
        const p = parentOf.get(i);
        const up = p === undefined ? null : inherited(i);
        const due = t.due ?? up?.due ?? null;
        ins.run(
          id,
          rel,
          i,
          lineHash(t.raw),
          t.raw,
          t.status,
          t.title,
          due,
          t.dueInferred ? 1 : 0,
          t.reminderRaw,
          t.priority,
          t.recur,
          t.done,
          JSON.stringify(up ? [...new Set([...t.slugs, ...up.slugs])] : t.slugs),
          JSON.stringify(t.tags),
          t.capture,
          section,
          readonly,
          list,
          kind,
          p === undefined ? null : (at.get(p)?.id ?? null),
          !t.due && due ? 1 : 0,
        );
      }
    }

    if (kind === 'weekly') {
      const w = parseWeekly(lines, base);
      const ins = this.db.prepare('INSERT OR REPLACE INTO events (id, path, line, hash, raw, date, time, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      const seen = new Map<string, number>();
      for (const e of w.events) {
        const nth = seen.get(e.raw) ?? 0;
        seen.set(e.raw, nth + 1);
        ins.run(itemId(rel, e.raw, nth), rel, e.line, lineHash(e.raw), e.raw, e.date, e.time, e.text);
      }
    }

    if (kind === 'habit' || kind === 'archived-habit') {
      const ins = this.db.prepare('INSERT INTO habit_logs (path, line, hash, date, value, note) VALUES (?, ?, ?, ?, ?, ?)');
      for (const l of readLog(lines)) ins.run(rel, l.line, lineHash(l.raw), l.date, l.value, l.note);
    }

    if (kind === 'daily' && date) {
      const ins = this.db.prepare('INSERT INTO daily_entries (path, date, line, hash, kind, json) VALUES (?, ?, ?, ?, ?, ?)');
      for (const c of readCheckins(lines)) ins.run(rel, date, c.line, lineHash(c.raw), 'checkin', JSON.stringify(c.value));
      for (const m of readMoods(lines)) ins.run(rel, date, m.line, lineHash(m.raw), 'mood', JSON.stringify(m.value));
      for (const b of readBullets(lines, 'Plan')) ins.run(rel, date, b.line, lineHash(lines[b.line].text), 'plan', JSON.stringify({ text: b.text }));
      const review = sectionText(lines, 'Review');
      if (review) ins.run(rel, date, hs.find((h) => h.text.trim().toLowerCase() === 'review')?.line ?? 0, '', 'review', JSON.stringify({ text: review }));
    }

    if (kind === 'links') {
      const ins = this.db.prepare('INSERT INTO links (path, line, hash, title, url, tags, note, saved) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      for (let i = 0; i < lines.length; i++) {
        const l = parseLinkLine(lines[i].text);
        if (l) ins.run(rel, i, lineHash(lines[i].text), l.title, l.url, JSON.stringify(l.tags), l.note, l.saved);
      }
    }

    if (kind === 'hadith') {
      const ins = this.db.prepare('INSERT OR REPLACE INTO hadith (id, path, line, heading, book, reference, grade, source, themes, arabic, english) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const e of parseLibrary(lines, rel)) ins.run(e.id, rel, e.line, e.heading, e.book, e.reference, e.grade, e.source, JSON.stringify(e.themes), e.arabic, e.english);
    }

    if (isListedNote(rel, kind) || kind === 'capture') {
      this.db.prepare('INSERT INTO notes_fts (path, title, body) VALUES (?, ?, ?)').run(rel, title, body.slice(0, 20000));
    }
  }

  // ---------------------------------------------------------------- watching

  watch(): void {
    if (this.watcher) return;
    this.watcher = chokidar.watch(this.root, {
      ignoreInitial: true,
      persistent: true,
      usePolling: this.opts.usePolling ?? false,
      interval: 500,
      ignored: (p: string, stats?: import('node:fs').Stats) => {
        const rel = relative(this.root, p).split(sep).join('/');
        if (!rel) return false;
        if (!isReadable(rel)) return true;
        return !!stats?.isFile() && !rel.toLowerCase().endsWith('.md');
      },
    });
    const queue = (p: string) => {
      const rel = relative(this.root, p).split(sep).join('/');
      if (!rel.toLowerCase().endsWith('.md') || !isReadable(rel)) return;
      this.pending.add(rel);
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.flush(), this.opts.debounceMs ?? 250);
    };
    this.watcher.on('add', queue).on('change', queue).on('unlink', queue);
  }

  private async flush(): Promise<void> {
    const paths = [...this.pending];
    this.pending.clear();
    for (const rel of paths) await this.reindex(rel).catch(() => undefined);
    if (paths.length) this.emit(paths, 'watch');
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    await this.watcher?.close();
    this.watcher = null;
  }

  // ---------------------------------------------------------------- writing

  async read(rel: string): Promise<string | null> {
    return readText(this.abs(safeRel(rel)));
  }

  /**
   * Move a note to a new path that must not exist yet: link(2) to the new name (fails rather than
   * clobber), then unlink the old one. The inode is the same, so a writer holding the file open
   * keeps writing into it; Syncthing and Obsidian see a new note and a removed one.
   */
  async move(fromRel: string, toRel: string): Promise<void> {
    const from = this.abs(safeRel(fromRel));
    const to = this.abs(safeRel(toRel));
    await fs.mkdir(dirname(to), { recursive: true });
    await fs.link(from, to);
    await fs.unlink(from);
    await this.reindex(safeRel(fromRel));
    await this.reindex(safeRel(toRel));
    this.emit([safeRel(fromRel), safeRel(toRel)], 'write');
  }

  /** Atomic read-transform-write of one note, then re-index it. */
  async mutate(rel: string, transform: Transform, opts: MutateOptions = {}): Promise<MutateResult> {
    const safe = safeRel(rel);
    const res = await mutateFile(this.abs(safe), transform, { mkdirs: true, ...opts });
    if (res.changed || res.created) {
      await this.reindex(safe);
      this.emit([safe], 'write');
    }
    return res;
  }

  /**
   * Replace the line at an anchor. `make` receives the current line text (the one whose hash
   * matched) and returns its replacement lines. Throws LineNotFound (and refreshes the file's
   * index) when the hash is no longer in the file.
   */
  async replaceAt(rel: string, anchor: Anchor, make: (text: string, lines: RawLine[], index: number) => string[]): Promise<{ result: MutateResult; index: number }> {
    let index = -1;
    let missing = false;
    const result = await this.mutate(rel, (lines) => {
      if (!lines) {
        missing = true;
        return null;
      }
      index = locate(lines, anchor);
      if (index < 0) {
        missing = true;
        return null;
      }
      const repl = make(lines[index].text, lines, index);
      const out = lines.slice();
      const eol = out[index].eol;
      const inner = out.find((l) => l.eol)?.eol ?? '\n';
      out.splice(index, 1, ...repl.map((t, k) => ({ text: t, eol: k === repl.length - 1 ? eol : inner })));
      return out;
    });
    if (missing) {
      await this.reindex(safeRel(rel));
      this.emit([safeRel(rel)], 'write');
      throw new LineNotFound(rel);
    }
    return { result, index };
  }
}

// ---------------------------------------------------------------- frontmatter helpers

function str(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  return null;
}

function isoDate(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v.trim())) return v.trim().slice(0, 10);
  return null;
}

function toTags(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).replace(/^#/, '').trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(/[,\s]+/).map((x) => x.replace(/^#/, '').trim()).filter(Boolean);
  return [];
}

function jsonSafe(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) => (x instanceof Date ? x.toISOString().slice(0, 10) : typeof x === 'bigint' ? String(x) : x)) ?? '{}');
}

export function contentOf(lines: RawLine[]): string {
  return joinLines(lines);
}
