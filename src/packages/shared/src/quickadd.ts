/**
 * Quick Add light syntax (spec §4): one text field, a type picker, and these markers, removed from
 * the title once understood:
 *
 *   dates     today, tonight, tomorrow (tmrw), day after tomorrow, monday / next fri / this sat,
 *             in 3 days / in 2 weeks, next week, next month, 2026-10-23, 10/23, oct 23, 23 october
 *   times     5pm, 5:30 pm, 17:30, at 5 (1–7 → pm), noon, midnight
 *   prayers   after maghrib (+15), before fajr (−15), at isha, maghrib+30, fajr-15
 *   repeat    every day|week|month|year|weekday|weekend|other day|3 days|monday[, thursday]
 *   priority  ! or !! (high), !!! (highest), !low
 *   tags      #tag        links to goals/projects/habits: @slug        a URL (links, wishlist)
 *
 * A time without a date means today, or tomorrow when that time has already passed today.
 */
import { addDays, addMonths, isIsoDate, MONTHS_LONG, MONTHS_SHORT, weekday } from './dates.js';
import { nextDate, parseRecurrence, type Priority } from './task.js';

export type QuickType = 'task' | 'note' | 'link' | 'shopping' | 'wishlist' | 'reminder';
export const QUICK_TYPES: QuickType[] = ['task', 'reminder', 'note', 'link', 'shopping', 'wishlist'];

export interface QuickParse {
  text: string;
  date: string | null;
  time: string | null;
  /** the `⏰` value: `2026-10-20 17:00` or `maghrib+30` */
  reminder: string | null;
  recur: string | null;
  priority: Priority | null;
  tags: string[];
  slugs: string[];
  url: string | null;
}

const DAYS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
const DAY_ALT = Object.keys(DAYS).sort((a, b) => b.length - a.length).join('|');
const LONG_DAY_ALT = 'sunday|monday|tuesday|wednesday|thursday|friday|saturday';
const MONTH_INDEX: Record<string, number> = {};
MONTHS_LONG.forEach((m, i) => (MONTH_INDEX[m.toLowerCase()] = i + 1));
MONTHS_SHORT.forEach((m, i) => (MONTH_INDEX[m.toLowerCase()] = i + 1));
MONTH_INDEX.sept = 9;
const MONTH_ALT = Object.keys(MONTH_INDEX).sort((a, b) => b.length - a.length).join('|');
const PRAYER_ALT = 'fajr|dhuhr|zuhr|asr|maghrib|isha';
/** The repeat marker: `every day`, `every 3 days`, `every monday and thursday`… */
const REPEAT_RE = new RegExp(`\\s(every (?:other (?:day|week)|weekdays?|weekends?|day|week|month|year|\\d{1,3} (?:days?|weeks?|months?|years?)|(?:${DAY_ALT})(?:(?:,\\s*|\\s+and\\s+|\\s+)(?:${DAY_ALT}))*))(?=\\s)`, 'i');

/**
 * Only the repeat of a short text (a group's item in Quick Add, round-3 brief §3): its words without
 * the marker, and the rule; a text with no repeat LifeOS understands comes back as it is.
 */
export function takeRepeat(input: string): { text: string; recur: string | null } {
  const s = ` ${input.replace(/\s+/g, ' ').trim()} `;
  const m = REPEAT_RE.exec(s);
  const rule = m ? m[1].toLowerCase().replace(/\s+/g, ' ') : null;
  if (!m || !rule || !parseRecurrence(rule)) return { text: input.trim(), recur: null };
  const text = (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim();
  return text ? { text, recur: rule } : { text: input.trim(), recur: null };
}

export interface QuickOptions {
  today: string;
  /** current wall-clock HH:MM (decides today vs tomorrow for a bare time) */
  now?: string;
}

function nextWeekday(today: string, wd: number, strictlyAfter: boolean): string {
  for (let i = strictlyAfter ? 1 : 0; i <= 7; i++) {
    const d = addDays(today, i);
    if (weekday(d) === wd) return d;
  }
  return addDays(today, 7);
}

function inferYear(today: string, month: number, day: number): string | null {
  const y = Number(today.slice(0, 4));
  for (const year of [y, y + 1]) {
    const d = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (isIsoDate(d) && d >= today) return d;
  }
  const d = `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isIsoDate(d) ? d : null;
}

export function parseQuickAdd(input: string, o: QuickOptions): QuickParse {
  let s = ` ${input.replace(/\s+/g, ' ').trim()} `;
  const out: QuickParse = { text: '', date: null, time: null, reminder: null, recur: null, priority: null, tags: [], slugs: [], url: null };
  const take = (re: RegExp, fn: (m: RegExpExecArray) => boolean | void) => {
    const m = re.exec(s);
    if (!m) return;
    if (fn(m) === false) return;
    s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length);
  };

  take(/\s(https?:\/\/[^\s]+)/i, (m) => {
    out.url = m[1];
  });
  // tags and slugs (all of them)
  for (let g = 0; g < 20; g++) {
    const before = s;
    take(/\s#([^\s#@]+)/u, (m) => {
      if (/^\d+$/.test(m[1])) return false;
      out.tags.push(m[1].replace(/[.,;:!?]+$/, ''));
    });
    take(/\s@([A-Za-z0-9][\w-]*)/u, (m) => {
      out.slugs.push(m[1].toLowerCase());
    });
    if (s === before) break;
  }
  take(/\s(!!!|!!|!(?:high|low|lowest|highest)?)(?=\s)/i, (m) => {
    const v = m[1].toLowerCase();
    out.priority = v === '!!!' || v === '!highest' ? 'highest' : v === '!low' ? 'low' : v === '!lowest' ? 'lowest' : 'high';
  });
  // repeat
  take(REPEAT_RE, (m) => {
    const rule = m[1].toLowerCase().replace(/\s+/g, ' ');
    if (!parseRecurrence(rule)) return false;
    out.recur = rule;
  });
  // prayer anchors
  take(new RegExp(`\\s(?:(after|before|at)\\s+)?(${PRAYER_ALT})(?:\\s*([+-])\\s*(\\d{1,3})(?:\\s*(?:mins?|m))?)?(?=\\s)`, 'i'), (m) => {
    if (!m[1] && !m[3]) return false; // a bare word "asr" in a title stays text
    const p = m[2].toLowerCase() === 'zuhr' ? 'dhuhr' : m[2].toLowerCase();
    let off = m[3] ? (m[3] === '-' ? -1 : 1) * Number(m[4]) : 0;
    if (m[1]?.toLowerCase() === 'after' && !m[3]) off = 15;
    if (m[1]?.toLowerCase() === 'before' && !m[3]) off = -15;
    out.reminder = off ? `${p}${off > 0 ? '+' : '-'}${Math.abs(off)}` : p;
  });
  // times
  take(/\s(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s?(am|pm)(?=\s)/i, (m) => {
    let h = Number(m[1]) % 12;
    if (m[3].toLowerCase() === 'pm') h += 12;
    const min = Number(m[2] ?? 0);
    if (h > 23 || min > 59) return false;
    out.time = `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  });
  if (!out.time) {
    take(/\s(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)(?=\s)/, (m) => {
      out.time = `${m[1].padStart(2, '0')}:${m[2]}`;
    });
  }
  if (!out.time) {
    take(/\s(?:at\s+)?(noon|midday|midnight)(?=\s)/i, (m) => {
      out.time = m[1].toLowerCase() === 'midnight' ? '00:00' : '12:00';
    });
  }
  if (!out.time) {
    take(/\sat\s+(\d{1,2})(?=\s)/i, (m) => {
      const h = Number(m[1]);
      if (h > 23) return false;
      out.time = `${String(h >= 1 && h <= 7 ? h + 12 : h).padStart(2, '0')}:00`;
    });
  }
  // dates
  const today = o.today;
  take(/\s(?:on\s+)?(\d{4}-\d{2}-\d{2})(?=\s)/, (m) => {
    if (!isIsoDate(m[1])) return false;
    out.date = m[1];
  });
  if (!out.date) take(/\s(?:on\s+|by\s+|due\s+)?(day after tomorrow)(?=\s)/i, () => void (out.date = addDays(today, 2)));
  if (!out.date)
    take(/\s(?:on\s+|by\s+|due\s+)?(today|tonight|tomorrow|tmrw|tmr)(?=\s)/i, (m) => {
      const w = m[1].toLowerCase();
      out.date = w === 'today' || w === 'tonight' ? today : addDays(today, 1);
      if (w === 'tonight' && !out.time && !out.reminder) out.time = '20:00';
    });
  if (!out.date)
    take(/\s(?:on\s+|by\s+|due\s+)?in\s+(\d{1,3})\s+(days?|weeks?|months?)(?=\s)/i, (m) => {
      const n = Number(m[1]);
      const u = m[2].toLowerCase();
      out.date = u.startsWith('day') ? addDays(today, n) : u.startsWith('week') ? addDays(today, 7 * n) : addMonths(today, n);
    });
  if (!out.date) take(/\snext\s+week(?=\s)/i, () => void (out.date = nextWeekday(today, 1, true)));
  if (!out.date) take(/\snext\s+month(?=\s)/i, () => void (out.date = `${addMonths(today, 1).slice(0, 7)}-01`));
  // full day names anywhere; short ones (sat, sun, wed…) only after on/by/due/next/this
  if (!out.date)
    take(new RegExp(`\\s(?:(?:(on|by|due|next|this)\\s+)(${DAY_ALT})|(${LONG_DAY_ALT}))(?=\\s)`, 'i'), (m) => {
      const name = (m[2] ?? m[3]).toLowerCase();
      const wd = DAYS[name];
      out.date = nextWeekday(today, wd, true);
      if (weekday(today) === wd && m[1]?.toLowerCase() === 'this') out.date = today;
    });
  if (!out.date)
    take(new RegExp(`\\s(?:on\\s+|by\\s+|due\\s+)?(${MONTH_ALT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?=\\s)`, 'i'), (m) => {
      const d = inferYear(today, MONTH_INDEX[m[1].toLowerCase()], Number(m[2]));
      if (!d) return false;
      out.date = d;
    });
  if (!out.date)
    take(new RegExp(`\\s(?:on\\s+|by\\s+|due\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_ALT})(?=\\s)`, 'i'), (m) => {
      const d = inferYear(today, MONTH_INDEX[m[2].toLowerCase()], Number(m[1]));
      if (!d) return false;
      out.date = d;
    });
  if (!out.date)
    take(/\s(?:on\s+|by\s+|due\s+)?(\d{1,2})\/(\d{1,2})(?=\s)/, (m) => {
      const d = inferYear(today, Number(m[1]), Number(m[2]));
      if (!d) return false;
      out.date = d;
    });

  // a repeat rule without a date starts on its first occurrence (today when today matches)
  if (out.recur && !out.date) {
    const rule = parseRecurrence(out.recur)!;
    out.date = rule.unit === 'weekdays' ? (rule.days.includes(weekday(today)) ? today : nextDate(rule, today)) : today;
  }
  if (out.time && !out.date) out.date = o.now && out.time <= o.now ? addDays(today, 1) : today;
  if (out.time && !out.reminder) out.reminder = `${out.date} ${out.time}`;
  if (out.reminder && !out.date) out.date = today;

  out.text = s
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(on|at|by|due|every)\s+/i, '')
    .replace(/\s+(on|at|by|due|in|every)$/i, '')
    .trim();
  return out;
}
