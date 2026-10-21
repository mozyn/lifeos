/**
 * Read models built from the index (never from a second copy of the data): Today, habits,
 * captures, events. Counters are derived from the vault every time (spec §7).
 */
import {
  addDays,
  bestStreak,
  currentStreak,
  FIVE,
  hijri,
  hm12,
  momentOf,
  nextPrayer,
  parseSchedule,
  plannedToday,
  PRAYER_LABELS,
  prayerTimes,
  selectFocus,
  weekRange,
  type CheckinLine,
  type HabitLog,
  type MoodLine,
} from '@lifeos/shared';
import type { Ctx } from './context.js';
import { draftDto, type DraftDto } from './drafts.js';
import { taskDto, type TaskDto, type TaskRow, withGroups } from './routes/tasks.js';

export interface EventDto {
  id: string;
  path: string;
  line: number;
  hash: string;
  date: string;
  time: string | null;
  text: string;
}

export function allTasks(ctx: Ctx): TaskDto[] {
  return (ctx.db.prepare("SELECT * FROM tasks WHERE list = 'tasks'").all() as TaskRow[]).map(taskDto);
}

export function planBullets(ctx: Ctx, date: string): string[] {
  return (ctx.db.prepare("SELECT json FROM daily_entries WHERE date = ? AND kind = 'plan' ORDER BY line").all(date) as { json: string }[]).map((r) => (JSON.parse(r.json) as { text: string }).text);
}

export function eventsBetween(ctx: Ctx, from: string, to: string): EventDto[] {
  const rows = ctx.db.prepare('SELECT id, path, line, hash, date, time, text FROM events WHERE date >= ? AND date <= ? ORDER BY date, time IS NULL, time, line').all(from, to) as EventDto[];
  return rows;
}

// ---------------------------------------------------------------- habits

export interface HabitDto {
  slug: string;
  path: string;
  title: string;
  kind: 'quit' | 'build';
  status: string;
  schedule: string;
  started: string | null;
  why: string | null;
  /** frontmatter `private: true` (round-2 brief §6): blurred in Privacy mode, never named in a nudge */
  private: boolean;
  scheduledToday: boolean;
  today: 'clean' | 'slip' | 'skip' | null;
  streak: number;
  best: number;
  logs: HabitLog[];
}

export function habitsView(ctx: Ctx, today: string, includeInactive = false): HabitDto[] {
  const files = ctx.db.prepare("SELECT path, title, fm, status FROM files WHERE kind = 'habit' ORDER BY title").all() as { path: string; title: string; fm: string; status: string | null }[];
  const logsBy = new Map<string, HabitLog[]>();
  for (const l of ctx.db.prepare('SELECT path, date, value, note FROM habit_logs ORDER BY date').all() as { path: string; date: string; value: 'clean' | 'slip' | 'skip'; note: string | null }[]) {
    logsBy.set(l.path, [...(logsBy.get(l.path) ?? []), { date: l.date, value: l.value, note: l.note }]);
  }
  const out: HabitDto[] = [];
  for (const f of files) {
    const fm = JSON.parse(f.fm) as Record<string, unknown>;
    const status = String(fm.status ?? 'active');
    if (!includeInactive && status !== 'active') continue;
    const logs = logsBy.get(f.path) ?? [];
    const schedule = String(fm.schedule ?? 'daily');
    const started = typeof fm.started === 'string' ? fm.started : null;
    out.push({
      slug: f.path.split('/').pop()!.replace(/\.md$/, ''),
      path: f.path,
      title: f.title,
      kind: fm.kind === 'quit' ? 'quit' : 'build',
      status,
      schedule,
      started,
      why: typeof fm.why === 'string' ? fm.why : null,
      private: fm.private === true || String(fm.private ?? '').toLowerCase() === 'true',
      scheduledToday: parseSchedule(schedule)(today),
      today: logs.filter((l) => l.date === today).at(-1)?.value ?? null,
      streak: currentStreak(logs, schedule, started, today),
      best: bestStreak(logs, schedule, started, today),
      logs,
    });
  }
  return out;
}

/** The names (titles and slugs) of private habits, archived ones too: Privacy mode curtains them in drafts and plans (ADR-63). */
export function privateHabitNames(ctx: Ctx): string[] {
  const rows = ctx.db.prepare("SELECT path, title, fm FROM files WHERE kind IN ('habit', 'archived-habit')").all() as { path: string; title: string; fm: string }[];
  return rows
    .filter((r) => {
      const v = (JSON.parse(r.fm) as Record<string, unknown>).private;
      return v === true || String(v ?? '').toLowerCase() === 'true';
    })
    .flatMap((r) => [r.title, r.path.split('/').pop()!.replace(/\.md$/, '')]);
}

// ---------------------------------------------------------------- ring captures

export interface CaptureDto {
  path: string;
  slug: string;
  title: string;
  date: string | null;
  time: string | null;
  tags: string[];
  needsReview: boolean;
  hasTask: boolean;
  decision: string | null;
  preview: string;
}

export function capturesView(ctx: Ctx): CaptureDto[] {
  const files = ctx.db.prepare("SELECT path, title, date, fm, tags, lifeos, preview, status FROM files WHERE kind = 'capture' ORDER BY path DESC").all() as {
    path: string;
    title: string;
    date: string | null;
    fm: string;
    tags: string;
    lifeos: string | null;
    preview: string;
    status: string | null;
  }[];
  const linked = new Set(
    (ctx.db.prepare('SELECT capture FROM tasks WHERE capture IS NOT NULL').all() as { capture: string }[]).map((r) => r.capture.split('/').pop()!.replace(/\.md$/, '')),
  );
  return files.map((f) => {
    const fm = JSON.parse(f.fm) as Record<string, unknown>;
    const tags = JSON.parse(f.tags) as string[];
    const slug = f.path.split('/').pop()!.replace(/\.md$/, '');
    const time = fm.time !== undefined ? String(fm.time).slice(0, 5) : (/^\d{4}-\d{2}-\d{2}-(\d{2})(\d{2})/.exec(slug)?.slice(1, 3).join(':') ?? null);
    return {
      path: f.path,
      slug,
      title: f.title,
      date: f.date,
      time,
      tags,
      needsReview: tags.includes('needs-review') || f.status === 'needs_review',
      hasTask: linked.has(slug),
      decision: f.lifeos,
      preview: f.preview,
    };
  });
}

/** Evening "nothing unsorted" (spec §6): today's captures that need review or yielded no task, not yet decided. */
export function unsortedToday(captures: CaptureDto[], today: string): CaptureDto[] {
  return captures.filter((c) => c.date === today && !c.decision && (c.needsReview || !c.hasTask));
}

// ---------------------------------------------------------------- Today

export interface TodayDto {
  date: string;
  hm: string;
  moment: 'morning' | 'midday' | 'evening';
  hijri: string;
  /** the Hijri day of the month (the night arc's moon, round-2 brief §2) */
  hijriDay: number;
  prayers: Record<string, string>;
  next: { name: string; label: string; time: string; at: string; date: string };
  plan: { headline: string | null; bullets: string[] };
  draft: DraftDto | null;
  review: DraftDto | null;
  tomorrowDraft: DraftDto | null;
  focus: TaskDto[];
  remaining: TaskDto[];
  doneToday: TaskDto[];
  overdue: TaskDto[];
  counters: { doneToday: number; doneWeek: number; longestStreak: number; planned: number };
  events: { today: EventDto[]; upcoming: EventDto[] };
  habits: HabitDto[];
  /** private habit names, for Privacy mode in drafts and plans (ADR-63) */
  privateNames: string[];
  inbox: { needsReview: number; sinceMorning: number };
  checkin: { checkins: CheckinLine[]; moods: MoodLine[]; morningLogged: boolean; eveningLogged: boolean };
  unsorted: CaptureDto[];
  reminders: { undelivered: number };
  session: { complete: boolean };
}

export function buildToday(ctx: Ctx): TodayDto {
  const date = ctx.today();
  const hm = ctx.hm();
  const s = ctx.settings();
  const times = prayerTimes(date, s.prayer);
  const np = nextPrayer(ctx.now(), s.prayer);
  const tasks = allTasks(ctx);
  const bullets = planBullets(ctx, date);
  const focus = selectFocus(tasks, bullets.slice(1), date) as TaskDto[];
  const planned = plannedToday(tasks, bullets.slice(1), date) as TaskDto[];
  const doneToday = tasks.filter((t) => t.status === 'done' && t.done === date);
  const { from } = weekRange(date);
  const doneWeek = tasks.filter((t) => t.status === 'done' && t.done && t.done >= from && t.done <= date).length;
  const habits = habitsView(ctx, date);
  const evToday = eventsBetween(ctx, date, date);
  const upcoming = eventsBetween(ctx, date, addDays(date, 14))
    .filter((e) => e.date > date || (e.time !== null && e.time >= hm))
    .slice(0, 3);
  const entries = ctx.db.prepare("SELECT kind, json FROM daily_entries WHERE date = ? AND kind IN ('checkin', 'mood') ORDER BY line").all(date) as { kind: string; json: string }[];
  const checkins = entries.filter((e) => e.kind === 'checkin').map((e) => JSON.parse(e.json) as CheckinLine);
  const moods = entries.filter((e) => e.kind === 'mood').map((e) => JSON.parse(e.json) as MoodLine);
  const captures = capturesView(ctx);
  const unsorted = unsortedToday(captures, date);
  const eveningLogged = moods.some((m) => momentOf(m.time) === 'evening' && (m.mood !== undefined || m.energy !== undefined));
  const draftRow = (kind: string, d: string) => ctx.db.prepare("SELECT * FROM drafts WHERE kind = ? AND date = ? AND status IN ('pending', 'generating') ORDER BY generated_at DESC LIMIT 1").get(kind, d);
  const asDraft = (r: unknown) => (r ? draftDto(r as Parameters<typeof draftDto>[0]) : null);
  const undelivered = (ctx.db.prepare("SELECT count(*) n FROM deliveries WHERE status IN ('failed', 'retry')").get() as { n: number }).n;
  return {
    date,
    hm,
    moment: momentOf(hm),
    hijri: hijri(date, s.hijriOffset).label,
    hijriDay: hijri(date, s.hijriOffset).day,
    prayers: times,
    next: { name: np.name, label: PRAYER_LABELS[np.name], time: np.time, at: np.at.toISOString(), date: np.date },
    plan: { headline: bullets[0] ?? null, bullets },
    draft: asDraft(draftRow('morning_plan', date)),
    review: asDraft(draftRow('evening_review', date)),
    tomorrowDraft: asDraft(draftRow('morning_plan', addDays(date, 1))),
    // a group's children ride on their parent's row (round-2 brief §10)
    focus: withGroups(focus, tasks),
    remaining: withGroups(planned.filter((t) => t.status === 'open'), tasks),
    doneToday: withGroups(doneToday, tasks),
    overdue: withGroups(tasks.filter((t) => t.status === 'open' && !t.readonly && t.kind !== 'archive' && t.due && t.due < date), tasks),
    counters: { doneToday: doneToday.length, doneWeek, longestStreak: Math.max(0, ...habits.map((h) => h.streak)), planned: planned.length },
    events: { today: evToday, upcoming },
    habits: habits.filter((h) => h.scheduledToday),
    privateNames: privateHabitNames(ctx),
    inbox: { needsReview: captures.filter((c) => c.needsReview && !c.decision).length, sinceMorning: captures.filter((c) => c.date === date && c.time !== null && c.time >= '11:00').length },
    checkin: { checkins, moods, morningLogged: checkins.some((c) => momentOf(c.time) === 'morning'), eveningLogged },
    unsorted,
    reminders: { undelivered },
    session: { complete: unsorted.length === 0 && eveningLogged },
  };
}

export const prayerLabel = (name: string, time: string) => `${PRAYER_LABELS[name as keyof typeof PRAYER_LABELS] ?? name} ${hm12(time)}`;
export { FIVE };
