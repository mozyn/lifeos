/**
 * Daily note (spec §5.2): `Daily Notes/YYYY-MM-DD.md`, from the vault's `Templates/Daily Note.md`
 * when it has one (the owner's adds the ring pipeline's sections: Ring captures, Ring requests,
 * Evening digest), else Plan, Tasks and Notes. LifeOS adds Check-in, Mood and Review when first
 * needed, before Evening digest when there is one, else at the end. The ring pipeline's sections are
 * read-only to LifeOS; nothing needs them (product brief 8 §6).
 */
import { findSection, headings, lastContentLine, type RawLine } from './markdown.js';

export const BRIDGE_SECTIONS = ['ring captures', 'ring requests', 'evening digest'];
export const DAILY_DIR = 'Daily Notes';

export const dailyPath = (date: string): string => `${DAILY_DIR}/${date}.md`;

/** The default daily note when the vault has no `Templates/Daily Note.md`. */
export const DEFAULT_DAILY_TEMPLATE = `---
date: {{date:YYYY-MM-DD}}
tags: [daily]
status: active
---

## Plan

## Tasks

## Notes
`;

/** Fill the Obsidian template placeholders LifeOS understands ({{date}}, {{date:YYYY-MM-DD}}, {{title}}). */
export function fillTemplate(template: string, date: string): string {
  return template
    .replace(/\{\{\s*date(?::\s*YYYY-MM-DD)?\s*\}\}/g, date)
    .replace(/\{\{\s*title\s*\}\}/g, date);
}

export interface CheckinLine {
  time: string;
  sleep?: number;
  workout?: boolean;
  prayers?: number;
  /** items LifeOS does not know, kept as written */
  extra: string[];
  /** the order the items were written in (an edit keeps it; new items go last) */
  order?: (CheckinKey | number)[];
}

type CheckinKey = 'sleep' | 'workout' | 'prayers';

const CHECKIN_RE = /^- (\d{1,2}:\d{2}) (.+)$/;

/** `- 07:10 sleep 6.5h · workout no · prayers 5/5` (any subset, any order) */
export function parseCheckinLine(text: string): CheckinLine | null {
  const m = CHECKIN_RE.exec(text.trim());
  if (!m) return null;
  const out: CheckinLine = { time: m[1].padStart(5, '0'), extra: [], order: [] };
  let known = 0;
  for (const item of m[2].split(/\s+·\s+/)) {
    const s = item.trim();
    let x: RegExpExecArray | null;
    if ((x = /^sleep (\d+(?:\.\d+)?)\s?h$/i.exec(s))) {
      out.sleep = Number(x[1]);
      out.order!.push('sleep');
      known++;
    } else if ((x = /^workout (yes|no)$/i.exec(s))) {
      out.workout = x[1].toLowerCase() === 'yes';
      out.order!.push('workout');
      known++;
    } else if ((x = /^prayers ([0-5])\/5$/i.exec(s))) {
      out.prayers = Number(x[1]);
      out.order!.push('prayers');
      known++;
    } else {
      out.order!.push(out.extra.length);
      out.extra.push(s);
    }
  }
  return known ? out : null;
}

export function formatSleep(h: number): string {
  return `${Number.isInteger(h) ? h : Math.round(h * 10) / 10}h`;
}

export function formatCheckinLine(c: CheckinLine): string {
  const text = (k: CheckinKey | number): string | null => {
    if (typeof k === 'number') return c.extra[k] ?? null;
    if (k === 'sleep') return c.sleep === undefined ? null : `sleep ${formatSleep(c.sleep)}`;
    if (k === 'workout') return c.workout === undefined ? null : `workout ${c.workout ? 'yes' : 'no'}`;
    return c.prayers === undefined ? null : `prayers ${c.prayers}/5`;
  };
  const order: (CheckinKey | number)[] = [...(c.order ?? [])];
  for (const k of ['sleep', 'workout', 'prayers'] as const) if (!order.includes(k)) order.push(k);
  c.extra.forEach((_, i) => order.includes(i) || order.push(i));
  const items = order.map(text).filter((x): x is string => x !== null);
  return `- ${c.time} ${items.join(' · ')}`;
}

export interface MoodLine {
  time: string;
  mood?: number;
  energy?: number;
  note?: string;
}

/** `- 07:12 mood 4 energy 3 — slept late, good focus` (mood and energy 1–5) */
export function parseMoodLine(text: string): MoodLine | null {
  const m = /^- (\d{1,2}:\d{2}) (?:mood ([1-5]))?\s*(?:energy ([1-5]))?\s*(?:[—–-]\s*(.*))?$/i.exec(text.trim());
  if (!m || (m[2] === undefined && m[3] === undefined)) return null;
  const out: MoodLine = { time: m[1].padStart(5, '0') };
  if (m[2] !== undefined) out.mood = Number(m[2]);
  if (m[3] !== undefined) out.energy = Number(m[3]);
  if (m[4]?.trim()) out.note = m[4].trim();
  return out;
}

export function formatMoodLine(m: MoodLine): string {
  const parts = [`- ${m.time}`];
  if (m.mood !== undefined) parts.push(`mood ${m.mood}`);
  if (m.energy !== undefined) parts.push(`energy ${m.energy}`);
  let s = parts.join(' ');
  if (m.note?.trim()) s += ` — ${m.note.trim().replace(/\s+/g, ' ')}`;
  return s;
}

export interface DailyEntries<T> {
  line: number;
  value: T;
  raw: string;
}

export function readCheckins(lines: RawLine[]): DailyEntries<CheckinLine>[] {
  const s = findSection(lines, 'Check-in');
  if (!s) return [];
  const out: DailyEntries<CheckinLine>[] = [];
  for (let i = s.start; i < s.end; i++) {
    const v = parseCheckinLine(lines[i].text);
    if (v) out.push({ line: i, value: v, raw: lines[i].text });
  }
  return out;
}

export function readMoods(lines: RawLine[]): DailyEntries<MoodLine>[] {
  const s = findSection(lines, 'Mood');
  if (!s) return [];
  const out: DailyEntries<MoodLine>[] = [];
  for (let i = s.start; i < s.end; i++) {
    const v = parseMoodLine(lines[i].text);
    if (v) out.push({ line: i, value: v, raw: lines[i].text });
  }
  return out;
}

/** Plain bullets under a section (`## Plan`, `## Review`): text without the `- `. */
export function readBullets(lines: RawLine[], section: string): { line: number; text: string }[] {
  const s = findSection(lines, section);
  if (!s) return [];
  const out: { line: number; text: string }[] = [];
  for (let i = s.start; i < s.end; i++) {
    const m = /^[-*+] (?!\[.\])(.+)$/.exec(lines[i].text.trim());
    if (m) out.push({ line: i, text: m[1].trim() });
  }
  return out;
}

/** Free text of a section (Review): the lines, trimmed of blank edges. */
export function sectionText(lines: RawLine[], section: string): string {
  const s = findSection(lines, section);
  if (!s) return '';
  return lines
    .slice(s.start, s.end)
    .map((l) => l.text)
    .join('\n')
    .trim();
}

/** Where to insert into an existing section: after its last non-blank line. */
export function sectionInsertAfter(lines: RawLine[], section: string): number | null {
  const s = findSection(lines, section, 2, headings(lines));
  return s ? lastContentLine(lines, s) : null;
}

/** Which "moment" a wall-clock time belongs to (spec §6). */
export type Moment = 'morning' | 'midday' | 'evening';
export function momentOf(hm: string): Moment {
  const h = Number(hm.slice(0, 2));
  if (h < 11) return 'morning';
  if (h < 17) return 'midday';
  return 'evening';
}
