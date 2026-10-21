/**
 * Lists (spec §4.5, §5.7, §5.8): all tasks, notes (recent first, searchable), links, shopping and
 * wishlist. The web search that files into them is routes/search.ts.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { formatTask, itemExtras, itemLabel, readCapture, splitLines, LINKS_PATH, SHOPPING_PATH, WISHLIST_PATH } from '@lifeos/shared';
import type { Ctx } from '../context.js';
import { HttpError } from '../http.js';
import { classify } from '../vault/paths.js';
import { taskDto, type TaskRow, withGroups } from './tasks.js';
import { capturesView } from '../views.js';

export function listRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/lists/tasks', async (req) => {
    const q = z.object({ status: z.enum(['open', 'done', 'all']).default('open'), q: z.string().max(200).default('') }).parse(req.query);
    const everything = ctx.db.prepare("SELECT * FROM tasks WHERE list = 'tasks' AND file_kind != 'archive'").all() as TaskRow[];
    let rows = everything;
    if (q.status !== 'all') rows = rows.filter((r) => r.status === q.status);
    if (q.q) {
      const needle = q.q.toLowerCase();
      rows = rows.filter((r) => r.title.toLowerCase().includes(needle) || r.path.toLowerCase().includes(needle));
    }
    const today = ctx.today();
    const rank = (r: TaskRow) => (r.status === 'done' ? `3${r.done ?? ''}` : r.due ? (r.due < today ? `0${r.due}` : r.due === today ? '1' : `2${r.due}`) : '4');
    rows.sort((a, b) => (q.status === 'done' ? (b.done ?? '').localeCompare(a.done ?? '') : rank(a).localeCompare(rank(b)) || a.path.localeCompare(b.path) || a.line - b.line));
    // a group's children ride on their parent's row; a search also finds a group by a child's words
    if (q.q) {
      const needle = q.q.toLowerCase();
      const hitParents = new Set(everything.filter((r) => r.parent_id && r.title.toLowerCase().includes(needle)).map((r) => r.parent_id!));
      for (const r of everything) if (hitParents.has(r.id) && !rows.includes(r) && (q.status === 'all' || r.status === q.status)) rows.push(r);
    }
    return { today, tasks: withGroups(rows.slice(0, 400).map(taskDto), everything.map(taskDto)) };
  });

  app.get('/api/lists/notes', async (req) => {
    const q = z.object({ q: z.string().max(200).default(''), ring: z.enum(['review', 'today', '']).default('') }).parse(req.query);
    const today = ctx.today();
    const captures = new Map(capturesView(ctx).map((c) => [c.path, c]));
    let rows: { path: string; title: string; kind: string; mtime: number; tags: string; preview: string; date: string | null }[];
    if (q.q.trim()) {
      const terms = q.q
        .replace(/["*():^-]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => `"${t}"*`)
        .join(' ');
      rows = ctx.db
        .prepare(
          `SELECT f.path, f.title, f.kind, f.mtime, f.tags, f.preview, f.date FROM notes_fts n JOIN files f ON f.path = n.path
           WHERE notes_fts MATCH ? ORDER BY rank LIMIT 100`,
        )
        .all(terms) as typeof rows;
    } else {
      rows = ctx.db.prepare('SELECT f.path, f.title, f.kind, f.mtime, f.tags, f.preview, f.date FROM notes_fts n JOIN files f ON f.path = n.path ORDER BY f.mtime DESC LIMIT 200').all() as typeof rows;
    }
    let notes = rows.map((r) => {
      const c = captures.get(r.path);
      return {
        path: r.path,
        title: r.title,
        kind: r.kind,
        modified: new Date(r.mtime).toISOString(),
        date: r.date,
        tags: JSON.parse(r.tags) as string[],
        preview: r.preview,
        ring: c ? { needsReview: c.needsReview, decision: c.decision, time: c.time } : null,
      };
    });
    if (q.ring === 'review') notes = notes.filter((n) => n.ring?.needsReview && !n.ring.decision);
    if (q.ring === 'today') notes = notes.filter((n) => n.ring && n.date === today);
    return { notes };
  });

  /** One note, read-only (LifeOS edits only the notes it created). */
  app.get('/api/notes', async (req) => {
    const { path } = z.object({ path: z.string().max(400) }).parse(req.query);
    const text = await ctx.vault.read(path);
    if (text === null) throw new HttpError(404, 'not_found', 'Note not found.');
    const lines = splitLines(text);
    const fmEnd = lines[0]?.text.trim() === '---' ? lines.findIndex((l, i) => i > 0 && l.text.trim() === '---') : -1;
    let body = lines
      .slice(fmEnd + 1)
      .map((l) => l.text)
      .join('\n')
      .replace(/^\s*\n/, '');
    const f = ctx.db.prepare('SELECT title, tags FROM files WHERE path = ?').get(path) as { title: string; tags: string } | undefined;
    const editable = !!ctx.db.prepare('SELECT 1 FROM created_files WHERE path = ?').get(path);
    let title = f?.title ?? path;
    if (editable) {
      const m = /^# (.+)\n\n?/.exec(body);
      if (m) {
        title = m[1];
        body = body.slice(m[0].length);
      }
    }
    const capture = classify(path) === 'capture' ? readCapture(lines, title) : null;
    return { path, title, body: body.trimEnd(), tags: f ? (JSON.parse(f.tags) as string[]) : [], editable, capture };
  });

  app.put('/api/notes', async (req) => {
    const b = z.object({ path: z.string().max(400), title: z.string().min(1).max(160), body: z.string().max(50000) }).parse(req.body);
    await ctx.ops.updateCreatedNote(b.path, b.title, b.body, ctx.today());
    return { ok: true };
  });

  app.get('/api/lists/links', async () => ({
    links: ctx.db.prepare('SELECT line, hash, title, url, tags, note, saved FROM links WHERE path = ? ORDER BY line DESC').all(LINKS_PATH).map((r) => ({ ...(r as object), tags: JSON.parse((r as { tags: string }).tags) as string[] })),
  }));

  app.post('/api/links', async (req) => {
    const b = z.object({ title: z.string().min(1).max(300), url: z.string().url().max(2000), tags: z.array(z.string().regex(/^[^\s#]+$/)).max(10).default([]), note: z.string().max(300).nullable().optional() }).parse(req.body);
    if (!/^https?:\/\//i.test(b.url)) throw new HttpError(400, 'bad_url', 'Only http and https links.');
    await ctx.ops.addLink({ title: b.title, url: b.url, tags: b.tags, note: b.note ?? null, saved: ctx.today() }, ctx.today());
    return { ok: true };
  });

  app.get('/api/lists/:kind', async (req) => {
    const { kind } = z.object({ kind: z.enum(['shopping', 'wishlist']) }).parse(req.params);
    const rows = ctx.db.prepare('SELECT * FROM tasks WHERE list = ? ORDER BY line').all(kind) as TaskRow[];
    return { path: kind === 'shopping' ? SHOPPING_PATH : WISHLIST_PATH, items: rows.map((r) => ({ ...taskDto(r), label: itemLabel(r.raw), extras: itemExtras(r.raw), bought: r.section.toLowerCase() === 'bought' })) };
  });

  app.post('/api/lists/:kind/items', async (req) => {
    const { kind } = z.object({ kind: z.enum(['shopping', 'wishlist']) }).parse(req.params);
    const b = z.object({ text: z.string().min(1).max(300), url: z.string().url().max(2000).optional(), price: z.string().max(20).optional() }).parse(req.body);
    let text = b.text.replace(/\s+/g, ' ').trim();
    if (b.price) text += ` ~${b.price.replace(/^~/, '')}`;
    // a link travels with the item (an item filed from a search result keeps where it was found)
    if (b.url) text += ` [link](${b.url})`;
    const line = formatTask({ text });
    await ctx.ops.addListItem(kind, line, ctx.today());
    return { ok: true, line };
  });

  app.post('/api/lists/shopping/clear-bought', async () => ({ ok: true, moved: await ctx.ops.clearBought() }));
}
