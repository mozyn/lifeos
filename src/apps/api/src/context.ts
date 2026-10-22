import { todayIn, nowHm, type PrayerSettings, DEFAULT_PRAYER_SETTINGS, DEFAULT_PREFERRED_DOMAINS, type HijriOffset } from '@lifeos/shared';
import { resolveAddress } from './address.js';
import type { Config } from './config.js';
import { type DB, getSetting } from './db.js';
import type { Egress } from './egress.js';
import type { VaultOps } from './vault/ops.js';
import type { EditOps } from './vault/edit-ops.js';
import type { Vault } from './vault/vault.js';

/** Settings kept in SQLite (spec §4 Settings); location lives here, never in the vault (§3). */
export interface AppSettings {
  /** where prayer times are computed, and the app's time zone once chosen (ADR-76, ADR-77) */
  prayer: PrayerSettings;
  /** the place's name as chosen ("Detroit, Michigan, United States"; null before the first run) */
  place: string | null;
  hijriOffset: HijriOffset;
  /** the one online comparison with Aladhan is allowed (opt-in, off by default, ADR-76) */
  prayerCheck: boolean;
  /** the Obsidian vault's name for `obsidian://` links; empty: no Obsidian links (ADR-79) */
  vaultName: string;
  /** what the AI prompts call the owner; empty: "the user" */
  ownerName: string;
  /** when the first-run step was finished (null: it is shown after the passphrase) */
  setupAt: string | null;
  telegram: boolean;
  quietStart: string;
  quietEnd: string;
  search: boolean;
  /** the Islamic search category boosts these domains (round-2 brief §8) */
  searchDomains: string[];
  ai: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  prayer: DEFAULT_PRAYER_SETTINGS,
  place: null,
  hijriOffset: 0,
  prayerCheck: false,
  vaultName: '',
  ownerName: '',
  setupAt: null,
  telegram: true,
  quietStart: '22:30',
  quietEnd: '06:30',
  search: true,
  searchDomains: DEFAULT_PREFERRED_DOMAINS,
  ai: true,
};

export interface Ctx {
  config: Config;
  db: DB;
  vault: Vault;
  ops: VaultOps;
  edits: EditOps;
  egress: Egress;
  now: () => Date;
  today: () => string;
  hm: () => string;
  /** the app's time zone: the chosen place's, else TZ (ADR-77) */
  tz: () => string;
  settings: () => AppSettings;
  /** the app's address: LIFEOS_PUBLIC_URL, else the owner's or the learned one (ADR-104); null: not known yet */
  publicUrl: () => string | null;
}

/** A zone the runtime knows (an IANA name such as America/Toronto). */
export function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz.length > 0 && tz.length < 64;
  } catch {
    return false;
  }
}

export function makeCtx(base: Omit<Ctx, 'today' | 'hm' | 'tz' | 'settings' | 'publicUrl'>): Ctx {
  const settings = () => {
    const stored = getSetting<Partial<AppSettings>>(base.db, 'app', {});
    const s = { ...DEFAULT_SETTINGS, ...stored };
    // the zone travels with the place; before a place is chosen it is the server's TZ
    const tz = stored.prayer?.tz && validZone(stored.prayer.tz) ? stored.prayer.tz : base.config.tz;
    s.prayer = { ...DEFAULT_PRAYER_SETTINGS, ...s.prayer, tz };
    return s;
  };
  const tz = () => settings().prayer.tz;
  return {
    ...base,
    settings,
    tz,
    publicUrl: () => resolveAddress(base.config, base.db).url,
    today: () => todayIn(tz(), base.now()),
    hm: () => nowHm(tz(), base.now()),
  };
}
