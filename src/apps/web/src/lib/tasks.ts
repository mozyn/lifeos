/**
 * Task actions shared by every screen: complete (with the reward) and reopen, through the outbox
 * with the task's line anchor, plus the optimistic overlay of pending writes.
 */
import { useMemo, useSyncExternalStore } from 'react';
import { addDays, daysBetween, hm12, shortDate, weekdayName } from '@lifeos/shared';
import { rewardBig, rewardSmall } from './rewards';
import { on, type OutboxOp, pendingOps, write } from './store';
import type { Task } from './types';

/** Complete a task (with the chime); `closesGroup`: the last open child of a group, the group reward. */
export function completeTask(t: Task, ringEl: HTMLElement | null, closesGroup = false): Promise<unknown> {
  if (closesGroup) rewardBig(ringEl);
  else rewardSmall(ringEl);
  return write({ path: `api/tasks/${t.id}/complete`, body: { path: t.path, line: t.line, hash: t.hash }, kind: 'complete', ref: t.id, label: `"${t.title}"` });
}

export function reopenTask(t: Task): Promise<unknown> {
  return write({ path: `api/tasks/${t.id}/reopen`, body: { path: t.path, line: t.line, hash: t.hash }, kind: 'reopen', ref: t.id, label: `"${t.title}"` });
}

/** The status a task shows: its pending write wins over the last server view. */
export function effectiveStatus(t: Task, pending: OutboxOp[]): Task['status'] {
  for (let i = pending.length - 1; i >= 0; i--) {
    const op = pending[i];
    if (op.ref !== t.id) continue;
    if (op.kind === 'complete') return 'done';
    if (op.kind === 'reopen') return 'open';
  }
  return t.status;
}

const onOutbox = (cb: () => void) => on('outbox', cb);

/**
 * A row's status with the writes still on their way (round 8): each row reads only its own, so a
 * write re-renders the rows it changes, not every row of every mounted screen (the outbox changes
 * two or three times per write).
 */
export function useEffectiveStatus(t: Task): Task['status'] {
  return useSyncExternalStore(onOutbox, () => effectiveStatus(t, pendingOps()));
}

/** The same for a group and its items: `[the group's, …each item's]`, a new array only when one changes. */
export function useEffectiveStatuses(ts: Task[]): Task['status'][] {
  const key = useSyncExternalStore(onOutbox, () => ts.map((t) => effectiveStatus(t, pendingOps())).join(' '));
  return useMemo(() => (key ? (key.split(' ') as Task['status'][]) : []), [key]);
}

/** Done today, counting writes still on their way. */
export function doneCount(base: number, tasks: Task[], pending: OutboxOp[]): number {
  let n = base;
  for (const t of tasks) {
    const eff = effectiveStatus(t, pending);
    if (eff === 'done' && t.status !== 'done') n++;
    if (eff !== 'done' && t.status === 'done') n--;
  }
  return Math.max(0, n);
}

export function dueLabel(due: string | null, today: string): { text: string; tone: 'over' | 'today' | 'soon' | 'later' } | null {
  if (!due) return null;
  const d = daysBetween(today, due);
  if (d < 0) return { text: d === -1 ? 'Yesterday' : `${-d} days overdue`, tone: 'over' };
  if (d === 0) return { text: 'Today', tone: 'today' };
  if (d === 1) return { text: 'Tomorrow', tone: 'soon' };
  if (d < 7) return { text: weekdayName(due), tone: 'soon' };
  return { text: shortDate(due), tone: 'later' };
}

export function reminderLabel(r: string | null): string | null {
  if (!r) return null;
  const m = /^(\d{4}-\d{2}-\d{2})?\s*(\d{1,2}:\d{2})?$/.exec(r.trim());
  if (m && (m[1] || m[2])) return m[2] ? hm12(m[2].padStart(5, '0')) : shortDate(m[1]!);
  const p = /^(fajr|sunrise|dhuhr|asr|maghrib|isha)([+-]\d+)?$/i.exec(r.trim());
  if (p) {
    const name = p[1][0].toUpperCase() + p[1].slice(1).toLowerCase();
    if (!p[2]) return `At ${name}`;
    const n = Number(p[2]);
    return n > 0 ? `${n} min after ${name}` : `${-n} min before ${name}`;
  }
  return r;
}

export { addDays };
