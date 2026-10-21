/**
 * Task groups (round-2 brief §10, ADR-57): the open groups (for "add to a group" from Shopping), a
 * group's edit (title, recurrence, children) and moving a shopping item into a group. Completing and
 * reopening go through the ordinary task routes, which know about groups.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { allTasks } from '../views.js';
import { Anchor, withGroups } from './tasks.js';

export function groupRoutes(app: FastifyInstance, ctx: Ctx): void {
  /** Open groups, soonest due first. */
  app.get('/api/groups', async () => {
    const all = allTasks(ctx);
    const groups = withGroups(
      all.filter((t) => t.status === 'open' && !t.readonly && t.kind !== 'archive'),
      all,
    ).filter((t) => t.group);
    groups.sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || a.title.localeCompare(b.title));
    return { groups: groups.map((g) => ({ id: g.id, path: g.path, line: g.line, hash: g.hash, title: g.title, due: g.due, recur: g.recur, total: g.group!.total, done: g.group!.done })) };
  });

  app.put('/api/groups', async (req) => {
    const b = Anchor.extend({
      title: z.string().max(300).optional(),
      recur: z.string().max(60).nullable().optional(),
      children: z.array(z.object({ line: z.number().int().min(0), hash: z.string().regex(/^[0-9a-f]{16}$/), text: z.string().max(300).optional(), remove: z.boolean().optional() })).max(100).optional(),
      add: z.array(z.string().min(1).max(300)).max(50).optional(),
    }).parse(req.body);
    const { path, line, hash, ...edit } = b;
    await ctx.ops.editGroup({ path, line, hash }, edit, ctx.today());
    return { ok: true };
  });

  /** A shopping item moves into a group (added there first, then taken off the list). */
  app.post('/api/groups/items', async (req) => {
    const b = z.object({ group: Anchor, item: Anchor }).parse(req.body);
    await ctx.ops.moveItemToGroup(b.group, b.item, ctx.today());
    return { ok: true };
  });
}
