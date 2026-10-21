/**
 * Calendar dates as `YYYY-MM-DD` strings and wall-clock times as `HH:MM`, in the user's time zone
 * (the configured one; UTC when none is). Date arithmetic runs on UTC midnights so DST never shifts a day.
 */

/** The zone when none is configured (porting guide §4: TZ defaults to UTC). */
export const DEFAULT_TZ = 'UTC';

export const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
export const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
export const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of an instant in a zone. */
export function zonedParts(at: Date, tz = DEFAULT_TZ): { date: string; time: string; seconds: number } {
  const p: Record<string, string> = {};
  for (const part of fmt(tz).formatToParts(at)) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, seconds: Number(p.second) };
}

export const todayIn = (tz = DEFAULT_TZ, at = new Date()): string => zonedParts(at, tz).date;
export const nowHm = (tz = DEFAULT_TZ, at = new Date()): string => zonedParts(at, tz).time;

/** Offset of the zone from UTC at that instant, in minutes (Detroit in winter: -300). */
export function zoneOffsetMinutes(at: Date, tz = DEFAULT_TZ): number {
  const { date, time, seconds } = zonedParts(at, tz);
  const asUtc = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), Number(time.slice(0, 2)), Number(time.slice(3, 5)), seconds);
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

/** The instant of a wall-clock time on a date in a zone (DST gaps resolve forward). */
export function zonedInstant(date: string, hm: string, tz = DEFAULT_TZ): Date {
  const [h, m] = hm.split(':').map(Number);
  const guess = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), h, m);
  let t = guess - zoneOffsetMinutes(new Date(guess), tz) * 60000;
  // one correction for instants near a DST change
  t = guess - zoneOffsetMinutes(new Date(t), tz) * 60000;
  return new Date(t);
}

const utc = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function addDays(d: string, n: number): string {
  return iso(utc(d) + n * 86400000);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((utc(b) - utc(a)) / 86400000);
}

/** 0 = Sunday … 6 = Saturday */
export function weekday(d: string): number {
  return new Date(utc(d)).getUTCDay();
}

/** Add calendar months, clamping the day (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(d: string, n: number): string {
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7)) - 1 + n;
  const day = Number(d.slice(8, 10));
  const ty = y + Math.floor(m / 12);
  const tm = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return iso(Date.UTC(ty, tm, Math.min(day, last)));
}

export function addYears(d: string, n: number): string {
  return addMonths(d, n * 12);
}

/** Monday of the ISO week containing d. */
export function mondayOf(d: string): string {
  const wd = weekday(d);
  return addDays(d, wd === 0 ? -6 : 1 - wd);
}

/** ISO 8601 week: { year, week } (the week's Thursday decides the year). */
export function isoWeek(d: string): { year: number; week: number } {
  const thursday = addDays(mondayOf(d), 3);
  const year = Number(thursday.slice(0, 4));
  const jan4 = `${year}-01-04`;
  const week = Math.floor(daysBetween(mondayOf(jan4), mondayOf(d)) / 7) + 1;
  return { year, week };
}

/** `2026-W43` */
export function isoWeekKey(d: string): string {
  const { year, week } = isoWeek(d);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Monday of an ISO week key such as `2026-W43`. */
export function mondayOfWeekKey(key: string): string | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(key);
  if (!m) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  return addDays(mondayOf(`${year}-01-04`), (week - 1) * 7);
}

export function compareDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** "Mon 10-19" (the weekly-note day bullet, spec §5.9: a vault format, not a display format) */
export function dayBulletLabel(d: string): string {
  return `${WEEKDAYS_SHORT[weekday(d)]} ${d.slice(5)}`;
}

// ------------------------------------------------------------------ display (round-2 brief §1)
//
// Every date the app shows is US English, month first, and comes from these functions: the one
// place a date becomes text. Never `toLocaleString()` without this locale, never day-first. The
// Hijri line keeps its own format (hijri.ts). Vault formats (ISO dates, `Mon 10-19` bullets) are
// not display formats and stay as they are.

export const DISPLAY_LOCALE = 'en-US';

const mon = (d: string) => MONTHS_SHORT[Number(d.slice(5, 7)) - 1];
const dayNum = (d: string) => Number(d.slice(8, 10));

/** "Tuesday, October 20" */
export function longDate(d: string): string {
  return `${WEEKDAYS_LONG[weekday(d)]}, ${MONTHS_LONG[Number(d.slice(5, 7)) - 1]} ${dayNum(d)}`;
}

/** "Tuesday, October 20, 2026" */
export function longDateYear(d: string): string {
  return `${longDate(d)}, ${d.slice(0, 4)}`;
}

/** "Oct 20" */
export function shortDate(d: string): string {
  return `${mon(d)} ${dayNum(d)}`;
}

/** "Tue, Oct 20" */
export function shortDateDow(d: string): string {
  return `${WEEKDAYS_SHORT[weekday(d)]}, ${shortDate(d)}`;
}

/** "Oct 20, 2026" */
export function shortDateYear(d: string): string {
  return `${shortDate(d)}, ${d.slice(0, 4)}`;
}

/** "10/20/2026" (where a date is numeric) */
export function numericDate(d: string): string {
  return `${Number(d.slice(5, 7))}/${dayNum(d)}/${d.slice(0, 4)}`;
}

/** "Tue" / "Tuesday" */
export function weekdayName(d: string, style: 'short' | 'long' = 'short'): string {
  return (style === 'long' ? WEEKDAYS_LONG : WEEKDAYS_SHORT)[weekday(d)];
}

/** "October 2026" from `2026-10` or a date in that month */
export function monthYear(ym: string): string {
  return `${MONTHS_LONG[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
}

/** "Oct 19 – 25", "Oct 26 – Nov 1", "Dec 28, 2026 – Jan 3, 2027" */
export function dateRange(a: string, b: string): string {
  if (a.slice(0, 4) !== b.slice(0, 4)) return `${shortDateYear(a)} – ${shortDateYear(b)}`;
  if (a.slice(0, 7) === b.slice(0, 7)) return `${shortDate(a)} – ${dayNum(b)}`;
  return `${shortDate(a)} – ${shortDate(b)}`;
}

/** "Oct 20, 5:30 PM": a date and a wall-clock time */
export function dateTimeText(d: string, hm: string): string {
  return `${shortDate(d)}, ${hm12(hm)}`;
}

/** An instant (ISO string or Date) as US text in a zone: "Oct 20, 5:30 PM", or the time alone. */
export function instantText(at: string | Date, opts: { tz?: string; date?: boolean; year?: boolean; seconds?: boolean } = {}): string {
  const t = typeof at === 'string' ? new Date(at) : at;
  if (Number.isNaN(t.getTime())) return '';
  const p = zonedParts(t, opts.tz ?? localZone());
  let time = hm12(p.time);
  if (opts.seconds) time = time.replace(/ (AM|PM)$/, `:${String(p.seconds).padStart(2, '0')} $1`);
  if (opts.date === false) return time;
  return `${opts.year ? shortDateYear(p.date) : shortDate(p.date)}, ${time}`;
}

/** Where a line lives, for people: "the daily note for Tue, Oct 20", "Areas/Reminders". */
export function noteLabel(path: string): string {
  const daily = /^Daily Notes\/(\d{4}-\d{2}-\d{2})\.md$/.exec(path);
  if (daily && isIsoDate(daily[1])) return `the daily note for ${shortDateDow(daily[1])}`;
  const weekly = /^Weekly Notes\/(\d{4}-W\d{2})\.md$/.exec(path);
  if (weekly) {
    const m = mondayOfWeekKey(weekly[1]);
    if (m) return `the weekly note for ${dateRange(m, addDays(m, 6))}`;
  }
  return path.replace(/\.md$/, '');
}

/** The zone this code runs in (the browser's; the API's TZ), UTC when unknown. */
export function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TZ;
  } catch {
    return DEFAULT_TZ;
  }
}

export function parseHm(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function formatHm(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** "5:30 PM" for display */
export function hm12(hm: string): string {
  const mins = parseHm(hm);
  if (mins === null) return hm;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
