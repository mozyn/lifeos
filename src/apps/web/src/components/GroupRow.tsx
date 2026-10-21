/**
 * A task group (round-2 brief §10): the parent's row shows "3 of 5" and expands to its children;
 * completing the last open child completes the group (the group reward), completing the parent
 * closes what is left. An item may repeat on its own (round-3 brief §3): it comes back in the
 * group and keeps it open. Tapping the title opens the group sheet: title, repeat and items.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { ChevronDown, Repeat, X } from 'lucide-react';
import { noteLabel, parseRecurrence, weekdayName } from '@lifeos/shared';
import { Sheet } from './ui';
import { Check, checkOf, TaskRow, taskActions } from './TaskRow';
import { SwipeRow } from './SwipeRow';
import { useGone } from '../lib/edits';
import { ApiError } from '../lib/api';
import { emit, on, toast, usePending, write } from '../lib/store';
import { completeTask, dueLabel, effectiveStatus, reopenTask } from '../lib/tasks';
import type { Task } from '../lib/types';
import { drillIn } from '../lib/transitions';

/** Which groups are open, kept while the app runs (a refresh must not fold a list someone is ticking). */
const expanded = new Set<string>();

/** "Every Saturday" from `every saturday`. */
export function recurText(recur: string | null): string | null {
  if (!recur) return null;
  return recur.replace(/^every/i, 'Every').replace(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, (d) => d[0].toUpperCase() + d.slice(1).toLowerCase());
}

export function GroupRow({ task, today }: { task: Task; today: string }) {
  const pending = usePending();
  const gone = useGone();
  const g = task.group!;
  const [open, setOpen] = useState(() => expanded.has(task.id));
  const status = effectiveStatus(task, pending);
  const done = status === 'done';
  const kids = g.children.map((c) => ({ c, s: effectiveStatus(c, pending) }));
  const doneN = kids.filter((k) => k.s === 'done').length;
  const total = kids.filter((k) => k.s !== 'cancelled').length;
  const due = done ? null : dueLabel(task.due, today);
  const rec = recurText(task.recur);
  const toggle = () => {
    if (expanded.has(task.id)) expanded.delete(task.id);
    else expanded.add(task.id);
    setOpen(!open);
  };
  const completeParent = (el: HTMLElement | null) => {
    if (task.readonly) return;
    const left = kids.filter((k) => k.s === 'open').length;
    const p = done ? reopenTask(task) : completeTask(task, el, !done);
    p.then(() => !done && left > 0 && toast(`${task.title} done; ${left} open ${left === 1 ? 'item' : 'items'} closed for this time`)).catch((e: unknown) => toast(e instanceof ApiError ? e.message : 'That change could not be saved.', 'error'));
  };
  /** a child completed: the last open one closes the group, with the group reward (one with its own repeat comes back instead, ADR-65) */
  const childDone = (c: Task) => !c.recur && kids.filter((k) => k.c.id !== c.id && k.s === 'open').length === 0;
  if (gone.has(task.id)) return null;
  // a group's delete takes its items with it (one Undo puts the whole block back)
  const a = taskActions({ ...task, title: `${task.title} (${g.children.length} items)` }, done, () => completeParent(checkOf(task.id)));
  return (
    <div className="group" data-testid="group-row" data-task-id={task.id} data-open={open ? '' : undefined}>
      <SwipeRow rowKey={task.id} data-check="" className="group-head" data-done={done ? '' : undefined} right={a.right} left={a.left} menu={a.menu} menuTitle={task.title} select={a.select}>
        <Check checked={done} onToggle={completeParent} label={`${done ? 'Reopen' : 'Complete'} the group: ${task.title}`} disabled={task.readonly} testId="group-check" />
        <div className="row-main">
          <button type="button" className="row-title row-open" onClick={(e) => void drillIn(e.currentTarget, () => openGroupSheet(task))} data-testid="group-open">
            {task.title}
          </button>
          <span className="row-meta">
            <span className={`tag group-count${doneN === total && total > 0 ? ' goal' : ''}`} data-testid="group-count">
              {doneN} of {total}
            </span>
            {due && <span className={`tag ${due.tone === 'over' ? 'due-over' : due.tone === 'today' ? 'due-today' : ''}`}>{due.text}</span>}
            {rec && (
              <span className="tag">
                <Repeat size={12} aria-hidden style={{ marginRight: 4 }} />
                {rec}
              </span>
            )}
            {task.slugs.map((s) => (
              <span key={s} className="tag goal">
                @{s}
              </span>
            ))}
          </span>
        </div>
        <button type="button" className="icon-btn group-toggle" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} the ${g.children.length} items of ${task.title}`} onClick={toggle} data-testid="group-toggle">
          <ChevronDown aria-hidden />
        </button>
      </SwipeRow>
      {open && (
        <div className="rows group-children" data-testid="group-children">
          {g.children.map((c) => (
            <TaskRow key={c.id} task={c} today={today} child closesGroup={() => childDone(c)} />
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ the group sheet

let current: Task | null = null;
export function openGroupSheet(t: Task | null): void {
  current = t;
  emit('group-sheet');
}

export function GroupSheetHost() {
  const t = useSyncExternalStore((cb) => on('group-sheet', cb), () => current);
  return t ? <GroupSheet task={t} onClose={() => openGroupSheet(null)} /> : null;
}

const REPEATS = (due: string | null) => [
  { v: '', label: 'Once' },
  { v: 'every day', label: 'Every day' },
  { v: due ? `every ${weekdayName(due, 'long').toLowerCase()}` : 'every week', label: due ? `Every ${weekdayName(due, 'long')}` : 'Every week' },
  { v: 'every month', label: 'Every month' },
];

function GroupSheet({ task, onClose }: { task: Task; onClose: () => void }) {
  const children = task.group?.children ?? [];
  const [title, setTitle] = useState(task.title);
  const [recur, setRecur] = useState(task.recur ?? '');
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setTitle(task.title);
    setRecur(task.recur ?? '');
    setTexts({});
    setRemoved(new Set());
    setAdded([]);
  }, [task]);
  const repeats = REPEATS(task.due);
  const custom = recur && !repeats.some((r) => r.v === recur);
  const recurOk = !recur.trim() || !!parseRecurrence(recur);
  const save = async () => {
    setBusy(true);
    try {
      const body = {
        path: task.path,
        line: task.line,
        hash: task.hash,
        title: title.trim() !== task.title ? title.trim() : undefined,
        recur: recur.trim() !== (task.recur ?? '') ? recur.trim() || null : undefined,
        children: children.filter((c) => removed.has(c.id) || (texts[c.id] !== undefined && texts[c.id].trim() && texts[c.id].trim() !== c.title)).map((c) => ({ line: c.line, hash: c.hash, remove: removed.has(c.id) || undefined, text: removed.has(c.id) ? undefined : texts[c.id]?.trim() })),
        add: [...added, ...(draft.trim() ? [draft.trim()] : [])],
      };
      await write({ method: 'PUT', path: 'api/groups', body, kind: 'group', ref: task.id, label: 'Group' });
      toast('Group saved');
      onClose();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Not saved.', 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title="Group"
      testId="group-sheet"
      footer={
        <button type="button" className="btn btn-primary btn-block" disabled={busy || !title.trim() || !recurOk} onClick={() => void save()} data-testid="group-save">
          Save group
        </button>
      }
    >
      <label className="field">
        <span>Title</span>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} data-testid="group-title" />
      </label>
      <div className="field">
        <span>Repeats</span>
        <div className="picks" role="radiogroup" aria-label="Repeats">
          {repeats.map((r) => (
            <button key={r.label} type="button" role="radio" className="pick" aria-checked={recur === r.v} onClick={() => setRecur(r.v)} data-testid={`group-repeat-${r.v ? r.v.replace(/\s+/g, '-') : 'once'}`}>
              {r.label}
            </button>
          ))}
        </div>
        <input className="input" value={custom ? recur : ''} onChange={(e) => setRecur(e.target.value)} placeholder="or type one: every 2 weeks, every monday, friday" aria-label="Repeat rule" aria-invalid={!recurOk} />
        {!recurOk && <span className="error">LifeOS reads repeats like “every saturday”, “every 2 weeks”, “every month”.</span>}
        <span className="caption">When a repeating group is done, the next one is added below it with every item unticked.</span>
      </div>
      <div className="field">
        <span>Items</span>
        <ul className="group-edit">
          {children.map((c) =>
            removed.has(c.id) ? null : (
              <li key={c.id}>
                <input className="input" value={texts[c.id] ?? c.title} onChange={(e) => setTexts({ ...texts, [c.id]: e.target.value })} aria-label={`Item: ${c.title}`} />
                <button type="button" className="icon-btn" aria-label={`Remove ${c.title}`} onClick={() => setRemoved(new Set([...removed, c.id]))} data-testid="group-item-remove">
                  <X />
                </button>
              </li>
            ),
          )}
          {added.map((a, i) => (
            <li key={`new${i}`}>
              <input className="input" value={a} onChange={(e) => setAdded(added.map((x, k) => (k === i ? e.target.value : x)))} aria-label={`New item ${i + 1}`} />
              <button type="button" className="icon-btn" aria-label={`Remove ${a}`} onClick={() => setAdded(added.filter((_, k) => k !== i))}>
                <X />
              </button>
            </li>
          ))}
        </ul>
        <div className="edit-row" data-reveal>
          <input
            className="input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && draft.trim()) {
                setAdded([...added, draft.trim()]);
                setDraft('');
              }
            }}
            placeholder="Add an item"
            aria-label="Add an item"
            data-testid="group-add-input"
          />
          <button
            type="button"
            className="btn"
            disabled={!draft.trim()}
            onClick={() => {
              setAdded([...added, draft.trim()]);
              setDraft('');
            }}
          >
            Add
          </button>
        </div>
      </div>
      <p className="caption">Items share the group&rsquo;s date and goal unless they carry their own. Saved in {noteLabel(task.path)}: the group&rsquo;s line and the lines under it only.</p>
    </Sheet>
  );
}
