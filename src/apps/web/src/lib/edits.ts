/**
 * Edit in place (round-2 brief §12): delete, archive, move and their Undo, shared by every row.
 * A delete or an archive leaves the screen at once (the `gone` overlay, until the next answer from
 * the server no longer has it) and shows a 6 s toast whose Undo puts back exactly what was removed;
 * what Undo missed waits 30 days in Settings → Advanced → Data → Recently deleted.
 */
import { useSyncExternalStore } from 'react';
import { shortDateDow } from '@lifeos/shared';
import { ApiError } from './api';
import { emit, on, pendingOps, toast, write } from './store';

export type LineKind = 'task' | 'item' | 'link' | 'event';
export interface LineRef {
  path: string;
  line: number;
  hash: string;
}

export const anchorOf = (r: LineRef): LineRef => ({ path: r.path, line: r.line, hash: r.hash });
export const errText = (e: unknown, fallback = 'That change could not be saved.') => (e instanceof ApiError ? e.message : fallback);

// ------------------------------------------------------------------ rows that just left

/**
 * Rows removed on this device, hidden until the server's next answers no longer have them: a key
 * stays while its write is on its way (offline: until the outbox has sent it), then a few seconds
 * more for the lists to reload, and is then forgotten (a row's id comes from its text, so the same
 * words added again later must show).
 */
const gone = new Map<string, number>();
let goneView: ReadonlySet<string> = new Set();
let sweepTimer: ReturnType<typeof setTimeout> | null = null;
function publish() {
  goneView = new Set(gone.keys());
  emit('gone');
}
function sweep() {
  sweepTimer = null;
  const now = Date.now();
  let next = Infinity;
  for (const [k, until] of gone) {
    if (until <= now) gone.delete(k);
    else next = Math.min(next, until);
  }
  publish();
  if (Number.isFinite(next)) sweepTimer = setTimeout(sweep, next - now + 20);
}
export function hide(keys: string[]): void {
  for (const k of keys) gone.set(k, Infinity);
  publish();
}
/** The write landed: the lists reload now; forget the keys a little later. */
function settle(keys: string[]): void {
  const until = Date.now() + 4000;
  for (const k of keys) if (gone.has(k)) gone.set(k, until);
  if (!sweepTimer) sweepTimer = setTimeout(sweep, 4020);
}
export function unhide(keys: string[]): void {
  for (const k of keys) gone.delete(k);
  publish();
}
export function useGone(): ReadonlySet<string> {
  return useSyncExternalStore((cb) => on('gone', cb), () => goneView);
}
// writes queued offline: once the outbox is empty they have all landed
on('synced', () => {
  if (!pendingOps().length) settle([...gone.keys()].filter((k) => gone.get(k) === Infinity));
});

// ------------------------------------------------------------------ lines

const undoLines = async (ids: string[], keys: string[], what: string) => {
  try {
    await write({ path: 'api/lines/restore', body: { ids }, kind: 'restore', label: `Undo ${what}` });
    unhide(keys);
    toast('Put back');
  } catch (e) {
    toast(errText(e, 'Not put back.'), 'error');
  }
};

/** Delete lines (each with the lines under it); one toast, one Undo for all of them. */
export async function deleteLines(items: { ref: LineRef; kind: LineKind; key: string; label: string }[]): Promise<void> {
  if (!items.length) return;
  const keys = items.map((i) => i.key);
  hide(keys);
  const what = items.length === 1 ? `“${items[0].label}”` : `${items.length} items`;
  try {
    let ids: string[] = [];
    let failed = 0;
    let queued = false;
    if (items.length === 1) {
      const r = await write<{ id: string }>({ path: 'api/lines/delete', body: { ...anchorOf(items[0].ref), kind: items[0].kind }, kind: 'delete', ref: items[0].key, label: `Delete ${what}` });
      if (r.result?.id) ids = [r.result.id];
      queued = r.queued;
    } else {
      const r = await write<{ undo: string[]; failed: unknown[] }>({ path: 'api/bulk', body: { op: 'delete', items: items.map((i) => ({ ...anchorOf(i.ref), kind: i.kind })) }, kind: 'bulk', label: `Delete ${what}` });
      ids = r.result?.undo ?? [];
      failed = r.result?.failed.length ?? 0;
      queued = r.queued;
    }
    // offline: hidden until the outbox has sent it (the 'synced' listener above)
    if (!queued) settle(keys);
    if (failed) toast(`${failed} could not be deleted: they changed in the vault. The view has been refreshed.`, 'error');
    toast(`Deleted ${what}`, 'info', ids.length ? { label: 'Undo', run: () => void undoLines(ids, keys, what) } : undefined);
  } catch (e) {
    unhide(keys);
    toast(errText(e, 'Not deleted.'), 'error');
  }
}

// ------------------------------------------------------------------ notes, goals, projects, habits

/** Archive (a note's Delete): to Archive/… with status archived; Undo brings it back as it was. */
export async function archivePaths(items: { path: string; label: string; key?: string }[], opts: { route?: string } = {}): Promise<void> {
  if (!items.length) return;
  const keys = items.map((i) => i.key ?? i.path);
  hide(keys);
  const what = items.length === 1 ? `“${items[0].label}”` : `${items.length} notes`;
  try {
    let archived: string[] = [];
    let queued = false;
    if (items.length === 1) {
      const r = await write<{ path: string }>({ path: opts.route ?? 'api/archive', body: { path: items[0].path }, kind: 'archive', ref: keys[0], label: `Archive ${what}` });
      if (r.result?.path) archived = [r.result.path];
      queued = r.queued;
    } else {
      const r = await write<{ archived: string[] }>({ path: 'api/bulk', body: { op: 'archive', paths: items.map((i) => i.path) }, kind: 'bulk', label: `Archive ${what}` });
      archived = r.result?.archived ?? [];
      queued = r.queued;
    }
    if (!queued) settle(keys);
    toast(`Archived ${what}`, 'info', archived.length ? { label: 'Undo', run: () => void restoreArchived(archived, keys, opts.route === 'api/habits/archive' ? 'api/habits/restore' : 'api/archive/restore') } : undefined);
  } catch (e) {
    unhide(keys);
    toast(errText(e, 'Not archived.'), 'error');
  }
}

async function restoreArchived(paths: string[], keys: string[], route: string) {
  try {
    for (const p of paths) await write({ path: route, body: { path: p }, kind: 'restore', label: 'Undo archive' });
    unhide(keys);
    toast('Put back');
  } catch (e) {
    toast(errText(e, 'Not put back.'), 'error');
  }
}

// ------------------------------------------------------------------ moves

export async function moveTasks(items: { ref: LineRef; id: string; label: string }[], to: { date?: string; slug?: string; title?: string }): Promise<boolean> {
  const where = to.date ? shortDateDow(to.date) : (to.title ?? `@${to.slug}`);
  try {
    if (items.length === 1) await write({ path: `api/tasks/${items[0].id}/move`, body: { ...anchorOf(items[0].ref), ...to, title: undefined }, kind: 'move', ref: items[0].id, label: `Move “${items[0].label}”` });
    else await write({ path: 'api/bulk', body: { op: 'move', items: items.map((i) => ({ ...anchorOf(i.ref), kind: 'task' })), date: to.date, slug: to.slug }, kind: 'bulk', label: `Move ${items.length} tasks` });
    toast(items.length === 1 ? `Moved to ${where}` : `${items.length} tasks moved to ${where}`);
    return true;
  } catch (e) {
    toast(errText(e, 'Not moved.'), 'error');
    return false;
  }
}

export async function moveItems(items: { ref: LineRef; label: string }[], list: 'shopping' | 'wishlist'): Promise<boolean> {
  const name = list === 'shopping' ? 'Shopping' : 'the wishlist';
  try {
    if (items.length === 1) await write({ path: 'api/lists/items/move', body: { ...anchorOf(items[0].ref), to: list }, kind: 'move', label: `Move “${items[0].label}”` });
    else await write({ path: 'api/bulk', body: { op: 'move', list, items: items.map((i) => ({ ...anchorOf(i.ref), kind: 'item' })) }, kind: 'bulk', label: `Move ${items.length} items` });
    toast(items.length === 1 ? `Moved to ${name}` : `${items.length} items moved to ${name}`);
    return true;
  } catch (e) {
    toast(errText(e, 'Not moved.'), 'error');
    return false;
  }
}

export type NoteFolder = 'Inbox' | 'Resources' | 'Areas' | 'Projects';
export const NOTE_FOLDERS: NoteFolder[] = ['Inbox', 'Resources', 'Areas', 'Projects'];

export async function moveNotes(paths: string[], folder: NoteFolder): Promise<boolean> {
  try {
    if (paths.length === 1) await write({ path: 'api/notes/move', body: { path: paths[0], folder }, kind: 'move', label: 'Move note' });
    else await write({ path: 'api/bulk', body: { op: 'move', paths, folder }, kind: 'bulk', label: `Move ${paths.length} notes` });
    toast(paths.length === 1 ? `Moved to ${folder}` : `${paths.length} notes moved to ${folder}`);
    return true;
  } catch (e) {
    toast(errText(e, 'Not moved.'), 'error');
    return false;
  }
}

export async function completeMany(items: { ref: LineRef; kind: 'task' | 'item' }[]): Promise<void> {
  try {
    const r = await write<{ done: number; failed: unknown[] }>({ path: 'api/bulk', body: { op: 'complete', items: items.map((i) => ({ ...anchorOf(i.ref), kind: i.kind })) }, kind: 'bulk', label: `Complete ${items.length}` });
    const n = r.result?.done ?? items.length;
    toast(`${n} done`);
    if (r.result?.failed.length) toast(`${r.result.failed.length} could not be completed: they changed in the vault.`, 'error');
  } catch (e) {
    toast(errText(e), 'error');
  }
}
