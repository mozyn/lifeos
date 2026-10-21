/**
 * Today's selections (spec §6, §7, §9 fallback): which tasks are in focus, what counts as planned,
 * and the deterministic morning plan used when the model is down.
 */
import { addDays, mondayOf } from './dates.js';
import { PRIORITY_RANK, type Priority } from './task.js';

export interface TaskLite {
  id: string;
  title: string;
  status: 'open' | 'done' | 'cancelled';
  due: string | null;
  done: string | null;
  priority: string | null;
  readonly?: boolean;
  kind?: string;
  /** a task group's child (round-2 brief §10): it rides on its parent's row, never on its own */
  parentId?: string | null;
}

/** Text compared the way a plan bullet names a task: lower case, letters and digits only. */
export function normTitle(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const rank = (t: TaskLite) => PRIORITY_RANK[(t.priority as Priority) ?? 'none'] ?? PRIORITY_RANK.none;

function eligible(t: TaskLite): boolean {
  return !t.readonly && t.kind !== 'archive' && !t.parentId;
}

/**
 * Focus (spec §6 morning): tasks picked in the plan first (in plan order), then overdue (oldest
 * first), then due today by priority. Tasks completed today keep their place, checked, so the
 * list does not jump as things get done. At most `limit`.
 */
export function selectFocus(tasks: TaskLite[], planBullets: string[], today: string, limit = 5): TaskLite[] {
  const pool = tasks.filter((t) => eligible(t) && (t.status === 'open' || (t.status === 'done' && t.done === today)));
  const out: TaskLite[] = [];
  const add = (t: TaskLite) => {
    if (!out.includes(t)) out.push(t);
  };
  const byTitle = new Map<string, TaskLite[]>();
  for (const t of pool) byTitle.set(normTitle(t.title), [...(byTitle.get(normTitle(t.title)) ?? []), t]);
  for (const b of planBullets) {
    const hit = byTitle.get(normTitle(b));
    if (hit) hit.forEach(add);
  }
  pool
    .filter((t) => t.due && t.due < today)
    .sort((a, b) => (a.due! < b.due! ? -1 : a.due! > b.due! ? 1 : rank(a) - rank(b)))
    .forEach(add);
  pool
    .filter((t) => t.due === today)
    .sort((a, b) => rank(a) - rank(b))
    .forEach(add);
  return out.slice(0, limit);
}

/** Planned today: everything focus could draw from (not capped), done today included. */
export function plannedToday(tasks: TaskLite[], planBullets: string[], today: string): TaskLite[] {
  const all = selectFocus(tasks, planBullets, today, Number.MAX_SAFE_INTEGER);
  for (const t of tasks) if (eligible(t) && t.status === 'done' && t.done === today && !all.includes(t)) all.push(t);
  return all;
}

export function weekRange(today: string): { from: string; to: string } {
  const from = mondayOf(today);
  return { from, to: addDays(from, 6) };
}

export interface FallbackPlan {
  headline: string;
  focus: { text: string; source_task_id: string | null; new: boolean }[];
  notes: string[];
}

/** Spec §9 job 1 fallback: focus = overdue first, then due today by priority; headline "N tasks, M events, next prayer X". */
export function fallbackPlan(tasks: TaskLite[], today: string, events: number, nextPrayer: string): FallbackPlan {
  const focus = selectFocus(
    tasks.filter((t) => t.status === 'open'),
    [],
    today,
  );
  const n = tasks.filter((t) => eligible(t) && t.status === 'open' && t.due && t.due <= today).length;
  const headline = `${n} ${n === 1 ? 'task' : 'tasks'}, ${events} ${events === 1 ? 'event' : 'events'}, next prayer ${nextPrayer}`;
  return { headline, focus: focus.map((t) => ({ text: t.title, source_task_id: t.id, new: false })), notes: [] };
}
