/**
 * Every write LifeOS makes to the vault (spec §5), each one a line-anchored replace or an
 * insertion at a located anchor, applied to the file as it is on disk at that moment.
 *
 * What may be written (and nothing else):
 *  - task lines anywhere except bridge-owned sections and ring captures (complete, reopen,
 *    reschedule, remind, plus a recurring task's next line right below it)
 *  - new tasks under `## Tasks` (today's daily note, a goal/project note, Areas/Reminders.md) and
 *    new items under `## Items` (shopping, wishlist); "clear bought" moves `[x]` items to `## Bought`
 *  - daily note sections Plan, Check-in, Mood, Review (the last three LifeOS-owned)
 *  - weekly note `## This week` (Add event)
 *  - habit `## Log` lines and new habit notes; new goal notes
 *  - Resources/links.md lines, favorites.md lines
 *  - the `lifeos:` frontmatter key of a ring capture (nothing else in it)
 *  - notes LifeOS created in Inbox/ (whole-file edits only while unchanged since LifeOS wrote them)
 */
import { createHash } from 'node:crypto';
import {
  addEventLines,
  addSection,
  BRIDGE_SECTIONS,
  clearBoughtLines,
  codeMask,
  childIndent,
  completeInGroup,
  completeTaskLine,
  dailyPath,
  DEFAULT_DAILY_TEMPLATE,
  editTaskLine,
  FAVORITES_PATH,
  FAVORITES_TEMPLATE,
  fillTemplate,
  findGroups,
  findSection,
  formatCheckinLine,
  formatLinkLine,
  formatLogLine,
  formatMoodLine,
  formatTask,
  goalTemplate,
  GOALS_DIR,
  headings,
  habitTemplate,
  HABITS_DIR,
  insertLines,
  itemLabel,
  joinLines,
  lastContentLine,
  type CheckinLine,
  type HabitKind,
  type LinkLine,
  LINKS_PATH,
  LINKS_TEMPLATE,
  listTemplate,
  type LogValue,
  type Moment,
  momentOf,
  type MoodLine,
  noteTemplate,
  parseCheckinLine,
  parseFavorites,
  parseLogLine,
  parseMoodLine,
  parseTaskLine,
  type RawLine,
  removeLines,
  replaceLine,
  nextDate,
  parseRecurrence,
  reminderNoteTemplate,
  REMINDERS_PATH,
  reopenInGroup,
  reopenTaskLine,
  sectionOfLines,
  removeFrontmatterLine,
  setFrontmatterLine,
  setTaskText,
  SHOPPING_PATH,
  slugify,
  splitLines,
  type TaskEdit,
  weekday,
  weeklyPath,
  WISHLIST_PATH,
} from '@lifeos/shared';
import { type DB, nowIso } from '../db.js';
import { classify } from './paths.js';
import { type Anchor, LineNotFound, locate, type Vault } from './vault.js';

export class Forbidden extends Error {}
export class NotFound extends Error {}
export class Conflict extends Error {}

export interface TaskRef extends Anchor {
  path: string;
}

/** Insert lines after the last content line of `## name`, adding the section (before Evening digest) when missing. */
export function insertIntoSection(lines: RawLine[], name: string, texts: string[], before: string[] = ['Evening digest']): RawLine[] {
  const sec = findSection(lines, name);
  if (sec) return insertLines(lines, lastContentLine(lines, sec), texts);
  return addSection(lines, name, texts, before);
}

export class VaultOps {
  constructor(
    private readonly vault: Vault,
    private readonly db: DB,
  ) {}

  // ---------------------------------------------------------------- daily note

  /** The content of a new daily note: the vault's own template when it has one. */
  async dailyTemplate(date: string): Promise<string> {
    const t = await this.vault.read('Templates/Daily Note.md').catch(() => null);
    return fillTemplate(t ?? DEFAULT_DAILY_TEMPLATE, date);
  }

  /** Apply `fn` to the daily note's lines, creating the note from the template first when missing. */
  async withDaily(date: string, fn: (lines: RawLine[]) => RawLine[] | null) {
    const template = await this.dailyTemplate(date);
    return this.vault.mutate(dailyPath(date), (lines) => fn(lines ?? splitLines(template)));
  }

  // ---------------------------------------------------------------- tasks

  assertTaskWritable(rel: string, lines: RawLine[], index: number) {
    const kind = classify(rel);
    if (kind === 'capture') throw new Forbidden('Ring captures are read-only to LifeOS.');
    if (['template', 'lifeos', 'hadith', 'favorites'].includes(kind)) throw new Forbidden('LifeOS does not edit this note.');
    const section = sectionOfLines(lines)[index] ?? '';
    if (BRIDGE_SECTIONS.includes(section.toLowerCase())) throw new Forbidden(`"${section}" belongs to the ring pipeline; LifeOS leaves it alone.`);
    if (!parseTaskLine(lines[index].text)) throw new LineNotFound(rel);
  }

  /**
   * A line-anchored change that may span a block (a task group): `fn` gets the note's lines and the
   * index the anchor's hash was found at, and returns the new lines (or null for no change). A hash
   * no longer in the note fails visibly (LineNotFound) and refreshes the index, as replaceAt does.
   */
  async atAnchor(ref: TaskRef, fn: (lines: RawLine[], index: number) => RawLine[] | null): Promise<number> {
    let index = -1;
    let missing = false;
    await this.vault.mutate(ref.path, (lines) => {
      if (!lines) {
        missing = true;
        return null;
      }
      index = locate(lines, ref);
      if (index < 0) {
        missing = true;
        return null;
      }
      return fn(lines, index);
    });
    if (missing) {
      await this.vault.reindex(ref.path);
      throw new LineNotFound(ref.path);
    }
    return index;
  }

  /**
   * `[x]` + `✅ date` (normalizing an inferred due date), and a recurring task's next line below it.
   * In a task group (round-2 brief §10): the last open child completes the parent too, and a
   * completed recurring parent gets its next block (fresh parent, children unchecked).
   */
  async completeTask(ref: TaskRef, today: string): Promise<{ line: string; next: string | null; index: number; parentDone: boolean }> {
    let line = '';
    let next: string | null = null;
    let parentDone = false;
    const index = await this.atAnchor(ref, (lines, i) => {
      this.assertTaskWritable(ref.path, lines, i);
      const text = lines[i].text;
      if (parseTaskLine(text)!.status === 'done') {
        line = text; // already done (another device, a replay): leave it
        return null;
      }
      const g = completeInGroup(lines, i, today);
      if (g) {
        line = g.lines[i].text;
        next = g.next ? g.next.join('\n') : null;
        parentDone = g.parentDone;
        return g.lines;
      }
      const r = completeTaskLine(text, today);
      line = r.line;
      next = r.next;
      return replaceLine(lines, i, next ? [r.line, next] : [r.line]);
    });
    return { line, next, index, parentDone };
  }

  async reopenTask(ref: TaskRef): Promise<{ line: string }> {
    let line = '';
    await this.atAnchor(ref, (lines, i) => {
      this.assertTaskWritable(ref.path, lines, i);
      const g = reopenInGroup(lines, i);
      if (g) {
        line = g[i].text;
        return g;
      }
      line = reopenTaskLine(lines[i].text);
      return replaceLine(lines, i, [line]);
    });
    return { line };
  }

  // ---------------------------------------------------------------- task groups (round-2 brief §10)

  /**
   * Edit a group: its title and recurrence, its children's words, children removed and added. The
   * parent is found by its anchor and every child named by its anchor must still be in the block;
   * the block is rewritten line by line, untouched lines kept as they are.
   */
  async editGroup(ref: TaskRef, edit: { title?: string; recur?: string | null; children?: { line: number; hash: string; text?: string; remove?: boolean }[]; add?: string[] }, today: string): Promise<void> {
    await this.atAnchor(ref, (lines, i) => {
      this.assertTaskWritable(ref.path, lines, i);
      const g = findGroups(lines).find((x) => x.parent === i) ?? { parent: i, children: [], end: i + 1 };
      const block = lines.slice(g.parent, g.end).map((l) => l.text);
      let parent = block[0];
      if (edit.title?.trim()) parent = setTaskText(parent, edit.title);
      if (edit.recur !== undefined) {
        const rule = edit.recur ? parseRecurrence(edit.recur) : null;
        if (edit.recur && !rule) throw new Forbidden(`"${edit.recur}" is not a repeat LifeOS understands (every day, every week, every saturday, every month…).`);
        parent = editTaskLine(parent, { recur: edit.recur ? edit.recur.trim().toLowerCase() : null });
        // a repeating group needs a date to repeat from: its first occurrence (today when today fits)
        if (rule && !parseTaskLine(parent)!.due) {
          const first = rule.unit === 'weekdays' ? (rule.days.includes(weekday(today)) ? today : nextDate(rule, today)) : today;
          parent = editTaskLine(parent, { due: first });
        }
      }
      // children: located by hash inside the block (nearest to where they were)
      const sub = lines.slice(g.parent, g.end);
      const drop = new Set<number>();
      const texts = new Map<number, string>();
      for (const c of edit.children ?? []) {
        const k = locate(sub, { line: c.line - g.parent, hash: c.hash });
        if (k <= 0 || !g.children.includes(g.parent + k)) throw new LineNotFound(ref.path);
        if (c.remove) {
          // the child and the lines indented under it
          const base = /^[ \t]*/.exec(sub[k].text)![0].length;
          drop.add(k);
          for (let j = k + 1; j < sub.length && /^[ \t]*/.exec(sub[j].text)![0].length > base; j++) drop.add(j);
        } else if (c.text?.trim()) texts.set(k, setTaskText(sub[k].text, c.text));
      }
      const indent = childIndent(lines, g.children.length ? g : null, parseTaskLine(block[0])!.indent);
      const out: string[] = [parent];
      for (let k = 1; k < block.length; k++) if (!drop.has(k)) out.push(texts.get(k) ?? block[k]);
      for (const a of edit.add ?? []) if (a.trim()) out.push(formatTask({ text: a, indent }));
      if (out.length === block.length && out.every((t, k) => t === block[k])) return null;
      const before = lines.slice(0, g.parent);
      const after = lines.slice(g.end);
      const eol = lines[g.parent].eol || '\n';
      const lastEol = lines[g.end - 1].eol;
      return [...before, ...out.map((text, k) => ({ text, eol: k === out.length - 1 ? lastEol : eol })), ...after];
    });
  }

  /** Move a shopping or wishlist item into a group: the child is added first, then the item leaves the list. */
  async moveItemToGroup(group: TaskRef, item: TaskRef, today: string): Promise<void> {
    if (!['shopping', 'wishlist'].includes(classify(item.path))) throw new Forbidden('Only shopping and wishlist items move into a group.');
    let label = '';
    const cur = await this.vault.read(item.path);
    const lines = cur === null ? null : splitLines(cur);
    const at = lines ? locate(lines, item) : -1;
    if (!lines || at < 0) {
      await this.vault.reindex(item.path);
      throw new LineNotFound(item.path);
    }
    label = itemLabel(lines[at].text);
    await this.editGroup(group, { add: [label] }, today);
    await this.atAnchor(item, (ls, i) => {
      if (!parseTaskLine(ls[i].text)) throw new LineNotFound(item.path);
      return removeLines(ls, [i]);
    });
  }

  /** Reschedule, set a reminder or a priority: normalizes the line (inferred due made explicit). */
  async editTask(ref: TaskRef, edit: TaskEdit): Promise<{ line: string }> {
    let line = '';
    await this.vault.replaceAt(ref.path, ref, (text, lines, i) => {
      this.assertTaskWritable(ref.path, lines, i);
      line = editTaskLine(text, { ...edit, normalize: true });
      return [line];
    });
    return { line };
  }

  /** A new task line under `## Tasks` of a note; creates the note with `create()` when missing. */
  async addTaskTo(rel: string, line: string, create: () => string | Promise<string>, section = 'Tasks'): Promise<void> {
    const fresh = await create();
    await this.vault.mutate(rel, (lines) => insertIntoSection(lines ?? splitLines(fresh), section, [line], []));
  }

  /** New task lines (one task, or a group's block) under today's `## Tasks`. */
  async addTaskToday(date: string, line: string | string[]): Promise<string> {
    await this.withDaily(date, (lines) => insertIntoSection(lines, 'Tasks', Array.isArray(line) ? line : [line]));
    return dailyPath(date);
  }

  async addReminderTask(date: string, line: string): Promise<string> {
    await this.addTaskTo(REMINDERS_PATH, line, () => reminderNoteTemplate(date));
    return REMINDERS_PATH;
  }

  // ---------------------------------------------------------------- daily sections

  /**
   * Check-in (spec §5.2, §6): one line per moment, updated in place while that moment lasts
   * ("saves on change"), a new line in the next moment. Only `## Check-in` is touched.
   */
  async saveCheckin(date: string, hm: string, patch: Partial<Omit<CheckinLine, 'time' | 'extra'>>): Promise<string> {
    let written = '';
    await this.withDaily(date, (lines) => {
      const sec = findSection(lines, 'Check-in');
      const moment = momentOf(hm);
      if (sec) {
        for (let i = sec.end - 1; i >= sec.start; i--) {
          const c = parseCheckinLine(lines[i].text);
          if (c && momentOf(c.time) === moment) {
            written = formatCheckinLine({ ...c, ...defined(patch) });
            if (written === lines[i].text) return null;
            const out = lines.slice();
            out[i] = { ...out[i], text: written };
            return out;
          }
        }
      }
      written = formatCheckinLine({ time: hm, extra: [], ...defined(patch) });
      return insertIntoSection(lines, 'Check-in', [written]);
    });
    return written;
  }

  /** Mood and energy (1–5) with an optional note: same per-moment rule as the check-in. */
  async saveMood(date: string, hm: string, patch: Partial<Omit<MoodLine, 'time'>>): Promise<string> {
    let written = '';
    await this.withDaily(date, (lines) => {
      const sec = findSection(lines, 'Mood');
      const moment: Moment = momentOf(hm);
      if (sec) {
        for (let i = sec.end - 1; i >= sec.start; i--) {
          const m = parseMoodLine(lines[i].text);
          if (m && momentOf(m.time) === moment) {
            written = formatMoodLine({ ...m, ...defined(patch) });
            if (written === lines[i].text) return null;
            const out = lines.slice();
            out[i] = { ...out[i], text: written };
            return out;
          }
        }
      }
      written = formatMoodLine({ time: hm, ...defined(patch) });
      // the check-in section first, mood after it (spec §5.2 order)
      return insertIntoSection(lines, 'Mood', [written]);
    });
    return written;
  }

  /** Approved plan (spec §9 job 1): plain bullets under `## Plan`, headline first. */
  async appendPlan(date: string, bullets: string[]): Promise<void> {
    const texts = bullets.map((b) => `- ${b.replace(/\s+/g, ' ').trim()}`).filter((b) => b.length > 2);
    if (!texts.length) return;
    await this.withDaily(date, (lines) => {
      const sec = findSection(lines, 'Plan');
      if (sec) return insertLines(lines, lastContentLine(lines, sec), texts);
      // no Plan heading: put it first after the frontmatter, as in the template
      return addSection(lines, 'Plan', texts, ['Ring captures', 'Ring requests', 'Tasks', 'Notes', 'Evening digest']);
    });
  }

  /** Approved evening review (spec §9 job 2): `## Review` (LifeOS-owned), replaced on re-approval. */
  async writeReview(date: string, text: string): Promise<void> {
    const body = text
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((l) => l.trimEnd());
    await this.withDaily(date, (lines) => {
      const sec = findSection(lines, 'Review');
      if (!sec) return addSection(lines, 'Review', body);
      const keepBlank = sec.end < lines.length ? [''] : [];
      const out = lines.slice(0, sec.start);
      const eol = lines[sec.heading.line].eol || '\n';
      for (const t of [...body, ...keepBlank]) out.push({ text: t, eol });
      return [...out, ...lines.slice(sec.end)];
    });
  }

  // ---------------------------------------------------------------- weekly events

  async addEvent(date: string, time: string | null, text: string): Promise<string> {
    const rel = weeklyPath(date);
    await this.vault.mutate(rel, (lines) => addEventLines(lines, date, time, text));
    return rel;
  }

  // ---------------------------------------------------------------- habits

  /** Log a day (clean/slip/skip): replaces that day's line (a same-day correction) or adds it in date order. */
  async logHabit(rel: string, date: string, value: LogValue, note: string | null): Promise<string> {
    if (classify(rel) !== 'habit') throw new Forbidden('not a habit note');
    const line = formatLogLine({ date, value, note });
    let found = true;
    await this.vault.mutate(rel, (lines) => {
      if (!lines) {
        found = false;
        return null;
      }
      const sec = findSection(lines, 'Log');
      if (!sec) return addSection(lines, 'Log', [line], []);
      let laterAt = -1;
      for (let i = sec.start; i < sec.end; i++) {
        const l = parseLogLine(lines[i].text);
        if (!l) continue;
        if (l.date === date) {
          if (lines[i].text === line) return null;
          const out = lines.slice();
          out[i] = { ...out[i], text: line };
          return out;
        }
        if (l.date > date && laterAt < 0) laterAt = i;
      }
      // in date order: before the first later day, else after the last line of the log
      return insertLines(lines, laterAt >= 0 ? laterAt - 1 : lastContentLine(lines, sec), [line]);
    });
    if (!found) throw new NotFound('habit note not found');
    return line;
  }

  /**
   * Edit a habit (round-2 brief §6): name, kind, schedule, started date and `private`, by patching
   * its frontmatter lines and its H1 only; the log is never touched.
   */
  async editHabit(rel: string, e: { title?: string; kind?: HabitKind; schedule?: string; started?: string; private?: boolean }): Promise<void> {
    if (classify(rel) !== 'habit') throw new Forbidden('not a habit note');
    let missing = false;
    await this.vault.mutate(rel, (lines) => {
      if (!lines) {
        missing = true;
        return null;
      }
      let out: RawLine[] = lines;
      const set = (key: string, value: string) => {
        const next = setFrontmatterLine(out, key, value);
        if (!next) throw new Forbidden('This habit note has no frontmatter; edit it in Obsidian.');
        out = next;
      };
      if (e.kind) set('kind', e.kind);
      if (e.schedule) set('schedule', e.schedule);
      if (e.started) set('started', e.started);
      if (e.private === true) set('private', 'true');
      if (e.private === false) out = removeFrontmatterLine(out, 'private');
      if (e.title?.trim()) {
        const title = `# ${e.title.replace(/\s+/g, ' ').trim()}`;
        const mask = codeMask(out);
        const h1 = headings(out, mask).find((h) => h.level === 1);
        if (h1) out = replaceLine(out, h1.line, [title]);
        else {
          const fm = out[0]?.text.trim() === '---' ? out.findIndex((l, i) => i > 0 && l.text.trim() === '---') : -1;
          out = insertLines(out, fm, [title]);
        }
      }
      return out;
    });
    if (missing) throw new NotFound('habit note not found');
  }

  /** "Delete" a habit (§6): the note moves to `Archive/Habits/<slug>.md` with `status: archived`; the log stays whole. */
  async archiveHabit(rel: string): Promise<string> {
    if (classify(rel) !== 'habit') throw new Forbidden('not a habit note');
    if ((await this.vault.read(rel)) === null) throw new NotFound('habit note not found');
    const slug = rel.split('/').pop()!.replace(/\.md$/, '');
    const dest = await this.freePath('Archive/Habits', slug);
    await this.vault.move(rel, dest);
    await this.vault.mutate(dest, (lines) => (lines ? setFrontmatterLine(lines, 'status', 'archived') : null));
    return dest;
  }

  /** Bring an archived habit back to `Areas/Habits/` as active (Settings → Advanced → Data → Archived). */
  async restoreHabit(rel: string): Promise<string> {
    if (!/^Archive\/Habits\/[^/]+\.md$/.test(rel)) throw new Forbidden('not an archived habit');
    if ((await this.vault.read(rel)) === null) throw new NotFound('archived habit not found');
    const slug = rel.split('/').pop()!.replace(/\.md$/, '');
    const dest = await this.freePath(HABITS_DIR, slug);
    await this.vault.move(rel, dest);
    await this.vault.mutate(dest, (lines) => (lines ? setFrontmatterLine(lines, 'status', 'active') : null));
    return dest;
  }

  async createHabit(h: { title: string; kind: HabitKind; schedule: string; started: string }): Promise<string> {
    const rel = await this.freePath(HABITS_DIR, slugify(h.title, 'habit'));
    await this.vault.mutate(rel, (lines) => (lines ? null : splitLines(habitTemplate(h))));
    await this.remember(rel);
    return rel;
  }

  // ---------------------------------------------------------------- goals, notes, links, lists

  async createGoal(g: { title: string; date: string; target: string | null; why: string | null }): Promise<string> {
    const rel = await this.freePath(GOALS_DIR, slugify(g.title, 'goal'));
    await this.vault.mutate(rel, (lines) => (lines ? null : splitLines(goalTemplate(g))));
    await this.remember(rel);
    return rel;
  }

  async createNote(title: string, body: string, date: string, tags: string[] = ['note']): Promise<string> {
    const rel = await this.freePath('Inbox', slugify(title, `note-${date}`));
    await this.vault.mutate(rel, (lines) => (lines ? null : splitLines(noteTemplate(title, date, body, tags))));
    await this.remember(rel);
    return rel;
  }

  /** Whole-file edit of a note LifeOS created, only while nobody else changed it since. */
  async updateCreatedNote(rel: string, title: string, body: string, date: string): Promise<void> {
    const row = this.db.prepare('SELECT sha FROM created_files WHERE path = ?').get(rel) as { sha: string } | undefined;
    if (!row) throw new Forbidden('LifeOS only edits notes it created; edit this one in Obsidian.');
    const cur = await this.vault.read(rel);
    if (cur === null) throw new NotFound('note not found');
    if (sha(cur) !== row.sha) throw new Conflict('This note changed outside LifeOS since it was created; edit it in Obsidian.');
    await this.vault.mutate(rel, (lines) => {
      if (!lines || joinLines(lines) !== cur) throw new Conflict('This note changed while saving; reload it.');
      const fm = lines[0]?.text.trim() === '---' ? lines.findIndex((x, i) => i > 0 && x.text.trim() === '---') : -1;
      const head = fm > 0 ? lines.slice(0, fm + 1) : [];
      return [...head, ...splitLines(noteBody(title, body))];
    });
    await this.remember(rel);
  }

  async addLink(l: LinkLine, date: string): Promise<void> {
    const line = formatLinkLine(l);
    await this.vault.mutate(LINKS_PATH, (lines) => {
      const cur = lines ?? splitLines(LINKS_TEMPLATE(date));
      let last = cur.length - 1;
      while (last >= 0 && cur[last].text.trim() === '') last--;
      return insertLines(cur, last, [line]);
    });
  }

  async addListItem(kind: 'shopping' | 'wishlist', line: string, date: string): Promise<string> {
    const rel = kind === 'shopping' ? SHOPPING_PATH : WISHLIST_PATH;
    await this.addTaskTo(rel, line, () => listTemplate(kind, date), 'Items');
    return rel;
  }

  /** "Clear bought": the [x] lines move to `## Bought` (shopping only; the wishlist is never auto-cleared). */
  async clearBought(): Promise<number> {
    let n = 0;
    await this.vault.mutate(SHOPPING_PATH, (lines) => {
      if (!lines) return null;
      const r = clearBoughtLines(lines);
      n = r.moved.length;
      return r.moved.length ? r.lines : null;
    });
    return n;
  }

  async pinFavorite(heading: string, date: string): Promise<boolean> {
    let added = false;
    await this.vault.mutate(FAVORITES_PATH, (lines) => {
      const cur = lines ?? splitLines(FAVORITES_TEMPLATE(date));
      if (parseFavorites(cur).includes(heading.trim())) return lines ? null : cur;
      added = true;
      let last = cur.length - 1;
      while (last >= 0 && cur[last].text.trim() === '') last--;
      return insertLines(cur, last, [`- ${heading.trim()}`]);
    });
    return added;
  }

  // ---------------------------------------------------------------- ring captures

  /** The one frontmatter key LifeOS owns on a capture (spec §5): `lifeos: ignored | task | note`. */
  async setCaptureDecision(rel: string, decision: 'ignored' | 'task' | 'note'): Promise<void> {
    if (classify(rel) !== 'capture') throw new Forbidden('not a ring capture');
    let missing = false;
    await this.vault.mutate(rel, (lines) => {
      if (!lines) {
        missing = true;
        return null;
      }
      const out = setFrontmatterLine(lines, 'lifeos', decision);
      if (!out) throw new Forbidden('capture has no frontmatter');
      return out;
    });
    if (missing) throw new NotFound('capture not found');
  }

  // ---------------------------------------------------------------- helpers

  async freePath(dir: string, slug: string): Promise<string> {
    for (let n = 1; n < 200; n++) {
      const rel = `${dir}/${n === 1 ? slug : `${slug}-${n}`}.md`;
      if ((await this.vault.read(rel)) === null) return rel;
    }
    throw new Conflict('no free file name');
  }

  private async remember(rel: string): Promise<void> {
    const text = await this.vault.read(rel);
    if (text !== null) this.db.prepare('INSERT INTO created_files (path, sha, created_at) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET sha = excluded.sha').run(rel, sha(text), nowIso());
  }
}

function noteBody(title: string, body: string): string {
  const b = body.replace(/\r\n?/g, '\n').trimEnd();
  return `# ${title.replace(/\s+/g, ' ').trim()}\n${b ? `\n${b}\n` : ''}`;
}

function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function sha(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}
