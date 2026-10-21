/**
 * Hijri dates (spec §10) via `Intl.DateTimeFormat('en-u-ca-islamic-umalqura')`, with a user offset
 * of −1, 0 or +1 days for moon-sighting differences. Month names in Arabic transliteration.
 */
import { addDays } from './dates.js';

export const HIJRI_MONTHS = [
  'Muḥarram',
  'Ṣafar',
  'Rabīʿ al-Awwal',
  'Rabīʿ al-Thānī',
  'Jumādā al-Ūlā',
  'Jumādā al-Ākhirah',
  'Rajab',
  'Shaʿbān',
  'Ramaḍān',
  'Shawwāl',
  'Dhū al-Qaʿdah',
  'Dhū al-Ḥijjah',
] as const;

export type HijriOffset = -1 | 0 | 1;

export interface HijriDate {
  day: number;
  month: number;
  year: number;
  monthName: string;
  /** "7 Jumādā al-Ūlā 1448" */
  label: string;
}

let fmt: Intl.DateTimeFormat | null = null;

export function hijri(date: string, offset: HijriOffset | number = 0): HijriDate {
  fmt ??= new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', { timeZone: 'UTC', day: 'numeric', month: 'numeric', year: 'numeric' });
  const shifted = addDays(date, Math.max(-1, Math.min(1, Math.round(offset))));
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(`${shifted}T12:00:00Z`))) parts[p.type] = p.value;
  const day = Number(parts.day);
  const month = Number(parts.month);
  const year = Number(String(parts.year ?? parts.relatedYear).replace(/\D/g, ''));
  const monthName = HIJRI_MONTHS[month - 1] ?? String(month);
  return { day, month, year, monthName, label: `${day} ${monthName} ${year}` };
}
