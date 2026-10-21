/**
 * Calendar events in weekly notes (spec §5.9), in the shape the ring pipeline (Hermes) writes:
 *
 *   ## This week
 *
 *   - Fri 10-16 — [[Daily Notes/2026-10-16]]
 *     - 18:30 Dinner at Ali's — Midtown
 *     - afternoon — Alex's wedding thing
 *
 * A nested bullet that starts with HH:MM has a time; anything else is all-day text shown as written.
 * Only `## This week` is read for events and only it is written (Add event); `Source:` lines and
 * everything else in the note are left alone.
 */
import { addDays, dayBulletLabel, isoWeekKey, mondayOf, mondayOfWeekKey, WEEKDAYS_SHORT } from './dates.js';
import { addSection, findSection, insertLines, type RawLine, splitLines } from './markdown.js';

export const WEEKLY_DIR = 'Weekly Notes';
export const weeklyPath = (date: string): string => `${WEEKLY_DIR}/${isoWeekKey(date)}.md`;

export interface WeekDay {
  date: string;
  line: number;
  /** nested lines under the bullet (indexes) */
  children: number[];
}

export interface WeekEvent {
  line: number;
  date: string;
  time: string | null;
  text: string;
  raw: string;
}

const DAY_RE = /^[-*] (Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w* (\d{1,2})-(\d{1,2})\b/;
const CHILD_RE = /^([ \t]+)[-*] (.*)$/;
const TIME_RE = /^(\d{1,2}):(\d{2})\b\s*(.*)$/;

export function parseEventText(s: string): { time: string | null; text: string } {
  const m = TIME_RE.exec(s.trim());
  if (m && Number(m[1]) < 24 && Number(m[2]) < 60) return { time: `${m[1].padStart(2, '0')}:${m[2]}`, text: m[3].trim() };
  return { time: null, text: s.trim() };
}

/** Days and events of a weekly note. `weekKey` (`2026-W42`) comes from the file name. */
export function parseWeekly(lines: RawLine[], weekKey: string): { monday: string | null; days: WeekDay[]; events: WeekEvent[] } {
  const monday = mondayOfWeekKey(weekKey);
  const sec = findSection(lines, 'This week');
  if (!sec || !monday) return { monday, days: [], events: [] };
  const week = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const days: WeekDay[] = [];
  const events: WeekEvent[] = [];
  let cur: WeekDay | null = null;
  for (let i = sec.start; i < sec.end; i++) {
    const text = lines[i].text;
    const d = DAY_RE.exec(text);
    if (d) {
      const mmdd = `${d[2].padStart(2, '0')}-${d[3].padStart(2, '0')}`;
      const date = week.find((x) => x.slice(5) === mmdd) ?? week.find((x) => WEEKDAYS_SHORT[new Date(`${x}T00:00:00Z`).getUTCDay()] === d[1]) ?? null;
      cur = date ? { date, line: i, children: [] } : null;
      if (cur) days.push(cur);
      continue;
    }
    const c = CHILD_RE.exec(text);
    if (c && cur) {
      cur.children.push(i);
      // only direct children are events (deeper bullets are details of the one above)
      const depth = c[1].replace(/\t/g, '  ').length;
      const firstDepth = (CHILD_RE.exec(lines[cur.children[0]].text)?.[1] ?? c[1]).replace(/\t/g, '  ').length;
      if (depth <= firstDepth) {
        const e = parseEventText(c[2]);
        events.push({ line: i, date: cur.date, time: e.time, text: e.text, raw: text });
      }
      continue;
    }
    if (text.trim() !== '') cur = null; // any other top-level line ends the day's list
  }
  return { monday, days, events };
}

/** A new weekly note in that shape, every day listed. */
export function weeklyTemplate(date: string): string {
  const monday = mondayOf(date);
  const key = isoWeekKey(date);
  const days = Array.from({ length: 7 }, (_, i) => `- ${dayBulletLabel(addDays(monday, i))}`).join('\n');
  return `---
date: ${monday}
tags: [weekly]
status: active
---

# Week ${key} (${monday} – ${addDays(monday, 6)})

## This week

${days}
`;
}

export function formatEventLine(indent: string, time: string | null, text: string): string {
  return `${indent}- ${time ? `${time} ` : ''}${text.replace(/\s+/g, ' ').trim()}`;
}

/**
 * Lines of the weekly note after adding an event under its day (spec §5.9). Creates the day bullet
 * (in date order) or the `## This week` section when missing. `lines` null = the note does not
 * exist: returns the whole new note.
 */
export function addEventLines(lines: RawLine[] | null, date: string, time: string | null, text: string): RawLine[] {
  if (!lines) lines = splitLines(weeklyTemplate(date));
  const key = isoWeekKey(date);
  let parsed = parseWeekly(lines, key);
  if (!findSection(lines, 'This week')) {
    // keep frontmatter, H1 and anything else; the section goes at the end
    lines = addSection(lines, 'This week', ['', `- ${dayBulletLabel(date)}`], []);
    parsed = parseWeekly(lines, key);
  }
  const indent = detectIndent(lines, parsed.days);
  let day = parsed.days.find((d) => d.date === date);
  if (!day) {
    const sec = findSection(lines, 'This week')!;
    const later = parsed.days.find((d) => d.date > date);
    let after: number;
    if (later) after = later.line - 1;
    else if (parsed.days.length) {
      const last = parsed.days[parsed.days.length - 1];
      after = last.children.length ? last.children[last.children.length - 1] : last.line;
    } else {
      // empty section: heading, blank, bullets (the ring pipeline's spacing)
      after = sec.start < lines.length && lines[sec.start].text.trim() === '' ? sec.start : sec.heading.line;
      if (after === sec.heading.line) {
        lines = insertLines(lines, after, ['']);
        after += 1;
      }
    }
    lines = insertLines(lines, after, [`- ${dayBulletLabel(date)}`]);
    parsed = parseWeekly(lines, key);
    day = parsed.days.find((d) => d.date === date)!;
  }
  const after = day.children.length ? day.children[day.children.length - 1] : day.line;
  return insertLines(lines, after, [formatEventLine(indent, time, text)]);
}

function detectIndent(lines: RawLine[], days: WeekDay[]): string {
  for (const d of days) {
    for (const c of d.children) {
      const m = CHILD_RE.exec(lines[c].text);
      if (m) return m[1];
    }
  }
  return '  ';
}
