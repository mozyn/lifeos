/**
 * Goals (spec §4.3, §5.3, §5.4): goals with progress derived from @slug tasks, personal projects in
 * progress with their last activity, and the counters (§7). One primary action: New goal.
 */
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Archive, Pencil, Plus } from 'lucide-react';
import { daysBetween, shortDateYear, todayIn } from '@lifeos/shared';
import { Sheet } from '../components/ui';
import { TaskRow } from '../components/TaskRow';
import { SwipeRow } from '../components/SwipeRow';
import { archivePaths, useGone } from '../lib/edits';
import { SelectScope } from '../lib/selection';
import { ApiError } from '../lib/api';
import { toast, useResource, write } from '../lib/store';
import type { Task } from '../lib/types';
import { drillIn } from '../lib/transitions';

interface Item {
  slug: string;
  path: string;
  title: string;
  status: string;
  target: string | null;
  why: string | null;
  done: number;
  total: number;
  lastActivity: string;
  next: Task | null;
}

interface GoalsDto {
  today: string;
  counters: { doneToday: number; doneWeek: number; longestStreak: number };
  goals: Item[];
  projects: Item[];
}

function Progress({ done, total, label }: { done: number; total: number; label: string }) {
  const f = total ? done / total : 0;
  return (
    <div className="progress-line" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
      <span className="bar">
        <span style={{ width: `${Math.round(f * 100)}%` }} />
      </span>
      <span className="caption num">
        {done} of {total}
      </span>
    </div>
  );
}

function ago(iso: string, today: string): string {
  const d = daysBetween(iso.slice(0, 10), today);
  return d <= 0 ? 'Updated today' : d === 1 ? 'Updated yesterday' : `Updated ${d} days ago`;
}

function ItemCard({ it, today, kind }: { it: Item; today: string; kind: 'goal' | 'project' }) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const gone = useGone();
  if (gone.has(it.path)) return null;
  return (
    <>
      <SwipeRow
        plain
        rowKey={it.path}
        className="goal-swipe"
        menuTitle={it.title}
        menu={() => [
          { label: 'Edit', icon: <Pencil aria-hidden />, run: () => setEditing(true), testId: 'menu-edit' },
          { label: 'Archive', icon: <Archive aria-hidden />, run: () => void archivePaths([{ path: it.path, label: it.title }]), tone: 'danger', testId: 'menu-archive' },
        ]}
      >
        <button type="button" className="card goal-card" onClick={(e) => void drillIn(e.currentTarget, () => navigate(`/goals/${it.slug}`))} data-testid={`${kind}-card`}>
          <span className="goal-title">{it.title}</span>
          {it.why && <span className="secondary goal-why">{it.why}</span>}
          <Progress done={it.done} total={it.total} label={`${it.title}: ${it.done} of ${it.total} tasks done`} />
          <span className="caption">
            {kind === 'goal' ? (it.target ? `Target ${shortDateYear(it.target)}` : 'No target date') : ago(it.lastActivity, today)}
            {it.next ? `. Next: ${it.next.title}` : ''}
          </span>
        </button>
      </SwipeRow>
      {editing && <GoalEdit it={it} kind={kind} onClose={() => setEditing(false)} />}
    </>
  );
}

const STATUSES = [
  { v: 'active', label: 'Active' },
  { v: 'paused', label: 'Paused' },
  { v: 'done', label: 'Done' },
];

/** A goal's or project's sheet (round-2 brief §12): title, status, target and why, in its frontmatter and H1. */
function GoalEdit({ it, kind, onClose, onArchived }: { it: Item; kind: 'goal' | 'project'; onClose: () => void; onArchived?: () => void }) {
  const [title, setTitle] = useState(it.title);
  const [status, setStatus] = useState(STATUSES.some((x) => x.v === it.status) ? it.status : 'active');
  const [target, setTarget] = useState(it.target ?? '');
  const [why, setWhy] = useState(it.why ?? '');
  const [busy, setBusy] = useState(false);
  const dirty = title.trim() !== it.title || status !== it.status || target !== (it.target ?? '') || why.trim() !== (it.why ?? '');
  const save = async () => {
    setBusy(true);
    try {
      await write({
        method: 'PATCH',
        path: 'api/goals',
        body: { path: it.path, title: title.trim() !== it.title ? title.trim() : undefined, status: status !== it.status ? status : undefined, target: target !== (it.target ?? '') ? target || null : undefined, why: why.trim() !== (it.why ?? '') ? why.trim() || null : undefined },
        kind: 'goal-edit',
        label: kind === 'goal' ? 'Edit goal' : 'Edit project',
      });
      toast('Saved');
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
      title={kind === 'goal' ? 'Goal' : 'Project'}
      testId="goal-edit"
      footer={
        <button type="button" className="btn btn-primary btn-block" disabled={busy || !dirty || !title.trim()} onClick={() => void save()} data-testid="goal-save">
          Save changes
        </button>
      }
    >
      <label className="field">
        <span>{kind === 'goal' ? 'Goal' : 'Project'}</span>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} data-testid="goal-title" />
      </label>
      <div className="field">
        <span>Status</span>
        <div className="picks" role="radiogroup" aria-label="Status">
          {STATUSES.map((x) => (
            <button key={x.v} type="button" role="radio" className="pick" aria-checked={status === x.v} onClick={() => setStatus(x.v)} data-testid={`goal-status-${x.v}`}>
              {x.label}
            </button>
          ))}
        </div>
      </div>
      <label className="field">
        <span>Why it matters (one line)</span>
        <input className="input" value={why} onChange={(e) => setWhy(e.target.value)} data-testid="goal-why" />
      </label>
      <label className="field">
        <span>Target date (optional)</span>
        <input className="input" type="date" value={target} onChange={(e) => setTarget(e.target.value)} data-testid="goal-target" />
      </label>
      <p className="caption">{it.path.replace(/\.md$/, '')}: the frontmatter and the title line change; its tasks stay as they are.</p>
      <div className="sheet-actions">
        <button
          type="button"
          className="btn btn-ghost btn-danger"
          onClick={() => {
            onClose();
            onArchived?.();
            void archivePaths([{ path: it.path, label: it.title }]);
          }}
          data-testid="goal-archive"
        >
          <Archive aria-hidden /> Archive
        </button>
      </div>
      <p className="caption">Archive moves the note to {kind === 'goal' ? 'Archive/Goals' : 'Archive/Projects'}; Settings → Advanced → Data → Archived brings it back.</p>
    </Sheet>
  );
}

function NewGoal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [why, setWhy] = useState('');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setTitle('');
      setWhy('');
      setTarget('');
    }
  }, [open]);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="New goal"
      testId="new-goal"
      footer={
        <button
          type="button"
          className="btn btn-primary btn-block"
          data-testid="goal-create"
          disabled={!title.trim() || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await write({ path: 'api/goals', body: { title, why: why || null, target: target || null }, kind: 'goal', label: 'New goal' });
              toast('Goal created in Areas/Goals');
              onClose();
            } catch (e) {
              toast(e instanceof ApiError ? e.message : 'Not saved.', 'error');
            } finally {
              setBusy(false);
            }
          }}
        >
          Create goal
        </button>
      }
    >
      <label className="field">
        <span>Goal</span>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Read the whole Qur'an with translation" />
      </label>
      <label className="field">
        <span>Why it matters (one line)</span>
        <input className="input" value={why} onChange={(e) => setWhy(e.target.value)} />
      </label>
      <label className="field">
        <span>Target date (optional)</span>
        <input className="input" type="date" value={target} onChange={(e) => setTarget(e.target.value)} />
      </label>
      <p className="caption">Progress counts every task tagged with this goal&rsquo;s @name, anywhere in the vault.</p>
    </Sheet>
  );
}

function GoalDetail({ slug, onClose }: { slug: string; onClose: () => void }) {
  const { data } = useResource<{ item: Item & { kind: string }; tasks: Task[] }>(`api/goals/${slug}`);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  const today = todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const add = async () => {
    if (!text.trim()) return;
    try {
      await write({ path: `api/goals/${slug}/tasks`, body: { text }, kind: 'goal-task', label: 'Add task' });
      setText('');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Not saved.', 'error');
    }
  };
  const open = data?.tasks.filter((t) => t.status === 'open') ?? [];
  const done = data?.tasks.filter((t) => t.status === 'done') ?? [];
  return (
    <Sheet
      open
      onClose={onClose}
      title={data?.item.title ?? 'Goal'}
      testId="goal-detail"
      tools={
        data ? (
          <button type="button" className="btn btn-quiet" onClick={() => setEditing(true)} data-testid="goal-edit-open">
            <Pencil aria-hidden /> Edit
          </button>
        ) : undefined
      }
    >
      {data && editing && <GoalEdit it={data.item} kind={data.item.kind === 'project' ? 'project' : 'goal'} onClose={() => setEditing(false)} onArchived={onClose} />}
      {data && (
        <SelectScope.Provider value={`goal:${slug}`}>
          {data.item.why && <p className="secondary">{data.item.why}</p>}
          <Progress done={data.item.done} total={data.item.total} label="Progress" />
          <p className="caption">
            {data.item.path.replace(/\.md$/, '')}. Tag tasks anywhere with @{slug} to count them here.
          </p>
          <div className="edit-row">
            <input className="input" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void add()} placeholder="Add a task (friday, #tag work too)" aria-label="New task" data-testid="goal-task-input" />
            <button type="button" className="btn btn-primary" disabled={!text.trim()} onClick={() => void add()}>
              Add
            </button>
          </div>
          {open.length > 0 && (
            <div className="rows">
              {open.map((t) => (
                <TaskRow key={t.id} task={t} today={today} />
              ))}
            </div>
          )}
          {done.length > 0 && (
            <details className="done-list">
              <summary>{done.length} done</summary>
              <div className="rows">
                {done.map((t) => (
                  <TaskRow key={t.id} task={t} today={today} />
                ))}
              </div>
            </details>
          )}
        </SelectScope.Provider>
      )}
    </Sheet>
  );
}

export function GoalsScreen() {
  const { data } = useResource<GoalsDto>('api/goals');
  const { slug } = useParams();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [others, setOthers] = useState(false);
  const goals = data?.goals.filter((g) => g.status === 'active') ?? [];
  const projects = data?.projects.filter((p) => p.status === 'active') ?? [];
  const rest = [...(data?.goals.filter((g) => g.status !== 'active') ?? []), ...(data?.projects.filter((p) => p.status !== 'active') ?? [])];
  return (
    <div className="page goals" data-testid="goals">
      <div className="page-head">
        <h1>Goals</h1>
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)} data-testid="new-goal-button">
          <Plus aria-hidden /> New goal
        </button>
      </div>
      {data && (
        <dl className="counter-strip" data-testid="counters">
          <div>
            <dt>Done today</dt>
            <dd className="num">{data.counters.doneToday}</dd>
          </div>
          <div>
            <dt>This week</dt>
            <dd className="num">{data.counters.doneWeek}</dd>
          </div>
          <div>
            <dt>Longest streak</dt>
            <dd className="num">{data.counters.longestStreak}</dd>
          </div>
        </dl>
      )}
      {data && goals.length === 0 && (
        <section className="card">
          <p className="secondary">No active goals yet. A goal is ongoing or long; something with an end state is a project in Projects/.</p>
        </section>
      )}
      <div className="stack">
        {goals.map((g) => (
          <ItemCard key={g.slug} it={g} today={data!.today} kind="goal" />
        ))}
      </div>
      {projects.length > 0 && (
        <>
          <h2 className="section-title">Projects in progress</h2>
          <div className="stack">
            {projects.map((p) => (
              <ItemCard key={p.slug} it={p} today={data!.today} kind="project" />
            ))}
          </div>
        </>
      )}
      {rest.length > 0 && (
        <button type="button" className="btn btn-ghost section-toggle" onClick={() => setOthers(!others)} aria-expanded={others}>
          {others ? 'Hide' : 'Show'} {rest.length} paused, done or idea
        </button>
      )}
      {others && (
        <div className="stack">
          {rest.map((p) => (
            <ItemCard key={p.slug} it={p} today={data!.today} kind={p.path.startsWith('Projects/') ? 'project' : 'goal'} />
          ))}
        </div>
      )}
      <NewGoal open={creating} onClose={() => setCreating(false)} />
      {slug && <GoalDetail slug={slug} onClose={() => navigate('/goals')} />}
    </div>
  );
}
