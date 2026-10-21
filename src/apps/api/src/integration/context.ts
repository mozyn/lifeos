/**
 * What Hermes reads (product brief 9 §1, ADR-85): a day's context for the AI jobs and for chat, and
 * a plain-text summary of a day or a week for a chat reply. Built from the index like every other
 * view (never from a second copy), with only what the jobs need: tasks, events, habits, unsorted
 * captures, goals, prayer times and quiet hours. No place, no coordinates, no file paths.
 *
 * Private habits (ADR-63) are "private habit P1" with their kind and streak only, and every string
 * passes the same scrub the AI prompts pass, so a habit's name cannot ride along in a task title,
 * an event, a goal or a capture.
 */
import { addDays, dateRange, hijri, hm12, longDateYear, nextPrayer, plannedToday, PRAYER_LABELS, prayerTimes, shortDateDow, type TaskLite, weekRange } from '@lifeos/shared';
import type { Ctx } from '../context.js';
import { PrivateHabits } from '../ai/private.js';
import { currentEndpoint, hermesDrafts } from '../ai/endpoint.js';
import type { TaskDto } from '../routes/tasks.js';
import { allTasks, capturesView, eventsBetween, habitsView, planBullets, unsortedToday } from '../views.js';
import { JOB_TIMES } from './jobs.js';

/** Every string in a value passed through the scrub (keys stay as they are). */
export function scrubDeep<T>(value: T, priv: PrivateHabits): T {
  if (!priv.any) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return priv.scrub(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

const taskOut = (t: TaskDto, day: string) => ({
  id: t.id,
  title: t.title,
  due: t.due,
  ...(t.due && t.due < day && t.status === 'open' ? { overdue: true } : {}),
  reminder: t.reminder,
  priority: t.priority,
  goals: t.slugs,
  tags: t.tags,
});

function dayTasks(ctx: Ctx, day: string) {
  const today = ctx.today();
  const tasks = allTasks(ctx);
  const writable = (t: TaskDto) => !t.readonly && t.kind !== 'archive';
  if (day === today) {
    const planned = plannedToday(tasks as TaskLite[], planBullets(ctx, day).slice(1), day) as TaskDto[];
    // overdue tasks are listed on their own (as on Today), not among today's
    const open = planned.filter((t) => t.status === 'open' && !(t.due && t.due < day));
    const overdue = tasks.filter((t) => t.status === 'open' && writable(t) && t.due && t.due < day);
    const done = tasks.filter((t) => t.status === 'done' && t.done === day);
    return { open, overdue, done };
  }
  return {
    open: tasks.filter((t) => t.status === 'open' && writable(t) && t.due === day),
    overdue: [] as TaskDto[],
    done: tasks.filter((t) => t.status === 'done' && t.done === day),
  };
}

/** `GET /api/integration/context?day=`: the day as the jobs and a chat need it. */
export function contextFor(ctx: Ctx, day: string) {
  const s = ctx.settings();
  const isToday = day === ctx.today();
  const times = prayerTimes(day, s.prayer);
  const np = isToday ? nextPrayer(ctx.now(), s.prayer) : null;
  const priv = new PrivateHabits(habitsView(ctx, day, true));
  const t = dayTasks(ctx, day);
  const habits = habitsView(ctx, day)
    .filter((h) => h.scheduledToday)
    .map((h) => (priv.isPrivate(h) ? { name: priv.name(h), private: true, kind: h.kind, streak: h.streak, today: h.today } : { name: h.title, kind: h.kind, schedule: h.schedule, streak: h.streak, best: h.best, today: h.today }));
  const goals = (ctx.db.prepare("SELECT path, title, fm FROM files WHERE kind = 'goal' ORDER BY title").all() as { path: string; title: string; fm: string }[])
    .map((g) => ({ ...g, fm: JSON.parse(g.fm) as Record<string, unknown> }))
    .filter((g) => String(g.fm.status ?? 'active') === 'active')
    .map((g) => ({ title: g.title, slug: g.path.split('/').pop()!.replace(/\.md$/, ''), target: typeof g.fm.target === 'string' ? g.fm.target : null, why: typeof g.fm.why === 'string' ? g.fm.why : null }));
  const unsorted = unsortedToday(capturesView(ctx), day)
    .filter((c) => !c.hasTask)
    .map((c) => ({ title: c.title, time: c.time, said: c.preview.replace(/\s+/g, ' ').slice(0, 300) }));
  const bullets = planBullets(ctx, day);
  const e = currentEndpoint(ctx);
  const out = {
    day,
    today: isToday,
    now: ctx.now().toISOString(),
    time: isToday ? ctx.hm() : null,
    timezone: ctx.tz(),
    date: longDateYear(day),
    hijri: hijri(day, s.hijriOffset).label,
    prayers: Object.fromEntries(['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'].map((p) => [p, times[p as keyof typeof times]])),
    next_prayer: np ? { name: PRAYER_LABELS[np.name], time: np.time } : null,
    quiet_hours: { start: s.quietStart, end: s.quietEnd },
    // when to ask GET /api/integration/jobs (the owner's time zone)
    schedule: JOB_TIMES,
    plan: bullets.length ? { headline: bullets[0], items: bullets.slice(1) } : null,
    counts: { open: t.open.length, overdue: t.overdue.length, done: t.done.length, events: 0 },
    tasks: { open: t.open.map((x) => taskOut(x, day)), overdue: t.overdue.slice(0, 30).map((x) => taskOut(x, day)), done: t.done.map((x) => ({ id: x.id, title: x.title })) },
    events: eventsBetween(ctx, day, day).map((ev) => ({ time: ev.time, text: ev.text })),
    habits,
    unsorted,
    goals,
    ai: { drafts_by: hermesDrafts(ctx) ? 'hermes' : e.provider === 'off' || !ctx.config.ai || !s.ai ? 'off' : 'lifeos' },
  };
  out.counts.events = out.events.length;
  return scrubDeep(out, priv);
}

/** `GET /api/integration/summary?range=day|week`: plain text for a chat reply, no model involved. */
export function summaryText(ctx: Ctx, range: 'day' | 'week'): string {
  const day = ctx.today();
  const s = ctx.settings();
  const priv = new PrivateHabits(habitsView(ctx, day, true));
  const list = (xs: string[], max = 8) => (xs.length > max ? `${xs.slice(0, max).join('; ')}; and ${xs.length - max} more` : xs.join('; '));
  const lines: string[] = [];
  if (range === 'day') {
    const t = dayTasks(ctx, day);
    const bullets = planBullets(ctx, day);
    const np = nextPrayer(ctx.now(), s.prayer);
    lines.push(`${longDateYear(day)} (${hijri(day, s.hijriOffset).label})`);
    if (bullets[0]) lines.push(`Plan: ${bullets[0]}`);
    lines.push(t.open.length ? `Open today (${t.open.length}): ${list(t.open.map((x) => `${x.title}${x.reminder ? ` (reminder ${x.reminder})` : ''}`))}` : 'Nothing open for today.');
    if (t.overdue.length) lines.push(`Overdue (${t.overdue.length}): ${list(t.overdue.map((x) => `${x.title} (due ${shortDateDow(x.due!)})`), 5)}`);
    if (t.done.length) lines.push(`Done today (${t.done.length}): ${list(t.done.map((x) => x.title))}`);
    const ev = eventsBetween(ctx, day, day);
    if (ev.length) lines.push(`Events: ${list(ev.map((e) => `${e.time ? hm12(e.time) : 'all day'} ${e.text}`))}`);
    const habits = habitsView(ctx, day).filter((h) => h.scheduledToday);
    if (habits.length) lines.push(`Habits: ${habits.map((h) => `${priv.name(h)} ${h.today === 'clean' ? 'kept' : h.today === 'slip' ? 'slipped' : h.today === 'skip' ? 'skipped' : 'not logged yet'}${h.streak ? ` (streak ${h.streak})` : ''}`).join('; ')}`);
    lines.push(`Next prayer: ${PRAYER_LABELS[np.name]} ${hm12(np.time)}${np.date !== day ? ' tomorrow' : ''}.`);
  } else {
    const { from, to } = weekRange(day);
    const tasks = allTasks(ctx);
    const done = tasks.filter((t) => t.status === 'done' && t.done && t.done >= from && t.done <= to);
    const due = tasks.filter((t) => t.status === 'open' && !t.readonly && t.kind !== 'archive' && t.due && t.due >= day && t.due <= to).sort((a, b) => (a.due! < b.due! ? -1 : 1));
    const overdue = tasks.filter((t) => t.status === 'open' && !t.readonly && t.kind !== 'archive' && t.due && t.due < day);
    lines.push(`Week of ${dateRange(from, to)}`);
    lines.push(`Done this week: ${done.length}.`);
    lines.push(due.length ? `Still due this week (${due.length}): ${list(due.map((t) => `${t.title} (${shortDateDow(t.due!)})`), 10)}` : 'Nothing else due this week.');
    if (overdue.length) lines.push(`Overdue (${overdue.length}): ${list(overdue.map((t) => t.title), 5)}`);
    const ev = eventsBetween(ctx, day, to);
    if (ev.length) lines.push(`Events ahead: ${list(ev.map((e) => `${shortDateDow(e.date)}${e.time ? ` ${hm12(e.time)}` : ''} ${e.text}`), 10)}`);
    const habits = habitsView(ctx, day);
    if (habits.length) lines.push(`Habit streaks: ${habits.map((h) => `${priv.name(h)} ${h.streak} ${h.streak === 1 ? 'day' : 'days'}`).join('; ')}`);
    const nextWeek = eventsBetween(ctx, addDays(to, 1), addDays(to, 7)).length;
    if (nextWeek) lines.push(`Next week has ${nextWeek} ${nextWeek === 1 ? 'event' : 'events'} so far.`);
  }
  return priv.scrub(lines.join('\n'));
}
