/**
 * Edit, move, delete and archive in place (round-2 brief §12, ADR-59). Everything the app shows can
 * be changed where it is shown; only the ring pipeline's sections (and a ring capture's body) stay
 * read-only. Each write is line-anchored (the item's line found by its hash at write time), every
 * line deleted is kept for 30 days so Undo and Settings → Advanced → Data → Recently deleted can put it back
 * exactly where it was, and nothing is ever destroyed: a note's Delete is an Archive.
 *
 *  - Lines (tasks, links, list items, events): edit replaces the line; delete removes the line and
 *    the lines indented under it (a group's children, an event's details); move takes them to
 *    another note and inserts them there before removing them here.
 *  - Notes: a title edit renames the file (same folder) and points the wiki-links that named it at
 *    the new name; the body is saved only if the note is unchanged since it was opened (compare
 *    and swap on its SHA-1), so an edit in Obsidian or by the ring pipeline is never overwritten;
 *    Move and Archive (`Archive/<folder>/…`, `status: archived`) carry the links along too.
 *  - Goals and projects: frontmatter fields and the title; Archive to `Archive/Goals/` or
 *    `Archive/Projects/`.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  addEventLines,
  BRIDGE_SECTIONS,
  blockOf,
  codeMask,
  editTaskLine,
  findSection,
  formatEventLine,
  formatItemLine,
  formatLinkLine,
  frontmatterRange,
  headings,
  insertLines,
  type ItemFields,
  joinLines,
  lastContentLine,
  type LinkLine,
  parseLinkLine,
  parseTaskLine,
  type RawLine,
  removeFrontmatterLine,
  removeLines,
  replaceLine,
  retargetLinks,
  sectionOfLines,
  setFrontmatterValue,
  setTaskLabels,
  setTaskText,
  slugify,
  splitLines,
  tagList,
  weeklyPath,
  yamlScalar,
} from '@lifeos/shared';
import { type DB, nowIso } from '../db.js';
import { classify, type FileKind, isReadable } from './paths.js';
import { Conflict, Forbidden, insertIntoSection, NotFound, type TaskRef, type VaultOps } from './ops.js';
import { type Anchor, LineNotFound, lineHash, locate, type Vault } from './vault.js';

export const DELETED_DAYS = 30;
export const DELETED_KEEP = 50;
export type NoteFolder = 'Inbox' | 'Resources' | 'Areas' | 'Projects';
export const NOTE_FOLDERS: NoteFolder[] = ['Inbox', 'Resources', 'Areas', 'Projects'];
export type LineKind = 'task' | 'item' | 'link' | 'event';

const sha = (s: string) => createHash('sha1').update(s).digest('hex');

/** Notes LifeOS never edits. */
const LOCKED: FileKind[] = ['template', 'lifeos', 'hadith', 'favorites'];

export interface DeletedRow {
  id: string;
  path: string;
  idx: number;
  lines: string;
  before_text: string | null;
  after_text: string | null;
  section: string;
  kind: string;
  label: string;
  at: string;
  restored_at: string | null;
}

/** Where an archived file goes, and where it comes back to. */
export function archivePathOf(rel: string): string {
  if (/^Areas\/Goals\//.test(rel)) return rel.replace(/^Areas\/Goals\//, 'Archive/Goals/');
  if (/^Areas\/Habits\//.test(rel)) return rel.replace(/^Areas\/Habits\//, 'Archive/Habits/');
  return `Archive/${rel}`;
}

export function restorePathOf(rel: string): string {
  if (/^Archive\/Goals\//.test(rel)) return rel.replace(/^Archive\/Goals\//, 'Areas/Goals/');
  if (/^Archive\/Habits\//.test(rel)) return rel.replace(/^Archive\/Habits\//, 'Areas/Habits/');
  return rel.replace(/^Archive\//, '');
}

export class EditOps {
  constructor(
    private readonly vault: Vault,
    private readonly db: DB,
    private readonly ops: VaultOps,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ---------------------------------------------------------------- guards

  /** A line LifeOS may change: not in a locked note, not in a ring capture, not in a bridge section. */
  private assertLineWritable(rel: string, lines: RawLine[], index: number): void {
    const kind = classify(rel);
    if (kind === 'capture') throw new Forbidden('A ring capture’s text is read-only; its title and tags can be edited.');
    if (LOCKED.includes(kind)) throw new Forbidden('LifeOS does not edit this note.');
    const section = sectionOfLines(lines)[index] ?? '';
    if (BRIDGE_SECTIONS.includes(section.toLowerCase())) throw new Forbidden(`"${section}" belongs to the ring pipeline; LifeOS leaves it alone.`);
    if (codeMask(lines)[index]) throw new LineNotFound(rel);
  }

  /** The line is the kind of thing the caller says it is (a delete from Links removes a link line). */
  private assertKind(rel: string, lines: RawLine[], i: number, kind: LineKind | 'move'): void {
    const k = classify(rel);
    const text = lines[i].text;
    const ok =
      kind === 'move'
        ? !!parseTaskLine(text) || k === 'weekly'
        : kind === 'task'
          ? !!parseTaskLine(text) && !['shopping', 'wishlist'].includes(k)
          : kind === 'item'
            ? !!parseTaskLine(text) && ['shopping', 'wishlist'].includes(k)
            : kind === 'link'
              ? k === 'links' && !!parseLinkLine(text)
              : k === 'weekly' && /^[ \t]+[-*] /.test(text) && (sectionOfLines(lines)[i] ?? '').toLowerCase() === 'this week';
    if (!ok) throw new LineNotFound(rel);
  }

  // ---------------------------------------------------------------- delete, undo, recently deleted

  /**
   * Remove a line and the lines indented under it. What was removed, and the lines around it, are
   * kept (SQLite, 30 days, the last 50) so it can be put back exactly where it was.
   */
  async deleteBlock(ref: TaskRef, meta: { kind: LineKind | 'move'; label?: string }): Promise<{ id: string; lines: string[] }> {
    let rec: Omit<DeletedRow, 'id' | 'kind' | 'label' | 'at' | 'restored_at'> | null = null;
    await this.ops.atAnchor(ref, (lines, i) => {
      this.assertLineWritable(ref.path, lines, i);
      this.assertKind(ref.path, lines, i, meta.kind);
      const b = blockOf(lines, i);
      const texts = lines.slice(b.start, b.end).map((l) => l.text);
      rec = { path: ref.path, idx: b.start, lines: JSON.stringify(texts), before_text: b.start > 0 ? lines[b.start - 1].text : null, after_text: b.end < lines.length ? lines[b.end].text : null, section: sectionOfLines(lines)[i] ?? '' };
      return removeLines(lines, Array.from({ length: b.end - b.start }, (_, k) => b.start + k));
    });
    const r = rec!;
    const texts = JSON.parse(r.lines) as string[];
    const id = randomUUID();
    const label = meta.label ?? (parseTaskLine(texts[0])?.title || parseLinkLine(texts[0])?.title || texts[0].replace(/^\s*[-*]\s*/, '')).slice(0, 160);
    this.db
      .prepare('INSERT INTO deleted_lines (id, path, idx, lines, before_text, after_text, section, kind, label, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, r.path, r.idx, r.lines, r.before_text, r.after_text, r.section, meta.kind, label, this.now().toISOString());
    this.prune();
    return { id, lines: texts };
  }

  private prune(): void {
    const since = new Date(this.now().getTime() - DELETED_DAYS * 86400_000).toISOString();
    this.db.prepare('DELETE FROM deleted_lines WHERE at < ?').run(since);
    this.db.prepare('DELETE FROM deleted_lines WHERE id NOT IN (SELECT id FROM deleted_lines ORDER BY at DESC LIMIT ?)').run(DELETED_KEEP);
  }

  /**
   * Put deleted lines back: after the line that was above them (the nearest copy of it to where
   * they were), else before the line that was below them, else at the end of their section, else
   * where they were.
   */
  async restore(id: string): Promise<{ path: string }> {
    const r = this.db.prepare('SELECT * FROM deleted_lines WHERE id = ?').get(id) as DeletedRow | undefined;
    if (!r) throw new NotFound('That is no longer in Recently deleted.');
    if (r.restored_at) return { path: r.path };
    const texts = JSON.parse(r.lines) as string[];
    const hash = lineHash;
    await this.vault.mutate(r.path, (lines) => {
      const cur = lines ?? [];
      let after = -1;
      if (r.before_text !== null) {
        const i = locate(cur, { line: r.idx - 1, hash: hash(r.before_text) });
        if (i >= 0) after = i;
      }
      if (after < 0 && r.after_text !== null) {
        const i = locate(cur, { line: r.idx, hash: hash(r.after_text) });
        if (i >= 0) after = i - 1;
      }
      if (after < 0 && r.before_text === null) after = -1;
      else if (after < 0) {
        const sec = r.section ? findSection(cur, r.section) : null;
        after = sec ? lastContentLine(cur, sec) : Math.min(r.idx, cur.length) - 1;
      }
      return insertLines(cur, after, texts);
    });
    this.db.prepare('UPDATE deleted_lines SET restored_at = ? WHERE id = ?').run(nowIso(), id);
    return { path: r.path };
  }

  recentlyDeleted(): { id: string; path: string; kind: string; label: string; at: string; lines: number }[] {
    this.prune();
    return (this.db.prepare('SELECT * FROM deleted_lines WHERE restored_at IS NULL ORDER BY at DESC LIMIT ?').all(DELETED_KEEP) as DeletedRow[]).map((r) => ({ id: r.id, path: r.path, kind: r.kind, label: r.label, at: r.at, lines: (JSON.parse(r.lines) as string[]).length }));
  }

  // ---------------------------------------------------------------- tasks

  /** Edit a task: words, due, reminder, priority, goal (@slugs), tags; the rest of the line stays. */
  async editTask(ref: TaskRef, e: { text?: string; due?: string | null; reminder?: string | null; priority?: 'highest' | 'high' | 'medium' | 'low' | 'lowest' | null; slugs?: string[]; tags?: string[] }): Promise<{ line: string }> {
    let line = '';
    await this.ops.atAnchor(ref, (lines, i) => {
      this.ops.assertTaskWritable(ref.path, lines, i);
      let t = lines[i].text;
      if (e.text?.trim()) t = setTaskText(t, e.text);
      t = editTaskLine(t, { due: e.due, reminder: e.reminder, priority: e.priority, normalize: true });
      // labels last: the tags end the line, after any field just added
      if (e.slugs || e.tags) t = setTaskLabels(t, { slugs: e.slugs, tags: e.tags });
      line = t;
      return t === lines[i].text ? null : replaceLine(lines, i, [t]);
    });
    return { line };
  }

  /**
   * Move a task (with its children) to another day's daily note or to a goal or project note, under
   * `## Tasks`. A move to a day makes that day its due date; a move to a goal links it (`@slug`).
   */
  async moveTask(ref: TaskRef, to: { date?: string; slug?: string }, dailyTemplate: (date: string) => Promise<string>): Promise<{ path: string }> {
    const cur = await this.vault.read(ref.path);
    const lines = cur === null ? null : splitLines(cur);
    const at = lines ? locate(lines, ref) : -1;
    if (!lines || at < 0) {
      await this.vault.reindex(ref.path);
      throw new LineNotFound(ref.path);
    }
    this.ops.assertTaskWritable(ref.path, lines, at);
    let target: string;
    let create: () => string | Promise<string>;
    if (to.date) {
      target = `Daily Notes/${to.date}.md`;
      create = () => dailyTemplate(to.date!);
    } else if (to.slug) {
      const row = this.db.prepare("SELECT path FROM files WHERE kind IN ('goal', 'project') AND path LIKE ?").get(`%/${to.slug}.md`) as { path: string } | undefined;
      if (!row) throw new NotFound('That goal or project is not in the vault.');
      target = row.path;
      create = () => `# ${to.slug}\n\n## Tasks\n`;
    } else throw new Forbidden('Say where the task goes.');
    if (target === ref.path) return { path: target };
    const del = await this.deleteBlock(ref, { kind: 'move' });
    try {
      const base = /^[ \t]*/.exec(del.lines[0])![0];
      const block = del.lines.map((t) => (t.startsWith(base) ? t.slice(base.length) : t.trimStart()));
      let head = block[0];
      if (to.date && parseTaskLine(head)) head = editTaskLine(head, { due: to.date, normalize: true });
      if (to.slug) {
        const p = parseTaskLine(head);
        if (p && !p.slugs.includes(to.slug)) head = setTaskLabels(head, { slugs: [...p.slugs, to.slug] });
      }
      const texts = [head, ...block.slice(1)];
      const fresh = await create();
      await this.vault.mutate(target, (ls) => insertIntoSection(ls ?? splitLines(fresh), 'Tasks', texts, to.date ? ['Evening digest'] : []));
    } catch (err) {
      await this.restore(del.id);
      throw err;
    }
    // a move is not a deletion the user should see in Recently deleted
    this.db.prepare('UPDATE deleted_lines SET restored_at = ? WHERE id = ?').run(nowIso(), del.id);
    return { path: target };
  }

  // ---------------------------------------------------------------- links (§5.7)

  async editLink(ref: TaskRef, l: Omit<LinkLine, 'saved'>): Promise<{ line: string }> {
    if (classify(ref.path) !== 'links') throw new Forbidden('not the links note');
    let line = '';
    await this.ops.atAnchor(ref, (lines, i) => {
      const cur = parseLinkLine(lines[i].text);
      if (!cur) throw new LineNotFound(ref.path);
      line = formatLinkLine({ ...l, saved: cur.saved });
      return line === lines[i].text ? null : replaceLine(lines, i, [line]);
    });
    return { line };
  }

  // ---------------------------------------------------------------- shopping and wishlist (§5.8)

  private assertList(rel: string): 'shopping' | 'wishlist' {
    const k = classify(rel);
    if (k !== 'shopping' && k !== 'wishlist') throw new Forbidden('not a shopping or wishlist item');
    return k;
  }

  async editItem(ref: TaskRef, f: ItemFields): Promise<{ line: string }> {
    this.assertList(ref.path);
    let line = '';
    await this.ops.atAnchor(ref, (lines, i) => {
      if (!parseTaskLine(lines[i].text)) throw new LineNotFound(ref.path);
      line = formatItemLine(lines[i].text, f);
      return line === lines[i].text ? null : replaceLine(lines, i, [line]);
    });
    return { line };
  }

  /** Shopping ↔ Wishlist: the item goes to the other list's `## Items` (open again), then leaves this one. */
  async moveItem(ref: TaskRef, to: 'shopping' | 'wishlist', date: string): Promise<{ path: string }> {
    const from = this.assertList(ref.path);
    if (from === to) return { path: ref.path };
    const del = await this.deleteBlock(ref, { kind: 'move' });
    try {
      const line = editTaskLine(del.lines[0].trimStart(), { status: 'open', done: null });
      await this.ops.addListItem(to, line, date);
    } catch (err) {
      await this.restore(del.id);
      throw err;
    }
    this.db.prepare('UPDATE deleted_lines SET restored_at = ? WHERE id = ?').run(nowIso(), del.id);
    return { path: to === 'shopping' ? 'Areas/Lists/shopping.md' : 'Areas/Lists/wishlist.md' };
  }

  /** Reorder: the item moves to just before another item (or to the end of `## Items`). */
  async reorderItem(ref: TaskRef, before: Anchor | null): Promise<void> {
    this.assertList(ref.path);
    await this.ops.atAnchor(ref, (lines, i) => {
      const sec = findSection(lines, 'Items');
      if (!sec || i < sec.start || i >= sec.end) throw new Forbidden('Only items under ## Items are reordered.');
      const b = blockOf(lines, i);
      const moving = lines.slice(b.start, b.end).map((l) => l.text);
      let out = removeLines(lines, Array.from({ length: b.end - b.start }, (_, k) => b.start + k));
      let at: number;
      if (before) {
        const j = locate(out, { line: before.line > i ? before.line - moving.length : before.line, hash: before.hash });
        if (j < 0) throw new LineNotFound(ref.path);
        at = j - 1;
      } else {
        const s2 = findSection(out, 'Items')!;
        at = lastContentLine(out, s2);
      }
      out = insertLines(out, at, moving);
      return joinLines(out) === joinLines(lines) ? null : out;
    });
  }

  /** A bought item comes back: from `## Bought` to the end of `## Items`, unticked. */
  async restoreBought(ref: TaskRef): Promise<void> {
    if (this.assertList(ref.path) !== 'shopping') throw new Forbidden('Only shopping has bought items.');
    await this.ops.atAnchor(ref, (lines, i) => {
      const bought = findSection(lines, 'Bought');
      if (!bought || i < bought.start || i >= bought.end) throw new Forbidden('That item is not under ## Bought.');
      const line = editTaskLine(lines[i].text, { status: 'open', done: null });
      let out = removeLines(lines, [i]);
      const items = findSection(out, 'Items');
      out = items ? insertLines(out, lastContentLine(out, items), [line]) : insertIntoSection(out, 'Items', [line], []);
      return out;
    });
  }

  // ---------------------------------------------------------------- events (§5.9)

  /** Edit an event's time and words (place included) in place, or move it to another day. */
  async editEvent(ref: TaskRef, e: { from: string; date: string; time: string | null; text: string }): Promise<{ path: string }> {
    if (classify(ref.path) !== 'weekly') throw new Forbidden('not a weekly note');
    if (e.date === e.from) {
      await this.ops.atAnchor(ref, (lines, i) => {
        const sec = findSection(lines, 'This week');
        if (!sec || i < sec.start || i >= sec.end) throw new Forbidden('Only events under ## This week are edited.');
        const indent = /^[ \t]*/.exec(lines[i].text)![0];
        if (!indent) throw new LineNotFound(ref.path);
        const line = formatEventLine(indent, e.time, e.text);
        return line === lines[i].text ? null : replaceLine(lines, i, [line]);
      });
      return { path: ref.path };
    }
    const del = await this.deleteBlock(ref, { kind: 'move' });
    const to = weeklyPath(e.date);
    try {
      await this.vault.mutate(to, (lines) => addEventLines(lines, e.date, e.time, e.text));
    } catch (err) {
      await this.restore(del.id);
      throw err;
    }
    this.db.prepare('UPDATE deleted_lines SET restored_at = ? WHERE id = ?').run(nowIso(), del.id);
    return { path: to };
  }

  // ---------------------------------------------------------------- notes

  /** A note as the editor sees it: title, body, tags, and what may be changed. */
  async readNote(rel: string): Promise<{ title: string; body: string; tags: string[]; sha: string; kind: FileKind; can: { title: boolean; body: boolean; tags: boolean; move: boolean; archive: boolean } }> {
    const text = await this.vault.read(rel);
    if (text === null) throw new NotFound('Note not found.');
    const kind = classify(rel);
    const lines = splitLines(text);
    const { h1, bodyStart } = this.titleLine(lines);
    const f = this.db.prepare('SELECT title, tags FROM files WHERE path = ?').get(rel) as { title: string; tags: string } | undefined;
    const body = lines
      .slice(bodyStart)
      .map((l) => l.text)
      .join('\n')
      .replace(/^\n+/, '')
      .trimEnd();
    const locked = LOCKED.includes(kind) || kind === 'daily' || kind === 'weekly';
    // a note with a section the ring pipeline writes is not rewritten whole from a textarea
    const bridged = headings(lines).some((h) => h.level === 2 && BRIDGE_SECTIONS.includes(h.text.trim().toLowerCase()));
    const capture = kind === 'capture' || bridged;
    return {
      title: f?.title ?? (h1 >= 0 ? lines[h1].text.replace(/^#\s+/, '') : rel),
      body,
      tags: f ? (JSON.parse(f.tags) as string[]) : [],
      sha: sha(text),
      kind,
      can: { title: !locked, body: !locked && !capture, tags: !locked, move: !locked && !capture && !['goal', 'habit', 'shopping', 'wishlist', 'links', 'reminders'].includes(kind), archive: !locked },
    };
  }

  /** The H1 that opens a note (after its frontmatter), and where its body starts. */
  private titleLine(lines: RawLine[]): { h1: number; bodyStart: number; fmEnd: number } {
    const fm = frontmatterRange(lines);
    const fmEnd = fm ? fm.end : -1;
    let i = fmEnd + 1;
    while (i < lines.length && lines[i].text.trim() === '') i++;
    const h1 = i < lines.length && /^#\s+\S/.test(lines[i].text) ? i : -1;
    return { h1, bodyStart: h1 >= 0 ? h1 + 1 : fmEnd + 1, fmEnd };
  }

  /**
   * Edit a note: title (the H1 and a frontmatter `title:`; a note in Inbox, Resources, Areas or a
   * project's folder is renamed to match, and the wiki-links naming it follow), body (only when the
   * note is unchanged since `sha` was read) and tags. A ring capture: title and tags only.
   */
  async editNote(rel: string, e: { title?: string; body?: string; tags?: string[]; sha?: string }): Promise<{ path: string }> {
    const info = await this.readNote(rel);
    if (e.body !== undefined && !info.can.body) throw new Forbidden(info.kind === 'capture' ? 'A ring capture’s text is read-only.' : 'LifeOS does not edit this note’s text here.');
    if ((e.title !== undefined && !info.can.title) || (e.tags !== undefined && !info.can.tags)) throw new Forbidden('LifeOS does not edit this note.');
    if (e.body !== undefined && e.sha !== info.sha) throw new Conflict('This note changed since you opened it (in Obsidian or by the ring). Your text was not saved; reopen it and try again.');
    const title = e.title?.replace(/\s+/g, ' ').trim();
    await this.vault.mutate(rel, (lines) => {
      if (!lines) return null;
      if (e.body !== undefined && sha(joinLines(lines)) !== e.sha) throw new Conflict('This note changed while saving; reopen it.');
      let out = lines;
      if (title) {
        // a capture's text is the ring's: its title lives in the frontmatter (which wins over the H1)
        const fm = frontmatterRange(out);
        if (info.kind === 'capture' || (fm && out.slice(fm.start + 1, fm.end).some((l) => /^title\s*:/.test(l.text)))) out = setFrontmatterValue(out, 'title', yamlScalar(title));
        if (info.kind !== 'capture') {
          const { h1, fmEnd } = this.titleLine(out);
          out = h1 >= 0 ? replaceLine(out, h1, [`# ${title}`]) : insertLines(out, fmEnd, [`# ${title}`]);
        }
      }
      if (e.tags) out = setFrontmatterValue(out, 'tags', tagList(e.tags));
      if (e.body !== undefined) {
        const { bodyStart } = this.titleLine(out);
        const head = out.slice(0, bodyStart);
        const text = e.body.replace(/\r\n?/g, '\n').trimEnd();
        const eol = out.find((l) => l.eol)?.eol ?? '\n';
        const body: RawLine[] = text ? ['', ...text.split('\n')].map((t) => ({ text: t, eol })) : [];
        if (head.length && !head[head.length - 1].eol) head[head.length - 1] = { ...head[head.length - 1], eol };
        out = [...head, ...body];
      }
      return out;
    });
    let path = rel;
    // the file follows its title (not a goal's or a project's: their file name is their @slug)
    if (title && ['note', 'archive'].includes(info.kind)) {
      const folder = rel.split('/').slice(0, -1).join('/');
      const slug = slugify(title, 'note');
      if (`${folder}/${slug}.md` !== rel) path = await this.moveFile(rel, await this.ops.freePath(folder, slug));
    }
    return { path };
  }

  /** Move a note to the top of Inbox, Resources, Areas or Projects (its links follow). */
  async moveNote(rel: string, folder: NoteFolder): Promise<{ path: string }> {
    const info = await this.readNote(rel);
    if (!info.can.move) throw new Forbidden('This note does not move from LifeOS.');
    if (!NOTE_FOLDERS.includes(folder)) throw new Forbidden('Move to Inbox, Resources, Areas or Projects.');
    const name = rel.split('/').pop()!.replace(/\.md$/, '');
    if (rel === `${folder}/${name}.md`) return { path: rel };
    return { path: await this.moveFile(rel, await this.ops.freePath(folder, name)) };
  }

  /**
   * Archive (a note's Delete, a goal's or project's Archive): to `Archive/<where it was>` (goals to
   * `Archive/Goals/`, projects to `Archive/Projects/`) with `status: archived`; the status it had is
   * kept so a restore (Undo, Settings → Advanced → Data → Archived) puts the file back byte for byte.
   */
  async archive(rel: string): Promise<{ path: string }> {
    const kind = classify(rel);
    if (LOCKED.includes(kind) || kind === 'daily' || kind === 'weekly' || /^Archive\//.test(rel)) throw new Forbidden('This note is not archived from LifeOS.');
    const text = await this.vault.read(rel);
    if (text === null) throw new NotFound('Note not found.');
    const lines = splitLines(text);
    const fm = frontmatterRange(lines);
    // the status line it had (null: none; '': no frontmatter at all), so a restore is byte for byte
    const prev = fm ? (lines.slice(fm.start + 1, fm.end).find((l) => /^status\s*:/.test(l.text))?.text ?? null) : '';
    const target = archivePathOf(rel);
    const dir = target.split('/').slice(0, -1).join('/');
    const dest = await this.ops.freePath(dir, target.split('/').pop()!.replace(/\.md$/, ''));
    const path = await this.moveFile(rel, dest);
    await this.vault.mutate(path, (ls) => (ls ? setFrontmatterValue(ls, 'status', 'archived') : null));
    this.db
      .prepare('INSERT INTO archive_log (path, original, prev_status, kind, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET original = excluded.original, prev_status = excluded.prev_status, kind = excluded.kind, at = excluded.at')
      .run(path, rel, prev, kind, this.now().toISOString());
    return { path };
  }

  /** Bring an archived note back where it was, with the status it had. */
  async restoreArchived(rel: string): Promise<{ path: string }> {
    if (!/^Archive\//.test(rel)) throw new Forbidden('not an archived note');
    if ((await this.vault.read(rel)) === null) throw new NotFound('That archived note is gone.');
    const log = this.db.prepare('SELECT * FROM archive_log WHERE path = ?').get(rel) as { original: string; prev_status: string | null } | undefined;
    const original = log?.original ?? restorePathOf(rel);
    const dir = original.split('/').slice(0, -1).join('/');
    const dest = await this.ops.freePath(dir, original.split('/').pop()!.replace(/\.md$/, ''));
    const path = await this.moveFile(rel, dest);
    await this.vault.mutate(path, (ls) => {
      if (!ls) return null;
      const fm = frontmatterRange(ls);
      const i = fm ? ls.slice(fm.start + 1, fm.end).findIndex((l) => /^status\s*:/.test(l.text)) : -1;
      if (log && log.prev_status === '' && fm && fm.start === 0 && fm.end === 2 && i === 0) return removeLines(ls, [0, 1, 2]);
      if (log && !log.prev_status) return i >= 0 ? removeFrontmatterLine(ls, 'status') : null;
      const line = log?.prev_status ?? 'status: active';
      return i >= 0 ? replaceLine(ls, fm!.start + 1 + i, [line]) : setFrontmatterValue(ls, 'status', line.replace(/^status\s*:\s*/, ''));
    });
    this.db.prepare('DELETE FROM archive_log WHERE path = ?').run(rel);
    return { path };
  }

  /** Everything under Archive/ that LifeOS archived or can restore. */
  archived(): { path: string; title: string; kind: string; original: string; archived: string }[] {
    const rows = this.db.prepare("SELECT path, title, mtime FROM files WHERE path LIKE 'Archive/%' ORDER BY mtime DESC LIMIT 200").all() as { path: string; title: string; mtime: number }[];
    const logs = new Map((this.db.prepare('SELECT path, original, kind, at FROM archive_log').all() as { path: string; original: string; kind: string; at: string }[]).map((r) => [r.path, r]));
    return rows.map((r) => {
      const log = logs.get(r.path);
      const original = log?.original ?? restorePathOf(r.path);
      const kind = log?.kind ?? (/^Archive\/Goals\//.test(r.path) ? 'goal' : /^Archive\/Habits\//.test(r.path) ? 'habit' : /^Archive\/Projects\/[^/]+\.md$/.test(r.path) ? 'project' : 'note');
      return { path: r.path, title: r.title, kind, original, archived: log?.at ?? new Date(r.mtime).toISOString() };
    });
  }

  /**
   * Move a file (link(2) then unlink: a writer holding it open keeps writing into it) and point the
   * wiki-links that named it at the new path, in every personal note (not in the ring pipeline's
   * sections, not in captures, templates, the spec or the library).
   */
  private async moveFile(from: string, to: string): Promise<string> {
    const names = (this.db.prepare('SELECT path FROM files').all() as { path: string }[]).map((r) => r.path);
    const baseOf = (p: string) => p.split('/').pop()!.replace(/\.md$/i, '').toLowerCase();
    const fromUnique = names.filter((p) => p !== from && baseOf(p) === baseOf(from)).length === 0;
    const toUnique = names.filter((p) => p !== from && baseOf(p) === baseOf(to)).length === 0;
    await this.vault.move(from, to);
    const needle = baseOf(from);
    for (const p of names.map((n) => (n === from ? to : n))) {
      if (!isReadable(p)) continue;
      const k = classify(p);
      if (LOCKED.includes(k) || k === 'capture') continue;
      const text = await this.vault.read(p);
      if (!text || !text.toLowerCase().includes(needle)) continue;
      await this.vault.mutate(p, (lines) => {
        if (!lines) return null;
        const mask = codeMask(lines);
        const sections = sectionOfLines(lines, headings(lines, mask));
        let changed = false;
        const out = lines.map((l, i) => {
          if (mask[i] || BRIDGE_SECTIONS.includes((sections[i] ?? '').toLowerCase()) || !l.text.includes('[[')) return l;
          const next = retargetLinks(l.text, from, to, { fromUnique, toUnique });
          if (next === l.text) return l;
          changed = true;
          return { ...l, text: next };
        });
        return changed ? out : null;
      });
    }
    return to;
  }

  // ---------------------------------------------------------------- goals and projects (§5.3, §5.4)

  async editGoal(rel: string, e: { title?: string; status?: string; target?: string | null; why?: string | null }): Promise<void> {
    const kind = classify(rel);
    if (kind !== 'goal' && kind !== 'project') throw new Forbidden('not a goal or a project');
    await this.vault.mutate(rel, (lines) => {
      if (!lines) throw new NotFound('not found');
      let out = lines;
      if (e.status) out = setFrontmatterValue(out, 'status', e.status);
      if (e.target !== undefined) out = e.target ? setFrontmatterValue(out, 'target', e.target) : removeFrontmatterLine(out, 'target');
      if (e.why !== undefined) out = e.why?.trim() ? setFrontmatterValue(out, 'why', yamlScalar(e.why)) : removeFrontmatterLine(out, 'why');
      if (e.title?.trim()) {
        const { h1, fmEnd } = this.titleLine(out);
        const t = `# ${e.title.replace(/\s+/g, ' ').trim()}`;
        out = h1 >= 0 ? replaceLine(out, h1, [t]) : insertLines(out, fmEnd, [t]);
      }
      return joinLines(out) === joinLines(lines) ? null : out;
    });
  }
}
