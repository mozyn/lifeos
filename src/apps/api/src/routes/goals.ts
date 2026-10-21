/**
 * Goals and personal projects (spec §5.3, §5.4), habits (§5.5) and the library (§5.10).
 * Progress is derived from the vault every time: done / all tasks carrying `@slug`, never typed.
 */
import { statSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { DraftRow } from '../drafts.js';
import { z } from 'zod';
import { formatTask, parseQuickAdd, weekRange } from '@lifeos/shared';
import type { Ctx } from '../context.js';
import { HttpError } from '../http.js';
import type { Nudges } from '../nudges.js';
import type { Sender } from '../telegram.js';
import { type TaskDto, withGroups } from './tasks.js';
import { allTasks, habitsView } from '../views.js';
import { classify } from '../vault/paths.js';

interface FileRow {
  path: string;
  title: string;
  fm: string;
  status: string | null;
  mtime: number;
}

export function goalRoutes(
  app: FastifyInstance,
  ctx: Ctx,
  nudges: Nudges,
  sender: Sender,
  telegramOn: () => boolean,
  /** a slip's nudge for Hermes to send (integration API, ADR-87) */
  offer: (d: DraftRow, habitPath: string) => void = () => undefined,
): void {
  const slugOf = (path: string) => path.split('/').pop()!.replace(/\.md$/, '');

  const view = (kind: 'goal' | 'project', tasks: TaskDto[]) => {
    const rows = ctx.db.prepare('SELECT path, title, fm, status, mtime FROM files WHERE kind = ? ORDER BY title').all(kind) as FileRow[];
    return rows.map((r) => {
      const fm = JSON.parse(r.fm) as Record<string, unknown>;
      const slug = slugOf(r.path);
      // goals count @slug tasks (§5.3); projects also count the tasks inside their own note (§5.4)
      const mine = tasks.filter((t) => t.slugs.includes(slug) || (kind === 'project' && t.path === r.path));
      const done = mine.filter((t) => t.status === 'done').length;
      const total = mine.filter((t) => t.status !== 'cancelled').length;
      return {
        slug,
        path: r.path,
        title: r.title,
        status: String(fm.status ?? r.status ?? 'active'),
        target: typeof fm.target === 'string' ? fm.target : null,
        why: typeof fm.why === 'string' ? fm.why : null,
        done,
        total,
        lastActivity: new Date(r.mtime).toISOString(),
        next: mine.filter((t) => t.status === 'open').sort((a, b) => (a.due ?? '9999') < (b.due ?? '9999') ? -1 : 1)[0] ?? null,
      };
    });
  };

  app.get('/api/goals', async () => {
    const today = ctx.today();
    const tasks = allTasks(ctx);
    const { from } = weekRange(today);
    const habits = habitsView(ctx, today);
    return {
      today,
      counters: {
        doneToday: tasks.filter((t) => t.status === 'done' && t.done === today).length,
        doneWeek: tasks.filter((t) => t.status === 'done' && t.done && t.done >= from && t.done <= today).length,
        longestStreak: Math.max(0, ...habits.map((h) => h.streak)),
      },
      goals: view('goal', tasks),
      projects: view('project', tasks),
    };
  });

  app.get('/api/goals/:slug', async (req) => {
    const { slug } = z.object({ slug: z.string().max(120) }).parse(req.params);
    const tasks = allTasks(ctx);
    const item = [...view('goal', tasks), ...view('project', tasks)].find((g) => g.slug === slug);
    if (!item) throw new HttpError(404, 'not_found', 'That goal or project is not in the vault.');
    const isProject = item.path.startsWith('Projects/');
    const list = tasks.filter((t) => t.slugs.includes(slug) || t.path === item.path);
    return { item: { ...item, kind: isProject ? 'project' : 'goal' }, tasks: withGroups(list, tasks) };
  });

  app.post('/api/goals', async (req) => {
    const b = z.object({ title: z.string().min(1).max(160), why: z.string().max(300).nullable().optional(), target: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional() }).parse(req.body);
    const path = await ctx.ops.createGoal({ title: b.title, date: ctx.today(), target: b.target ?? null, why: b.why?.trim() || null });
    return { ok: true, path, slug: slugOf(path) };
  });

  /** A task added from a goal or project screen goes into that note under ## Tasks, carrying @slug (§5.1). */
  app.post('/api/goals/:slug/tasks', async (req) => {
    const { slug } = z.object({ slug: z.string().max(120) }).parse(req.params);
    const b = z.object({ text: z.string().min(1).max(500) }).parse(req.body);
    const row = ctx.db.prepare("SELECT path, kind FROM files WHERE kind IN ('goal', 'project') AND path LIKE ?").get(`%/${slug}.md`) as { path: string; kind: string } | undefined;
    if (!row) throw new HttpError(404, 'not_found', 'That goal or project is not in the vault.');
    const q = parseQuickAdd(b.text, { today: ctx.today(), now: ctx.hm() });
    if (!q.text) throw new HttpError(400, 'empty', 'Write what the task is.');
    const slugs = [...new Set([slug, ...q.slugs])];
    const line = formatTask({ text: q.text, due: q.date, reminder: q.reminder, priority: q.priority, recur: q.recur, slugs, tags: q.tags });
    await ctx.ops.addTaskTo(row.path, line, () => `# ${slug}\n\n## Tasks\n`);
    return { ok: true, path: row.path, line };
  });

  // ---------------------------------------------------------------- habits (§5.5, §9 job 3)

  app.post('/api/habits', async (req) => {
    const b = z
      .object({
        title: z.string().min(1).max(120),
        kind: z.enum(['quit', 'build']),
        schedule: z.string().regex(/^(daily|weekdays|weekends|(mon|tue|wed|thu|fri|sat|sun)(,(mon|tue|wed|thu|fri|sat|sun))*)$/).default('daily'),
      })
      .parse(req.body);
    const path = await ctx.ops.createHabit({ title: b.title, kind: b.kind, schedule: b.schedule, started: ctx.today() });
    return { ok: true, path };
  });

  const SCHEDULE = z.string().regex(/^(daily|weekdays|weekends|(mon|tue|wed|thu|fri|sat|sun)(,(mon|tue|wed|thu|fri|sat|sun))*)$/);

  /** Edit (round-2 brief §6): name, kind, schedule, started, private; frontmatter and H1 only. */
  app.patch('/api/habits', async (req) => {
    const b = z
      .object({
        path: z.string().max(400),
        title: z.string().min(1).max(120).optional(),
        kind: z.enum(['quit', 'build']).optional(),
        schedule: SCHEDULE.optional(),
        started: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        private: z.boolean().optional(),
      })
      .parse(req.body);
    const { path, ...edit } = b;
    await ctx.ops.editHabit(path, edit);
    return { ok: true };
  });

  /** "Delete" (§6): moved to Archive/Habits with status archived, the log kept; restorable. */
  app.post('/api/habits/archive', async (req) => {
    const b = z.object({ path: z.string().max(400) }).parse(req.body);
    if (classify(b.path) !== 'habit') throw new HttpError(403, 'forbidden', 'not a habit note');
    return { ok: true, ...(await ctx.edits.archive(b.path)) };
  });

  app.post('/api/habits/restore', async (req) => {
    const b = z.object({ path: z.string().max(400) }).parse(req.body);
    if (classify(b.path) !== 'archived-habit') throw new HttpError(403, 'forbidden', 'not an archived habit');
    return { ok: true, ...(await ctx.edits.restoreArchived(b.path)) };
  });

  /** Settings → Advanced → Data → Archived. */
  app.get('/api/habits/archived', async () => {
    const rows = ctx.db.prepare("SELECT path, title, mtime FROM files WHERE path LIKE 'Archive/Habits/%' ORDER BY mtime DESC").all() as { path: string; title: string; mtime: number }[];
    const logs = ctx.db.prepare('SELECT count(*) n FROM habit_logs WHERE path = ?');
    return { habits: rows.map((r) => ({ path: r.path, title: r.title, archived: new Date(r.mtime).toISOString(), logs: (logs.get(r.path) as { n: number }).n })) };
  });

  app.get('/api/habits/nudge', async (req) => {
    const { path } = z.object({ path: z.string().max(400) }).parse(req.query);
    const d = nudges.latest(path, ctx.today());
    return { nudge: d ? { id: d.id, payload: JSON.parse(d.payload), model: d.model, fallback: !!d.fallback, fallbackReason: d.fallback_reason, generatedAt: d.generated_at, sources: JSON.parse(d.sources) } : null };
  });

  /** After a slip is logged: the nudge (verbatim entry + encouragement), and a Telegram nudge before 20:00. */
  app.post('/api/habits/slip', async (req) => {
    const b = z.object({ path: z.string().max(400) }).parse(req.body);
    const habit = habitsView(ctx, ctx.today(), true).find((h) => h.path === b.path);
    if (!habit) throw new HttpError(404, 'not_found', 'Habit not found.');
    const d = await nudges.create(habit, ctx.today(), 'slip');
    const p = JSON.parse(d.payload);
    let sent = false;
    const s = ctx.settings();
    const hm = ctx.hm();
    const quiet = s.quietStart < s.quietEnd ? hm >= s.quietStart && hm < s.quietEnd : hm >= s.quietStart || hm < s.quietEnd;
    const already = ctx.db.prepare('SELECT 1 FROM nudges WHERE habit = ? AND date = ?').get(habit.path, ctx.today());
    if (hm < '20:00' && !quiet) offer(d, habit.path);
    if (hm < '20:00' && !quiet && !already && telegramOn()) {
      try {
        await sender.send(nudges.text(p));
        ctx.db.prepare('INSERT OR IGNORE INTO nudges (habit, date, kind, at) VALUES (?, ?, ?, ?)').run(habit.path, ctx.today(), 'slip', new Date().toISOString());
        sent = true;
      } catch {
        sent = false;
      }
    }
    return { ok: true, nudge: { id: d.id, payload: p, model: d.model, fallback: !!d.fallback, fallbackReason: d.fallback_reason, generatedAt: d.generated_at, sources: JSON.parse(d.sources) }, sent };
  });

  // ---------------------------------------------------------------- the library (§5.10)

  app.get('/api/library/daily', async () => {
    const date = ctx.today();
    const e = await nudges.library.daily(date);
    const favs = await nudges.library.favorites();
    return { date, entry: e, pinned: e ? favs.includes(e.heading) : false, size: (ctx.db.prepare('SELECT count(*) n FROM hadith').get() as { n: number }).n };
  });

  app.post('/api/library/pin', async (req) => {
    const b = z.object({ heading: z.string().min(1).max(400) }).parse(req.body);
    const exists = ctx.db.prepare('SELECT 1 FROM hadith WHERE heading = ?').get(b.heading);
    if (!exists) throw new HttpError(404, 'not_found', 'That entry is not in the library.');
    const added = await ctx.ops.pinFavorite(b.heading, ctx.today());
    return { ok: true, added };
  });

  void statSync;
}
