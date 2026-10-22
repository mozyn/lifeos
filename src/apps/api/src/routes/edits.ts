/**
 * Edit, move, delete, archive and undo in place (round-2 brief §12, ADR-59). Every write is
 * line-anchored (path + line + hash) or a whole-note change guarded by the note's SHA-1; a delete
 * answers with the id Undo and Settings → Advanced → Data → Recently deleted restore it by.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { joinPlace } from '@lifeos/shared';
import type { Ctx } from '../context.js';
import { HttpError } from '../http.js';
import { refusedText, rootsOf } from '../unwritable.js';
import { type LineKind, NOTE_FOLDERS, type NoteFolder } from '../vault/edit-ops.js';
import { Anchor } from './tasks.js';

const ISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const TAG = z.string().regex(/^[^\s#@]+$/).max(60);
const SLUG = z.string().regex(/^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u).max(120);
const KIND = z.enum(['task', 'item', 'link', 'event']);
const Path = z.string().min(1).max(400);

export function editRoutes(app: FastifyInstance, ctx: Ctx): void {
  const e = ctx.edits;

  // ---------------------------------------------------------------- lines: delete, undo, recently deleted

  app.post('/api/lines/delete', async (req) => {
    const b = Anchor.extend({ kind: KIND }).parse(req.body);
    const r = await e.deleteBlock({ path: b.path, line: b.line, hash: b.hash }, { kind: b.kind });
    return { ok: true, id: r.id, lines: r.lines.length };
  });

  /** Undo (one or several ids, put back last-deleted first so neighbours land where they were). */
  app.post('/api/lines/restore', async (req) => {
    const b = z.object({ ids: z.array(z.string().uuid()).min(1).max(200) }).parse(req.body);
    for (const id of [...b.ids].reverse()) await e.restore(id);
    return { ok: true };
  });

  app.get('/api/deleted', async () => ({ items: e.recentlyDeleted() }));

  // ---------------------------------------------------------------- tasks

  app.post('/api/tasks/:id/move', async (req) => {
    const b = Anchor.extend({ date: ISO.optional(), slug: SLUG.optional() })
      .refine((x) => !!x.date !== !!x.slug, 'Move to a day or to a goal or project.')
      .parse(req.body);
    const r = await e.moveTask({ path: b.path, line: b.line, hash: b.hash }, { date: b.date, slug: b.slug }, (d) => ctx.ops.dailyTemplate(d));
    return { ok: true, path: r.path };
  });

  // ---------------------------------------------------------------- links

  app.patch('/api/links', async (req) => {
    const b = Anchor.extend({ title: z.string().min(1).max(300), url: z.string().url().max(2000), tags: z.array(TAG).max(10).default([]), note: z.string().max(300).nullable().optional() }).parse(req.body);
    if (!/^https?:\/\//i.test(b.url)) throw new HttpError(400, 'bad_url', 'Only http and https links.');
    const r = await e.editLink({ path: b.path, line: b.line, hash: b.hash }, { title: b.title.replace(/\s+/g, ' ').trim(), url: b.url.trim(), tags: b.tags, note: b.note?.trim() || null });
    return { ok: true, line: r.line };
  });

  // ---------------------------------------------------------------- shopping and wishlist

  app.patch('/api/lists/items', async (req) => {
    const b = Anchor.extend({ text: z.string().min(1).max(300), price: z.string().max(20).nullable().optional(), url: z.string().url().max(2000).nullable().optional(), tags: z.array(TAG).max(10).optional() }).parse(req.body);
    if (b.price && !/^~?\$?\s?\d+(?:[.,]\d{1,2})?$/.test(b.price.trim())) throw new HttpError(400, 'bad_price', 'A price like 12 or 12.50.');
    const r = await e.editItem({ path: b.path, line: b.line, hash: b.hash }, { text: b.text, price: b.price, url: b.url, tags: b.tags });
    return { ok: true, line: r.line };
  });

  app.post('/api/lists/items/move', async (req) => {
    const b = Anchor.extend({ to: z.enum(['shopping', 'wishlist']) }).parse(req.body);
    return { ok: true, ...(await e.moveItem({ path: b.path, line: b.line, hash: b.hash }, b.to, ctx.today())) };
  });

  app.post('/api/lists/items/reorder', async (req) => {
    const b = Anchor.extend({ before: z.object({ line: z.number().int().min(0), hash: z.string().regex(/^[0-9a-f]{16}$/) }).nullable() }).parse(req.body);
    await e.reorderItem({ path: b.path, line: b.line, hash: b.hash }, b.before);
    return { ok: true };
  });

  /** A bought item back on the list. */
  app.post('/api/lists/items/unbuy', async (req) => {
    const b = Anchor.parse(req.body);
    await e.restoreBought(b);
    return { ok: true };
  });

  // ---------------------------------------------------------------- events

  app.patch('/api/events', async (req) => {
    const b = Anchor.extend({ from: ISO, date: ISO, time: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/).nullable(), text: z.string().min(1).max(300), place: z.string().max(120).nullable().optional() }).parse(req.body);
    const r = await e.editEvent({ path: b.path, line: b.line, hash: b.hash }, { from: b.from, date: b.date, time: b.time ? b.time.padStart(5, '0') : null, text: joinPlace(b.text, b.place) });
    return { ok: true, path: r.path };
  });

  // ---------------------------------------------------------------- notes

  app.get('/api/notes/edit', async (req) => {
    const { path } = z.object({ path: Path }).parse(req.query);
    return { path, ...(await e.readNote(path)) };
  });

  app.patch('/api/notes', async (req) => {
    const b = z.object({ path: Path, title: z.string().min(1).max(160).optional(), body: z.string().max(200_000).optional(), tags: z.array(TAG).max(20).optional(), sha: z.string().regex(/^[0-9a-f]{40}$/).optional() }).parse(req.body);
    const { path, ...edit } = b;
    return { ok: true, ...(await e.editNote(path, edit)) };
  });

  app.post('/api/notes/move', async (req) => {
    const b = z.object({ path: Path, folder: z.enum(NOTE_FOLDERS as [NoteFolder, ...NoteFolder[]]) }).parse(req.body);
    return { ok: true, ...(await e.moveNote(b.path, b.folder)) };
  });

  /** A note's Delete, a goal's or project's Archive: to Archive/… with status archived (never destroyed). */
  app.post('/api/archive', async (req) => {
    const b = z.object({ path: Path }).parse(req.body);
    return { ok: true, ...(await e.archive(b.path)) };
  });

  app.post('/api/archive/restore', async (req) => {
    const b = z.object({ path: Path }).parse(req.body);
    return { ok: true, ...(await e.restoreArchived(b.path)) };
  });

  app.get('/api/archive', async () => ({ items: e.archived() }));

  // ---------------------------------------------------------------- goals and projects

  app.patch('/api/goals', async (req) => {
    const b = z
      .object({
        path: Path,
        title: z.string().min(1).max(160).optional(),
        status: z.enum(['active', 'paused', 'done']).optional(),
        target: ISO.nullable().optional(),
        why: z.string().max(300).nullable().optional(),
      })
      .parse(req.body);
    const { path, ...edit } = b;
    await e.editGoal(path, edit);
    return { ok: true };
  });

  // ---------------------------------------------------------------- bulk (long-press select in every list)

  /**
   * Complete, delete, move or archive N things at once. Lines go bottom-up within each note so the
   * anchors of the ones still to do stay where they were; the answer carries the Undo ids (deletes)
   * or the archived paths, and what could not be done with why.
   */
  app.post('/api/bulk', async (req) => {
    const b = z
      .object({
        op: z.enum(['complete', 'delete', 'move', 'archive']),
        items: z.array(Anchor.extend({ kind: KIND })).max(200).default([]),
        paths: z.array(Path).max(200).default([]),
        date: ISO.optional(),
        slug: SLUG.optional(),
        list: z.enum(['shopping', 'wishlist']).optional(),
        folder: z.enum(NOTE_FOLDERS as [NoteFolder, ...NoteFolder[]]).optional(),
      })
      .parse(req.body);
    const items = [...b.items].sort((x, y) => x.path.localeCompare(y.path) || y.line - x.line);
    const undo: string[] = [];
    const archived: string[] = [];
    const failed: { ref: string; message: string }[] = [];
    let done = 0;
    const one = async (ref: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
        done++;
      } catch (err) {
        // a refused write says whose the folder is and the fix, as a single write would (ADR-105)
        failed.push({ ref, message: refusedText(err, rootsOf(ctx.config)) ?? (err as Error).message });
      }
    };
    if (b.op === 'archive' || (b.op === 'move' && b.folder)) {
      for (const p of b.paths)
        await one(p, async () => {
          if (b.op === 'archive') archived.push((await e.archive(p)).path);
          else await e.moveNote(p, b.folder!);
        });
      return { ok: failed.length === 0, done, failed, archived };
    }
    for (const it of items) {
      const ref = { path: it.path, line: it.line, hash: it.hash };
      const kind = it.kind as LineKind;
      await one(`${it.path}:${it.line}`, async () => {
        if (b.op === 'complete') {
          if (kind !== 'task' && kind !== 'item') throw new HttpError(400, 'not_a_task', 'Only tasks and items are completed.');
          await ctx.ops.completeTask(ref, ctx.today());
        } else if (b.op === 'delete') undo.push((await e.deleteBlock(ref, { kind })).id);
        else if (kind === 'task' && (b.date || b.slug)) await e.moveTask(ref, { date: b.date, slug: b.slug }, (d) => ctx.ops.dailyTemplate(d));
        else if (kind === 'item' && b.list) await e.moveItem(ref, b.list, ctx.today());
        else throw new HttpError(400, 'bad_move', 'Say where these go.');
      });
    }
    return { ok: failed.length === 0, done, failed, undo };
  });
}
