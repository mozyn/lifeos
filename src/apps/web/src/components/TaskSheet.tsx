/**
 * A task's sheet (spec §5.1: complete, reschedule, set reminder; round-2 brief §12: everything else).
 * Opened by tapping a task's text. Editing normalizes the line to the emoji format; nothing else in
 * the note changes.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { addDays, noteLabel, todayIn } from '@lifeos/shared';
import { Sheet } from './ui';
import { ApiError } from '../lib/api';
import { emit, on, toast, useResource, write } from '../lib/store';
import { anchorOf, deleteLines } from '../lib/edits';
import { FolderInput, Trash2 } from 'lucide-react';
import { openMove } from './MoveSheet';
import { dueLabel, reminderLabel } from '../lib/tasks';
import type { Task } from '../lib/types';

const PRAYER_ANCHORS = [
  { v: 'fajr+15', label: 'After Fajr' },
  { v: 'dhuhr+15', label: 'After Dhuhr' },
  { v: 'asr+15', label: 'After Asr' },
  { v: 'maghrib+30', label: 'After Maghrib' },
  { v: 'isha+15', label: 'After Isha' },
];

const PRIORITIES: { v: string | null; label: string }[] = [
  { v: null, label: 'None' },
  { v: 'low', label: 'Low' },
  { v: 'medium', label: 'Medium' },
  { v: 'high', label: 'High' },
];
/** the two extremes the Tasks plugin also has, offered only on a task that already uses one */
const EXTREMES: Record<string, string> = { highest: 'Highest', lowest: 'Lowest' };

const tagsOf = (s: string) => [...new Set(s.split(/[\s,]+/).map((t) => t.replace(/^#/, '').trim()).filter(Boolean))];

/**
 * A task's sheet (spec §5.1, round-2 brief §12): its words, due date and reminder (applied at once,
 * as before), priority, goals and tags (saved together), Move and Delete. Only the task's line
 * changes; Delete takes the lines under it too, and Undo puts them all back.
 */
export function TaskSheet({ task, onClose }: { task: Task | null; onClose: () => void }) {
  const today = todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [prio, setPrio] = useState<string | null>(null);
  const [slugs, setSlugs] = useState<string[]>([]);
  const [tags, setTags] = useState('');
  const { data: goals } = useResource<{ goals: { slug: string; title: string; status: string }[]; projects: { slug: string; title: string; status: string }[] }>(task && !task.readonly ? 'api/goals' : null);
  useEffect(() => {
    setDate(task?.due ?? '');
    const m = /(\d{1,2}:\d{2})$/.exec(task?.reminder ?? '');
    setTime(m ? m[1].padStart(5, '0') : '');
    setText(task?.title ?? '');
    setPrio(task?.priority ?? null);
    setSlugs(task?.slugs ?? []);
    setTags((task?.tags ?? []).join(' '));
  }, [task]);
  if (!task) return <Sheet open={false} onClose={onClose} title="">{null}</Sheet>;
  const edit = async (patch: { due?: string | null; reminder?: string | null }, label: string) => {
    setBusy(true);
    try {
      await write({ method: 'PATCH', path: `api/tasks/${task.id}`, body: { path: task.path, line: task.line, hash: task.hash, ...patch }, kind: 'edit', ref: task.id, label });
      toast(label);
      onClose();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Not saved.', 'error');
    } finally {
      setBusy(false);
    }
  };
  const tagList = tagsOf(tags);
  const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  const dirty = (text.trim() && text.trim() !== task.title) || prio !== (task.priority ?? null) || !sameList(slugs, task.slugs) || !sameList(tagList, task.tags);
  const save = async () => {
    setBusy(true);
    try {
      await write({
        method: 'PATCH',
        path: `api/tasks/${task.id}`,
        body: {
          path: task.path,
          line: task.line,
          hash: task.hash,
          text: text.trim() !== task.title ? text.trim() : undefined,
          priority: prio !== (task.priority ?? null) ? prio : undefined,
          slugs: !sameList(slugs, task.slugs) ? slugs : undefined,
          tags: !sameList(tagList, task.tags) ? tagList : undefined,
        },
        kind: 'edit',
        ref: task.id,
        label: 'Edit task',
      });
      toast('Task saved');
      onClose();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Not saved.', 'error');
    } finally {
      setBusy(false);
    }
  };
  const due = dueLabel(task.due, today);
  const open = !task.readonly && task.status === 'open';
  const targets = [...(goals?.goals ?? []), ...(goals?.projects ?? [])].filter((g) => g.status === 'active' || slugs.includes(g.slug));
  const unknown = slugs.filter((s) => !targets.some((g) => g.slug === s));
  const sel = { key: task.id, kind: 'task' as const, label: task.title, ref: anchorOf(task), id: task.id, open };
  return (
    <Sheet
      open
      onClose={onClose}
      title="Task"
      testId="task-sheet"
      footer={
        task.readonly ? undefined : (
          <button type="button" className="btn btn-primary btn-block" disabled={busy || !dirty || !text.trim()} onClick={() => void save()} data-testid="task-save">
            Save changes
          </button>
        )
      }
    >
      {task.readonly ? (
        <>
          <p className="sheet-task-title">{task.title}</p>
          <p className="secondary">This line is in a ring-pipeline section; LifeOS leaves it as it is.</p>
        </>
      ) : (
        <label className="field">
          <span>Task</span>
          <input className="input" value={text} onChange={(e) => setText(e.target.value)} aria-label="Task" data-testid="task-text" />
        </label>
      )}
      <p className="caption">
        In {noteLabel(task.path)}
        {due ? `. ${due.text}` : ''}
        {task.reminder ? `. Reminder: ${reminderLabel(task.reminder)}` : ''}
        {task.status === 'done' ? '. Done' : ''}
      </p>
      {open && (
        <>
          <div className="field">
            <span>Due</span>
            <div className="picks">
              <button type="button" className="pick" aria-pressed={task.due === today} disabled={busy} onClick={() => void edit({ due: today }, 'Due today')}>
                Today
              </button>
              <button type="button" className="pick" aria-pressed={task.due === addDays(today, 1)} disabled={busy} onClick={() => void edit({ due: addDays(today, 1) }, 'Due tomorrow')}>
                Tomorrow
              </button>
              <button type="button" className="pick" disabled={busy} onClick={() => void edit({ due: addDays(today, 7) }, 'Moved a week')}>
                Next week
              </button>
            </div>
            <div className="edit-row">
              <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Due date" data-testid="task-due" />
              <button type="button" className="btn" disabled={busy || !date || date === task.due} onClick={() => void edit({ due: date }, 'Rescheduled')} data-testid="task-due-set">
                Set
              </button>
            </div>
          </div>
          <div className="field">
            <span>Remind me</span>
            <div className="picks">
              {PRAYER_ANCHORS.map((p) => (
                <button key={p.v} type="button" className="pick" aria-pressed={task.reminder === p.v} disabled={busy} onClick={() => void edit({ reminder: p.v, due: task.due ?? today }, `Reminder: ${p.label.toLowerCase()}`)}>
                  {p.label}
                </button>
              ))}
            </div>
            <div className="edit-row">
              <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Reminder time" data-testid="task-remind-time" />
              <button type="button" className="btn" data-testid="task-remind-set" disabled={busy || !time} onClick={() => void edit({ reminder: `${task.due || date || today} ${time}`, due: task.due || date || today }, 'Reminder set')}>
                Set
              </button>
            </div>
            {task.reminder && (
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void edit({ reminder: null }, 'Reminder removed')}>
                Remove reminder
              </button>
            )}
          </div>
        </>
      )}
      {!task.readonly && (
        <>
          <div className="field">
            <span>Priority</span>
            <div className="picks" role="radiogroup" aria-label="Priority">
              {[...PRIORITIES, ...(task.priority && EXTREMES[task.priority] ? [{ v: task.priority, label: EXTREMES[task.priority] }] : [])].map((p) => (
                <button key={p.label} type="button" role="radio" className="pick" aria-checked={prio === p.v} onClick={() => setPrio(p.v)} data-testid={`task-prio-${p.label.toLowerCase()}`}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          {(targets.length > 0 || unknown.length > 0) && (
            <div className="field">
              <span>Goal</span>
              <div className="picks">
                {[...targets.map((g) => ({ slug: g.slug, title: g.title })), ...unknown.map((u) => ({ slug: u, title: `@${u}` }))].map((g) => (
                  <button key={g.slug} type="button" className="pick" aria-pressed={slugs.includes(g.slug)} onClick={() => setSlugs(slugs.includes(g.slug) ? slugs.filter((x) => x !== g.slug) : [...slugs, g.slug])} data-testid="task-goal">
                    {g.title}
                  </button>
                ))}
              </div>
            </div>
          )}
          <label className="field">
            <span>Tags</span>
            <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="family errands" aria-label="Tags" data-testid="task-tags" />
          </label>
          <div className="sheet-actions">
            <button type="button" className="btn" onClick={() => openMove({ kind: 'task', items: [sel], done: onClose })} data-testid="task-move">
              <FolderInput aria-hidden /> Move
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-danger"
              onClick={() => {
                onClose();
                void deleteLines([{ ref: anchorOf(task), kind: 'task', key: task.id, label: task.title }]);
              }}
              data-testid="task-delete"
            >
              <Trash2 aria-hidden /> Delete
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}

// one sheet for the whole app: any task row opens it
let current: Task | null = null;
export function openTaskSheet(t: Task | null): void {
  current = t;
  emit('task-sheet');
}

export function TaskSheetHost() {
  const t = useSyncExternalStore((cb) => on('task-sheet', cb), () => current);
  return <TaskSheet task={t} onClose={() => openTaskSheet(null)} />;
}
