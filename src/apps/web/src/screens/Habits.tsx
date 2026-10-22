/**
 * Habits (spec §4.4, §5.5, §9 job 3): build and quit habits, today's log in one tap, streaks, the
 * month calendar, and the slip flow — a slip is logged without drama, then a verbatim library entry
 * and a short encouragement (labelled "From LifeOS") are shown. On the big screen (round 8f,
 * ADR-107) it is master and detail: the habits on the left; the one opened (its edit, past days and
 * archive) or a slip's flow in the side panel, which shows the streaks and the day's reminder
 * while nothing is open.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, Eye, EyeOff, MoreHorizontal, Pencil, Plus } from 'lucide-react';
import { addDays, longDate, mondayOf, monthStates, monthYear, parseSchedule, shortDate, shortDateDow, todayIn, weekday, type DayState } from '@lifeos/shared';
import { FromLifeOS, HadithEntry, type Entry } from '../components/Hadith';
import { Curtained, habitName } from '../components/Private';
import { Segmented, Sheet, Switch, useMedia } from '../components/ui';
import { SidePanel } from '../components/SidePanel';
import { WIDE } from '../lib/dock';
import { usePrivacy } from '../lib/privacy';
import { ApiError } from '../lib/api';
import { rewardBig, rewardSmall } from '../lib/rewards';
import { toast, useResource, write } from '../lib/store';
import type { Habit } from '../lib/types';
import { drillIn } from '../lib/transitions';
import { archivePaths, useGone } from '../lib/edits';
import { SwipeRow } from '../components/SwipeRow';

interface NudgeDto {
  id: string;
  payload: { entry: Entry | null; encouragement: string; encouragementBy: 'model' | 'fallback'; reason: string };
  model: string | null;
  fallback: boolean;
  fallbackReason: string | null;
}

const LABELS = {
  quit: { clean: 'Held', slip: 'Slip', skip: 'Skip', kind: 'Quitting' },
  build: { clean: 'Done', slip: 'Missed', skip: 'Skip', kind: 'Building' },
};

const STATE_LABEL: Record<DayState, string> = {
  clean: 'clean',
  slip: 'slip',
  skip: 'skipped',
  'not-logged': 'not logged',
  'not-scheduled': 'not scheduled',
  future: 'ahead',
  'before-start': 'before the start',
};

function Month({ h, today, onPick }: { h: Habit; today: string; onPick: (date: string) => void }) {
  const [ym, setYm] = useState(today.slice(0, 7));
  const states = useMemo(() => monthStates(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), h.logs, h.schedule, h.started, today), [ym, h, today]);
  const lead = (weekday(`${ym}-01`) + 6) % 7;
  const move = (n: number) => {
    const d = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + n, 1));
    setYm(d.toISOString().slice(0, 7));
  };
  return (
    <div className="month" data-testid="habit-month">
      <div className="month-head">
        <button type="button" className="icon-btn" aria-label="Previous month" onClick={() => move(-1)}>
          ‹
        </button>
        <span>
          {monthYear(ym)}
        </span>
        <button type="button" className="icon-btn" aria-label="Next month" onClick={() => move(1)} disabled={ym >= today.slice(0, 7)}>
          ›
        </button>
      </div>
      <div className="month-grid" role="grid" aria-label={`${h.title}, ${monthYear(ym)}`}>
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
          <span key={i} className="month-dow" aria-hidden>
            {d}
          </span>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          <span key={`lead${i}`} />
        ))}
        {states.map((s) => (
          <button
            key={s.date}
            type="button"
            className={`day day-${s.state}${s.date === today ? ' is-today' : ''}`}
            disabled={s.state === 'future' || s.state === 'before-start'}
            onClick={() => onPick(s.date)}
            aria-label={`${shortDateDow(s.date)}: ${STATE_LABEL[s.state]}`}
          >
            {Number(s.date.slice(8))}
          </button>
        ))}
      </div>
      <p className="caption month-key">
        <span className="key key-clean" /> clean <span className="key key-slip" /> slip <span className="key key-skip" /> skipped <span className="key key-not-logged" /> not logged
      </p>
    </div>
  );
}

function NudgeView({ n, h }: { n: NudgeDto; h: Habit }) {
  return (
    <div className="nudge" data-testid="nudge">
      {n.payload.entry ? <HadithEntry e={n.payload.entry} /> : <p className="caption">The hadith library is empty: copy Resources/hadith-library from the starter vault into your notes folder (see the README).</p>}
      <FromLifeOS text={n.payload.encouragement} fallback={n.payload.encouragementBy === 'fallback'} model={n.model} names={h.private ? [h.title, h.slug] : undefined} />
    </div>
  );
}

export function SlipSheet({ h, date, onClose }: { h: Habit | null; date: string; onClose: () => void }) {
  const privacy = usePrivacy();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [nudge, setNudge] = useState<NudgeDto | null>(null);
  useEffect(() => {
    setNote('');
    setNudge(null);
  }, [h]);
  if (!h) return null;
  const save = async () => {
    setBusy(true);
    try {
      await write({ path: 'api/habits/log', body: { path: h.path, value: 'slip', note: note.trim() || null, date }, kind: 'habit-log', label: h.title });
      if (date === todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone)) {
        const r = await write<{ nudge: NudgeDto }>({ path: 'api/habits/slip', body: { path: h.path }, kind: 'habit-nudge', label: 'Encouragement' });
        if (r.result?.nudge) setNudge(r.result.nudge);
        else onClose();
      } else onClose();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Not logged.', 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title={nudge ? 'Slip logged' : `${LABELS[h.kind].slip}: ${habitName(h, privacy)}`}
      testId="slip-sheet"
      footer={
        nudge ? (
          <button type="button" className="btn btn-block" onClick={onClose}>
            Close
          </button>
        ) : (
          <button type="button" className="btn btn-primary btn-block" disabled={busy} onClick={() => void save()} data-testid="slip-save">
            Log {h.kind === 'quit' ? 'slip' : 'missed day'}
          </button>
        )
      }
    >
      {nudge ? (
        <NudgeView n={nudge} h={h} />
      ) : (
        <>
          <p className="secondary">It goes in the log as it is. Your history stays; tomorrow starts fresh.</p>
          <label className="field">
            <span>What happened? (optional)</span>
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="phone in bed again" data-testid="slip-note" />
          </label>
        </>
      )}
    </Sheet>
  );
}

/** "Next check-in: today", "Logged today · next Wed, Oct 21", "Next: Mon, Oct 26". */
export function nextCheckIn(h: Habit, today: string): string {
  const scheduled = parseSchedule(h.schedule);
  const next = (from: string) => {
    for (let i = 1; i <= 14; i++) {
      const d = addDays(from, i);
      if (scheduled(d)) return d;
    }
    return null;
  };
  const label = (d: string | null) => (!d ? '' : d === addDays(today, 1) ? 'tomorrow' : shortDateDow(d));
  if (h.scheduledToday && !h.today) return 'Next check-in: today';
  const n = next(today);
  if (h.today) return `Logged today${n ? ` · next ${label(n)}` : ''}`;
  return n ? `Next check-in: ${label(n)}` : 'No day scheduled soon';
}

const SCHEDULE_TEXT = (s: string) => {
  if (s === 'daily' || s === 'every day') return 'every day';
  if (s === 'weekdays' || s === 'weekends') return s;
  const map: Record<string, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
  return s.split(',').map((x) => map[x.trim().slice(0, 3)] ?? x).join(', ');
};

/** This month at a glance: one small bar per day, coloured by how it went; not a control. */
function MonthStrip({ h, today }: { h: Habit; today: string }) {
  const ym = today.slice(0, 7);
  const states = useMemo(() => monthStates(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), h.logs, h.schedule, h.started, today), [ym, h, today]);
  const count = (k: DayState) => states.filter((x) => x.state === k).length;
  const summary = `${monthYear(ym)}: ${count('clean')} kept, ${count('slip')} ${count('slip') === 1 ? 'slip' : 'slips'}, ${count('skip')} skipped, ${count('not-logged')} not logged`;
  return (
    <div className="mstrip" role="img" aria-label={summary} data-testid="month-strip">
      <div className="mstrip-days">
        {states.map((x) => (
          <span key={x.date} className={`ms ms-${x.state}${x.date === today ? ' is-today' : ''}`} />
        ))}
      </div>
      <div className="mstrip-ends caption" aria-hidden>
        <span>{shortDate(`${ym}-01`)}</span>
        <span>{shortDate(states[states.length - 1].date)}</span>
      </div>
    </div>
  );
}

/** Today's log as one grouped glass control: Done/Held, Slip, Skip (round-2 brief §5). */
function LogControl({ h, value, onLog, onSlip }: { h: Habit; value: Habit['today']; onLog: (v: 'clean' | 'skip', el: HTMLElement | null) => void; onSlip: (el: HTMLElement | null) => void }) {
  const L = LABELS[h.kind];
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} className="habit-log" data-testid="habit-log">
      <Segmented
        label={`${h.title} today`}
        fill
        value={value}
        onChange={(v) => {
          const el = ref.current?.querySelector<HTMLElement>(`[data-testid="habit-${v}"]`) ?? null;
          if (v === 'slip') onSlip(el);
          else onLog(v, el);
        }}
        options={[
          { value: 'clean', label: L.clean, testId: 'habit-clean' },
          { value: 'slip', label: L.slip, testId: 'habit-slip' },
          { value: 'skip', label: L.skip, testId: 'habit-skip' },
        ]}
      />
    </div>
  );
}

async function setPrivate(h: Habit, on: boolean): Promise<void> {
  try {
    await write({ method: 'PATCH', path: 'api/habits', body: { path: h.path, private: on }, kind: 'habit-edit', label: 'Edit habit' });
    toast(on ? `${h.title} is private` : `${h.title} is no longer private`);
  } catch (e) {
    toast(e instanceof ApiError ? e.message : 'Not saved.', 'error');
  }
}

function HabitCard({ h, today, onSlip, onOpen, selected = false }: { h: Habit; today: string; onSlip: (h: Habit, date: string) => void; onOpen: (h: Habit, el: HTMLElement) => void; selected?: boolean }) {
  const privacy = usePrivacy();
  const [value, setValue] = useState(h.today);
  const { data: nudge } = useResource<{ nudge: NudgeDto | null }>(h.today === 'slip' ? `api/habits/nudge?path=${encodeURIComponent(h.path)}` : null);
  useEffect(() => setValue(h.today), [h.today]);
  const L = LABELS[h.kind];
  const log = async (v: 'clean' | 'skip', el: HTMLElement | null) => {
    setValue(v);
    try {
      const r = await write<{ extended: boolean }>({ path: 'api/habits/log', body: { path: h.path, value: v, date: today }, kind: 'habit-log', label: h.title });
      if (v === 'clean') {
        // a clean day that extends the streak: the bigger reward (§7)
        if (r.result?.extended) rewardBig(el);
        else rewardSmall(null);
      }
    } catch (e) {
      setValue(h.today);
      toast(e instanceof ApiError ? e.message : 'Not logged.', 'error');
    }
  };
  return (
    <Curtained as="section" isPrivate={h.private} className={`card habit${selected ? ' is-selected' : ''}`} testId="habit-card" aria-label={habitName(h, privacy)} aria-current={selected ? 'true' : undefined}>
      {/* touch and hold the habit's name for its menu (round-2 brief §12) */}
      <SwipeRow
        plain
        rowKey={h.path}
        className="habit-top"
        menuTitle={h.title}
        menu={() => [
          { label: 'Edit', icon: <Pencil aria-hidden />, run: () => onOpen(h, document.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(h.path)}"] .habit-more`) ?? document.body), testId: 'menu-edit' },
          { label: h.private ? 'Make it not private' : 'Make private', icon: h.private ? <Eye aria-hidden /> : <EyeOff aria-hidden />, run: () => void setPrivate(h, !h.private), testId: 'menu-private' },
          { label: 'Archive', icon: <Archive aria-hidden />, run: () => void archivePaths([{ path: h.path, label: h.title }], { route: 'api/habits/archive' }), tone: 'danger', testId: 'menu-archive' },
        ]}
      >
        <div className="habit-id">
          <h2>{h.title}</h2>
          <span className="caption">
            {L.kind} · {SCHEDULE_TEXT(h.schedule)}
          </span>
        </div>
        <div className="streak" aria-label={`Streak ${h.streak} ${h.streak === 1 ? 'day' : 'days'}, best ${h.best}`}>
          <span className="streak-n num" data-testid="streak">
            {h.streak}
          </span>
          <span className="caption">{h.streak === 1 ? 'day' : 'days'}</span>
        </div>
        <button type="button" className="icon-btn habit-more" aria-label={`${h.title}: edit, past days, archive`} onClick={(e) => onOpen(h, e.currentTarget)} data-testid="habit-more">
          <MoreHorizontal />
        </button>
      </SwipeRow>
      <p className="habit-next" data-testid="habit-next">
        {nextCheckIn(h, today)}
      </p>
      <MonthStrip h={h} today={today} />
      {h.scheduledToday ? <LogControl h={h} value={value} onLog={(v, el) => void log(v, el)} onSlip={(el) => void drillIn(el, () => onSlip(h, today))} /> : <p className="caption habit-off">Not scheduled today.</p>}
      {h.today === 'slip' && nudge?.nudge && <NudgeView n={nudge.nudge} h={h} />}
    </Curtained>
  );
}

const DAYS = [
  ['mon', 'M'],
  ['tue', 'T'],
  ['wed', 'W'],
  ['thu', 'T'],
  ['fri', 'F'],
  ['sat', 'S'],
  ['sun', 'S'],
] as const;

type Sched = 'daily' | 'weekdays' | 'weekends' | 'days';

function schedOf(s: string): { kind: Sched; days: string[] } {
  if (s === 'daily' || s === 'weekdays' || s === 'weekends') return { kind: s, days: [] };
  return { kind: 'days', days: s.split(',').map((x) => x.trim().slice(0, 3)) };
}

/** The fields a habit has (new, or an edit of one): name, kind, schedule, started. Solid choices inside a sheet. */
function HabitFields({ v, set }: { v: { title: string; kind: 'build' | 'quit'; sched: Sched; days: string[]; started?: string }; set: (p: Partial<{ title: string; kind: 'build' | 'quit'; sched: Sched; days: string[]; started: string }>) => void }) {
  return (
    <>
      <label className="field">
        <span>Habit</span>
        <input className="input" value={v.title} onChange={(e) => set({ title: e.target.value })} placeholder={v.kind === 'quit' ? 'No late-night scrolling' : 'Morning walk'} data-testid="habit-title" />
      </label>
      <div className="field">
        <span>Kind</span>
        <div className="picks" role="radiogroup" aria-label="Kind">
          {(['build', 'quit'] as const).map((k) => (
            <button key={k} type="button" role="radio" className="pick" aria-checked={v.kind === k} onClick={() => set({ kind: k })} data-testid={`habit-kind-${k}`}>
              {k === 'build' ? 'Build' : 'Quit'}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span>When</span>
        <div className="picks" role="radiogroup" aria-label="Schedule">
          {(
            [
              ['daily', 'Every day'],
              ['weekdays', 'Weekdays'],
              ['weekends', 'Weekends'],
              ['days', 'Some days'],
            ] as const
          ).map(([k, l]) => (
            <button key={k} type="button" role="radio" className="pick" aria-checked={v.sched === k} onClick={() => set({ sched: k, days: k === 'days' && !v.days.length ? ['mon', 'wed', 'fri'] : v.days })} data-testid={`habit-sched-${k}`}>
              {l}
            </button>
          ))}
        </div>
        {v.sched === 'days' && (
          <div className="picks day-picks" role="group" aria-label="Days">
            {DAYS.map(([d, l]) => (
              <button key={d} type="button" className="pick" aria-pressed={v.days.includes(d)} aria-label={d} onClick={() => set({ days: v.days.includes(d) ? v.days.filter((x) => x !== d) : DAYS.map((x) => x[0]).filter((x) => x === d || v.days.includes(x)) })}>
                {l}
              </button>
            ))}
          </div>
        )}
      </div>
      {v.started !== undefined && (
        <label className="field">
          <span>Started</span>
          <input className="input" type="date" value={v.started} onChange={(e) => set({ started: e.target.value })} data-testid="habit-started" />
        </label>
      )}
    </>
  );
}

const scheduleValue = (v: { sched: Sched; days: string[] }) => (v.sched === 'days' ? v.days.join(',') || 'daily' : v.sched);

function NewHabit({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [v, setV] = useState({ title: '', kind: 'build' as 'build' | 'quit', sched: 'daily' as Sched, days: [] as string[] });
  useEffect(() => {
    if (open) setV({ title: '', kind: 'build', sched: 'daily', days: [] });
  }, [open]);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="New habit"
      testId="new-habit"
      footer={
        <button
          type="button"
          className="btn btn-primary btn-block"
          data-testid="habit-create"
          disabled={!v.title.trim()}
          onClick={async () => {
            try {
              await write({ path: 'api/habits', body: { title: v.title, kind: v.kind, schedule: scheduleValue(v) }, kind: 'habit', label: 'New habit' });
              toast('Habit created in Areas/Habits');
              onClose();
            } catch (e) {
              toast(e instanceof ApiError ? e.message : 'Not saved.', 'error');
            }
          }}
        >
          Create habit
        </button>
      }
    >
      <HabitFields v={v} set={(p) => setV((cur) => ({ ...cur, ...p }))} />
    </Sheet>
  );
}

/**
 * One habit's sheet (round-2 brief §6): edit (name, kind, schedule, started: the note's frontmatter
 * and title only, the log untouched), private, log a past day, archive ("delete": the note moves to
 * Archive/Habits with its log; Settings → Advanced → Data restores it).
 */
function HabitSheet({ h, today, onClose, onSlip }: { h: Habit; today: string; onClose: () => void; onSlip: (h: Habit, date: string) => void }) {
  const init = () => ({ title: h.title, kind: h.kind, ...(() => { const s = schedOf(h.schedule); return { sched: s.kind, days: s.days }; })(), started: h.started ?? '', private: h.private });
  const [v, setV] = useState(init);
  const [busy, setBusy] = useState(false);
  const [past, setPast] = useState<string | null>(null);
  const L = LABELS[v.kind];
  const changed = v.title.trim() !== h.title || v.kind !== h.kind || scheduleValue(v) !== h.schedule || (v.started || null) !== h.started || v.private !== h.private;
  const save = async () => {
    setBusy(true);
    try {
      await write({ method: 'PATCH', path: 'api/habits', body: { path: h.path, title: v.title.trim() !== h.title ? v.title.trim() : undefined, kind: v.kind !== h.kind ? v.kind : undefined, schedule: scheduleValue(v) !== h.schedule ? scheduleValue(v) : undefined, started: v.started && v.started !== h.started ? v.started : undefined, private: v.private !== h.private ? v.private : undefined }, kind: 'habit-edit', label: 'Edit habit' });
      toast('Habit saved');
      onClose();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Not saved.', 'error');
    } finally {
      setBusy(false);
    }
  };
  /** No confirm (round-2 brief §12): archived at once, with a 6 s Undo; Settings → Advanced → Data restores it later. */
  const archive = () => {
    onClose();
    void archivePaths([{ path: h.path, label: h.title }], { route: 'api/habits/archive' });
  };
  const logPast = async (value: 'clean' | 'skip', date: string) => {
    try {
      await write({ path: 'api/habits/log', body: { path: h.path, value, date }, kind: 'habit-log', label: h.title });
      toast(`${shortDateDow(date)}: ${value === 'clean' ? L.clean.toLowerCase() : 'skipped'}`);
      setPast(null);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Not logged.', 'error');
    }
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title={h.title}
      testId="habit-sheet"
      footer={
        <button type="button" className="btn btn-primary btn-block" disabled={busy || !changed || !v.title.trim()} onClick={() => void save()} data-testid="habit-save">
          Save changes
        </button>
      }
    >
      <HabitFields v={v} set={(p) => setV((cur) => ({ ...cur, ...p }))} />
      <Switch label="Private" hint="While Privacy mode is on: blurred, named only “Private habit”, left out of the calendar’s marks. Never named in a Telegram nudge." checked={v.private} onChange={(x) => setV((cur) => ({ ...cur, private: x }))} testId="habit-private" />
      <div className="field">
        <span>Log a past day</span>
        <Month h={h} today={today} onPick={(d) => setPast(d)} />
        {past && (
          <div className="past-log" data-testid="past-log">
            <span className="secondary">{longDate(past)}</span>
            <div className="picks">
              <button type="button" className="pick" onClick={() => void logPast('clean', past)}>
                {L.clean}
              </button>
              <button type="button" className="pick" onClick={() => onSlip(h, past)}>
                {L.slip}
              </button>
              <button type="button" className="pick" onClick={() => void logPast('skip', past)}>
                {L.skip}
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="field danger-zone">
        <button type="button" className="btn btn-ghost btn-danger" onClick={archive} data-testid="habit-archive">
          <Archive aria-hidden /> Archive this habit
        </button>
        <span className="caption">The note moves to Archive/Habits with its whole log. Undo right after, or restore it any time from Settings → Advanced → Data.</span>
      </div>
    </Sheet>
  );
}

/** The week so far across the active habits: kept of the scheduled days (skips and today's not-yet left out). */
export function weekRate(habits: Habit[], today: string): { kept: number; total: number } {
  const monday = mondayOf(today);
  let kept = 0;
  let total = 0;
  for (const h of habits) {
    const sched = parseSchedule(h.schedule);
    const map = new Map(h.logs.map((l) => [l.date, l.value]));
    for (let d = monday; d <= today; d = addDays(d, 1)) {
      if (h.started && d < h.started) continue;
      const v = map.get(d);
      if (!sched(d) && !v) continue;
      if (v === 'skip') continue;
      if (v === 'clean') {
        kept++;
        total++;
      } else if (v === 'slip' || d < today) total++;
    }
  }
  return { kept, total };
}

function DailyPick() {
  const { data, reload } = useResource<{ entry: Entry | null; pinned: boolean; size: number }>('api/library/daily');
  if (!data?.entry) return null;
  return (
    <section className="card daily-pick" aria-labelledby="dp-h" data-testid="daily-pick">
      <div className="card-head">
        <h2 id="dp-h">A reminder for today</h2>
        {!data.pinned && (
          <button
            type="button"
            className="btn btn-quiet"
            onClick={async () => {
              await write({ path: 'api/library/pin', body: { heading: data.entry!.heading }, kind: 'pin', label: 'Pin' }).catch(() => undefined);
              toast('Pinned to favorites.md');
              void reload();
            }}
          >
            Pin
          </button>
        )}
      </div>
      <HadithEntry e={data.entry} compact />
    </section>
  );
}

export function HabitsScreen() {
  const { data } = useResource<{ today: string; habits: Habit[] }>('api/habits');
  const privacy = usePrivacy();
  const [creating, setCreating] = useState(false);
  const [slip, setSlip] = useState<{ h: Habit; date: string } | null>(null);
  const [open, setOpen] = useState<Habit | null>(null);
  const gone = useGone();
  const active = data?.habits.filter((h) => h.status === 'active' && !gone.has(h.path)) ?? [];
  const today = data?.today ?? todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const best = active.reduce<Habit | null>((b, h) => (!b || h.streak > b.streak ? h : b), null);
  const rate = weekRate(active, today);
  // the sheet follows the habit's latest data (after a save the list refreshes)
  const current = open ? (active.find((h) => h.path === open.path) ?? null) : null;
  const desk = useMedia(WIDE);
  const stats = active.length > 0 && (
        <dl className="habit-stats" data-testid="habit-stats">
          <div>
            <dt>Longest streak</dt>
            <dd className="num" data-testid="stat-streak">
              {best?.streak ?? 0}
              <small>{best?.streak === 1 ? 'day' : 'days'}</small>
            </dd>
            {best && best.streak > 0 && <span className="caption">{habitName(best, privacy)}</span>}
          </div>
          <div>
            <dt>This week</dt>
            <dd className="num" data-testid="stat-week">
              {rate.total ? `${Math.round((100 * rate.kept) / rate.total)}%` : '—'}
            </dd>
            <span className="caption">{rate.total ? `${rate.kept} of ${rate.total} days kept` : 'Nothing due yet'}</span>
          </div>
        </dl>
  );
  const head = (
    <div className="page-head">
      <h1>Habits</h1>
      <button type="button" className="btn btn-primary" onClick={() => setCreating(true)} data-testid="new-habit-button">
        <Plus aria-hidden /> New habit
      </button>
    </div>
  );
  const list = (
    <>
      {!desk && stats}
      {data && active.length === 0 && (
        <section className="card">
          <p className="secondary">No habits yet. Build one (a morning walk) or quit one (late-night scrolling).</p>
        </section>
      )}
      <div className="habit-list">
        {active.map((h) => (
          <HabitCard key={h.path} h={h} today={today} onSlip={(x, date) => setSlip({ h: x, date })} onOpen={(x, el) => void drillIn(el, () => setOpen(x))} selected={desk && current?.path === h.path} />
        ))}
        {!desk && <DailyPick />}
      </div>
    </>
  );
  return (
    <div className={`page habits${desk ? ' habits-desk' : ''}`} data-testid="habits">
      {head}
      {desk ? <div className="habits-main">{list}</div> : list}
      {desk && (
        <SidePanel label="The habit opened" testId="habits-panel">
          {stats}
          <DailyPick />
          <p className="caption habits-hint">Open a habit (⋯) to edit it, log a past day or archive it; it opens here, beside the list.</p>
        </SidePanel>
      )}
      <NewHabit open={creating} onClose={() => setCreating(false)} />
      {current && <HabitSheet h={current} today={today} onClose={() => setOpen(null)} onSlip={(x, date) => setSlip({ h: x, date })} />}
      {slip && <SlipSheet h={slip.h} date={slip.date} onClose={() => setSlip(null)} />}
    </div>
  );
}
