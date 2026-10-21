import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { addDays, habitsOn, hijri, isoWeekKey, mondayOf, prayerTimes } from '@lifeos/shared';
import type { Ctx } from '../context.js';
import { HttpError } from '../http.js';
import { allTasks, eventsBetween, habitsView } from '../views.js';
import { withGroups } from './tasks.js';

const ISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export function weekRoutes(app: FastifyInstance, ctx: Ctx): void {
  /** Seven days from `start` (default: this week's Monday): events, tasks due, prayer times, Hijri (spec §4.2). */
  app.get('/api/week', async (req) => {
    const q = z.object({ start: ISO.optional(), from: z.enum(['monday', 'today']).default('monday') }).parse(req.query);
    const today = ctx.today();
    const start = q.start ? mondayOf(q.start) : q.from === 'today' ? today : mondayOf(today);
    const end = addDays(start, 6);
    const s = ctx.settings();
    const events = eventsBetween(ctx, start, end);
    const all = allTasks(ctx);
    const tasks = withGroups(
      all.filter((t) => t.due && t.due >= start && t.due <= end && t.status !== 'cancelled' && t.kind !== 'archive'),
      all,
    );
    const habits = habitsView(ctx, today, true);
    const days = Array.from({ length: 7 }, (_, i) => {
      const date = addDays(start, i);
      return {
        date,
        hijri: hijri(date, s.hijriOffset).label,
        prayers: prayerTimes(date, s.prayer),
        events: events.filter((e) => e.date === date),
        tasks: tasks.filter((t) => t.due === date),
        // the streak marks are derived from these on the device (Privacy mode decides what counts)
        habits: habitsOn(date, habits),
      };
    });
    return { start, key: isoWeekKey(start), today, days };
  });

  /** Add event (spec §5.9): writes the weekly note's event shape under the right day. */
  app.post('/api/events', async (req) => {
    const b = z.object({ date: ISO, time: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/).nullable().optional(), text: z.string().min(1).max(300) }).parse(req.body);
    const time = b.time ? b.time.padStart(5, '0') : null;
    const path = await ctx.ops.addEvent(b.date, time, b.text.replace(/\s+/g, ' ').trim());
    return { ok: true, path };
  });

  // ---------------------------------------------------------------- habits

  app.get('/api/habits', async () => ({ today: ctx.today(), habits: habitsView(ctx, ctx.today(), true) }));

  app.post('/api/habits/log', async (req) => {
    const b = z.object({ path: z.string().max(400), date: ISO.optional(), value: z.enum(['clean', 'slip', 'skip']), note: z.string().max(200).nullable().optional() }).parse(req.body);
    const date = b.date ?? ctx.today();
    if (date > ctx.today()) throw new HttpError(400, 'future', 'A day that has not happened yet cannot be logged.');
    const before = habitsView(ctx, ctx.today(), true).find((h) => h.path === b.path);
    if (!before) throw new HttpError(404, 'not_found', 'Habit not found.');
    const line = await ctx.ops.logHabit(b.path, date, b.value, b.note ?? null);
    const after = habitsView(ctx, ctx.today(), true).find((h) => h.path === b.path)!;
    return { ok: true, line, streak: after.streak, extended: after.streak > before.streak };
  });
}
