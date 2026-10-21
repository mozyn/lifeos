/**
 * Habits (spec §5.5): `Areas/Habits/<slug>.md`, one `## Log` line per day:
 * `- 2026-10-19 clean`, `- 2026-10-20 slip — phone in bed again`, `- 2026-10-21 skip`.
 * Streak = consecutive scheduled days marked clean, counted back from today (today not yet logged
 * does not break it); skip days are excused and neither count nor break; missing days are "not
 * logged", never slips, but they do end a streak.
 */
import { addDays, compareDates, daysBetween, isIsoDate, weekday } from './dates.js';
import { findSection, type RawLine } from './markdown.js';

export type HabitKind = 'quit' | 'build';
export type LogValue = 'clean' | 'slip' | 'skip';
export const HABITS_DIR = 'Areas/Habits';

export interface HabitLog {
  date: string;
  value: LogValue;
  note: string | null;
}

const LOG_RE = /^- (\d{4}-\d{2}-\d{2}) (clean|slip|skip)\b\s*(?:[—–-]\s*(.*))?$/i;

export function parseLogLine(text: string): HabitLog | null {
  const m = LOG_RE.exec(text.trim());
  if (!m || !isIsoDate(m[1])) return null;
  return { date: m[1], value: m[2].toLowerCase() as LogValue, note: m[3]?.trim() || null };
}

export function formatLogLine(l: HabitLog): string {
  return `- ${l.date} ${l.value}${l.note?.trim() ? ` — ${l.note.trim().replace(/\s+/g, ' ')}` : ''}`;
}

export interface LogLine extends HabitLog {
  line: number;
  raw: string;
}

export function readLog(lines: RawLine[]): LogLine[] {
  const s = findSection(lines, 'Log');
  if (!s) return [];
  const out: LogLine[] = [];
  for (let i = s.start; i < s.end; i++) {
    const v = parseLogLine(lines[i].text);
    if (v) out.push({ ...v, line: i, raw: lines[i].text });
  }
  return out;
}

const DAY: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/** `daily | weekdays | weekends | mon,wed,fri` → is that date scheduled? Unknown text = daily. */
export function parseSchedule(s: string | null | undefined): (date: string) => boolean {
  const v = (s ?? 'daily').trim().toLowerCase();
  if (v === '' || v === 'daily' || v === 'every day') return () => true;
  if (v === 'weekdays') return (d) => weekday(d) >= 1 && weekday(d) <= 5;
  if (v === 'weekends') return (d) => weekday(d) === 0 || weekday(d) === 6;
  const days = v
    .split(/[\s,]+/)
    .map((x) => DAY[x.slice(0, 3)])
    .filter((x) => x !== undefined);
  if (!days.length) return () => true;
  const set = new Set(days);
  return (d) => set.has(weekday(d));
}

/** The last entry wins when a day was logged twice. */
export function logMap(logs: HabitLog[]): Map<string, HabitLog> {
  const m = new Map<string, HabitLog>();
  for (const l of logs) m.set(l.date, l);
  return m;
}

export function currentStreak(logs: HabitLog[], schedule: string | null | undefined, started: string | null | undefined, today: string): number {
  const map = logMap(logs);
  const scheduled = parseSchedule(schedule);
  const start = started && isIsoDate(started) ? started : earliest(logs) ?? today;
  let d = map.has(today) ? today : addDays(today, -1);
  let n = 0;
  for (let guard = 0; guard < 3700 && compareDates(d, start) >= 0; guard++, d = addDays(d, -1)) {
    if (!scheduled(d)) continue;
    const v = map.get(d)?.value;
    if (v === 'clean') n++;
    else if (v === 'skip') continue;
    else break;
  }
  return n;
}

export function bestStreak(logs: HabitLog[], schedule: string | null | undefined, started: string | null | undefined, today: string): number {
  const map = logMap(logs);
  const scheduled = parseSchedule(schedule);
  const start = started && isIsoDate(started) ? started : earliest(logs) ?? today;
  let best = 0;
  let run = 0;
  const span = Math.min(3700, daysBetween(start, today));
  for (let i = 0; i <= span; i++) {
    const d = addDays(start, i);
    if (!scheduled(d)) continue;
    const v = map.get(d)?.value;
    if (v === 'clean') best = Math.max(best, ++run);
    else if (v === 'skip') continue;
    else if (d !== today) run = 0;
  }
  return best;
}

function earliest(logs: HabitLog[]): string | null {
  let e: string | null = null;
  for (const l of logs) if (!e || l.date < e) e = l.date;
  return e;
}

export type DayState = LogValue | 'not-logged' | 'not-scheduled' | 'future' | 'before-start';

/** The month calendar (spec §4.4): one state per day of the month. */
export function monthStates(year: number, month: number, logs: HabitLog[], schedule: string | null | undefined, started: string | null | undefined, today: string): { date: string; state: DayState }[] {
  const map = logMap(logs);
  const scheduled = parseSchedule(schedule);
  const first = `${year}-${String(month).padStart(2, '0')}-01`;
  const out: { date: string; state: DayState }[] = [];
  for (let d = first; d.slice(0, 7) === first.slice(0, 7); d = addDays(d, 1)) {
    const logged = map.get(d)?.value;
    let state: DayState;
    if (logged) state = logged;
    else if (compareDates(d, today) > 0) state = 'future';
    else if (started && isIsoDate(started) && compareDates(d, started) < 0) state = 'before-start';
    else if (!scheduled(d)) state = 'not-scheduled';
    else state = 'not-logged';
    out.push({ date: d, state });
  }
  return out;
}

export function habitTemplate(h: { title: string; kind: HabitKind; schedule: string; started: string }): string {
  return `---
date: ${h.started}
tags: [habit]
kind: ${h.kind}
status: active
started: ${h.started}
schedule: ${h.schedule}
---
# ${h.title.trim()}

## Log
`;
}

/** kebab-case file slug from a title (ASCII; falls back to a dated slug). */
export function slugify(title: string, fallback = 'note'): string {
  const s = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return s || fallback;
}
