/**
 * Prayer times (spec §10), offline with adhan-js, in the browser and in the API alike. Default
 * method Tehran (Institute of Geophysics: Fajr 17.7°, Isha 14°, Maghrib 4.5° after sunset); Leva
 * Institute, Qum (the Jafari method: Fajr 16°, Isha 14°, Maghrib 4°) and the common Sunni methods
 * are available (ADR-76). Asr with shadow factor 1. Times are wall-clock HH:MM in the configured
 * zone, rounded to the nearest minute.
 */
import { CalculationMethod, CalculationParameters, Coordinates, Madhab, PrayerTimes, Rounding } from 'adhan';
import { DEFAULT_TZ, addDays, zonedInstant, zonedParts } from './dates.js';
import type { PrayerName } from './task.js';

export const PRAYER_METHODS = ['tehran', 'qum', 'mwl', 'isna', 'egypt', 'karachi', 'makkah', 'dubai', 'kuwait', 'qatar', 'singapore', 'turkey', 'moonsighting'] as const;
export type PrayerMethod = (typeof PRAYER_METHODS)[number];

export interface PrayerSettings {
  lat: number;
  lon: number;
  tz: string;
  method: PrayerMethod;
}

/**
 * Until the first-run step chooses a place (ADR-76): Makkah, in the server's zone. The location is a
 * setting (spec §3: never in the vault, never sent anywhere), so no install carries anyone's home.
 */
export const DEFAULT_PRAYER_SETTINGS: PrayerSettings = { lat: 21.4225, lon: 39.8262, tz: DEFAULT_TZ, method: 'tehran' };

export const PRAYER_LABELS: Record<PrayerName, string> = { fajr: 'Fajr', sunrise: 'Sunrise', dhuhr: 'Dhuhr', asr: 'Asr', maghrib: 'Maghrib', isha: 'Isha' };
/** the five prayers (sunrise is a time, not a prayer) */
export const FIVE: PrayerName[] = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
export const METHOD_LABELS: Record<PrayerMethod, string> = {
  tehran: 'Institute of Geophysics, Tehran (Fajr 17.7°, Isha 14°, Maghrib 4.5°)',
  qum: 'Leva Institute, Qum, the Jafari method (Fajr 16°, Isha 14°, Maghrib 4°)',
  mwl: 'Muslim World League (Fajr 18°, Isha 17°)',
  isna: 'ISNA, North America (Fajr 15°, Isha 15°)',
  egypt: 'Egyptian General Authority of Survey (Fajr 19.5°, Isha 17.5°)',
  karachi: 'University of Islamic Sciences, Karachi (Fajr 18°, Isha 18°)',
  makkah: 'Umm al-Qura, Makkah (Fajr 18.5°, Isha 90 min after Maghrib)',
  dubai: 'Dubai (Fajr 18.2°, Isha 18.2°)',
  kuwait: 'Kuwait (Fajr 18°, Isha 17.5°)',
  qatar: 'Qatar (Fajr 18°, Isha 90 min after Maghrib)',
  singapore: 'Singapore (Fajr 20°, Isha 18°)',
  turkey: 'Diyanet, Turkey (Fajr 18°, Isha 17°)',
  moonsighting: 'Moonsighting Committee Worldwide (Fajr 18°, Isha 18°, seasonal)',
};
/** Short names for a picker. */
export const METHOD_SHORT: Record<PrayerMethod, string> = {
  tehran: 'Tehran',
  qum: 'Qum (Jafari)',
  mwl: 'Muslim World League',
  isna: 'ISNA (North America)',
  egypt: 'Egypt',
  karachi: 'Karachi',
  makkah: 'Umm al-Qura (Makkah)',
  dubai: 'Dubai',
  kuwait: 'Kuwait',
  qatar: 'Qatar',
  singapore: 'Singapore',
  turkey: 'Turkey (Diyanet)',
  moonsighting: 'Moonsighting Committee',
};
/** Aladhan's id for each method (the opt-in online comparison, §10). */
export const ALADHAN_METHOD: Record<PrayerMethod, number> = { tehran: 7, qum: 0, mwl: 3, isna: 2, egypt: 5, karachi: 1, makkah: 4, dubai: 16, kuwait: 9, qatar: 10, singapore: 11, turkey: 13, moonsighting: 15 };

export const isPrayerMethod = (x: unknown): x is PrayerMethod => typeof x === 'string' && (PRAYER_METHODS as readonly string[]).includes(x);

const METHOD_PARAMS: Record<Exclude<PrayerMethod, 'qum'>, () => CalculationParameters> = {
  tehran: () => CalculationMethod.Tehran(),
  mwl: () => CalculationMethod.MuslimWorldLeague(),
  isna: () => CalculationMethod.NorthAmerica(),
  egypt: () => CalculationMethod.Egyptian(),
  karachi: () => CalculationMethod.Karachi(),
  makkah: () => CalculationMethod.UmmAlQura(),
  dubai: () => CalculationMethod.Dubai(),
  kuwait: () => CalculationMethod.Kuwait(),
  qatar: () => CalculationMethod.Qatar(),
  singapore: () => CalculationMethod.Singapore(),
  turkey: () => CalculationMethod.Turkey(),
  moonsighting: () => CalculationMethod.MoonsightingCommittee(),
};

export function methodParams(method: PrayerMethod): CalculationParameters {
  const p = method === 'qum' ? new CalculationParameters('Other', 16, 14, 0, 4) : (METHOD_PARAMS[method] ?? METHOD_PARAMS.tehran)();
  p.madhab = Madhab.Shafi;
  p.rounding = Rounding.Nearest;
  return p;
}

export type DayTimes = Record<PrayerName, string>;

/** A day's times as HH:MM in the zone. */
export function prayerTimes(date: string, s: PrayerSettings = DEFAULT_PRAYER_SETTINGS): DayTimes {
  const at = prayerInstants(date, s);
  const out = {} as DayTimes;
  for (const k of Object.keys(at) as PrayerName[]) out[k] = zonedParts(at[k], s.tz).time;
  return out;
}

/** A day's times as instants. adhan reads the calendar day from a Date's local fields, so the day is passed as a local-noon Date. */
export function prayerInstants(date: string, s: PrayerSettings = DEFAULT_PRAYER_SETTINGS): Record<PrayerName, Date> {
  const [y, m, d] = date.split('-').map(Number);
  const pt = new PrayerTimes(new Coordinates(s.lat, s.lon), new Date(y, m - 1, d, 12), methodParams(s.method));
  return { fajr: pt.fajr, sunrise: pt.sunrise, dhuhr: pt.dhuhr, asr: pt.asr, maghrib: pt.maghrib, isha: pt.isha };
}

/** The next of the five prayers after `now` (tomorrow's Fajr after Isha). */
export function nextPrayer(now: Date, s: PrayerSettings = DEFAULT_PRAYER_SETTINGS): { name: PrayerName; time: string; at: Date; date: string } {
  const today = zonedParts(now, s.tz).date;
  for (const date of [today, addDays(today, 1)]) {
    const times = prayerTimes(date, s);
    for (const name of FIVE) {
      const at = zonedInstant(date, times[name], s.tz);
      if (at.getTime() > now.getTime()) return { name, time: times[name], at, date };
    }
  }
  const date = addDays(today, 1);
  const time = prayerTimes(date, s).fajr;
  return { name: 'fajr', time, at: zonedInstant(date, time, s.tz), date };
}

/** The wall-clock time of a prayer-anchored reminder (`maghrib+30`) on a date. */
export function anchoredTime(date: string, prayer: PrayerName, offset: number, s: PrayerSettings = DEFAULT_PRAYER_SETTINGS): { date: string; time: string } {
  const base = zonedInstant(date, prayerTimes(date, s)[prayer], s.tz);
  const p = zonedParts(new Date(base.getTime() + offset * 60000), s.tz);
  return { date: p.date, time: p.time };
}

/** "2 h 14 min", "38 min", "now" */
export function countdown(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins === 0) return 'now';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}
