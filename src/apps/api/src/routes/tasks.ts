import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { currentChildren } from '@lifeos/shared';
import { HttpError } from '../http.js';

export interface TaskRow {
  id: string;
  path: string;
  line: number;
  hash: string;
  raw: string;
  status: 'open' | 'done' | 'cancelled';
  title: string;
  due: string | null;
  due_inferred: number;
  reminder: string | null;
  priority: string | null;
  recur: string | null;
  done: string | null;
  slugs: string;
  tags: string;
  capture: string | null;
  section: string;
  readonly: number;
  list: string;
  file_kind: string;
  parent_id: string | null;
  due_inherited: number;
}

/** What the web app gets for a task (the anchor travels with it so writes are line-anchored). */
export function taskDto(r: TaskRow) {
  return {
    id: r.id,
    path: r.path,
    line: r.line,
    hash: r.hash,
    status: r.status,
    title: r.title,
    due: r.due,
    dueInferred: !!r.due_inferred,
    reminder: r.reminder,
    priority: r.priority,
    recur: r.recur,
    done: r.done,
    slugs: JSON.parse(r.slugs) as string[],
    tags: JSON.parse(r.tags) as string[],
    capture: r.capture,
    section: r.section,
    readonly: !!r.readonly,
    list: r.list,
    kind: r.file_kind,
    /** a group's child (round-2 brief §10): its parent's id; the due date may be the parent's */
    parentId: r.parent_id,
    dueInherited: !!r.due_inherited,
  };
}
export type TaskDto = ReturnType<typeof taskDto> & { group?: TaskGroup | null };

/** A group's children as its parent row carries them: done of all (cancelled ones left out). */
export interface TaskGroup {
  total: number;
  done: number;
  children: TaskDto[];
}

/**
 * The rows a list shows: children of a group leave the list and ride on their parent (wherever
 * the parent is listed), with "done of all"; `all` is where the children are looked up.
 */
export function withGroups(list: TaskDto[], all: TaskDto[]): TaskDto[] {
  const kids = new Map<string, TaskDto[]>();
  for (const t of all) if (t.parentId) kids.set(t.parentId, [...(kids.get(t.parentId) ?? []), t]);
  return list
    .filter((t) => !t.parentId)
    .map((t) => {
      // a repeating child stands once for its series: its closed earlier instances are history (ADR-65)
      const children = currentChildren((kids.get(t.id) ?? []).sort((a, b) => a.line - b.line));
      if (!children.length) return t;
      const counted = children.filter((c) => c.status !== 'cancelled');
      return { ...t, group: { total: counted.length, done: counted.filter((c) => c.status === 'done').length, children } };
    });
}

export const Anchor = z.object({ path: z.string().min(1).max(400), line: z.number().int().min(0), hash: z.string().regex(/^[0-9a-f]{16}$/) });

export function taskRoutes(app: FastifyInstance, ctx: Ctx): void {
  const byId = ctx.db.prepare('SELECT * FROM tasks WHERE id = ?');
  const atAnchor = ctx.db.prepare('SELECT * FROM tasks WHERE path = ? AND line = ?');

  app.get('/api/tasks', async (req) => {
    const q = z
      .object({ status: z.enum(['open', 'done', 'all']).default('open'), path: z.string().optional(), list: z.string().default('tasks'), limit: z.coerce.number().int().min(1).max(2000).default(500) })
      .parse(req.query);
    const where: string[] = ['list = ?'];
    const args: unknown[] = [q.list];
    if (q.status !== 'all') {
      where.push('status = ?');
      args.push(q.status);
    }
    if (q.path) {
      where.push('path = ?');
      args.push(q.path);
    }
    const rows = ctx.db.prepare(`SELECT * FROM tasks WHERE ${where.join(' AND ')} ORDER BY due IS NULL, due, path, line LIMIT ?`).all(...args, q.limit) as TaskRow[];
    return { tasks: rows.map(taskDto) };
  });

  app.get('/api/tasks/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const r = byId.get(id) as TaskRow | undefined;
    if (!r) throw new HttpError(404, 'not_found', 'This task is no longer in the vault (it may have been edited or completed elsewhere).');
    return { task: taskDto(r) };
  });

  const after = (path: string, line: number) => {
    const r = atAnchor.get(path, line) as TaskRow | undefined;
    return r ? taskDto(r) : null;
  };

  app.post('/api/tasks/:id/complete', async (req) => {
    const a = Anchor.parse(req.body);
    const r = await ctx.ops.completeTask(a, ctx.today());
    // parentDone: the last open child closed its group (the client plays the group reward)
    return { ok: true, line: r.line, next: r.next, parentDone: r.parentDone, task: after(a.path, r.index) };
  });

  app.post('/api/tasks/:id/reopen', async (req) => {
    const a = Anchor.parse(req.body);
    const r = await ctx.ops.reopenTask(a);
    return { ok: true, line: r.line };
  });

  app.patch('/api/tasks/:id', async (req) => {
    const b = Anchor.extend({
      due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      reminder: z.string().max(40).nullable().optional(),
      priority: z.enum(['highest', 'high', 'medium', 'low', 'lowest']).nullable().optional(),
      // round-2 brief §12: the words, the goals (@slug) and the tags too
      text: z.string().min(1).max(500).optional(),
      slugs: z.array(z.string().regex(/^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u).max(120)).max(10).optional(),
      tags: z.array(z.string().regex(/^[^\s#@]+$/).max(60)).max(20).optional(),
    }).parse(req.body);
    const { path, line, hash, ...edit } = b;
    const r = await ctx.edits.editTask({ path, line, hash }, edit);
    return { ok: true, line: r.line };
  });
}
