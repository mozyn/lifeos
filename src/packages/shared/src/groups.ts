/**
 * Task groups (round-2 brief §10; a §5.1 extension, ADR-57): a parent task line with indented child
 * task lines directly beneath it.
 *
 *   - [ ] Weekly shopping 🔁 every saturday 📅 2026-10-24 @household
 *     - [ ] Olive oil
 *     - [ ] Call the butcher
 *     - [ ] Return the library books
 *
 * - The block is the parent and every following non-blank line indented deeper than it; its
 *   children are the task lines one level in (deeper task lines belong to a child and travel with
 *   it). A blank line or a line at the parent's indent ends the block.
 * - Children inherit the parent's due date and goal (`@slug`); a child's own `📅`/`⏰` overrides.
 * - Completing the last open child completes the parent. Completing the parent closes the open
 *   children as cancelled (`[-] ❌ date`: they were not done this time). A recurring parent, once
 *   done, gets its next occurrence right below the block: a fresh parent line with the next date
 *   and every child unchecked, their own dates moved by the same number of days.
 * - A child may repeat on its own (round-3 brief §3, ADR-65): `  - [ ] Water the plants 🔁 every
 *   3 days`. Completing it writes `[x] ✅ date` and its next occurrence right below it (after the
 *   lines indented under it), inside the same group, dated from its own date or the one it inherits;
 *   the parent is untouched, and the new open instance keeps the group open (a group with a
 *   repeating child closes when its parent is ticked). When a repeating parent's next block is
 *   made, each repeating child is carried once (its latest instance, unchecked) on its own dates.
 * - Every edit replaces or inserts whole lines; untouched lines stay byte-identical.
 */
import { addDays, daysBetween } from './dates.js';
import { takeRepeat } from './quickadd.js';
import { normTitle } from './today.js';
import { codeMask, insertLines, type RawLine, replaceLine } from './markdown.js';
import { editTaskLine, formatReminder, nextOccurrenceLine, parseTaskLine, type ParsedTask, type TaskToken } from './task.js';

export interface GroupBlock {
  /** line index of the parent */
  parent: number;
  /** line indexes of the children (task lines one level in) */
  children: number[];
  /** one past the last line of the block */
  end: number;
}

const indentWidth = (s: string) => s.replace(/\t/g, '    ').length;

/** The groups of a note: every task line with at least one child task beneath it. */
export function findGroups(lines: RawLine[], mask = codeMask(lines)): GroupBlock[] {
  const out: GroupBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    const p = parseTaskLine(lines[i].text);
    if (!p) continue;
    const base = indentWidth(p.indent);
    let level = -1;
    const children: number[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const text = lines[j].text;
      if (mask[j] || text.trim() === '') break;
      const ind = indentWidth(/^[ \t]*/.exec(text)![0]);
      if (ind <= base) break;
      const c = parseTaskLine(text);
      if (!c) continue;
      if (level < 0) level = ind;
      if (ind <= level) {
        level = ind;
        children.push(j);
      }
    }
    if (children.length) out.push({ parent: i, children, end: j });
  }
  return out;
}

/** The group a line belongs to, as parent or child. */
export function groupOf(groups: GroupBlock[], index: number): { group: GroupBlock; role: 'parent' | 'child' } | null {
  for (const g of groups) {
    if (g.parent === index) return { group: g, role: 'parent' };
    if (g.children.includes(index)) return { group: g, role: 'child' };
  }
  return null;
}

const closed = (t: ParsedTask | null) => !!t && (t.status === 'done' || t.status === 'cancelled');

export interface GroupWrite {
  lines: RawLine[];
  /** the parent was completed by this write (the group reward) */
  parentDone: boolean;
  /** the next occurrence's lines, when the parent recurs */
  next: string[] | null;
}

/** One past the last line a child owns: the child and the lines indented deeper under it. */
function childEnd(lines: RawLine[], g: GroupBlock, c: number): number {
  const base = indentWidth(/^[ \t]*/.exec(lines[c].text)![0]);
  let j = c + 1;
  while (j < g.end && indentWidth(/^[ \t]*/.exec(lines[j].text)![0]) > base) j++;
  return j;
}

/** Which repeating child a line is an instance of (its words and its rule). */
function seriesKey(t: Pick<ParsedTask, 'title' | 'recur'>): string {
  return `${normTitle(t.title)}\u0000${(t.recur ?? '').toLowerCase().replace(/\s+/g, ' ').trim()}`;
}

/**
 * A repeating child's next line (ADR-65): by its rule from its own date, or from the parent's date
 * it inherits (the new line then carries that date explicitly); null when the child does not repeat.
 */
export function nextChildLine(raw: string, parentRaw: string, today: string): string | null {
  const t = parseTaskLine(raw);
  if (!t?.recur) return null;
  let base = raw;
  if (!t.due && !t.scheduled && !t.start) {
    const p = parseTaskLine(parentRaw);
    if (p?.due) base = editTaskLine(raw, { due: p.due });
  }
  return nextOccurrenceLine(base, today);
}

/**
 * The children a group shows: a repeating child's earlier instances that are closed are its history
 * (the vault keeps them); its latest instance and any open one stand for it.
 */
export function currentChildren<T extends { title: string; recur: string | null; status: string; line: number }>(children: T[]): T[] {
  const last = new Map<string, number>();
  for (const c of children) if (c.recur) last.set(seriesKey(c), Math.max(last.get(seriesKey(c)) ?? -1, c.line));
  return children.filter((c) => !c.recur || c.status === 'open' || last.get(seriesKey(c)) === c.line);
}

/** A task's line moved by `days` (its dated fields: due, scheduled, start, a dated reminder). */
function shiftDates(raw: string, days: number): string {
  if (!days) return raw;
  let line = raw;
  const t = parseTaskLine(raw);
  if (!t) return raw;
  const set = (kind: TaskToken['kind'], value: string) => {
    const tok = parseTaskLine(line)!.tokens.find((x) => x.kind === kind);
    if (!tok) return;
    const text = kind === 'reminder' ? `⏰ ${value}` : `${{ due: '📅', scheduled: '⏳', start: '🛫' }[kind as 'due']} ${value}`;
    line = line.slice(0, tok.start) + text + line.slice(tok.end);
  };
  if (t.due && !t.dueInferred) set('due', addDays(t.due, days));
  if (t.scheduled) set('scheduled', addDays(t.scheduled, days));
  if (t.start) set('start', addDays(t.start, days));
  if (t.reminder?.kind === 'at' && t.reminder.date) set('reminder', formatReminder({ ...t.reminder, date: addDays(t.reminder.date, days) }));
  return line;
}

/** A child for the next occurrence: unchecked, its ✅/❌ gone, its own dates moved with the parent. */
function freshChild(raw: string, days: number): string {
  const t = parseTaskLine(raw);
  if (!t) return raw;
  let line = editTaskLine(raw, { status: 'open', done: null });
  const cancelled = parseTaskLine(line)!.tokens.find((x) => x.kind === 'cancelled');
  if (cancelled) {
    let s = cancelled.start;
    while (s > 0 && (line[s - 1] === ' ' || line[s - 1] === '\t')) s--;
    line = line.slice(0, s) + line.slice(cancelled.end);
  }
  return shiftDates(line, days);
}

/**
 * The parent is done: `[x] ✅ today` (an inferred date made explicit, §5.1), open children closed as
 * cancelled, and, when it recurs, the next block appended right after this one.
 */
export function completeGroup(lines: RawLine[], g: GroupBlock, today: string): GroupWrite {
  const parentRaw = lines[g.parent].text;
  let out = lines.slice();
  for (const c of g.children) {
    const t = parseTaskLine(out[c].text);
    if (t && t.status === 'open') out = replaceLine(out, c, [editTaskLine(out[c].text, { status: 'cancelled' }) + ` ❌ ${today}`]);
  }
  out = replaceLine(out, g.parent, [editTaskLine(parentRaw, { status: 'done', done: today, normalize: true })]);
  const nextParent = nextOccurrenceLine(parentRaw, today);
  if (!nextParent) return { lines: out, parentDone: true, next: null };
  const p = parseTaskLine(parentRaw)!;
  const np = parseTaskLine(nextParent)!;
  const days = p.due && np.due ? daysBetween(p.due, np.due) : 0;
  // a repeating child goes on once, from its latest instance, on its own dates (ADR-65)
  const latest = new Map<string, number>();
  for (const c of g.children) {
    const t = parseTaskLine(lines[c].text);
    if (t?.recur) latest.set(seriesKey(t), c);
  }
  const body: string[] = [];
  for (let i = g.parent + 1; i < g.end; ) {
    const t = g.children.includes(i) ? parseTaskLine(lines[i].text) : null;
    if (t?.recur) {
      const end = childEnd(lines, g, i);
      if (latest.get(seriesKey(t)) === i) {
        const closedBefore = t.status !== 'open';
        body.push(closedBefore ? (nextChildLine(lines[i].text, parentRaw, today) ?? freshChild(lines[i].text, 0)) : freshChild(lines[i].text, 0));
        for (let j = i + 1; j < end; j++) body.push(parseTaskLine(lines[j].text) ? freshChild(lines[j].text, 0) : lines[j].text);
      }
      i = end;
      continue;
    }
    const text = lines[i].text;
    body.push(parseTaskLine(text) ? freshChild(text, days) : text);
    i++;
  }
  const next = [nextParent, ...body];
  return { lines: insertLines(out, g.end - 1, next), parentDone: true, next };
}

/**
 * Complete one task line of a group: a child (`[x] ✅ today`; the last open child completes the
 * parent too), or the parent itself (completeGroup).
 */
export function completeInGroup(lines: RawLine[], index: number, today: string, groups = findGroups(lines)): GroupWrite | null {
  const at = groupOf(groups, index);
  if (!at) return null;
  if (at.role === 'parent') return completeGroup(lines, at.group, today);
  const t = parseTaskLine(lines[index].text);
  if (!t || t.status !== 'open') return { lines, parentDone: false, next: null };
  let out = replaceLine(lines, index, [editTaskLine(lines[index].text, { status: 'done', done: today, normalize: true })]);
  // a child with its own repeat: its next occurrence below it, in the same group; the parent is untouched
  const again = nextChildLine(lines[index].text, lines[at.group.parent].text, today);
  if (again) return { lines: insertLines(out, childEnd(lines, at.group, index) - 1, [again]), parentDone: false, next: [again] };
  const parent = parseTaskLine(out[at.group.parent].text);
  const allClosed = at.group.children.every((c) => closed(parseTaskLine(out[c].text)));
  if (!allClosed || !parent || parent.status !== 'open') return { lines: out, parentDone: false, next: null };
  const r = completeGroup(out, at.group, today);
  out = r.lines;
  return { lines: out, parentDone: true, next: r.next };
}

/** Reopen a child; a done parent above it opens again too (a group with an open child is not done). */
export function reopenInGroup(lines: RawLine[], index: number, groups = findGroups(lines)): RawLine[] | null {
  const at = groupOf(groups, index);
  if (!at || at.role !== 'child') return null;
  let out = replaceLine(lines, index, [editTaskLine(lines[index].text, { status: 'open', done: null })]);
  const parent = parseTaskLine(out[at.group.parent].text);
  if (parent?.status === 'done') out = replaceLine(out, at.group.parent, [editTaskLine(out[at.group.parent].text, { status: 'open', done: null })]);
  return out;
}

// ------------------------------------------------------------------ writing a group

/** A task line's words replaced, every field and tag kept (in their order, after the words). */
export function setTaskText(raw: string, text: string): string {
  const t = parseTaskLine(raw);
  if (!t) throw new Error('not a task line');
  const head = raw.slice(0, t.statusAt + 2);
  const fields = t.tokens.map((x) => raw.slice(x.start, x.end).trim()).filter(Boolean);
  return `${head} ${[text.replace(/\s+/g, ' ').trim(), ...fields].join(' ')}`;
}

/** The child indent a group uses (its first child's), or two spaces deeper than the parent. */
export function childIndent(lines: RawLine[], g: GroupBlock | null, parentIndent = ''): string {
  if (g && g.children.length) return /^[ \t]*/.exec(lines[g.children[0]].text)![0];
  return `${parentIndent}  `;
}

/** "olive oil" → "Olive oil": a child typed in Quick Add starts with a capital. */
export function capitalize(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

/**
 * Quick Add's group syntax (round-2 brief §10): `Weekly shopping every saturday: olive oil; call the
 * butcher; library books`. The words before the first ": " are the parent (dates, repeat, @goal and
 * #tags read as usual); the rest, split at ";", are the children. A colon without a ";" after it is
 * just a colon.
 */
export function splitGroupInput(input: string): { head: string; items: string[] } | null {
  const m = /^(.+?):\s+(.+)$/s.exec(input.trim());
  if (!m || !m[2].includes(';')) return null;
  const items = m[2]
    .split(';')
    .map((x) => capitalize(x))
    .filter(Boolean);
  if (items.length < 2 || !m[1].trim()) return null;
  return { head: m[1].trim(), items };
}

/** The lines of a new group block; an item's own repeat ("water the plants every 3 days") becomes its `🔁` (ADR-65). */
export function formatGroup(parentLine: string, items: string[], indent = '  '): string[] {
  return [
    parentLine,
    ...items.map((item) => {
      const r = takeRepeat(item);
      return `${indent}- [ ] ${r.text.replace(/\s+/g, ' ').trim()}${r.recur ? ` 🔁 ${r.recur}` : ''}`;
    }),
  ];
}

