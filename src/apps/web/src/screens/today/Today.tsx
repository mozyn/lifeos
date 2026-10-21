/**
 * Today (spec §6): the three moments. Time of day picks the mode (before 11:00 morning, 11–17
 * midday, after 17:00 evening); the segmented control in the top bar switches. At most four cards
 * above the fold on a 412 px screen; everything else is one tap away. On the fold's inner screen,
 * two panes: the moment's cards and the week strip.
 */
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Moon, Sun, Sunrise } from 'lucide-react';
import { hm12, shortDateDow } from '@lifeos/shared';
import { Segmented, useMedia } from '../../components/ui';
import { TopBarSlot, useGo } from '../../shell/context';
import { setSegState, switchSegment, warmSegments } from '../../lib/segments';
import { rewardBig } from '../../lib/rewards';
import { endSelectIn, SelectScope } from '../../lib/selection';
import { useResource } from '../../lib/store';
import { isNarrow } from '../../lib/viewport';
import type { Today, Week } from '../../lib/types';
import { EventRow } from '../calendar/parts';
import { DayHeader } from './DayHeader';
import { CheckinCard, ChipStrip, FocusCard, PlanCard, ProgressCard, RemainingCard, ReviewCard, SessionDone, TomorrowCard, UnsortedCard, WhatChanged } from './cards';

export type Mode = 'morning' | 'midday' | 'evening';
const MODES: Mode[] = ['morning', 'midday', 'evening'];

export function modeAt(d: Date): Mode {
  const h = d.getHours();
  return h < 11 ? 'morning' : h < 17 ? 'midday' : 'evening';
}

export function useNow(everyMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), everyMs);
    const vis = () => document.visibilityState === 'visible' && setNow(new Date());
    document.addEventListener('visibilitychange', vis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', vis);
    };
  }, [everyMs]);
  return now;
}

/**
 * The week ahead (the fold's side pane): a day's name opens it in the Calendar; its events are the
 * events themselves, edited in place with the Calendar's event sheet (round-3 brief §4).
 */
function WeekStrip({ today }: { today: Today }) {
  const { data } = useResource<Week>('api/week?from=today');
  const go = useGo();
  if (!data) return null;
  return (
    <section className="card week-strip" aria-labelledby="ws-h" data-testid="week-strip">
      <div className="card-head">
        <h2 id="ws-h">The week ahead</h2>
      </div>
      <ol className="ws-days">
        {data.days.map((d) => {
          const open = d.tasks.filter((t) => t.status === 'open').length;
          return (
            <li key={d.date} className={`ws-day${d.date === today.date ? ' is-today' : ''}`} data-testid="ws-day">
              <button type="button" className="ws-date" onClick={() => go(`/calendar?view=day&d=${d.date}`)} aria-label={`${d.date === today.date ? 'Today' : shortDateDow(d.date)}: open the day`}>
                {d.date === today.date ? 'Today' : shortDateDow(d.date)}
              </button>
              <div className="ws-items">
                {d.events.length === 0 && open === 0 && <span className="muted">Free</span>}
                {d.events.length > 0 && (
                  <ul className="ws-evs">
                    {d.events.slice(0, 3).map((e) => (
                      <EventRow key={e.id} e={e} className="ws-ev" testId="ws-event">
                        {e.time ? <span className="num">{hm12(e.time)}</span> : null} {e.text}
                      </EventRow>
                    ))}
                  </ul>
                )}
                {open > 0 && (
                  <button type="button" className="ws-tasks" onClick={() => go(`/calendar?view=day&d=${d.date}`)}>
                    {open} {open === 1 ? 'task due' : 'tasks due'}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

const MODE_LABEL: Record<Mode, string> = { morning: 'Morning', midday: 'Midday', evening: 'Evening' };
/** under 400 px (round-3 brief §5): an icon over the label in 12 px (the tab bar's size), so the switch fits beside the eye, the sun/moon and the gear */
const MODE_ICON: Record<Mode, ReactNode> = { morning: <Sunrise aria-hidden />, midday: <Sun aria-hidden />, evening: <Moon aria-hidden /> };

/** One moment's cards: one selection scope (round-3 brief §4), so Select in a task's hold menu picks up any of its tasks. */
function MomentCards({ m, today, hm }: { m: Mode; today: Today; hm: string }) {
  let cards;
  if (m === 'morning')
    cards = (
      <>
        <PlanCard today={today} />
        <FocusCard today={today} />
        <CheckinCard today={today} moment="morning" />
        <ChipStrip today={today} />
      </>
    );
  else if (m === 'midday')
    cards = (
      <>
        <ProgressCard today={today} />
        <WhatChanged today={today} />
        <RemainingCard today={today} hm={hm} />
        <ChipStrip today={today} />
      </>
    );
  else
    cards = (
      <>
        {today.session.complete && <SessionDone />}
        <ReviewCard today={today} />
        <CheckinCard today={today} moment="evening" rows={['mood', 'energy']} title="How was today?" dismissible={false} inline />
        <UnsortedCard today={today} />
        <TomorrowCard today={today} />
      </>
    );
  return <SelectScope.Provider value={`today:${m}`}>{cards}</SelectScope.Provider>;
}

/**
 * The three moments stay mounted (round-2 brief §11), as Lists' segments do (lib/segments.ts): the
 * one shown first, the others once Today is on screen and the app is idle. A switch is a 150 ms
 * cross-fade in one grid cell, so the cards' container never collapses and nothing below jumps;
 * each moment keeps its own scroll position; with reduced motion the switch is instant.
 */
function Moments({ mode, today, hm }: { mode: Mode; today: Today; hm: string }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState<ReadonlySet<Mode>>(() => new Set([mode]));
  const shown = useRef<Mode>(mode);
  const segs = useRef(new Map<Mode, HTMLElement>());
  const has = mounted.has(mode) ? mounted : new Set([...mounted, mode]);
  useLayoutEffect(() => {
    if (!mounted.has(mode)) setMounted((m) => new Set([...m, mode]));
    const body = bodyRef.current;
    const to = segs.current.get(mode);
    if (!body || !to || shown.current === mode) return;
    switchSegment(body, segs.current.get(shown.current) ?? null, to, { from: shown.current, to: mode });
    shown.current = mode;
  }, [mode, mounted]);
  useEffect(() => warmSegments(bodyRef.current, MODES, (k) => setMounted((m) => (m.has(k) ? m : new Set([...m, k])))), []);
  const segRef = useCallback(
    (k: Mode) => (el: HTMLElement | null) => {
      if (!el) {
        segs.current.delete(k);
        return;
      }
      segs.current.set(k, el);
      if (!el.dataset.state) setSegState(el, k === shown.current ? 'active' : 'hidden');
    },
    [],
  );
  const refs = useMemo(() => Object.fromEntries(MODES.map((m) => [m, segRef(m)])) as Record<Mode, (el: HTMLElement | null) => void>, [segRef]);
  return (
    <div className="today-moments" ref={bodyRef} data-testid="today-moments">
      {MODES.filter((m) => has.has(m)).map((m) => (
        <section key={m} className="seg-pane today-moment" data-seg={m} ref={refs[m]} aria-label={MODE_LABEL[m]} data-testid={`moment-${m}`}>
          <MomentCards m={m} today={today} hm={hm} />
        </section>
      ))}
    </div>
  );
}

export function TodayScreen() {
  const { data: today, error } = useResource<Today>('api/today');
  const now = useNow();
  const auto = modeAt(now);
  const [picked, setPicked] = useState<{ mode: Mode; auto: Mode } | null>(null);
  // a manual choice holds until the clock moves into another moment
  const mode = picked && picked.auto === auto ? picked.mode : auto;
  // a selection belongs to the moment it started in
  useEffect(() => endSelectIn('today:'), [mode]);
  const wide = useMedia('(min-width: 700px)');
  const narrow = isNarrow();
  const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  // closing the evening session plays the completion reward, once, and only when it happens now
  const wasComplete = useRef<boolean | null>(null);
  useEffect(() => {
    if (!today) return;
    const complete = today.session.complete;
    if (wasComplete.current === false && complete && mode === 'evening') rewardBig(document.querySelector('[data-testid="moment-evening"] [data-testid="session-complete"]'));
    wasComplete.current = complete;
  }, [today, mode]);

  const control = (
    <TopBarSlot>
      <Segmented
        label="Moment of the day"
        onGlass
        compact={narrow}
        value={mode}
        onChange={(m) => m !== mode && setPicked({ mode: m, auto })}
        options={MODES.map((m) => ({ value: m, label: MODE_LABEL[m], icon: narrow ? MODE_ICON[m] : undefined, testId: `mode-${m}` }))}
        testId="mode-switch"
      />
    </TopBarSlot>
  );

  if (!today) {
    return (
      <div className="page">
        {control}
        {error ? (
          <section className="card">
            <h2>Today could not load</h2>
            <p className="secondary">{error.message === 'offline' ? 'You are offline and nothing is saved on this device yet.' : error.message}</p>
          </section>
        ) : (
          <div className="skeleton" aria-busy="true" aria-label="Loading today" />
        )}
      </div>
    );
  }

  return (
    <div className="page today" data-mode={mode} data-testid={`today-${mode}`}>
      {control}
      <DayHeader today={today} now={now} />
      {wide ? (
        <div className="today-panes">
          <div className="pane-main">
            <Moments mode={mode} today={today} hm={hm} />
          </div>
          <aside className="pane-side">
            <WeekStrip today={today} />
          </aside>
        </div>
      ) : (
        <Moments mode={mode} today={today} hm={hm} />
      )}
    </div>
  );
}
