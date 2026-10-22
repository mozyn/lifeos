/**
 * The app's own address (round 8c, ADR-104): what a Telegram reminder's link, a habit nudge's link,
 * the integration API's task links, the Hermes prompt and the starter notes' guide link point at.
 *
 *   1. LIFEOS_PUBLIC_URL, when set, always wins.
 *   2. Else the address the owner typed in Settings → Advanced → Address.
 *   3. Else the one learned from the owner's browser: the page that sets the passphrase or signs in
 *      sends its own origin and base path (`location.origin` + `/lifeos`). No Host or forwarded
 *      header is read: a proxy can rewrite those, and behind one they name the container.
 *   4. Else none: links a browser opens are relative (`/lifeos/t/<id>`), Telegram texts carry no
 *      link, and the Hermes prompt says the address is not known yet.
 *
 * Learning (`learned`): an address on a loopback name (localhost, 127.x, ::1), 0.0.0.0 or a
 * container name is kept only while nothing better is known; a non-loopback one replaces it and is
 * never replaced by one of those again. An https address is not replaced by a plain-http one (the
 * phone's tailnet address over a LAN sign-in); between two of one kind, the newest wins.
 */
import { createHash } from 'node:crypto';
import { joinLines } from '@lifeos/shared';
import type { Config } from './config.js';
import { type DB, getSetting, setSetting } from './db.js';
import type { Vault } from './vault/vault.js';

/** The app's base path (Vite `base`, the router's basename, the cookie path). */
export const BASE_PATH = '/lifeos';

export type AddressSource = 'env' | 'owner' | 'learned';

export interface StoredAddress {
  url: string;
  source: 'owner' | 'learned';
  at: string;
}

export interface Address {
  url: string | null;
  source: AddressSource | null;
  at: string | null;
}

const KEY = 'address';

/**
 * An address as LifeOS keeps it: http or https, no user, query or fragment, the path without its
 * trailing slash; a bare origin gets the app's path. Anything else is null.
 */
export function cleanAddress(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > 300) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname) return null;
  if (u.username || u.password || u.search || u.hash || /[?#]/.test(s)) return null;
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${path || BASE_PATH}`;
}

/** Docker's names for this stack's containers and the host, and a bare container id. */
function containerName(h: string, name: string): boolean {
  if (h.endsWith('.docker.internal') || /^[0-9a-f]{12}$|^[0-9a-f]{64}$/.test(h)) return true;
  const services = ['web', 'api', 'searxng'];
  return services.includes(h) || [name, 'lifeos'].some((n) => services.some((s) => h === `${n}-${s}`));
}

/**
 * A host only this machine (or this compose network) reaches: a loopback name or address, an
 * unspecified one (0.0.0.0, ::) or a container's name. The WHATWG parser has already turned every
 * IPv4 spelling (0x7f.1, 2130706433) into dotted form and lower-cased the name.
 */
export function internalHost(hostname: string, name = 'lifeos'): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(h) || h === '0.0.0.0') return true;
  if (h === '::1' || h === '::' || /^::ffff:(7f[0-9a-f]{2}:[0-9a-f]{1,4}|0:0)$/.test(h)) return true;
  return containerName(h, name);
}

/** 0: this machine only; 1: reachable over plain http; 2: reachable over https. */
export function addressRank(url: string, name = 'lifeos'): 0 | 1 | 2 {
  const u = new URL(url);
  if (internalHost(u.hostname, name)) return 0;
  return u.protocol === 'https:' ? 2 : 1;
}

/**
 * What the store holds after a browser offered `offered` (null: no change). An address the owner
 * typed is never replaced by a learned one.
 */
export function learned(current: StoredAddress | null, offered: unknown, at: string, name = 'lifeos'): StoredAddress | null {
  const url = cleanAddress(offered);
  if (!url || current?.source === 'owner') return null;
  if (current && (current.url === url || addressRank(url, name) < addressRank(current.url, name))) return null;
  return { url, source: 'learned', at };
}

export function storedAddress(db: DB): StoredAddress | null {
  const s = getSetting<StoredAddress | null>(db, KEY, null);
  return s && typeof s.url === 'string' && cleanAddress(s.url) === s.url ? s : null;
}

/** The address in force and where it came from. */
export function resolveAddress(config: Pick<Config, 'publicUrl'>, db: DB): Address {
  if (config.publicUrl) return { url: config.publicUrl, source: 'env', at: null };
  const s = storedAddress(db);
  return s ? { url: s.url, source: s.source, at: s.at } : { url: null, source: null, at: null };
}

/**
 * The page's own address, as far as the request shows: when the browser sent an Origin header (it
 * does on a POST, unless its referrer policy made it "null"), the address must be on that origin.
 */
export function fromOrigin(offered: unknown, origin: string | undefined): boolean {
  const url = cleanAddress(offered);
  if (!url) return false;
  if (!origin || origin === 'null') return true;
  try {
    return new URL(origin).origin === new URL(url).origin;
  } catch {
    return false;
  }
}

/** Remember the browser's address when the rules allow; true when it changed. */
export function learnAddress(config: Pick<Config, 'publicUrl' | 'name'>, db: DB, offered: unknown, now: Date): boolean {
  if (config.publicUrl) return false;
  const next = learned(storedAddress(db), offered, now.toISOString(), config.name);
  if (!next) return false;
  setSetting(db, KEY, next);
  return true;
}

/** The owner's own address from Settings, or null to forget it (learning starts again). */
export function setOwnerAddress(db: DB, url: string | null, now: Date): void {
  if (url) setSetting(db, KEY, { url, source: 'owner', at: now.toISOString() } satisfies StoredAddress);
  else db.prepare('DELETE FROM settings WHERE key = ?').run(KEY);
}

/** Whether the signed-in page should offer its address: nothing set, or only a loopback one learned. */
export function wantsAddress(config: Pick<Config, 'publicUrl' | 'name'>, db: DB): boolean {
  if (config.publicUrl) return false;
  const s = storedAddress(db);
  return !s || (s.source === 'learned' && addressRank(s.url, config.name) === 0);
}

/** A link into the app (`path` from the app's root, as `/t/<id>`): absolute when the address is known, else relative. */
export function appLink(url: string | null, path: string): string {
  return `${url ?? BASE_PATH}${path}`;
}

// ------------------------------------------------------------------ the starter notes' guide link

/** The guide's link as the starter notes are seeded without an address (product brief 10, ADR-104). */
export const RELATIVE_GUIDE = `${BASE_PATH}/guide.html`;
export const GUIDE_NOTE = 'Resources/links.md';

/** What LifeOS last wrote in the links note: rewritten only while the note is still exactly that. */
export interface GuideRecord {
  path: string;
  hash: string;
  url: string;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function guideRecord(text: string, url = RELATIVE_GUIDE): GuideRecord | null {
  return text.includes(`](${url})`) ? { path: GUIDE_NOTE, hash: sha(text), url } : null;
}

/**
 * The starter notes' guide link follows the address once one reachable from another device is
 * known (never a loopback one), only while the links note is byte for byte what LifeOS wrote: an
 * edit by anyone (Obsidian, Syncthing, the app) ends it for good. Returns the record to keep
 * (null: stop following), or `undefined` when nothing changed.
 */
export async function relinkGuide(vault: Vault, rec: GuideRecord, address: string | null, name = 'lifeos'): Promise<GuideRecord | null | undefined> {
  if (!address || addressRank(address, name) === 0) return undefined;
  const target = `${address}/guide.html`;
  if (target === rec.url) return undefined;
  let next: GuideRecord | null = null;
  await vault.mutate(rec.path, (lines) => {
    if (!lines || sha(joinLines(lines)) !== rec.hash) return null;
    const i = lines.findIndex((l) => l.text.includes(`](${rec.url})`));
    if (i < 0) return null;
    const out = lines.map((l, j) => (j === i ? { ...l, text: l.text.replace(`](${rec.url})`, `](${target})`) } : l));
    next = { path: rec.path, hash: sha(joinLines(out)), url: target };
    return out;
  });
  return next;
}
