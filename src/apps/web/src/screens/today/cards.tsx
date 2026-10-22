/**
 * Today's cards (spec §6). Content sits on solid cards; the only glass here is the chip strip
 * (controls that open other tabs) and the checkboxes. Each card has one job.
 */
import { useEffect, useRef, useState } from 'react';
import { Archive, CalendarDays, ChevronDown, ChevronRight, Flame, Inbox, BellOff, Pencil, Sparkles, X } from 'lucide-react';
import { NoteSheet } from '../../components/NoteSheet';
import { archivePaths } from '../../lib/edits';
import { hm12, instantText, normTitle, shortDateDow, todayIn } from '@lifeos/shared';
import { SlipSheet } from '../Habits';
import { EventRow } from '../calendar/parts';
import { Curtained, habitName, PrivateText } from '../../components/Private';
import { usePrivacy } from '../../lib/privacy';
import { Glass } from '../../glass/Glass';
import { useGo } from '../../shell/context';
import { Sheet } from '../../components/ui';
import { TaskRow } from '../../components/TaskRow';
import { CloudGate } from '../../components/AiProvider';
import { api, ApiError } from '../../lib/api';
import { countUp, pulse, rewardBig } from '../../lib/rewards';
import { toast, usePending, write } from '../../lib/store';
import { doneCount, effectiveStatus } from '../../lib/tasks';
import type { Capture, CheckinLine, Draft, EventItem, Habit, MoodLine, PlanPayload, ReviewPayload, Task, Today } from '../../lib/types';

// ------------------------------------------------------------------ the plan: "Today in one line"

/** A plain draft made while a cloud provider's first job waits for the owner's OK (ADR-81). */
const waitingForOk = (d: Draft) => d.fallback && !!d.fallbackReason?.startsWith('waiting for your OK');

export function DraftMeta({ d }: { d: Draft }) {
  const [open, setOpen] = useState(false);
  const when = instantText(d.generatedAt, { date: false });
  return (
    <div className="draft-meta">
      <button type="button" className="draft-meta-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {d.fallback ? (d.via === 'hermes' ? 'A plain draft while Hermes is away' : 'Drafted without the model') : `Drafted by ${d.model ?? 'the model'}`} at {when}
        <ChevronDown size={16} aria-hidden style={{ rotate: open ? '180deg' : '0deg' }} />
      </button>
      {open && (
        <dl className="draft-detail">
          <dt>Model</dt>
          <dd>{d.model ?? 'none (deterministic fallback)'}</dd>
          {d.fallback && (
            <>
              <dt>Why</dt>
              <dd>{d.fallbackReason ?? 'model unavailable'}</dd>
            </>
          )}
          <dt>Prompt tokens</dt>
          <dd>{d.promptTokens ?? 0}</dd>
          <dt>Sources</dt>
          <dd>{d.sources.join('; ')}</dd>
          <dt>Generated</dt>
          <dd>{instantText(d.generatedAt, { year: true })}</dd>
        </dl>
      )}
    </div>
  );
}

export function PlanEditor({ open, onClose, initial, onApprove, title }: { open: boolean; onClose: () => void; initial: PlanPayload; onApprove: (p: PlanPayload) => void; title: string }) {
  const [headline, setHeadline] = useState(initial.headline);
  const [items, setItems] = useState(initial.focus);
  const [extra, setExtra] = useState('');
  useEffect(() => {
    if (open) {
      setHeadline(initial.headline);
      setItems(initial.focus);
      setExtra('');
    }
  }, [open, initial]);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      testId="plan-editor"
      footer={
        <button
          type="button"
          className="btn btn-primary btn-block"
          onClick={() => onApprove({ headline: headline.trim() || initial.headline, focus: [...items, ...(extra.trim() ? [{ text: extra.trim(), source_task_id: null, new: true }] : [])].slice(0, 5), notes: initial.notes })}
        >
          Approve
        </button>
      }
    >
      <label className="field">
        <span>Today in one line</span>
        <input className="input" value={headline} onChange={(e) => setHeadline(e.target.value)} />
      </label>
      <div className="field">
        <span>Focus</span>
        {items.map((f, i) => (
          <div key={i} className="edit-row">
            <input className="input" value={f.text} onChange={(e) => setItems(items.map((x, k) => (k === i ? { ...x, text: e.target.value } : x)))} aria-label={`Focus ${i + 1}`} />
            <button type="button" className="icon-btn" aria-label={`Remove ${f.text}`} onClick={() => setItems(items.filter((_, k) => k !== i))}>
              <X />
            </button>
          </div>
        ))}
        {items.length < 5 && <input className="input" value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="Add a focus item (becomes a task)" aria-label="New focus item" />}
      </div>
    </Sheet>
  );
}

export function PlanCard({ today }: { today: Today }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const d = today.draft;
  const decide = async (kind: 'approve' | 'dismiss', payload?: PlanPayload) => {
    if (!d || busy) return;
    setBusy(true);
    try {
      // approvals never fire rewards (spec §7)
      await write({ path: `api/drafts/${d.id}/${kind}`, body: payload ? { payload } : {}, kind: `draft-${kind}`, label: kind === 'approve' ? 'Approve plan' : 'Dismiss plan' });
      setEditing(false);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not save the plan.', 'error');
    } finally {
      setBusy(false);
    }
  };
  if (!d) {
    if (today.plan.headline) {
      return (
        <section className="plan-line" aria-label="Today in one line" data-testid="plan-line">
          <p className="plan-headline">
            <PrivateText text={today.plan.headline} names={today.privateNames} />
          </p>
        </section>
      );
    }
    return (
      <section className="card plan-card" aria-label="Today in one line">
        <p className="secondary">No plan for today yet.</p>
        <div className="card-foot">
          <button type="button" className="btn btn-primary" onClick={() => void write({ path: 'api/drafts/morning', kind: 'draft-request', label: 'Draft a plan' }).catch(() => undefined)}>
            Draft a plan
          </button>
        </div>
      </section>
    );
  }
  if (d.status === 'generating') {
    // Hermes drafts on its own schedule (ADR-86): after 2 minutes the plain plan stands in
    if (d.via === 'hermes')
      return (
        <section className="card plan-card drafting" aria-label="Plan draft" aria-busy="true" data-testid="plan-drafting" data-via="hermes">
          <p className="plan-headline">Waiting for Hermes</p>
          <p className="plan-sub">Hermes is drafting today&rsquo;s plan with its own model. If it takes more than 2 minutes, a plain plan shows here until Hermes&rsquo;s arrives.</p>
        </section>
      );
    return (
      <section className="card plan-card drafting" aria-label="Plan draft" aria-busy="true" data-testid="plan-drafting">
        <p className="plan-headline">Drafting today&rsquo;s plan</p>
        <p className="plan-sub">The model is reading today&rsquo;s tasks and events. This takes a few seconds; the focus list below is ready now.</p>
      </section>
    );
  }
  const p = d.payload;
  // the Focus card below already lists the tasks it picks; the draft only names what it adds
  const shown = new Set(today.focus.map((t) => normTitle(t.title)));
  const extra = p.focus.filter((f) => f.new || !shown.has(normTitle(f.text)));
  const same = p.focus.length - extra.length;
  return (
    <section className="card plan-card" aria-label="Plan draft" data-testid="plan-draft">
      <p className="plan-headline">
        <PrivateText text={p.headline} names={today.privateNames} />
      </p>
      {same > 0 && <p className="plan-sub">{`Focus on the ${same === 1 ? 'task' : `${same} tasks`} below${extra.length ? ', and:' : '.'}`}</p>}
      {extra.length > 0 && (
        <ul className="plan-focus">
          {extra.map((f, i) => (
            <li key={i}>
              <PrivateText text={f.text} names={today.privateNames} />
              {f.new && <span className="tag">new task</span>}
            </li>
          ))}
        </ul>
      )}
      {p.notes.length > 0 && (
        <p className="caption">
          <PrivateText text={p.notes.join(' ')} names={today.privateNames} />
        </p>
      )}
      {waitingForOk(d) && today.aiCloud && <CloudGate cloud={today.aiCloud} />}
      <DraftMeta d={d} />
      <div className="card-foot">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void decide('approve')} data-testid="plan-approve">
          Approve
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setEditing(true)}>
          Edit
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void decide('dismiss')}>
          Dismiss
        </button>
      </div>
      <PlanEditor open={editing} onClose={() => setEditing(false)} initial={p} title="Edit today's plan" onApprove={(edited) => void decide('approve', edited)} />
    </section>
  );
}

// ------------------------------------------------------------------ focus

export function FocusCard({ today }: { today: Today }) {
  const pending = usePending();
  const onCompleted = (t: Task, el: HTMLElement | null) => {
    const left = today.focus.filter((f) => f.id !== t.id && effectiveStatus(f, pending) !== 'done');
    // the last focus task: the bigger reward
    if (today.focus.length > 1 && left.length === 0) setTimeout(() => rewardBig(el), 120);
  };
  return (
    <section className="card" aria-labelledby="focus-h" data-testid="focus-card">
      <div className="card-head">
        <h2 id="focus-h">Focus</h2>
      </div>
      {today.focus.length === 0 ? (
        <p className="empty">Nothing due today. Add something with the plus button, or enjoy the space.</p>
      ) : (
        <div className="rows">
          {today.focus.map((t) => (
            <TaskRow key={t.id} task={t} today={today.date} onCompleted={onCompleted} />
          ))}
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ check-in

type RowKey = 'sleep' | 'workout' | 'prayers' | 'mood' | 'energy';

const SLEEP = [5, 6, 6.5, 7, 7.5, 8, 9];

function latest<T extends { time: string }>(xs: T[], moment: 'morning' | 'evening' | 'midday'): T | undefined {
  const inMoment = (t: string) => {
    const h = Number(t.slice(0, 2));
    return moment === 'morning' ? h < 11 : moment === 'midday' ? h >= 11 && h < 17 : h >= 17;
  };
  return [...xs].reverse().find((x) => inMoment(x.time));
}

export function CheckinCard({ today, moment, rows = ['sleep', 'workout', 'prayers', 'mood', 'energy'], title = 'Check-in', dismissible = true, inline = false }: { today: Today; moment: 'morning' | 'midday' | 'evening'; rows?: RowKey[]; title?: string; dismissible?: boolean; inline?: boolean }) {
  const key = `lifeos.checkin.hidden.${today.date}.${moment}`;
  const [hidden, setHidden] = useState(() => localStorage.getItem(key) === '1');
  const [open, setOpen] = useState<RowKey | null>(null);
  const [local, setLocal] = useState<Partial<CheckinLine & MoodLine>>({});
  const c = latest(today.checkin.checkins, moment);
  const m = latest(today.checkin.moods, moment);
  useEffect(() => setLocal({}), [today]);
  if (hidden) return null;
  const value = (k: RowKey) => (local as Record<string, unknown>)[k] ?? (k === 'mood' || k === 'energy' ? m?.[k] : c?.[k]);
  const save = (k: RowKey, v: number | boolean) => {
    setLocal((s) => ({ ...s, [k]: v }));
    setOpen(null);
    const isMood = k === 'mood' || k === 'energy';
    void write({ path: isMood ? 'api/mood' : 'api/checkin', body: { [k]: v }, kind: isMood ? 'mood' : 'checkin', label: 'Check-in' }).catch((e: unknown) => toast(e instanceof ApiError ? e.message : 'Check-in not saved.', 'error'));
  };
  const show = (k: RowKey): string => {
    const v = value(k);
    if (v === undefined || v === null) return 'Not logged';
    if (k === 'sleep') return `${v} h`;
    if (k === 'workout') return v ? 'Yes' : 'No';
    if (k === 'prayers') return `${v} of 5`;
    return `${v} of 5`;
  };
  const options: Record<RowKey, { v: number | boolean; label: string }[]> = {
    sleep: SLEEP.map((h) => ({ v: h, label: `${h}` })),
    workout: [
      { v: true, label: 'Yes' },
      { v: false, label: 'No' },
    ],
    prayers: [0, 1, 2, 3, 4, 5].map((n) => ({ v: n, label: String(n) })),
    mood: [1, 2, 3, 4, 5].map((n) => ({ v: n, label: String(n) })),
    energy: [1, 2, 3, 4, 5].map((n) => ({ v: n, label: String(n) })),
  };
  const LABEL: Record<RowKey, string> = { sleep: 'Sleep', workout: 'Workout', prayers: 'Prayers', mood: 'Mood', energy: 'Energy' };
  return (
    <section className="card checkin" aria-labelledby={`ci-${moment}`} data-testid={`checkin-${moment}`}>
      <div className="card-head">
        <h2 id={`ci-${moment}`}>{title}</h2>
        {dismissible && (
          <button
            type="button"
            className="icon-btn"
            aria-label="Hide the check-in for today"
            onClick={() => {
              localStorage.setItem(key, '1');
              setHidden(true);
            }}
          >
            <X />
          </button>
        )}
      </div>
      <div className="ci-rows">
        {inline &&
          rows.map((k) => (
            <div key={k} className="ci-row ci-inline">
              <span className="ci-label" id={`cil-${moment}-${k}`}>
                {LABEL[k]}
              </span>
              <div className="picks" role="radiogroup" aria-labelledby={`cil-${moment}-${k}`}>
                {options[k].map((o) => (
                  <button key={String(o.v)} type="button" role="radio" className="pick" aria-checked={value(k) === o.v} onClick={() => save(k, o.v)} data-testid={`ci-${k}-${String(o.v)}`}>
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        {!inline && rows.map((k) => (
          <div key={k} className="ci-row" data-open={open === k ? '' : undefined}>
            <button type="button" className="ci-summary" aria-expanded={open === k} onClick={() => setOpen(open === k ? null : k)} data-testid={`ci-${k}`}>
              <span>{LABEL[k]}</span>
              <span className={value(k) === undefined ? 'muted' : 'ci-value'}>{show(k)}</span>
            </button>
            {open === k && (
              <div className="picks ci-picks" role="radiogroup" aria-label={LABEL[k]}>
                {options[k].map((o) => (
                  <button key={String(o.v)} type="button" role="radio" className="pick" aria-checked={value(k) === o.v} onClick={() => save(k, o.v)} data-testid={`ci-${k}-${String(o.v)}`}>
                    {o.label}
                  </button>
                ))}
                {(k === 'mood' || k === 'energy') && <span className="caption ci-scale">1 is low, 5 is high</span>}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ the chip strip

export function ChipStrip({ today, habits = true }: { today: Today; habits?: boolean }) {
  const go = useGo();
  // the big screen shows the habits beside the moment (HabitsCard): no chip for them there
  const habitsDue = habits ? today.habits.filter((h) => !h.today).length : 0;
  const chips = [
    { n: today.events.today.length, one: 'event', many: 'events', icon: <CalendarDays />, to: '/calendar?view=day', id: 'events' },
    { n: habitsDue, one: 'habit to log', many: 'habits to log', icon: <Flame />, to: '/habits', id: 'habits' },
    { n: today.inbox.needsReview, one: 'capture to review', many: 'captures to review', icon: <Inbox />, to: '/lists/notes?ring=review', id: 'inbox' },
    { n: today.reminders.undelivered, one: 'reminder not delivered', many: 'reminders not delivered', icon: <BellOff />, to: '/settings?s=reminders', id: 'undelivered' },
  ].filter((c) => c.n > 0);
  if (!chips.length) return null;
  return (
    <nav className="chips strip" aria-label="Also today">
      {chips.map((c) => (
        <Glass key={c.id} as="button" className="chip" press onClick={() => go(c.to)} data-testid={`chip-${c.id}`}>
          {c.icon}
          <span className="chip-n">{c.n}</span> {c.n === 1 ? c.one : c.many}
        </Glass>
      ))}
    </nav>
  );
}

// ------------------------------------------------------------------ midday

export function ProgressCard({ today }: { today: Today }) {
  const pending = usePending();
  const all = [...today.focus, ...today.remaining, ...today.doneToday];
  const uniq = [...new Map(all.map((t) => [t.id, t])).values()];
  const done = doneCount(today.counters.doneToday, uniq, pending);
  const planned = Math.max(today.counters.planned, done);
  const frac = planned ? done / planned : 0;
  const numRef = useRef<HTMLSpanElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const prev = useRef(done);
  useEffect(() => {
    if (done > prev.current) {
      countUp(numRef.current, prev.current, done);
      pulse(ringRef.current);
    } else if (numRef.current) numRef.current.textContent = String(done);
    prev.current = done;
  }, [done]);
  const R = 46;
  const C = 2 * Math.PI * R;
  return (
    <section className="card progress" aria-label="Progress today" data-testid="progress-card">
      <div className="ring" ref={ringRef} role="img" aria-label={`${done} of ${planned} planned tasks done`}>
        <svg viewBox="0 0 110 110" aria-hidden>
          <circle cx="55" cy="55" r={R} className="ring-track" />
          <circle cx="55" cy="55" r={R} className="ring-fill" strokeDasharray={C} strokeDashoffset={C * (1 - frac)} />
        </svg>
        <span className="ring-text">
          <span className="ring-n num" ref={numRef} data-testid="done-today">
            {done}
          </span>
          <span className="ring-of">of {planned}</span>
        </span>
      </div>
      <dl className="counters">
        <div>
          <dt>Done this week</dt>
          <dd className="num">{today.counters.doneWeek + (done - today.counters.doneToday)}</dd>
        </div>
        <div>
          <dt>Longest streak</dt>
          <dd className="num">
            {today.counters.longestStreak} {today.counters.longestStreak === 1 ? 'day' : 'days'}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function nextEvent(today: Today, hm: string): EventItem | undefined {
  return today.events.today.find((e) => e.time && e.time >= hm) ?? today.events.upcoming[0];
}

export function RemainingCard({ today, hm }: { today: Today; hm: string }) {
  const ev = nextEvent(today, hm);
  return (
    <section className="card" aria-labelledby="rem-h" data-testid="remaining-card">
      <div className="card-head">
        <h2 id="rem-h">Still to do</h2>
        <span className="card-aside">{today.remaining.length}</span>
      </div>
      {ev && (
        // the event itself, edited where it is shown (round-3 brief §4): the Calendar's event sheet
        <EventRow e={ev} as="div" className="next-event" testId="today-next-event">
          Next: {ev.time ? hm12(ev.time) : ev.date === today.date ? 'today' : shortDateDow(ev.date)} {ev.text}
        </EventRow>
      )}
      {today.remaining.length === 0 ? (
        <p className="empty">Everything planned for today is done.</p>
      ) : (
        <div className="rows">
          {today.remaining.map((t) => (
            <TaskRow key={t.id} task={t} today={today.date} />
          ))}
        </div>
      )}
    </section>
  );
}

export function WhatChanged({ today }: { today: Today }) {
  const go = useGo();
  if (!today.inbox.sinceMorning) return null;
  return (
    <Glass as="button" className="chip changed" press onClick={() => go('/lists/notes?ring=today')} data-testid="what-changed">
      <Sparkles />
      {today.inbox.sinceMorning === 1 ? '1 new ring capture since morning' : `${today.inbox.sinceMorning} new ring captures since morning`}
    </Glass>
  );
}

// ------------------------------------------------------------------ evening

export function HabitLogRow({ h, onLogged }: { h: Habit; onLogged?: (extended: boolean, el: HTMLElement | null) => void }) {
  const privacy = usePrivacy();
  const [value, setValue] = useState(h.today);
  const [slipping, setSlipping] = useState(false);
  useEffect(() => setValue(h.today), [h.today]);
  const log = async (v: 'clean' | 'slip', el: HTMLElement | null) => {
    setValue(v);
    try {
      const r = await write<{ extended: boolean }>({ path: 'api/habits/log', body: { path: h.path, value: v }, kind: 'habit-log', label: h.title });
      onLogged?.(!!r.result?.extended && v === 'clean', el);
    } catch (e) {
      setValue(h.today);
      toast(e instanceof ApiError ? e.message : 'Not logged.', 'error');
    }
  };
  return (
    <Curtained className="habit-row" isPrivate={!!h.private} testId="habit-row" aria-label={habitName(h, privacy)}>
      <span className="habit-name">{h.title}</span>
      <div className="picks">
        <button type="button" className="pick" aria-pressed={value === 'clean'} onClick={(e) => void log('clean', e.currentTarget)} data-testid="habit-clean">
          {h.kind === 'quit' ? 'Held' : 'Done'}
        </button>
        <button type="button" className="pick" aria-pressed={value === 'slip'} onClick={() => setSlipping(true)} data-testid="habit-slip">
          Slip
        </button>
      </div>
      {slipping && <SlipSheet h={h} date={todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone)} onClose={() => setSlipping(false)} />}
    </Curtained>
  );
}

export function ReviewCard({ today, habits = true }: { today: Today; habits?: boolean }) {
  const pending = usePending();
  const [showDone, setShowDone] = useState(false);
  const [showSlipped, setShowSlipped] = useState(false);
  const all = [...new Map([...today.focus, ...today.remaining, ...today.doneToday].map((t) => [t.id, t])).values()];
  const done = doneCount(today.counters.doneToday, all, pending);
  return (
    <section className="card review" aria-labelledby="rev-h" data-testid="review-card">
      <div className="card-head">
        <h2 id="rev-h">Today in review</h2>
      </div>
      <div className="review-stats">
        <button type="button" className="stat" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
          <span className="stat-n num">{done}</span>
          <span className="stat-l">done</span>
        </button>
        <button type="button" className="stat" aria-expanded={showSlipped} onClick={() => setShowSlipped(!showSlipped)}>
          <span className={`stat-n num${today.overdue.length ? ' warn' : ''}`}>{today.overdue.length}</span>
          <span className="stat-l">slipped</span>
        </button>
      </div>
      {showDone && (
        <div className="rows">
          {today.doneToday.length ? today.doneToday.map((t) => <TaskRow key={t.id} task={t} today={today.date} />) : <p className="empty">Nothing ticked off yet today.</p>}
        </div>
      )}
      {showSlipped && (
        <div className="rows">
          {today.overdue.length ? today.overdue.map((t) => <TaskRow key={t.id} task={t} today={today.date} />) : <p className="empty">Nothing overdue.</p>}
        </div>
      )}
      {habits && today.habits.length > 0 && (
        <div className="review-habits">
          {today.habits.map((h) => (
            <HabitLogRow key={h.path} h={h} onLogged={(ext, el) => ext && rewardBig(el)} />
          ))}
        </div>
      )}
    </section>
  );
}

/** Today's habits, logged in one tap (the big screen's second column, round 8f). */
export function HabitsCard({ today }: { today: Today }) {
  if (today.habits.length === 0) return null;
  const logged = today.habits.filter((h) => h.today).length;
  return (
    <section className="card" aria-labelledby="th-h" data-testid="today-habits">
      <div className="card-head">
        <h2 id="th-h">Habits</h2>
        <span className="card-aside">
          {logged} of {today.habits.length} logged
        </span>
      </div>
      <div className="review-habits">
        {today.habits.map((h) => (
          <HabitLogRow key={h.path} h={h} onLogged={(ext, el) => ext && rewardBig(el)} />
        ))}
      </div>
    </section>
  );
}

export function TomorrowCard({ today }: { today: Today }) {
  const d = today.review;
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const decide = async (kind: 'approve' | 'dismiss', payload?: ReviewPayload) => {
    if (!d || busy) return;
    setBusy(true);
    try {
      await write({ path: `api/drafts/${d.id}/${kind}`, body: payload ? { payload } : {}, kind: `draft-${kind}`, label: kind === 'approve' ? 'Approve review' : 'Dismiss review' });
      setEditing(false);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not save.', 'error');
    } finally {
      setBusy(false);
    }
  };
  const next3 = today.events.upcoming.slice(0, 3);
  const tomorrowPlan = today.tomorrowDraft?.payload;
  return (
    <section className="card" aria-labelledby="tom-h" data-testid="tomorrow-card">
      <div className="card-head">
        <h2 id="tom-h">Tomorrow</h2>
      </div>
      {d?.status === 'generating' ? (
        <p className="secondary" aria-busy="true" data-testid="review-drafting">
          {d.via === 'hermes' ? <>Waiting for Hermes to draft the review and tomorrow&rsquo;s plan…</> : <>Drafting the review and tomorrow&rsquo;s plan with the model…</>}
        </p>
      ) : d ? (
        <>
          <p className="plan-headline small-headline">
            <PrivateText text={d.payload.tomorrow.headline} names={today.privateNames} />
          </p>
          {d.payload.tomorrow.focus.length > 0 && (
            <ul className="plan-focus">
              {d.payload.tomorrow.focus.map((f, i) => (
                <li key={i}>
                  <PrivateText text={f} names={today.privateNames} />
                </li>
              ))}
            </ul>
          )}
          {d.payload.review && (
            <div className="review-block">
              <span className="caption">Review of today, saved under ## Review when you approve</span>
              <p className="review-text">
                <PrivateText text={d.payload.review} names={today.privateNames} />
              </p>
            </div>
          )}
          {waitingForOk(d) && today.aiCloud && <CloudGate cloud={today.aiCloud} />}
          <DraftMeta d={d} />
          <div className="card-foot">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void decide('approve')} data-testid="review-approve">
              Approve
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setEditing(true)}>
              Edit
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void decide('dismiss')}>
              Dismiss
            </button>
          </div>
          <PlanEditor
            open={editing}
            onClose={() => setEditing(false)}
            title="Edit tomorrow's plan"
            initial={{ headline: d.payload.tomorrow.headline, focus: d.payload.tomorrow.focus.map((text) => ({ text, source_task_id: null, new: false })), notes: [] }}
            onApprove={(p) => void decide('approve', { ...d.payload, tomorrow: { headline: p.headline, focus: p.focus.map((f) => f.text) } })}
          />
        </>
      ) : tomorrowPlan ? (
        <p className="secondary">
          Tomorrow&rsquo;s plan is ready for the morning: <PrivateText text={tomorrowPlan.headline} names={today.privateNames} />
        </p>
      ) : (
        <p className="secondary">The plan for tomorrow appears here this evening.</p>
      )}
      {next3.length > 0 && (
        <ul className="events-mini" aria-label="Next events">
          {next3.map((e) => (
            <EventRow key={e.id} e={e} testId="today-event">
              <span className="ev-when">{e.date === today.date ? 'Today' : shortDateDow(e.date)}{e.time ? `, ${hm12(e.time)}` : ''}</span>
              <span>{e.text}</span>
            </EventRow>
          ))}
        </ul>
      )}
    </section>
  );
}

export function UnsortedCard({ today }: { today: Today }) {
  const [open, setOpen] = useState<Capture | null>(null);
  if (!today.unsorted.length) return null;
  return (
    <section className="card" aria-labelledby="uns-h" data-testid="unsorted-card">
      <div className="card-head">
        <h2 id="uns-h">Sort today&rsquo;s captures</h2>
        <span className="card-aside">{today.unsorted.length} left</span>
      </div>
      <div className="rows">
        {today.unsorted.map((c) => (
          <button key={c.path} type="button" className="row row-button capture-row" onClick={() => setOpen(c)} data-testid="unsorted-item">
            <span className="row-main">
              <span className="row-title">{c.title}</span>
              <span className="row-meta">
                {c.time && <span className="tag">{hm12(c.time)}</span>}
                {c.needsReview && <span className="tag due-over">Needs review</span>}
              </span>
            </span>
            <ChevronRight className="chev" size={20} aria-hidden />
          </button>
        ))}
      </div>
      <CaptureSheet capture={open} onClose={() => setOpen(null)} />
    </section>
  );
}

export function CaptureSheet({ capture, onClose }: { capture: Capture | null; onClose: () => void }) {
  const [detail, setDetail] = useState<{ transcript: string; organized: string } | null>(null);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setDetail(null);
    if (!capture) return;
    setText(capture.title);
    void api<{ transcript: string; organized: string }>(`api/captures/${encodeURIComponent(capture.slug)}`)
      .then(setDetail)
      .catch(() => setDetail({ transcript: capture.preview, organized: '' }));
  }, [capture]);
  const resolve = async (decision: 'task' | 'note' | 'ignore') => {
    if (!capture || busy) return;
    setBusy(true);
    try {
      await write({ path: 'api/captures/resolve', body: { path: capture.path, decision, text }, kind: 'capture', label: 'Ring capture' });
      onClose();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Not saved.', 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open={!!capture} onClose={onClose} title="Ring capture" testId="capture-sheet">
      <blockquote className="transcript">{detail ? detail.transcript || capture?.preview : 'Loading…'}</blockquote>
      <div className="field-group" data-reveal>
      <label className="field">
        <span>As a task</span>
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} data-testid="capture-task-text" />
      </label>
      <div className="capture-actions">
        <button type="button" className="btn btn-primary" disabled={busy || !text.trim()} onClick={() => void resolve('task')} data-testid="capture-make-task">
          Make task
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void resolve('note')} data-testid="capture-make-note">
          Keep as note
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void resolve('ignore')} data-testid="capture-ignore">
          Ignore
        </button>
      </div>
      </div>
      {capture && (
        <div className="sheet-actions">
          <button type="button" className="btn btn-quiet" onClick={() => setEditing(capture.path)} data-testid="capture-edit">
            <Pencil aria-hidden /> Title and tags
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-danger"
            onClick={() => {
              onClose();
              void archivePaths([{ path: capture.path, label: capture.title }]);
            }}
            data-testid="capture-archive"
          >
            <Archive aria-hidden /> Archive
          </button>
        </div>
      )}
      {editing && <NoteSheet path={editing} onClose={() => setEditing(null)} />}
    </Sheet>
  );
}

export function SessionDone() {
  return (
    <section className="card session-done" data-testid="session-complete" aria-live="polite">
      <h2>Evening session complete</h2>
      <p className="secondary">Everything from today is sorted and your check-in is logged.</p>
    </section>
  );
}
