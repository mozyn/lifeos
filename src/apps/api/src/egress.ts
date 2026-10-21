/**
 * Outbound HTTP (spec §3 "Privacy (absolute)"), copied in spirit from Work OS `egress.ts`.
 *
 * One allowlisted fetch wrapper: each purpose may reach only its own hosts —
 *   ai             the model endpoint chosen for this install, and only that one (ADR-75, ADR-81);
 *                  nothing while AI is off
 *   search         lifeos-searxng:8080          (user-triggered web search)
 *   telegram       api.telegram.org:443         (reminder delivery, when a bot is configured)
 *   prayer-verify  api.aladhan.com:443          (only for the opted-in, user-triggered check, §10)
 *   push           the push endpoints of the browsers that subscribed to reminders (ADR-80)
 * Anything else is refused before a connection is made, and logged. Every call (allowed or not) is
 * appended to the outbound log with host, purpose, method, bytes and timing — never the body,
 * never the query string.
 *
 * Defense in depth: the socket guard (from Work OS) refuses any TCP connection from this process
 * to a host that is not on the list, whatever library opened it.
 */
import net from 'node:net';
import type { DB } from './db.js';

export type Purpose = 'ai' | 'search' | 'telegram' | 'prayer-verify' | 'push';

/** The purposes whose host never changes. */
export const ALLOWLIST: Record<'search' | 'telegram' | 'prayer-verify', string> = {
  search: 'lifeos-searxng:8080',
  telegram: 'api.telegram.org:443',
  'prayer-verify': 'api.aladhan.com:443',
};

/** The fixed hosts the API may reach in normal operation (spec §3) — Aladhan is added only per call. */
export const STANDING_HOSTS = [ALLOWLIST.search, ALLOWLIST.telegram];

export class EgressRefused extends Error {
  code = 'EGRESS_REFUSED';
  constructor(public target: string) {
    super(`outbound request to ${target} refused: not on the allowlist`);
  }
}

export interface OutboundRow {
  at: string;
  host: string;
  purpose: string;
  method: string;
  bytes_out: number;
  bytes_in: number;
  status: number | null;
  ok: number;
  ms: number;
  refused: number;
}

export function hostPort(url: string): string {
  const u = new URL(url);
  const port = u.port || (u.protocol === 'https:' ? '443' : u.protocol === 'http:' ? '80' : '');
  return `${u.hostname.toLowerCase()}:${port}`;
}

export interface EgressOptions {
  /** extra host:port per purpose (tests only: a mock model server on 127.0.0.1) */
  extra?: Partial<Record<Purpose, string[]>>;
  /** in-memory log when there is no database (scripts) */
  memoryLog?: OutboundRow[];
}

export class Egress {
  private aladhanOpen = 0;
  /** the hosts that follow the settings: the model endpoint, the push services */
  private dynamic: Partial<Record<Purpose, () => string[]>> = {};

  constructor(
    private readonly db: DB | null,
    private readonly opts: EgressOptions = {},
  ) {}

  /** The current host:port list for a purpose that follows the settings (`ai`, `push`). */
  follow(purpose: 'ai' | 'push', hosts: () => string[]): void {
    this.dynamic[purpose] = hosts;
  }

  allowedFor(purpose: Purpose): string[] {
    const fixed = purpose in ALLOWLIST ? [ALLOWLIST[purpose as keyof typeof ALLOWLIST]] : [];
    return [...fixed, ...this.followed(purpose), ...(this.opts.extra?.[purpose] ?? [])];
  }

  private followed(purpose: Purpose): string[] {
    try {
      return (this.dynamic[purpose]?.() ?? []).map((h) => h.toLowerCase());
    } catch {
      return [];
    }
  }

  /** Is a host:port allowed right now for anything? (the socket guard's question) */
  socketAllowed(host: string, port: number): boolean {
    const hp = `${host.toLowerCase()}:${port}`;
    if (STANDING_HOSTS.includes(hp)) return true;
    if (this.aladhanOpen > 0 && hp === ALLOWLIST['prayer-verify']) return true;
    if (this.followed('ai').includes(hp) || this.followed('push').includes(hp)) return true;
    return Object.values(this.opts.extra ?? {}).some((xs) => xs?.includes(hp));
  }

  private log(row: Omit<OutboundRow, 'at'>): void {
    const full: OutboundRow = { at: new Date().toISOString(), ...row };
    if (this.opts.memoryLog) this.opts.memoryLog.push(full);
    if (!this.db) return;
    try {
      this.db.prepare('INSERT INTO outbound_log (at, host, purpose, method, bytes_out, bytes_in, status, ok, ms, refused) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(full.at, full.host, full.purpose, full.method, full.bytes_out, full.bytes_in, full.status, full.ok, full.ms, full.refused);
      this.db.prepare('DELETE FROM outbound_log WHERE id <= (SELECT max(id) - 5000 FROM outbound_log)').run();
    } catch {
      /* the log must never break the call */
    }
  }

  /**
   * fetch() for one purpose. The response body is passed through a counter so bytes in are logged
   * when the caller finishes reading it (streams included).
   */
  async fetch(url: string, init: RequestInit & { purpose: Purpose }): Promise<Response> {
    const { purpose, ...rest } = init;
    const method = (rest.method ?? 'GET').toUpperCase();
    let target: string;
    try {
      target = hostPort(url);
    } catch {
      this.log({ host: 'invalid-url', purpose, method, bytes_out: 0, bytes_in: 0, status: null, ok: 0, ms: 0, refused: 1 });
      throw new EgressRefused('an invalid URL');
    }
    if (!this.allowedFor(purpose).includes(target)) {
      this.log({ host: target, purpose, method, bytes_out: 0, bytes_in: 0, status: null, ok: 0, ms: 0, refused: 1 });
      throw new EgressRefused(target);
    }
    const bytesOut = bodyBytes(rest.body);
    const started = Date.now();
    if (purpose === 'prayer-verify') this.aladhanOpen++;
    let res: Response;
    try {
      res = await fetch(url, rest);
    } catch (e) {
      if (purpose === 'prayer-verify') this.aladhanOpen--;
      this.log({ host: target, purpose, method, bytes_out: bytesOut, bytes_in: 0, status: null, ok: 0, ms: Date.now() - started, refused: 0 });
      throw e;
    }
    if (!res.body) {
      if (purpose === 'prayer-verify') this.aladhanOpen--;
      this.log({ host: target, purpose, method, bytes_out: bytesOut, bytes_in: 0, status: res.status, ok: res.ok ? 1 : 0, ms: Date.now() - started, refused: 0 });
      return res;
    }
    let bytesIn = 0;
    let logged = false;
    const finish = () => {
      if (logged) return;
      logged = true;
      if (purpose === 'prayer-verify') this.aladhanOpen--;
      this.log({ host: target, purpose, method, bytes_out: bytesOut, bytes_in: bytesIn, status: res.status, ok: res.ok ? 1 : 0, ms: Date.now() - started, refused: 0 });
    };
    const counted = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, ctl) {
          bytesIn += chunk.byteLength;
          ctl.enqueue(chunk);
        },
        flush() {
          finish();
        },
      }),
    );
    const out = new Response(counted, { status: res.status, statusText: res.statusText, headers: res.headers });
    // a body the caller never reads is still logged
    setTimeout(finish, 180_000).unref?.();
    return out;
  }
}

function bodyBytes(body: unknown): number {
  if (body == null) return 0;
  if (typeof body === 'string') return Buffer.byteLength(body);
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (body instanceof URLSearchParams) return Buffer.byteLength(body.toString());
  return 0;
}

// ------------------------------------------------------------------ socket guard (Work OS egress.ts)

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1']);
let installed = false;
let guardEgress: Egress | null = null;

/** Refuse any TCP connection to a host the egress policy does not allow (loopback excepted). */
export function installSocketGuard(egress: Egress): void {
  guardEgress = egress;
  if (installed) return;
  installed = true;
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guarded(this: net.Socket, ...args: unknown[]) {
    const t = targetOf(args);
    if (t && !LOOPBACK.has(t.host.toLowerCase()) && guardEgress && !guardEgress.socketAllowed(t.host, t.port)) {
      const err = Object.assign(new Error(`outbound connection to ${t.host}:${t.port} refused by the LifeOS egress guard`), { code: 'EGRESS_REFUSED' });
      process.nextTick(() => this.destroy(err));
      return this;
    }
    return original.apply(this, args as Parameters<typeof original>);
  } as typeof original;
}

function targetOf(args: unknown[]): { host: string; port: number } | null {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  if (first && typeof first === 'object') {
    const o = first as { host?: string; port?: number | string; path?: string };
    if (o.path) return null;
    return { host: String(o.host ?? 'localhost'), port: Number(o.port ?? 0) };
  }
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: Number(first) };
  }
  return null;
}
