/**
 * The integration token (product brief 9 §1, ADR-85): a second credential next to the passphrase,
 * for the owner's agent (Hermes). Created in Settings → Hermes and shown once; only its SHA-256 is
 * kept (like a session, ADR-11: 32 random bytes need no slow hash). One token at a time: a new one
 * replaces the old. It opens `/api/integration/*` and nothing else, at most 60 calls a minute; a
 * client that keeps presenting a wrong token is slowed down (the valid token never is: it is looked
 * up first, and the lookup of a 256-bit secret's hash costs nothing worth guessing against).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DB } from '../db.js';

/** Recognisable in a config file or a secret scanner; never part of the secret's strength. */
export const TOKEN_PREFIX = 'lifeos_it_';
export const CALLS_PER_MINUTE = 60;
/** wrong or missing tokens: per client in 10 minutes, and from everyone in an hour */
const BAD_PER_CLIENT = 20;
const BAD_ALL = 200;

export interface TokenRow {
  id: string;
  hash: string;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  last_model: string | null;
  last_reminders_at: string | null;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** A model name as Hermes reports it (`X-Hermes-Model`, a draft's `model`): printable, short. */
export function cleanModel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/[^\w .:/@+()-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return s || null;
}

export class IntegrationTokens {
  private calls = new Map<string, number[]>();
  private bad = new Map<string, number[]>();
  private badAll: number[] = [];

  constructor(private readonly db: DB) {}

  /** The token in force (its hash and when it was last used), or null. */
  active(): TokenRow | null {
    return (this.db.prepare('SELECT * FROM integration_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 1').get() as TokenRow | undefined) ?? null;
  }

  /** A new token (any earlier one stops working). The only time the token itself exists here. */
  create(now = new Date()): { token: string; row: TokenRow } {
    const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const id = randomUUID();
    this.db.transaction(() => {
      this.db.prepare('UPDATE integration_tokens SET revoked_at = ? WHERE revoked_at IS NULL').run(now.toISOString());
      this.db.prepare('INSERT INTO integration_tokens (id, hash, created_at) VALUES (?, ?, ?)').run(id, sha(token), now.toISOString());
    })();
    this.calls.clear();
    return { token, row: this.active()! };
  }

  /** Revoke the token in force; true when there was one. */
  revoke(now = new Date()): boolean {
    this.calls.clear();
    return this.db.prepare('UPDATE integration_tokens SET revoked_at = ? WHERE revoked_at IS NULL').run(now.toISOString()).changes > 0;
  }

  /** The row for a presented token, or null (wrong, revoked, or not a token at all). */
  check(token: string | undefined): TokenRow | null {
    if (!token || token.length > 200 || !token.startsWith(TOKEN_PREFIX)) return null;
    return (this.db.prepare('SELECT * FROM integration_tokens WHERE hash = ? AND revoked_at IS NULL').get(sha(token)) as TokenRow | undefined) ?? null;
  }

  /** Seconds to wait when this token has made 60 calls in the last minute, else null (the call counts). */
  limited(row: TokenRow, now = Date.now()): number | null {
    const recent = (this.calls.get(row.id) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= CALLS_PER_MINUTE) {
      this.calls.set(row.id, recent);
      return Math.max(1, Math.ceil((recent[0] + 60_000 - now) / 1000));
    }
    recent.push(now);
    this.calls.set(row.id, recent);
    return null;
  }

  /** Seconds a client must wait after too many wrong tokens, else null. */
  refusedFor(client: string, now = Date.now()): number | null {
    const mine = (this.bad.get(client) ?? []).filter((t) => now - t < 10 * 60_000);
    this.bad.set(client, mine);
    this.badAll = this.badAll.filter((t) => now - t < 60 * 60_000);
    if (mine.length >= BAD_PER_CLIENT) return Math.ceil((mine[0] + 10 * 60_000 - now) / 1000);
    if (this.badAll.length >= BAD_ALL) return Math.ceil((this.badAll[0] + 60 * 60_000 - now) / 1000);
    return null;
  }

  failed(client: string, now = Date.now()): void {
    this.bad.set(client, [...(this.bad.get(client) ?? []), now]);
    this.badAll.push(now);
    // many senders (or forged addresses): forget the ones whose attempts have all expired
    if (this.bad.size > 500) for (const [k, ts] of this.bad) if (!ts.some((t) => now - t < 10 * 60_000)) this.bad.delete(k);
  }

  /** A call was made with the token (the status line's "last call"), and the model Hermes named. */
  touch(row: TokenRow, model: string | null, now = new Date()): void {
    const last = row.last_used_at ? Date.parse(row.last_used_at) : 0;
    if (model && model !== row.last_model) this.db.prepare('UPDATE integration_tokens SET last_model = ? WHERE id = ?').run(model, row.id);
    // at most one write in 10 s for the time itself
    if (now.getTime() - last > 10_000) this.db.prepare('UPDATE integration_tokens SET last_used_at = ? WHERE id = ?').run(now.toISOString(), row.id);
  }

  /** Hermes asked for reminders (Settings → Reminders: "Hermes sends them"). */
  touchReminders(row: TokenRow, now = new Date()): void {
    const last = row.last_reminders_at ? Date.parse(row.last_reminders_at) : 0;
    if (now.getTime() - last > 10_000) this.db.prepare('UPDATE integration_tokens SET last_reminders_at = ? WHERE id = ?').run(now.toISOString(), row.id);
  }
}
