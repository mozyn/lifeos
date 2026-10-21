/**
 * "Verify prayer times" (spec §10): the one user-triggered online check, allowed only when the owner
 * opted in (ADR-76). Fetches Aladhan's timings for a date through the egress wrapper (rounded
 * coordinates, the method's Aladhan id) and returns them beside the offline numbers. Never scheduled.
 */
import { ALADHAN_METHOD, type PrayerSettings, prayerTimes } from '@lifeos/shared';
import type { Egress } from './egress.js';

export const VERIFY_PRAYERS = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'] as const;

export interface VerifyRow {
  prayer: (typeof VERIFY_PRAYERS)[number];
  offline: string;
  aladhan: string | null;
  diffMin: number | null;
}

export interface VerifyResult {
  date: string;
  method: string;
  url: string;
  timezone: string | null;
  rows: VerifyRow[];
  maxDiff: number | null;
  agree: boolean;
}

const KEY: Record<(typeof VERIFY_PRAYERS)[number], string> = { fajr: 'Fajr', sunrise: 'Sunrise', dhuhr: 'Dhuhr', asr: 'Asr', maghrib: 'Maghrib', isha: 'Isha' };
const mins = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

export function aladhanUrl(date: string, s: PrayerSettings): string {
  const [y, m, d] = date.split('-');
  const lat = (Math.round(s.lat * 100) / 100).toFixed(2);
  const lon = (Math.round(s.lon * 100) / 100).toFixed(2);
  return `https://api.aladhan.com/v1/timings/${d}-${m}-${y}?latitude=${lat}&longitude=${lon}&method=${ALADHAN_METHOD[s.method]}`;
}

export async function verifyPrayerTimes(egress: Egress, date: string, s: PrayerSettings): Promise<VerifyResult> {
  const url = aladhanUrl(date, s);
  const res = await egress.fetch(url, { purpose: 'prayer-verify', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Aladhan answered ${res.status}`);
  const body = (await res.json()) as { data?: { timings?: Record<string, string>; meta?: { timezone?: string } } };
  const timings = body.data?.timings ?? {};
  const offline = prayerTimes(date, s);
  const rows: VerifyRow[] = VERIFY_PRAYERS.map((p) => {
    const raw = timings[KEY[p]];
    const hm = raw ? (/(\d{1,2}):(\d{2})/.exec(raw) ?? null) : null;
    const aladhan = hm ? `${hm[1].padStart(2, '0')}:${hm[2]}` : null;
    return { prayer: p, offline: offline[p], aladhan, diffMin: aladhan ? Math.abs(mins(aladhan) - mins(offline[p])) : null };
  });
  const diffs = rows.map((r) => r.diffMin).filter((x): x is number => x !== null);
  const maxDiff = diffs.length ? Math.max(...diffs) : null;
  return { date, method: s.method, url: url.replace(/\?.*$/, '?…'), timezone: body.data?.meta?.timezone ?? null, rows, maxDiff, agree: maxDiff !== null && maxDiff <= 2 && diffs.length === rows.length };
}
