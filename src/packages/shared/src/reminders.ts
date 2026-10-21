/**
 * Reminder timing (spec §8), pure so it is unit-tested:
 *  - a `⏰` resolves to a wall-clock moment: `⏰ 2026-10-23 17:30` as written; `⏰ 17:30` on the
 *    task's due date (else today); `⏰ 2026-10-23` at 09:00; `⏰ maghrib+30` against that day's
 *    computed prayer times (the due date, else today);
 *  - quiet hours (default 22:30–06:30, may span midnight) hold non-urgent reminders until they
 *    end; ⏫ (and 🔺) bypass them;
 *  - a reminder more than 24 h late is not sent (a restored backup or a rebuilt index must not
 *    flood the phone); it is recorded as expired.
 */
import { addDays, parseHm, zonedInstant, zonedParts } from './dates.js';
import { anchoredTime, type PrayerSettings } from './prayer.js';
import { parseReminder } from './task.js';

export const DEFAULT_REMINDER_TIME = '09:00';
export const MAX_LATE_MS = 24 * 3600_000;

export interface ReminderInput {
  reminder: string;
  due: string | null;
  priority: string | null;
}

/** The moment a reminder is meant for (before quiet hours), or null when it cannot be read. */
export function fireTime(r: ReminderInput, today: string, s: PrayerSettings): Date | null {
  const spec = parseReminder(r.reminder);
  if (!spec) return null;
  if (spec.kind === 'prayer') {
    const at = anchoredTime(r.due ?? today, spec.prayer, spec.offset, s);
    return zonedInstant(at.date, at.time, s.tz);
  }
  const date = spec.date ?? r.due ?? today;
  return zonedInstant(date, spec.time ?? DEFAULT_REMINDER_TIME, s.tz);
}

export function isUrgent(priority: string | null): boolean {
  return priority === 'high' || priority === 'highest';
}

/** Is a wall-clock HH:MM inside quiet hours [start, end)? Windows may span midnight. */
export function inQuiet(hm: string, start: string, end: string): boolean {
  const t = parseHm(hm)!;
  const a = parseHm(start)!;
  const b = parseHm(end)!;
  if (a === b) return false;
  return a < b ? t >= a && t < b : t >= a || t < b;
}

/** When a non-urgent reminder may go out: its own time, or the end of the quiet hours it falls in. */
export function releaseTime(fire: Date, quietStart: string, quietEnd: string, tz: string): Date {
  const { date, time } = zonedParts(fire, tz);
  if (!inQuiet(time, quietStart, quietEnd)) return fire;
  // the end of this quiet window: today's end if we are before it (after midnight), else tomorrow's
  const endToday = zonedInstant(date, quietEnd, tz);
  return endToday.getTime() > fire.getTime() ? endToday : zonedInstant(addDays(date, 1), quietEnd, tz);
}

export type Decision = { action: 'wait'; at: Date } | { action: 'send' } | { action: 'hold'; until: Date } | { action: 'expire' };

/**
 * What to do with an undelivered reminder now. `held` reminders are re-checked each minute: once
 * the quiet hours end they are sent (still within the 24 h window counted from their release).
 */
export function decide(fire: Date, now: Date, urgent: boolean, quiet: { start: string; end: string; tz: string }): Decision {
  if (fire.getTime() > now.getTime()) return { action: 'wait', at: fire };
  const release = urgent ? fire : releaseTime(fire, quiet.start, quiet.end, quiet.tz);
  // it is quiet right now (the app was down, or a late reminder): hold non-urgent ones until morning
  const nowHm = zonedParts(now, quiet.tz).time;
  const quietNow = !urgent && inQuiet(nowHm, quiet.start, quiet.end);
  const until = quietNow ? releaseTime(now, quiet.start, quiet.end, quiet.tz) : release;
  if (now.getTime() - until.getTime() > MAX_LATE_MS) return { action: 'expire' };
  if (until.getTime() > now.getTime()) return { action: 'hold', until };
  return { action: 'send' };
}

/** Retry backoff after a failed delivery: 1, 2, 4 … up to 60 minutes. */
export function backoffMs(attempts: number): number {
  return Math.min(60, 2 ** Math.max(0, attempts - 1)) * 60_000;
}
