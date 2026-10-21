/**
 * Calendar (round-2 brief §3, §4): the Day and Month views' data. Week is routes/week.ts. Events
 * come from the weekly notes (§5.9, the only event storage), tasks from their due dates, habits
 * from their logs; the streak marks and the goal chips are derived here or on the device, never
 * stored.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { addDays, habitsOn, hijri, hijriSpan, monthCells, prayerTimes } from '@lifeos/shared';
import type { Ctx } from '../context.js';
import { HttpError } from '../http.js';
import { allTasks, eventsBetween, habitsView } from '../views.js';
import { withGroups } from './tasks.js';

const ISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export function calendarRoutes(app: FastifyInstance, ctx: Ctx): void {
  /**
   * A month: per day the Hijri day, how many events and open tasks are due, and the habits scheduled;
   * `list` names the events and tasks for the day's popover (round-3 brief §2, ADR-64).
   */
  app.get('/api/calendar/month', async (req) => {
    const q = z.object({ m: z.string().regex(/^\d{4}-\d{2}$/).optional() }).parse(req.query);
    const today = ctx.today();
    const ym = q.m ?? today.slice(0, 7);
    const s = ctx.settings();
    const dates = monthCells(ym).filter((d): d is string => !!d);
    const from = dates[0];
    const to = dates[dates.length - 1];
    const events = eventsBetween(ctx, from, to);
    const tasks = allTasks(ctx).filter((t) => t.due && t.due >= from && t.due <= to && t.status !== 'cancelled' && t.kind !== 'archive' && !t.parentId);
    const habits = habitsView(ctx, today, true);
    return {
      month: ym,
      today,
      hijri: hijriSpan(ym, s.hijriOffset),
      days: dates.map((date) => {
        const h = hijri(date, s.hijriOffset);
        return {
          date,
          hijriDay: h.day,
          hijriMonth: h.monthName,
          events: events.filter((e) => e.date === date).length,
          tasks: tasks.filter((t) => t.due === date && t.status === 'open').length,
          done: tasks.filter((t) => t.due === date && t.status === 'done').length,
          habits: date <= today ? habitsOn(date, habits) : [],
          list: {
            events: events.filter((e) => e.date === date).map((e) => ({ id: e.id, time: e.time, text: e.text })),
            tasks: tasks.filter((t) => t.due === date).map((t) => ({ id: t.id, title: t.title, done: t.status === 'done' })),
          },
        };
      }),
    };
  });

  /** A day's agenda: Hijri and Gregorian, the prayers, events, tasks due, habits due, goal chips. */
  app.get('/api/calendar/day', async (req) => {
    const q = z.object({ d: ISO.optional() }).parse(req.query);
    const today = ctx.today();
    const date = q.d ?? today;
    if (Number.isNaN(Date.parse(`${date}T12:00:00Z`))) throw new HttpError(400, 'bad_date', 'That is not a date.');
    const s = ctx.settings();
    const h = hijri(date, s.hijriOffset);
    const all = allTasks(ctx);
    const tasks = withGroups(
      all.filter((t) => t.due === date && t.status !== 'cancelled' && t.kind !== 'archive'),
      all,
    );
    const habits = habitsView(ctx, today, true);
    const day = habitsOn(date, habits).map((x) => {
      const full = habits.find((y) => y.path === x.path)!;
      return { ...x, schedule: full.schedule, streak: full.streak };
    });
    // goal progress chips (§4): the goals and projects the day's tasks serve, progress derived
    const slugs = [...new Set(tasks.flatMap((t) => t.slugs))];
    const goals = slugs
      .map((slug) => {
        const f = ctx.db.prepare("SELECT path, title, kind FROM files WHERE kind IN ('goal', 'project') AND path LIKE ?").get(`%/${slug}.md`) as { path: string; title: string; kind: string } | undefined;
        if (!f) return null;
        const mine = all.filter((t) => t.slugs.includes(slug) || (f.kind === 'project' && t.path === f.path));
        return { slug, title: f.title, kind: f.kind, done: mine.filter((t) => t.status === 'done').length, total: mine.filter((t) => t.status !== 'cancelled').length };
      })
      .filter((g): g is NonNullable<typeof g> => !!g);
    return {
      date,
      today,
      hijri: h.label,
      hijriDay: h.day,
      prayers: prayerTimes(date, s.prayer),
      events: eventsBetween(ctx, date, date),
      tasks,
      habits: date <= today ? day : day.map((x) => ({ ...x, value: null })),
      goals,
      prev: addDays(date, -1),
      next: addDays(date, 1),
    };
  });
}
