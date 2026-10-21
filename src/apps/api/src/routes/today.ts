import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { dateTimeText, formatGroup, formatTask, parseQuickAdd, QUICK_TYPES, formatLinkLine, splitGroupInput } from '@lifeos/shared';
import type { Ctx } from '../context.js';
import type { Planner } from '../planner.js';
import { HttpError } from '../http.js';
import { buildToday } from '../views.js';
import { cloudPending, currentEndpoint, providerName } from '../ai/endpoint.js';
import { cloudWarning } from './ai.js';
import { REMINDERS_PATH } from '@lifeos/shared';

const PlanPayload = z.object({
  headline: z.string().max(300),
  focus: z.array(z.object({ text: z.string().max(300), source_task_id: z.string().nullable().optional().default(null), new: z.boolean().default(false) })).max(5),
  notes: z.array(z.string().max(400)).max(5).default([]),
});
const ReviewPayload = z.object({
  review: z.string().max(2000),
  unsorted: z.array(z.object({ capture_file: z.string().max(400), suggestion: z.enum(['task', 'note', 'ignore']), text: z.string().max(300) })).max(30),
  tomorrow: z.object({ headline: z.string().max(300), focus: z.array(z.string().max(300)).max(5) }),
});

export function todayRoutes(app: FastifyInstance, ctx: Ctx, planner: Planner, sweep: () => void = () => undefined): void {
  app.get('/api/today', async () => {
    // a draft that waited for Hermes longer than the usual 120 s shows the plain one (ADR-86)
    sweep();
    planner.ensureMorning();
    planner.ensureEvening();
    // a cloud provider's first job waits for the owner's OK here (ADR-81): the warning, again
    const host = cloudPending(ctx);
    const e = currentEndpoint(ctx);
    return { ...buildToday(ctx), aiCloud: host ? { host, who: providerName(e), warning: cloudWarning(providerName(e)) } : null };
  });

  app.post('/api/drafts/:id/approve', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const d = planner.drafts.get(id);
    if (!d) throw new HttpError(404, 'not_found', 'That draft is gone.');
    const body = (req.body ?? {}) as { payload?: unknown };
    if (d.kind === 'morning_plan') await planner.approvePlan(id, body.payload ? PlanPayload.parse(body.payload) : undefined);
    else if (d.kind === 'evening_review') await planner.approveReview(id, body.payload ? ReviewPayload.parse(body.payload) : undefined);
    else throw new HttpError(400, 'kind', 'This draft is approved from the Habits tab.');
    return { ok: true };
  });

  app.post('/api/drafts/:id/dismiss', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    planner.dismiss(id);
    return { ok: true };
  });

  /** Ask for a fresh morning plan (the "Draft a plan" button when none is waiting). */
  app.post('/api/drafts/morning', async () => {
    const date = ctx.today();
    for (const d of [planner.drafts.latest('morning_plan', date, ['pending', 'dismissed', 'approved'])]) if (d && d.status === 'pending') return { ok: true, id: d.id };
    planner.draft('morning_plan', date);
    return { ok: true };
  });

  // ---------------------------------------------------------------- Quick Add (spec §4)

  app.post('/api/quick', async (req) => {
    const b = z.object({ type: z.enum(QUICK_TYPES as [string, ...string[]]), text: z.string().min(1).max(2000), body: z.string().max(20000).optional() }).parse(req.body);
    const today = ctx.today();
    const text = b.type === 'note' ? b.text : b.text.replace(/\s+/g, ' ');
    const q = parseQuickAdd(text, { today, now: ctx.hm() });
    switch (b.type) {
      case 'task': {
        // a group (round-2 brief §10): "Weekly shopping every saturday: olive oil; call the butcher"
        const group = splitGroupInput(text);
        if (group) {
          const g = parseQuickAdd(group.head, { today, now: ctx.hm() });
          if (!g.text) throw new HttpError(400, 'empty', 'Write what the group is called, before the colon.');
          const parent = formatTask({ text: g.text, due: g.date, reminder: g.reminder, priority: g.priority, recur: g.recur, slugs: g.slugs, tags: g.tags });
          const lines = formatGroup(parent, group.items);
          const path = await ctx.ops.addTaskToday(today, lines);
          return { ok: true, type: b.type, path, line: lines.join('\n'), group: group.items.length };
        }
        if (!q.text) throw new HttpError(400, 'empty', 'Write what the task is.');
        const line = formatTask({ text: q.text, due: q.date, reminder: q.reminder, priority: q.priority, recur: q.recur, slugs: q.slugs, tags: q.tags });
        const path = await ctx.ops.addTaskToday(today, line);
        return { ok: true, type: b.type, path, line };
      }
      case 'reminder': {
        if (!q.text) throw new HttpError(400, 'empty', 'Write what to be reminded of.');
        let reminder = q.reminder;
        let date = q.date;
        if (!reminder) {
          date = date ?? (ctx.hm() < '09:00' ? today : null);
          if (!date) date = new Date(Date.parse(`${today}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
          reminder = `${date} 09:00`;
        }
        const line = formatTask({ text: q.text, due: date, reminder, priority: q.priority, recur: q.recur, slugs: q.slugs, tags: q.tags });
        await ctx.ops.addReminderTask(today, line);
        return { ok: true, type: b.type, path: REMINDERS_PATH, line, when: reminder.includes(' ') ? dateTimeText(reminder.slice(0, 10), reminder.slice(11)) : reminder };
      }
      case 'note': {
        const title = b.text.split('\n')[0].trim().slice(0, 120);
        if (!title) throw new HttpError(400, 'empty', 'Give the note a title.');
        const path = await ctx.ops.createNote(title, b.body ?? b.text.split('\n').slice(1).join('\n'), today);
        return { ok: true, type: b.type, path };
      }
      case 'link': {
        if (!q.url) throw new HttpError(400, 'no_url', 'Paste the link (https://…) with an optional title.');
        let host = q.url;
        try {
          host = new URL(q.url).hostname.replace(/^www\./, '');
        } catch {
          throw new HttpError(400, 'bad_url', 'That link does not look right.');
        }
        await ctx.ops.addLink({ title: q.text || host, url: q.url, tags: q.tags, note: null, saved: today }, today);
        return { ok: true, type: b.type, path: 'Resources/links.md', line: formatLinkLine({ title: q.text || host, url: q.url, tags: q.tags, note: null, saved: today }) };
      }
      case 'shopping':
      case 'wishlist': {
        // items keep their words as typed (prices, sizes); only tags, slugs and a URL are understood
        let item = text.replace(/\s(https?:\/\/\S+)/i, ' ').replace(/(^|\s)[#@][^\s#@]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (!item) throw new HttpError(400, 'empty', 'Write the item.');
        if (b.type === 'wishlist' && q.url) item += ` [link](${q.url})`;
        const line = formatTask({ text: item, tags: q.tags });
        const path = await ctx.ops.addListItem(b.type, line, today);
        return { ok: true, type: b.type, path, line };
      }
    }
    throw new HttpError(400, 'type', 'Unknown type.');
  });

  // ---------------------------------------------------------------- check-in and mood (spec §5.2)

  app.post('/api/checkin', async (req) => {
    const b = z.object({ sleep: z.number().min(0).max(24).optional(), workout: z.boolean().optional(), prayers: z.number().int().min(0).max(5).optional() }).parse(req.body);
    const line = await ctx.ops.saveCheckin(ctx.today(), ctx.hm(), b);
    return { ok: true, line };
  });

  app.post('/api/mood', async (req) => {
    const b = z.object({ mood: z.number().int().min(1).max(5).optional(), energy: z.number().int().min(1).max(5).optional(), note: z.string().max(200).optional() }).parse(req.body);
    const line = await ctx.ops.saveMood(ctx.today(), ctx.hm(), b);
    return { ok: true, line };
  });

  // ---------------------------------------------------------------- ring captures

  app.get('/api/captures/:slug', async (req) => {
    const { slug } = z.object({ slug: z.string().max(200) }).parse(req.params);
    const row = ctx.db.prepare("SELECT path FROM files WHERE kind = 'capture' AND path LIKE ?").get(`%/${slug}.md`) as { path: string } | undefined;
    if (!row) throw new HttpError(404, 'not_found', 'Capture not found.');
    const text = (await ctx.vault.read(row.path)) ?? '';
    const { readCapture, splitLines } = await import('@lifeos/shared');
    const c = readCapture(splitLines(text), slug);
    const f = ctx.db.prepare('SELECT title, date, lifeos FROM files WHERE path = ?').get(row.path) as { title: string; date: string; lifeos: string | null };
    return { path: row.path, title: f.title, date: f.date, decision: f.lifeos, transcript: c.transcript, organized: c.organized };
  });

  app.post('/api/captures/resolve', async (req) => {
    const b = z.object({ path: z.string().max(400), decision: z.enum(['task', 'note', 'ignore']), text: z.string().max(300).default('') }).parse(req.body);
    await planner.resolveCapture(b.path, b.decision, b.text);
    return { ok: true };
  });
}
