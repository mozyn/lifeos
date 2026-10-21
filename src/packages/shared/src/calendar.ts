/**
 * The calendar's derived marks (round-2 brief §3, §4): nothing here is stored, everything comes from
 * the habit logs (§5.5), the weekly notes' events (§5.9) and the tasks' due dates (§5.1).
 *
 * - A day where every habit scheduled that day was marked `clean` gets a streak mark (a flame); a
 *   day with a slip gets a muted mark. Skips are excused (they neither make nor break the mark); a
 *   day with nothing logged, or only skips, gets no mark.
 * - Private habits (`private: true`) are left out of the marks while Privacy mode is on.
 * - The moon's phase on the night arc comes from the Hijri day (new around the 1st, full around the
 *   14th).
 */
import { addDays, compareDates, isIsoDate, weekday } from './dates.js';
import { type HabitLog, parseSchedule } from './habit.js';
import { hijri } from './hijri.js';

export interface HabitDay {
  path: string;
  slug: string;
  title: string;
  kind: 'quit' | 'build';
  private: boolean;
  value: 'clean' | 'slip' | 'skip' | null;
}

export type DayMark = 'streak' | 'slip' | null;

/** The habits scheduled on a date (active, started by then), each with that day's log value. */
export function habitsOn(
  date: string,
  habits: { path: string; slug: string; title: string; kind: 'quit' | 'build'; private?: boolean; status?: string; schedule: string; started: string | null; logs: HabitLog[] }[],
): HabitDay[] {
  const out: HabitDay[] = [];
  for (const h of habits) {
    if (h.status && h.status !== 'active') continue;
    if (h.started && isIsoDate(h.started) && compareDates(date, h.started) < 0) continue;
    const logged = h.logs.filter((l) => l.date === date).at(-1)?.value ?? null;
    // a day logged off-schedule still counts as that habit's day
    if (!parseSchedule(h.schedule)(date) && !logged) continue;
    out.push({ path: h.path, slug: h.slug, title: h.title, kind: h.kind, private: !!h.private, value: logged });
  }
  return out;
}

const visible = (habits: HabitDay[], hidePrivate: boolean) => (hidePrivate ? habits.filter((h) => !h.private) : habits);

/** Flame, muted mark or nothing for a day (see the module comment). */
export function dayMark(habits: HabitDay[], opts: { hidePrivate?: boolean } = {}): DayMark {
  const hs = visible(habits, !!opts.hidePrivate);
  if (hs.some((h) => h.value === 'slip')) return 'slip';
  const counted = hs.filter((h) => h.value !== 'skip');
  if (counted.length && counted.every((h) => h.value === 'clean')) return 'streak';
  return null;
}

/** At least one habit kept that day (the month's third dot). */
export function habitKept(habits: HabitDay[], opts: { hidePrivate?: boolean } = {}): boolean {
  return visible(habits, !!opts.hidePrivate).some((h) => h.value === 'clean');
}

/** The dates shown for a month, Monday first: `null` for the blanks before the 1st and after the last. */
export function monthCells(ym: string): (string | null)[] {
  const first = `${ym}-01`;
  const lead = (weekday(first) + 6) % 7;
  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let d = first; d.slice(0, 7) === ym; d = addDays(d, 1)) cells.push(d);
  while (cells.length % 7) cells.push(null);
  return cells;
}

/** "Rabīʿ al-Thānī – Jumādā al-Ūlā 1448": the Hijri months a Gregorian month spans. */
export function hijriSpan(ym: string, offset = 0): string {
  const first = hijri(`${ym}-01`, offset);
  let lastDate = `${ym}-28`;
  while (addDays(lastDate, 1).slice(0, 7) === ym) lastDate = addDays(lastDate, 1);
  const last = hijri(lastDate, offset);
  if (first.month === last.month && first.year === last.year) return `${first.monthName} ${first.year}`;
  if (first.year === last.year) return `${first.monthName} – ${last.monthName} ${last.year}`;
  return `${first.monthName} ${first.year} – ${last.monthName} ${last.year}`;
}

export interface MoonPhase {
  /** 0 new … 0.5 full … 1 new again */
  phase: number;
  /** lit fraction of the disc, 0..1 */
  lit: number;
  /** the lit side as seen from the northern hemisphere: right while waxing */
  waxing: boolean;
}

/**
 * The moon on a Hijri day: the month starts at the new crescent, so the phase is roughly the day:
 * new around the 1st, full around the 14th, waning after. Good to a day, which is what a drawing
 * needs (round-2 brief §2).
 */
export function moonPhase(hijriDay: number): MoonPhase {
  const day = Math.max(1, Math.min(30, Math.round(hijriDay)));
  // day 1 → 0.02 (a thin crescent), day 14 → 0.5 (full), day 29/30 → ~1 (dark)
  const phase = day <= 14 ? 0.02 + ((day - 1) / 13) * 0.48 : 0.5 + ((day - 14) / 16) * 0.48;
  const lit = (1 - Math.cos(2 * Math.PI * phase)) / 2;
  return { phase, lit, waxing: phase < 0.5 };
}
