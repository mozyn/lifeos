/**
 * One passphrase (spec §12, ADR-11). First run: no `.env.auth` → the app asks for a passphrase once
 * and this module writes `LIFEOS_AUTH_HASH=<argon2id>` to it (mode 600, created with link(2) so a
 * second setup can never overwrite the first). There are no default credentials.
 * Sessions: 32 random bytes in an HttpOnly, SameSite=Strict cookie scoped to /lifeos for 90 days;
 * only their SHA-256 is stored. Logins are rate-limited per client and globally.
 */
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import type { DB } from './db.js';

export const COOKIE = 'lifeos_sid';
export const SESSION_DAYS = 90;
export const MIN_PASSPHRASE = 4;

const ARGON = { memoryCost: 65536, timeCost: 3, parallelism: 1, outputLen: 32 } as const;

export class AuthError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfter?: number,
  ) {
    super(message);
  }
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export class Auth {
  private cached: string | null | undefined;
  /** the passphrase file's modification time when it was read (deleting it resets the passphrase) */
  private cachedMtime = -1;
  private fails = new Map<string, number[]>();
  private globalFails: number[] = [];

  constructor(
    private readonly file: string,
    private readonly db: DB,
  ) {}

  /**
   * The stored hash, or null when the passphrase has not been set yet. Read again whenever the file
   * changes, so deleting it (the README's "forgot the passphrase") asks for a new one at once.
   */
  storedHash(): string | null {
    let mtime: number;
    try {
      mtime = statSync(this.file).mtimeMs;
    } catch {
      this.cached = null;
      this.cachedMtime = -1;
      return null;
    }
    if (this.cached && this.cachedMtime === mtime) return this.cached;
    try {
      const text = readFileSync(this.file, 'utf8');
      const m = /^LIFEOS_AUTH_HASH=(\$argon2id\$\S+)\s*$/m.exec(text);
      this.cached = m ? m[1] : null;
      this.cachedMtime = mtime;
    } catch {
      this.cached = null;
    }
    return this.cached;
  }

  needsSetup(): boolean {
    return this.storedHash() === null;
  }

  async setup(passphrase: string): Promise<void> {
    if (!this.needsSetup()) throw new AuthError(409, 'already_set', 'A passphrase is already set.');
    if (typeof passphrase !== 'string' || [...passphrase].length < MIN_PASSPHRASE) throw new AuthError(400, 'too_short', `Use at least ${MIN_PASSPHRASE} characters.`);
    if (passphrase.length > 512) throw new AuthError(400, 'too_long', 'That passphrase is too long.');
    const h = await argonHash(passphrase, ARGON);
    const body = `# LifeOS passphrase (argon2id). Written once by the first-run screen. Delete this file to set a new one.\nLIFEOS_AUTH_HASH=${h}\n`;
    const tmp = join(dirname(this.file), `.env.auth.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    const fh = await fs.open(tmp, 'wx', 0o600);
    try {
      await fh.writeFile(body);
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await fs.chmod(tmp, 0o600);
      await fs.link(tmp, this.file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new AuthError(409, 'already_set', 'A passphrase is already set.');
      throw e;
    } finally {
      await fs.unlink(tmp).catch(() => undefined);
    }
    this.cached = h;
    this.cachedMtime = -1;
    // a new passphrase signs every device out (the old one may be why it was reset)
    this.db.prepare('DELETE FROM sessions').run();
  }

  private limited(client: string): number | null {
    const now = Date.now();
    const recent = (this.fails.get(client) ?? []).filter((t) => now - t < 15 * 60_000);
    this.fails.set(client, recent);
    this.globalFails = this.globalFails.filter((t) => now - t < 60 * 60_000);
    if (recent.length >= 5) return Math.ceil((recent[0] + 15 * 60_000 - now) / 1000);
    if (this.globalFails.length >= 30) return Math.ceil((this.globalFails[0] + 60 * 60_000 - now) / 1000);
    return null;
  }

  async login(passphrase: string, client: string): Promise<{ token: string; expires: Date }> {
    const wait = this.limited(client);
    if (wait) throw new AuthError(429, 'rate_limited', 'Too many attempts. Try again later.', wait);
    const h = this.storedHash();
    if (!h) throw new AuthError(409, 'setup_needed', 'Set a passphrase first.');
    const ok = typeof passphrase === 'string' && passphrase.length <= 512 && (await argonVerify(h, passphrase).catch(() => false));
    if (!ok) {
      this.fails.set(client, [...(this.fails.get(client) ?? []), Date.now()]);
      this.globalFails.push(Date.now());
      throw new AuthError(401, 'wrong', 'That passphrase is not right.');
    }
    this.fails.delete(client);
    return this.createSession();
  }

  createSession(): { token: string; expires: Date } {
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const expires = new Date(now.getTime() + SESSION_DAYS * 86400_000);
    this.db.prepare('INSERT INTO sessions (id_hash, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?)').run(sha(token), now.toISOString(), expires.toISOString(), now.toISOString());
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now.toISOString());
    return { token, expires };
  }

  check(token: string | undefined): boolean {
    if (!token || token.length > 100) return false;
    const row = this.db.prepare('SELECT expires_at, last_seen FROM sessions WHERE id_hash = ?').get(sha(token)) as { expires_at: string; last_seen: string } | undefined;
    if (!row) return false;
    const now = Date.now();
    if (Date.parse(row.expires_at) < now) return false;
    if (now - Date.parse(row.last_seen) > 3600_000) this.db.prepare('UPDATE sessions SET last_seen = ? WHERE id_hash = ?').run(new Date(now).toISOString(), sha(token));
    return true;
  }

  revoke(token: string | undefined): void {
    if (token) this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha(token));
  }
}
