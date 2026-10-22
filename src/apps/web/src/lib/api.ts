/**
 * The API client. Every URL is relative to the app's base (`/lifeos/`), so the app works on the
 * tailnet path and on http://127.0.0.1:8480/lifeos/ alike (ADR-9). Writes carry the app header and
 * an idempotency key; a 401 asks the shell to show the passphrase screen.
 */
export const BASE = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export class NetworkError extends Error {}

export function url(path: string): string {
  return BASE + path.replace(/^\/+/, '');
}

/**
 * The address this page opened LifeOS at (origin and base path, `https://nas.example.ts.net/lifeos`):
 * sent when the passphrase is set or on a sign-in, so reminder links and the Hermes prompt use the
 * address the owner really opens (ADR-104), not one the server would guess from its own headers.
 */
export function appAddress(): string {
  return location.origin + BASE.replace(/\/+$/, '');
}

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  json?: unknown;
  idem?: string;
  signal?: AbortSignal;
}

export async function api<T>(path: string, o: ApiOptions = {}): Promise<T> {
  return (await request<T>(path, o)).body;
}

/** A GET, with the response text as well (the cache compares it to skip unchanged data). */
export function apiGet<T>(path: string): Promise<{ body: T; text: string }> {
  return request<T>(path, {});
}

async function request<T>(path: string, o: ApiOptions): Promise<{ body: T; text: string }> {
  const method = o.method ?? (o.json === undefined ? 'GET' : 'POST');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') headers['X-LifeOS'] = '1';
  if (o.json !== undefined) headers['Content-Type'] = 'application/json';
  if (o.idem) headers['Idempotency-Key'] = o.idem;
  let res: Response;
  try {
    res = await fetch(url(path), { method, headers, body: o.json === undefined ? undefined : JSON.stringify(o.json), credentials: 'same-origin', signal: o.signal, cache: 'no-store' });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new NetworkError('offline');
  }
  // the service worker answers for an unreachable server with 503 (offline)
  if (res.status === 503 && res.headers.get('x-lifeos-offline') === '1') throw new NetworkError('offline');
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const b = (body ?? {}) as { error?: string; message?: string };
    if (res.status === 401) window.dispatchEvent(new CustomEvent('lifeos:signed-out'));
    if (res.status >= 502 && res.status <= 504) throw new NetworkError('server unreachable');
    throw new ApiError(res.status, b.error ?? 'error', b.message ?? `Request failed (${res.status})`);
  }
  return { body: body as T, text };
}

export function uuid(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
