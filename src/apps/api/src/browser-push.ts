/**
 * Browser notifications for reminders (product brief 8 §6, ADR-80): the channel that needs nothing
 * but the installed app. A device that turns them on in Settings → Reminders hands the API a Web
 * Push subscription (endpoint and keys, kept in SQLite); when a reminder fires, each device gets
 * one push, once per reminder (keyed like a Telegram delivery: file + line hash), through the
 * egress wrapper (purpose `push`, whose allowlist is exactly the subscribed endpoints' hosts).
 *
 * The payload is encrypted for the device (RFC 8291, `push.ts`): the browser's push endpoint
 * (Google's for Chrome, Mozilla's for Firefox, Apple's for Safari) carries it without being able
 * to read it. The VAPID keys come from `.env.push` (an older install.sh wrote one) or are generated
 * on the first start and kept in SQLite in /data (product brief 10 §1); the private key is never
 * logged or returned.
 */
import type { DB } from './db.js';
import { getSetting, setSetting } from './db.js';
import { hostPort } from './egress.js';
import { buildPushRequest, generateVapidKeys, isVapidKeys, type PushSubscriptionJson, pushResult, type VapidKeys, validSubscription } from './push.js';

export interface PushDevice {
  endpoint: string;
  p256dh: string;
  auth: string;
  host: string;
  label: string;
  created_at: string;
  last_ok_at: string | null;
  last_error: string | null;
}

export interface PushPayload {
  title: string;
  body: string;
  /** opened on a tap, relative to the app (`t/<id>`, `today`) */
  url: string;
  /** a later push with the same tag replaces the earlier one on the device */
  tag?: string;
}

export type PushFetch = (url: string, init: RequestInit) => Promise<Response>;

const MAX_ATTEMPTS = 5;

export class BrowserPush {
  private cachedKeys: VapidKeys | null = null;

  constructor(
    private readonly db: DB,
    private readonly fetchImpl: PushFetch,
    private readonly env: { publicKey?: string | null; privateKey?: string | null; subject: string },
    private readonly now: () => Date = () => new Date(),
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, host TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, last_ok_at TEXT, last_error TEXT);
      CREATE TABLE IF NOT EXISTS push_sent (key TEXT NOT NULL, endpoint TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL, PRIMARY KEY (key, endpoint));
    `);
  }

  /** `.env.push`'s keys when valid, else the ones generated for this install. */
  keys(): VapidKeys {
    if (this.cachedKeys) return this.cachedKeys;
    const fromEnv = { publicKey: this.env.publicKey ?? '', privateKey: this.env.privateKey ?? '' };
    if (isVapidKeys(fromEnv)) return (this.cachedKeys = fromEnv);
    const stored = getSetting<unknown>(this.db, 'vapid', null);
    if (isVapidKeys(stored)) return (this.cachedKeys = stored);
    const fresh = generateVapidKeys();
    setSetting(this.db, 'vapid', fresh);
    return (this.cachedKeys = fresh);
  }

  /** The keys, made now if there are none yet: where they came from ('generated' only the once). */
  ensureKeys(): 'env' | 'stored' | 'generated' {
    if (this.keySource === 'env') return 'env';
    const had = isVapidKeys(getSetting<unknown>(this.db, 'vapid', null));
    this.keys();
    return had ? 'stored' : 'generated';
  }

  get keySource(): 'env' | 'generated' {
    return isVapidKeys({ publicKey: this.env.publicKey ?? '', privateKey: this.env.privateKey ?? '' }) ? 'env' : 'generated';
  }

  devices(): PushDevice[] {
    return this.db.prepare('SELECT * FROM push_subs ORDER BY created_at').all() as PushDevice[];
  }

  /** The hosts the `push` purpose may reach: exactly the subscribed endpoints'. */
  hosts(): string[] {
    return (this.db.prepare('SELECT DISTINCT host FROM push_subs').all() as { host: string }[]).map((r) => r.host);
  }

  subscribe(sub: unknown, label = ''): PushDevice {
    if (!validSubscription(sub)) throw new Error('not a push subscription');
    const s = sub as PushSubscriptionJson;
    const host = hostPort(s.endpoint);
    this.db
      .prepare(
        `INSERT INTO push_subs (endpoint, p256dh, auth, host, label, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label`,
      )
      .run(s.endpoint, s.keys.p256dh, s.keys.auth, host, label.slice(0, 60), this.now().toISOString());
    return this.db.prepare('SELECT * FROM push_subs WHERE endpoint = ?').get(s.endpoint) as PushDevice;
  }

  unsubscribe(endpoint: string): boolean {
    this.db.prepare('DELETE FROM push_sent WHERE endpoint = ?').run(endpoint);
    return this.db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(endpoint).changes > 0;
  }

  /**
   * One push to each device (or the one named). With a `key`, a device that already has it is
   * skipped, and one that failed retryably is tried again on a later call (at most 5 times).
   */
  async send(payload: PushPayload, opts: { key?: string; endpoint?: string; ttlSec?: number; urgency?: 'normal' | 'high' } = {}): Promise<{ sent: number; skipped: number; gone: number; failed: number }> {
    const out = { sent: 0, skipped: 0, gone: 0, failed: 0 };
    const devices = this.devices().filter((d) => !opts.endpoint || d.endpoint === opts.endpoint);
    if (!devices.length) return out;
    const body = JSON.stringify({ title: payload.title.slice(0, 120), body: payload.body.slice(0, 400), url: payload.url, tag: payload.tag });
    const keys = this.keys();
    for (const d of devices) {
      const prev = opts.key ? (this.db.prepare('SELECT status, attempts FROM push_sent WHERE key = ? AND endpoint = ?').get(opts.key, d.endpoint) as { status: string; attempts: number } | undefined) : undefined;
      if (prev && (prev.status === 'sent' || prev.status === 'failed')) {
        out.skipped++;
        continue;
      }
      const attempts = (prev?.attempts ?? 0) + 1;
      const record = (status: string) => {
        if (opts.key) this.db.prepare('INSERT INTO push_sent (key, endpoint, status, attempts, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key, endpoint) DO UPDATE SET status = excluded.status, attempts = excluded.attempts, at = excluded.at').run(opts.key, d.endpoint, status, attempts, this.now().toISOString());
      };
      let status: number | null = null;
      try {
        const req = buildPushRequest({ endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } }, body, keys, { subject: this.env.subject, ttlSec: opts.ttlSec ?? 4 * 3600, urgency: opts.urgency ?? 'normal', topic: tagTopic(payload.tag) });
        const res = await this.fetchImpl(req.url, { ...req.init, body: new Uint8Array(req.init.body), signal: AbortSignal.timeout(15_000) });
        status = res.status;
        await res.body?.cancel().catch(() => undefined);
      } catch (e) {
        this.db.prepare('UPDATE push_subs SET last_error = ? WHERE endpoint = ?').run(`unreachable (${(e as Error).name})`, d.endpoint);
        record(attempts >= MAX_ATTEMPTS ? 'failed' : 'retry');
        out.failed++;
        continue;
      }
      const r = pushResult(status);
      if (r === 'ok') {
        this.db.prepare('UPDATE push_subs SET last_ok_at = ?, last_error = NULL WHERE endpoint = ?').run(this.now().toISOString(), d.endpoint);
        record('sent');
        out.sent++;
      } else if (r === 'gone') {
        // the browser dropped the subscription (uninstalled, permission revoked): forget it
        this.unsubscribe(d.endpoint);
        out.gone++;
      } else {
        this.db.prepare('UPDATE push_subs SET last_error = ? WHERE endpoint = ?').run(`answered ${status}`, d.endpoint);
        record(r === 'retry' && attempts < MAX_ATTEMPTS ? 'retry' : 'failed');
        out.failed++;
      }
    }
    return out;
  }
}

/** A tag as a push Topic (≤ 32 base64url characters), so a newer push replaces a waiting one. */
function tagTopic(tag: string | undefined): string | undefined {
  if (!tag) return undefined;
  const t = Buffer.from(tag).toString('base64url').slice(-32);
  return t || undefined;
}
