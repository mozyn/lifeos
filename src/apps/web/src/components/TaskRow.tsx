/**
 * A task row: the glass checkbox (spec §6: "each row: glass checkbox, text, due/goal chips"). The
 * checkbox is a quiet ring at rest; while pressed a clear lens materializes over it (glass on the
 * control layer only), and completing swells and pops it with the chime (lib/rewards.ts).
 */
import { useRef } from 'react';
import { Check as CheckIcon, FolderInput, Lock, Pencil, Repeat, RotateCcw, Trash2 } from 'lucide-react';
import { Glass } from '../glass/Glass';
import { controllerFor } from '../glass/engine';
import { motionReduced } from '../glass/spring';
import { ApiError } from '../lib/api';
import { toast, usePending } from '../lib/store';
import { completeTask, dueLabel, effectiveStatus, reminderLabel, reopenTask } from '../lib/tasks';
import type { Task } from '../lib/types';
import { openTaskSheet } from './TaskSheet';
import { GroupRow, openGroupSheet, recurText } from './GroupRow';
import { type MenuItem } from './RowMenu';
import { type RowAction, SwipeRow } from './SwipeRow';
import { openMove } from './MoveSheet';
import { anchorOf, deleteLines, useGone } from '../lib/edits';
import type { Selectable } from '../lib/selection';
import { drillIn } from '../lib/transitions';

export function Check({ checked, onToggle, label, disabled, testId }: { checked: boolean; onToggle: (ring: HTMLElement | null) => void; label: string; disabled?: boolean; testId?: string }) {
  const lens = useRef<HTMLElement | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <button
      ref={btn}
      type="button"
      role="checkbox"
      className="check"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      data-testid={testId}
      onPointerDown={() => {
        if (!motionReduced() && lens.current) void controllerFor(lens.current)?.materialize(1);
      }}
      onPointerUp={() => lens.current && void controllerFor(lens.current)?.materialize(0)}
      onPointerCancel={() => lens.current && void controllerFor(lens.current)?.materialize(0)}
      onClick={() => onToggle(btn.current)}
    >
      <span className="check-ring">
        <CheckIcon aria-hidden />
      </span>
      <Glass ref={lens} className="check-lens" variant="clear" profile="lens" dormant bezel={8} aria-hidden />
    </button>
  );
}

export function TaskRow({ task, today, onCompleted, showSource, child, closesGroup }: { task: Task; today: string; onCompleted?: (t: Task, el: HTMLElement | null) => void; showSource?: boolean; child?: boolean; closesGroup?: () => boolean }) {
  if (task.group && !child) return <GroupRow task={task} today={today} />;
  return <PlainRow task={task} today={today} onCompleted={onCompleted} showSource={showSource} child={child} closesGroup={closesGroup} />;
}

/** A row's checkbox (the reward plays on it when a swipe completes the task). */
export const checkOf = (key: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(key)}"] .check`);

/** What a task row can do, for its swipes, its menu and the bulk bar. */
export function taskActions(task: Task, done: boolean, toggle: () => void) {
  const editable = !task.readonly;
  const label = task.title;
  const select: Selectable | null = editable ? { key: task.id, kind: 'task', label, ref: anchorOf(task), id: task.id, open: !done } : null;
  const remove = () => void deleteLines([{ ref: anchorOf(task), kind: 'task', key: task.id, label }]);
  const move = () => openMove({ kind: 'task', items: [select!] });
  return {
    select,
    right: editable ? ({ label: done ? 'Reopen' : 'Done', icon: done ? <RotateCcw aria-hidden /> : <CheckIcon aria-hidden />, tone: 'ok', run: toggle } as RowAction) : null,
    left: editable ? ({ label: 'Delete', icon: <Trash2 aria-hidden />, tone: 'danger', away: true, run: remove } as RowAction) : null,
    menu: editable
      ? (): MenuItem[] => [
          { label: 'Edit', icon: <Pencil aria-hidden />, run: () => (task.group ? openGroupSheet(task) : openTaskSheet(task)), testId: 'menu-edit' },
          { label: 'Move', icon: <FolderInput aria-hidden />, run: move, testId: 'menu-move' },
          { label: 'Delete', icon: <Trash2 aria-hidden />, run: remove, tone: 'danger', testId: 'menu-delete' },
        ]
      : undefined,
  };
}

function PlainRow({ task, today, onCompleted, showSource, child, closesGroup }: { task: Task; today: string; onCompleted?: (t: Task, el: HTMLElement | null) => void; showSource?: boolean; child?: boolean; closesGroup?: () => boolean }) {
  const pending = usePending();
  const gone = useGone();
  const status = effectiveStatus(task, pending);
  const done = status === 'done';
  const due = done ? null : dueLabel(task.due, today);
  const rem = done ? null : reminderLabel(task.reminder);
  // a group's item with its own repeat says so (round-3 brief §3)
  const rec = child ? recurText(task.recur) : null;
  const toggle = (el: HTMLElement | null) => {
    if (task.readonly) return;
    const p = done ? reopenTask(task) : completeTask(task, el, !!closesGroup?.());
    if (!done) onCompleted?.(task, el);
    p.catch((e: unknown) => toast(e instanceof ApiError ? e.message : 'That change could not be saved.', 'error'));
  };
  if (gone.has(task.id)) return null;
  const a = taskActions(task, done, () => toggle(checkOf(task.id)));
  return (
    <SwipeRow
      rowKey={task.id}
      data-check=""
      className={child ? 'child' : undefined}
      data-done={done ? '' : undefined}
      testId={child ? 'group-child' : 'task-row'}
      data-task-id={task.id}
      right={a.right}
      left={a.left}
      menu={a.menu}
      menuTitle={task.title}
      select={a.select}
    >
      <Check checked={done} onToggle={toggle} label={`${done ? 'Reopen' : 'Complete'}: ${task.title}`} disabled={task.readonly} testId="task-check" />
      <div className="row-main">
        <button type="button" className="row-title row-open" onClick={(e) => void drillIn(e.currentTarget, () => openTaskSheet(task))} data-testid="task-open">
          {task.title}
        </button>
        {((due && !(child && task.dueInherited)) || rem || rec || (!child && task.slugs.length > 0) || task.readonly || (showSource && task.capture)) && (
          <span className="row-meta">
            {due && !(child && task.dueInherited) && <span className={`tag ${due.tone === 'over' ? 'due-over' : due.tone === 'today' ? 'due-today' : ''}`}>{due.text}</span>}
            {rem && <span className="tag">{rem}</span>}
            {rec && (
              <span className="tag" data-testid="child-repeat">
                <Repeat size={12} aria-hidden style={{ marginRight: 4 }} />
                {rec}
              </span>
            )}
            {!child && task.slugs.map((s) => (
              <span key={s} className="tag goal">
                @{s}
              </span>
            ))}
            {task.readonly && (
              <span className="tag" title="In a ring-pipeline section: LifeOS does not edit it">
                <Lock size={12} aria-hidden style={{ marginRight: 4 }} />
                Ring section
              </span>
            )}
          </span>
        )}
      </div>
    </SwipeRow>
  );
}
