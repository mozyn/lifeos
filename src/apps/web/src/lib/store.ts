/**
 * Data on the device (spec §12, copied in spirit from the Work OS outbox pattern):
 *  - every GET is cached in IndexedDB (Dexie), so the app opens offline with the last view;
 *  - every write goes through a durable outbox with an idempotency key (the op id). It is sent at
 *    once when online, replayed in order on reconnect, and the server answers a replay with the
 *    first result, so a write lands in the vault once. A 4xx (the vault line changed) is a conflict:
 *    the op is dropped and the change is shown to the user, never silently forced.
 *  - pending writes are overlaid on cached data, so the UI shows what was done while offline.
 */
import Dexie, { type Table } from 'dexie';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api, ApiError, apiGet, NetworkError, url, uuid } from './api';
import { afterSlide } from './panes';

export interface OutboxOp {
  id: string;
  seq: number;
  method: 'POST' | 'PATCH' | 'PUT';
  path: string;
  body: unknown;
  kind: string;
  ref?: string;
  label: string;
  status: 'pending' | 'sending';
  attempts: number;
  createdAt: number;
}

class LifeDB extends Dexie {
  cache!: Table<{ key: string; value: unknown; at: number }, string>;
  outbox!: Table<OutboxOp, string>;
  constructor() {
    super('lifeos');
    this.version(1).stores({ cache: 'key', outbox: 'id, seq, status' });
  }
}

export const db = new LifeDB();

// ------------------------------------------------------------------ tiny event bus

type Fn = () => void;
const bus = new Map<string, Set<Fn>>();
export function on(evt: string, fn: Fn): () => void {
  if (!bus.has(evt)) bus.set(evt, new Set());
  bus.get(evt)!.add(fn);
  return () => bus.get(evt)!.delete(fn);
}
export function emit(evt: string): void {
  for (const fn of [...(bus.get(evt) ?? [])]) fn();
}

// ------------------------------------------------------------------ toasts

export interface Toast {
  id: string;
  text: string;
  tone?: 'error' | 'info';
  /** one action (Undo), shown as a button in the toast */
  action?: { label: string; run: () => void };
}
let toasts: Toast[] = [];
export function toast(text: string, tone: Toast['tone'] = 'info', action?: Toast['action']): void {
  const t = { id: uuid(), text, tone, action };
  toasts = [...toasts, t].slice(-3);
  emit('toasts');
  // an Undo stays 6 s (round-2 brief §12)
  setTimeout(() => dismissToast(t.id), tone === 'error' ? 7000 : action ? 6000 : 3500);
}
export function dismissToast(id: string): void {
  toasts = toasts.filter((t) => t.id !== id);
  emit('toasts');
}
export function useToasts(): Toast[] {
  return useSyncExternalStore((cb) => on('toasts', cb), () => toasts);
}

// ------------------------------------------------------------------ connectivity

let online = typeof navigator === 'undefined' ? true : navigator.onLine;
export function useOnline(): boolean {
  return useSyncExternalStore(
    (cb) => on('online', cb),
    () => online,
  );
}
function setOnline(v: boolean) {
  if (online === v) return;
  online = v;
  emit('online');
}

// ------------------------------------------------------------------ the outbox

let pending: OutboxOp[] = [];
let seq = 0;
const waiters = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

async function refreshPending() {
  pending = await db.outbox.orderBy('seq').toArray();
  emit('outbox');
}

export function pendingOps(): OutboxOp[] {
  return pending;
}

export function usePending(): OutboxOp[] {
  return useSyncExternalStore((cb) => on('outbox', cb), () => pending);
}

export interface WriteResult<T> {
  queued: boolean;
  result?: T;
}

/** Queue a write; resolves with the server's answer, or `{ queued: true }` when offline. */
export async function write<T = unknown>(op: { method?: OutboxOp['method']; path: string; body?: unknown; kind: string; ref?: string; label: string }): Promise<WriteResult<T>> {
  const full: OutboxOp = { id: uuid(), seq: Date.now() * 1000 + (seq++ % 1000), method: op.method ?? 'POST', path: op.path, body: op.body ?? {}, kind: op.kind, ref: op.ref, label: op.label, status: 'pending', attempts: 0, createdAt: Date.now() };
  await db.outbox.put(full);
  await refreshPending();
  return new Promise<WriteResult<T>>((resolve, reject) => {
    // offline: the op stays queued and the caller carries on with the optimistic view; a later
    // refusal of it is shown as a toast (no caller is waiting any more)
    const off = on('offline-queued', () => {
      off();
      waiters.delete(full.id);
      resolve({ queued: true });
    });
    waiters.set(full.id, {
      resolve: (r) => {
        off();
        resolve({ queued: false, result: r as T });
      },
      reject: (e) => {
        off();
        reject(e);
      },
    });
    void flush();
  });
}

let flushing = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let failures = 0;

export async function flush(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    for (;;) {
      const op = await db.outbox.orderBy('seq').first();
      if (!op) break;
      await db.outbox.update(op.id, { status: 'sending', attempts: op.attempts + 1 });
      try {
        const res = await api(op.path, { method: op.method, json: op.body, idem: op.id });
        await db.outbox.delete(op.id);
        failures = 0;
        setOnline(true);
        waiters.get(op.id)?.resolve(res);
        waiters.delete(op.id);
        emit('synced');
      } catch (e) {
        if (e instanceof NetworkError) {
          await db.outbox.update(op.id, { status: 'pending' });
          setOnline(false);
          emit('offline-queued');
          failures++;
          if (retryTimer) clearTimeout(retryTimer);
          retryTimer = setTimeout(() => void flush(), Math.min(60_000, 2000 * 2 ** Math.min(failures, 5)));
          break;
        }
        // a refusal is final: the vault changed under this write, or it was invalid
        await db.outbox.delete(op.id);
        const msg = e instanceof ApiError ? e.message : 'The change could not be saved.';
        if (!waiters.has(op.id)) toast(`${op.label}: ${msg}`, 'error');
        waiters.get(op.id)?.reject(e);
        waiters.delete(op.id);
        emit('synced');
      }
    }
  } finally {
    flushing = false;
    await refreshPending();
  }
}

export function startSync(): void {
  void db.outbox
    .where('status')
    .equals('sending')
    .modify({ status: 'pending' })
    .then(refreshPending)
    .then(flush);
  window.addEventListener('online', () => {
    setOnline(true);
    void flush();
  });
  window.addEventListener('offline', () => setOnline(false));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void flush();
  });
  openEvents();
}

// ------------------------------------------------------------------ live vault changes (SSE)

let es: EventSource | null = null;
function openEvents() {
  if (es || typeof EventSource === 'undefined') return;
  try {
    es = new EventSource(url('api/events'), { withCredentials: true });
  } catch {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  es.addEventListener('vault', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => emit('vault'), 150);
  });
  es.addEventListener('hello', () => setOnline(true));
  es.onerror = () => {
    // the browser reconnects by itself; a closed stream (signed out) is reopened on sign-in
    if (es?.readyState === EventSource.CLOSED) es = null;
  };
}
export function reopenEvents(): void {
  es?.close();
  es = null;
  openEvents();
}

// ------------------------------------------------------------------ cached reads

/**
 * The last answer for each GET, in memory (UI brief 3): a screen mounted in a hidden pane renders
 * at once from here, with no IndexedDB round trip and no skeleton; `text` lets a refresh that
 * brings the same JSON skip the re-render.
 */
const mem = new Map<string, { data: unknown; text: string; at: number; stale: boolean }>();
const inflight = new Map<string, Promise<{ data: unknown; text: string; stale: boolean }>>();
const MEM_MAX = 120;

export function cached<T>(path: string): { data: T; stale: boolean; at: number } | null {
  const hit = mem.get(path);
  return hit ? { data: hit.data as T, stale: hit.stale, at: hit.at } : null;
}

async function fetchShared(path: string): Promise<{ data: unknown; text: string; stale: boolean }> {
  const running = inflight.get(path);
  if (running) return running;
  const p = (async () => {
    try {
      const { body, text } = await apiGet<unknown>(path);
      setOnline(true);
      const prev = mem.get(path);
      // the same JSON as before keeps the same object: nothing downstream re-renders
      const data = prev && prev.text === text ? prev.data : body;
      mem.delete(path);
      mem.set(path, { data, text, at: Date.now(), stale: false });
      // the most recent answers only (search-as-you-type paths would otherwise pile up)
      if (mem.size > MEM_MAX) mem.delete(mem.keys().next().value!);
      if (!prev || prev.text !== text) void db.cache.put({ key: path, value: body, at: Date.now() });
      return { data, text, stale: false };
    } catch (e) {
      if (!(e instanceof NetworkError)) throw e;
      setOnline(false);
      const hit = mem.get(path) ?? (await db.cache.get(path).then((h) => (h ? { data: h.value, text: '', at: h.at, stale: true } : undefined)));
      if (hit) return { data: hit.data, text: hit.text, stale: true };
      throw e;
    } finally {
      inflight.delete(path);
    }
  })();
  inflight.set(path, p);
  return p;
}

export async function load<T>(path: string): Promise<{ data: T; stale: boolean }> {
  const r = await fetchShared(path);
  return { data: r.data as T, stale: r.stale };
}

/** Fetch these GETs into memory now (app load: every screen's first data, from the index). */
export function prefetch(paths: string[]): Promise<void> {
  return Promise.allSettled(paths.map((p) => fetchShared(p))).then(() => undefined);
}

export interface Resource<T> {
  data: T | null;
  error: Error | null;
  stale: boolean;
  loading: boolean;
  reload: () => Promise<void>;
}

type ResState<T> = { data: T | null; error: Error | null; stale: boolean; loading: boolean };

function initial<T>(path: string | null): ResState<T> {
  const hit = path ? mem.get(path) : undefined;
  return hit ? { data: hit.data as T, error: null, stale: hit.stale, loading: false } : { data: null, error: null, stale: false, loading: true };
}

/** A data change that would re-render a screen waits for a running slide to end (UI brief 3 §4). */
function deliver(fn: () => void): void {
  afterSlide(fn);
}

/**
 * A cached GET that refreshes when the vault changes, when writes land, and on focus. A screen in
 * a hidden pane keeps its subscription (it stays current while hidden); answers that change
 * nothing do not re-render, and answers that do wait until no slide is running.
 */
export function useResource<T>(path: string | null): Resource<T> {
  const [state, setState] = useState<ResState<T>>(() => initial<T>(path));
  const cur = useRef(path);
  cur.current = path;
  const reload = useCallback(async () => {
    const p = cur.current;
    if (!p) return;
    try {
      const r = await load<T>(p);
      if (cur.current !== p) return;
      deliver(() => {
        if (cur.current !== p) return;
        setState((s) => (s.data === r.data && s.stale === r.stale && !s.error && !s.loading ? s : { data: r.data, error: null, stale: r.stale, loading: false }));
      });
    } catch (e) {
      if (cur.current === p) deliver(() => cur.current === p && setState((s) => ({ ...s, error: e as Error, loading: false })));
    }
  }, []);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    const hit = mem.get(path);
    if (hit) {
      setState((s) => (s.data === hit.data ? s : { data: hit.data as T, error: null, stale: hit.stale, loading: false }));
    } else {
      setState((s) => (s.loading ? s : { ...s, loading: true }));
      // the copy on the device first (instant first paint offline), then the network
      void db.cache.get(path).then((h) => {
        if (alive && h && cur.current === path && !mem.has(path)) setState((s) => (s.data ? s : { data: h.value as T, error: null, stale: true, loading: true }));
      });
    }
    // a prefetched answer from the last few seconds is current: no second request on mount
    if (!hit || Date.now() - hit.at > 5000) void reload();
    const offs = [on('vault', () => void reload()), on('synced', () => void reload()), on('online', () => online && void reload())];
    const onFocus = () => document.visibilityState === 'visible' && void reload();
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      alive = false;
      offs.forEach((f) => f());
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [path, reload]);
  return { ...state, reload };
}
