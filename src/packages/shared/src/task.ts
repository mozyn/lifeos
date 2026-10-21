/**
 * Task lines (spec §5.1): `- [ ]` / `- [x]` with Obsidian Tasks emoji fields, plus `⏰` reminders,
 * `@slug` links and `#tags`.
 *
 * The parser keeps the line as it is and records where each field sits, so serializing an untouched
 * line is the line itself, whatever the field order. Edits change only the field they touch (or
 * append it at the end) — a ring-pipeline line keeps its text, dashes and wikilinks. New lines from
 * LifeOS use one canonical order that the Tasks plugin can still read (ADR-14): description,
 * `@slug`s, `⏰`, priority, `🔁`, `📅`, `✅`, then `#tags`.
 */
import { addDays, addMonths, addYears, isIsoDate, weekday } from './dates.js';

export type TaskStatus = 'open' | 'done' | 'cancelled';
export type Priority = 'highest' | 'high' | 'medium' | 'low' | 'lowest';
export type DateField = 'due' | 'scheduled' | 'start' | 'created' | 'done' | 'cancelled';
export type TokenKind = DateField | 'reminder' | 'priority' | 'recur' | 'slug' | 'tag';

export const PRAYERS = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'] as const;
export type PrayerName = (typeof PRAYERS)[number];

export interface TaskToken {
  kind: TokenKind;
  /** offsets in the full line */
  start: number;
  end: number;
  value: string;
}

export type ReminderSpec =
  | { kind: 'at'; date: string | null; time: string | null }
  | { kind: 'prayer'; prayer: PrayerName; offset: number };

export interface WikiLink {
  target: string;
  heading: string | null;
  alias: string | null;
  start: number;
  end: number;
}

export interface ParsedTask {
  raw: string;
  indent: string;
  bullet: string;
  statusChar: string;
  status: TaskStatus;
  /** offset of the status character in the line */
  statusAt: number;
  tokens: TaskToken[];
  /** the text without fields (slugs, tags and links kept) */
  description: string;
  /** what the UI shows: no fields, slugs, tags or source-capture links */
  title: string;
  due: string | null;
  dueInferred: boolean;
  scheduled: string | null;
  start: string | null;
  created: string | null;
  done: string | null;
  cancelledOn: string | null;
  reminder: ReminderSpec | null;
  reminderRaw: string | null;
  priority: Priority | null;
  recur: string | null;
  slugs: string[];
  tags: string[];
  links: WikiLink[];
  /** the wikilink that names the ring capture this task came from (spec §5.1) */
  capture: string | null;
}

const TASK_LINE = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)\[([^\]])\](.*)$/;

export function isTaskLine(text: string): boolean {
  return TASK_LINE.test(text);
}

const DATE_EMOJI: Record<string, DateField> = {
  '📅': 'due',
  '📆': 'due',
  '🗓': 'due',
  '⏳': 'scheduled',
  '🛫': 'start',
  '➕': 'created',
  '✅': 'done',
  '❌': 'cancelled',
};
export const FIELD_EMOJI: Record<DateField | 'reminder' | 'recur', string> = {
  due: '📅',
  scheduled: '⏳',
  start: '🛫',
  created: '➕',
  done: '✅',
  cancelled: '❌',
  reminder: '⏰',
  recur: '🔁',
};
export const PRIORITY_EMOJI: Record<Priority, string> = { highest: '🔺', high: '⏫', medium: '🔼', low: '🔽', lowest: '⏬' };
const EMOJI_PRIORITY: Record<string, Priority> = Object.fromEntries(Object.entries(PRIORITY_EMOJI).map(([k, v]) => [v, k as Priority]));
/** sort rank: highest first, no priority between medium and low (as in the Tasks plugin) */
export const PRIORITY_RANK: Record<Priority | 'none', number> = { highest: 0, high: 1, medium: 2, none: 3, low: 4, lowest: 5 };

const DATE_FIELD_RE = /(📅|📆|🗓|⏳|🛫|➕|✅|❌)️?[ \t]*(\d{4}-\d{2}-\d{2})/gu;
const PRAYER_RE = 'fajr|sunrise|dhuhr|zuhr|asr|maghrib|isha';
const REMINDER_RE = new RegExp(
  `⏰\\uFE0F?[ \\t]*(\\d{4}-\\d{2}-\\d{2}(?:[ T]\\d{1,2}:\\d{2})?|\\d{1,2}:\\d{2}|(?:${PRAYER_RE})(?:[ \\t]*[+-][ \\t]*\\d{1,3}(?:[ \\t]*(?:mins|min|m)\\b)?)?)`,
  'giu',
);
const PRIORITY_RE = /(🔺|⏫|🔼|🔽|⏬)️?/gu;
const RECUR_RE = /🔁️?[ \t]*([^📅📆🗓⏳🛫➕✅❌⏰🔺⏫🔼🔽⏬🔁#@\u0000]*)/gu;
const SLUG_RE = /(?<=^|[\s(])@([A-Za-z0-9][\w-]*)/gu;
const TAG_RE = /(?<=^|[\s(])#([^\s#@,;:!?()[\]{}"'<>`]+)/gu;
const WIKILINK_RE = /\[\[([^\]|#]*)(?:#([^\]|]*))?(?:\|([^\]]*))?\]\]/g;
/** spans whose content is not markdown fields: wikilinks, links, inline code, bare URLs */
const PROTECTED_RE = /\[\[[^\]]*\]\]|!?\[[^\]]*\]\([^)]*\)|`[^`]*`|https?:\/\/[^\s)>\]]+/g;

/** The string with protected spans blanked out (same length, so offsets stay valid). */
function mask(s: string): string {
  return s.replace(PROTECTED_RE, (m) => '\u0000'.repeat(m.length));
}

/** A capture slug as the ring pipeline writes it: `2026-10-14-124053-head-this-week…` or an Inbox/Ring path. */
export function looksLikeCapture(target: string): boolean {
  const t = target.trim();
  return /(^|\/)\d{4}-\d{2}-\d{2}-\d{6}(-|$)/.test(t) || t.startsWith('Inbox/Ring/');
}

export function parseReminder(raw: string): ReminderSpec | null {
  const s = raw.trim();
  let m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(s);
  if (m) {
    if (!isIsoDate(m[1])) return null;
    return { kind: 'at', date: m[1], time: m[2] !== undefined ? `${m[2].padStart(2, '0')}:${m[3]}` : null };
  }
  m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m) return { kind: 'at', date: null, time: `${m[1].padStart(2, '0')}:${m[2]}` };
  m = new RegExp(`^(${PRAYER_RE})(?:\\s*([+-])\\s*(\\d{1,3})(?:\\s*(?:mins|min|m))?)?$`, 'i').exec(s);
  if (m) {
    const name = m[1].toLowerCase();
    const prayer = (name === 'zuhr' ? 'dhuhr' : name) as PrayerName;
    const offset = m[2] ? (m[2] === '-' ? -1 : 1) * Number(m[3]) : 0;
    return { kind: 'prayer', prayer, offset };
  }
  return null;
}

export function formatReminder(r: ReminderSpec): string {
  if (r.kind === 'prayer') return r.offset ? `${r.prayer}${r.offset > 0 ? '+' : '-'}${Math.abs(r.offset)}` : r.prayer;
  if (r.date && r.time) return `${r.date} ${r.time}`;
  return r.date ?? r.time ?? '';
}

export function parseTaskLine(raw: string): ParsedTask | null {
  const m = TASK_LINE.exec(raw);
  if (!m) return null;
  const [, indent, bullet, gap, statusChar, body] = m;
  const statusAt = indent.length + bullet.length + gap.length + 1;
  const bodyAt = statusAt + 2;
  const status: TaskStatus = statusChar === 'x' || statusChar === 'X' ? 'done' : statusChar === '-' ? 'cancelled' : 'open';
  const masked = mask(body);
  const tokens: TaskToken[] = [];
  const add = (kind: TokenKind, start: number, end: number, value: string) => tokens.push({ kind, start: bodyAt + start, end: bodyAt + end, value });

  for (const x of masked.matchAll(DATE_FIELD_RE)) {
    if (isIsoDate(x[2])) add(DATE_EMOJI[x[1]], x.index!, x.index! + x[0].length, x[2]);
  }
  for (const x of masked.matchAll(REMINDER_RE)) {
    if (parseReminder(x[1])) add('reminder', x.index!, x.index! + x[0].length, x[1].trim());
  }
  for (const x of masked.matchAll(PRIORITY_RE)) add('priority', x.index!, x.index! + x[0].length, EMOJI_PRIORITY[x[1]]);
  for (const x of masked.matchAll(RECUR_RE)) {
    const text = x[1].replace(/\s+$/, '');
    if (/^every\b/i.test(text)) add('recur', x.index!, x.index! + x[0].length - (x[1].length - text.length), text);
  }
  for (const x of masked.matchAll(SLUG_RE)) add('slug', x.index!, x.index! + x[0].length, x[1].toLowerCase());
  for (const x of masked.matchAll(TAG_RE)) {
    const tag = x[1].replace(/[.]+$/, '');
    if (/^\d+$/.test(tag) || !tag) continue;
    add('tag', x.index!, x.index! + 1 + tag.length, tag);
  }
  tokens.sort((a, b) => a.start - b.start);

  const first = <K extends TokenKind>(k: K) => tokens.find((t) => t.kind === k)?.value ?? null;
  const fieldTokens = tokens.filter((t) => t.kind !== 'slug' && t.kind !== 'tag');

  // description: the body with field tokens cut out
  let description = '';
  let cursor = bodyAt;
  for (const t of fieldTokens) {
    description += raw.slice(cursor, t.start);
    cursor = t.end;
  }
  description += raw.slice(cursor);
  description = description.replace(/\s+/g, ' ').trim();

  const links: WikiLink[] = [];
  for (const x of body.matchAll(WIKILINK_RE)) {
    links.push({ target: x[1].trim(), heading: x[2]?.trim() || null, alias: x[3]?.trim() || null, start: bodyAt + x.index!, end: bodyAt + x.index! + x[0].length });
  }
  const capture = links.find((l) => looksLikeCapture(l.target))?.target ?? null;

  let due = first('due');
  let dueInferred = false;
  if (!due) {
    // ring-pipeline lines: the first ISO date in the text (never inside links or fields), read-only
    let blanked = masked.split('');
    for (const t of fieldTokens) for (let i = t.start - bodyAt; i < t.end - bodyAt; i++) blanked[i] = '\u0000';
    const text = blanked.join('');
    for (const x of text.matchAll(/(?<!\d)(\d{4}-\d{2}-\d{2})(?!\d)/g)) {
      if (isIsoDate(x[1])) {
        due = x[1];
        dueInferred = true;
        break;
      }
    }
    blanked = [];
  }

  const reminderRaw = first('reminder');
  const slugs = [...new Set(tokens.filter((t) => t.kind === 'slug').map((t) => t.value))];
  const tags = [...new Set(tokens.filter((t) => t.kind === 'tag').map((t) => t.value))];
  return {
    raw,
    indent,
    bullet,
    statusChar,
    status,
    statusAt,
    tokens,
    description,
    title: displayTitle(raw, bodyAt, tokens, links),
    due,
    dueInferred,
    scheduled: first('scheduled'),
    start: first('start'),
    created: first('created'),
    done: first('done'),
    cancelledOn: first('cancelled'),
    reminder: reminderRaw ? parseReminder(reminderRaw) : null,
    reminderRaw,
    priority: first('priority') as Priority | null,
    recur: first('recur'),
    slugs,
    tags,
    links,
    capture,
  };
}

/** The line as the UI shows it: fields, @slugs, #tags and source-capture links removed; other links as text. */
function displayTitle(raw: string, bodyAt: number, tokens: TaskToken[], links: WikiLink[]): string {
  type Cut = { start: number; end: number; repl: string };
  const cuts: Cut[] = tokens.map((t) => ({ start: t.start, end: t.end, repl: '' }));
  for (const l of links) cuts.push({ start: l.start, end: l.end, repl: looksLikeCapture(l.target) ? '' : (l.alias ?? (l.heading && !l.target ? l.heading : basename(l.target))) });
  cuts.sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = bodyAt;
  for (const c of cuts) {
    if (c.start < cursor) continue;
    out += raw.slice(cursor, c.start) + c.repl;
    cursor = c.end;
  }
  out += raw.slice(cursor);
  out = out.replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, (_m, t: string) => t);
  out = out.replace(/\s+/g, ' ').trim();
  // separators left dangling by a removed trailing link: "Do it — " → "Do it"
  for (let i = 0; i < 3; i++) out = out.replace(/\s*[—–-]\s*$/u, '').replace(/^\s*[—–-]\s*/u, '').trim();
  return out;
}

function basename(target: string): string {
  const b = target.split('/').pop() ?? target;
  return b.replace(/\.md$/i, '');
}

// ------------------------------------------------------------------ edits

export interface TaskEdit {
  status?: TaskStatus;
  done?: string | null;
  due?: string | null;
  reminder?: string | null;
  priority?: Priority | null;
  recur?: string | null;
  /** make an inferred due date explicit (LifeOS edits a ring-pipeline line: spec §5.1) */
  normalize?: boolean;
}

const APPEND_ORDER: (TokenKind | 'priority')[] = ['reminder', 'priority', 'recur', 'due', 'done', 'cancelled'];

function tokenText(kind: TokenKind, value: string): string {
  if (kind === 'priority') return PRIORITY_EMOJI[value as Priority];
  if (kind === 'slug') return `@${value}`;
  if (kind === 'tag') return `#${value}`;
  return `${FIELD_EMOJI[kind as keyof typeof FIELD_EMOJI]} ${value}`;
}

/**
 * Apply an edit to a task line. Touches only the status character and the fields named in the edit;
 * new fields are appended at the end in canonical order. Returns the line unchanged when the edit
 * changes nothing.
 */
export function editTaskLine(raw: string, edit: TaskEdit): string {
  const t = parseTaskLine(raw);
  if (!t) throw new Error('not a task line');
  type Rep = { start: number; end: number; text: string };
  const reps: Rep[] = [];
  const appends: { kind: TokenKind; value: string }[] = [];

  if (edit.status) {
    const c = edit.status === 'done' ? 'x' : edit.status === 'cancelled' ? '-' : ' ';
    const keep = edit.status === 'open' ? t.statusChar === '/' || t.statusChar === ' ' : edit.status === 'done' ? t.statusChar === 'x' || t.statusChar === 'X' : t.statusChar === '-';
    if (!keep) reps.push({ start: t.statusAt, end: t.statusAt + 1, text: c });
  }
  const setField = (kind: TokenKind, value: string | null | undefined) => {
    if (value === undefined) return;
    const existing = t.tokens.filter((x) => x.kind === kind);
    if (value === null) {
      for (const x of existing) {
        // take the whitespace before the token with it
        let s = x.start;
        while (s > 0 && (raw[s - 1] === ' ' || raw[s - 1] === '\t')) s--;
        reps.push({ start: s, end: x.end, text: '' });
      }
      return;
    }
    if (existing.length) {
      const x = existing[0];
      if (x.value !== value) reps.push({ start: x.start, end: x.end, text: tokenText(kind, value) });
      return;
    }
    appends.push({ kind, value });
  };
  setField('done', edit.done);
  let due = edit.due;
  if (due === undefined && edit.normalize && t.dueInferred && t.due) due = t.due;
  setField('due', due);
  setField('reminder', edit.reminder);
  setField('priority', edit.priority);
  setField('recur', edit.recur);

  reps.sort((a, b) => b.start - a.start);
  let out = raw;
  for (const r of reps) out = out.slice(0, r.start) + r.text + out.slice(r.end);
  if (appends.length) {
    appends.sort((a, b) => APPEND_ORDER.indexOf(a.kind) - APPEND_ORDER.indexOf(b.kind));
    out = out.replace(/[ \t]+$/, '') + appends.map((a) => ` ${tokenText(a.kind, a.value)}`).join('');
  }
  return out;
}

export interface NewTask {
  text: string;
  status?: TaskStatus;
  due?: string | null;
  reminder?: string | null;
  priority?: Priority | null;
  recur?: string | null;
  slugs?: string[];
  tags?: string[];
  done?: string | null;
  indent?: string;
}

/** A new task line in canonical order (ADR-14). */
export function formatTask(n: NewTask): string {
  const c = n.status === 'done' ? 'x' : n.status === 'cancelled' ? '-' : ' ';
  let s = `${n.indent ?? ''}- [${c}] ${n.text.replace(/\s+/g, ' ').trim()}`;
  for (const slug of n.slugs ?? []) s += ` @${slug}`;
  if (n.reminder) s += ` ⏰ ${n.reminder}`;
  if (n.priority) s += ` ${PRIORITY_EMOJI[n.priority]}`;
  if (n.recur) s += ` 🔁 ${n.recur}`;
  if (n.due) s += ` 📅 ${n.due}`;
  if (n.done) s += ` ✅ ${n.done}`;
  for (const tag of n.tags ?? []) s += ` #${tag}`;
  return s;
}

// ------------------------------------------------------------------ recurrence

export type RecurRule =
  | { unit: 'day' | 'week' | 'month' | 'year'; every: number; whenDone: boolean }
  | { unit: 'weekdays'; days: number[]; whenDone: boolean };

const DAY_NAMES: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};

/** `every day|week|month|year`, `every N days|weeks|months|years`, `every monday[, friday]`, `every weekday`, `… when done` */
export function parseRecurrence(text: string): RecurRule | null {
  let s = text.trim().toLowerCase().replace(/\s+/g, ' ');
  const whenDone = / when done$/.test(s);
  s = s.replace(/ when done$/, '');
  if (!s.startsWith('every')) return null;
  s = s.slice(5).trim();
  if (s === '' ) return null;
  let m = /^(day|week|month|year)$/.exec(s);
  if (m) return { unit: m[1] as 'day', every: 1, whenDone };
  if (s === 'other day') return { unit: 'day', every: 2, whenDone };
  if (s === 'other week') return { unit: 'week', every: 2, whenDone };
  m = /^(\d{1,3}) (day|week|month|year)s?$/.exec(s);
  if (m && Number(m[1]) > 0) return { unit: m[2] as 'day', every: Number(m[1]), whenDone };
  if (s === 'weekday' || s === 'weekdays') return { unit: 'weekdays', days: [1, 2, 3, 4, 5], whenDone };
  if (s === 'weekend' || s === 'weekends') return { unit: 'weekdays', days: [0, 6], whenDone };
  const parts = s.split(/\s*(?:,|and)\s*|\s+/).filter(Boolean);
  if (parts.length && parts.every((p) => p in DAY_NAMES)) return { unit: 'weekdays', days: [...new Set(parts.map((p) => DAY_NAMES[p]))].sort(), whenDone };
  return null;
}

export function nextDate(rule: RecurRule, from: string): string {
  if (rule.unit === 'weekdays') {
    for (let i = 1; i <= 7; i++) {
      const d = addDays(from, i);
      if (rule.days.includes(weekday(d))) return d;
    }
    return addDays(from, 7);
  }
  if (rule.unit === 'day') return addDays(from, rule.every);
  if (rule.unit === 'week') return addDays(from, 7 * rule.every);
  if (rule.unit === 'month') return addMonths(from, rule.every);
  return addYears(from, rule.every);
}

/**
 * The next occurrence of a recurring task as a new open line (spec §5.1: appended below the
 * completed one). Due, scheduled and start move by the rule; a dated `⏰` keeps its time and moves
 * with the due date; a prayer-anchored `⏰` stays as written. Returns null for non-recurring lines.
 */
export function nextOccurrenceLine(raw: string, today: string): string | null {
  const t = parseTaskLine(raw);
  if (!t?.recur) return null;
  const rule = parseRecurrence(t.recur);
  if (!rule) return null;
  const base = rule.whenDone ? today : (t.due ?? t.scheduled ?? t.start ?? today);
  const next = nextDate(rule, base);
  const shift = (d: string | null) => (d ? addDays(d, daysDiff(base, next)) : d);
  let line = editTaskLine(raw, {
    status: 'open',
    done: null,
    due: t.due ? next : undefined,
  });
  const reps: { kind: TokenKind; value: string }[] = [];
  if (t.scheduled) reps.push({ kind: 'scheduled', value: shift(t.scheduled)! });
  if (t.start) reps.push({ kind: 'start', value: shift(t.start)! });
  if (t.reminder?.kind === 'at' && t.reminder.date) reps.push({ kind: 'reminder', value: formatReminder({ ...t.reminder, date: shift(t.reminder.date) }) });
  if (!t.due && !t.scheduled && !t.start) {
    // a recurring task without dates gets a due date so the next one is visible on its day
    line = editTaskLine(line, { due: next });
  }
  for (const r of reps) {
    const tok = tokenOf(parseTaskLine(line)!, r.kind);
    if (tok) line = line.slice(0, tok.start) + tokenText(r.kind, r.value) + line.slice(tok.end);
  }
  // a "created" date belongs to the original
  line = editTaskLineRemove(line, 'created');
  return line;
}

function tokenOf(t: ParsedTask, kind: TokenKind): TaskToken | undefined {
  return t.tokens.find((x) => x.kind === kind);
}

function editTaskLineRemove(raw: string, kind: TokenKind): string {
  const t = parseTaskLine(raw);
  const tok = t && tokenOf(t, kind);
  if (!tok) return raw;
  let s = tok.start;
  while (s > 0 && (raw[s - 1] === ' ' || raw[s - 1] === '\t')) s--;
  return raw.slice(0, s) + raw.slice(tok.end);
}

function daysDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/** Completing a task (spec §5.1): `[x]` and `✅ date`, normalizing an inferred due date; plus the next occurrence. */
export function completeTaskLine(raw: string, today: string): { line: string; next: string | null } {
  return { line: editTaskLine(raw, { status: 'done', done: today, normalize: true }), next: nextOccurrenceLine(raw, today) };
}

/** Un-completing: back to `[ ]`, the `✅` removed. */
export function reopenTaskLine(raw: string): string {
  return editTaskLine(raw, { status: 'open', done: null });
}
