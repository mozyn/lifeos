/**
 * Calendar → Day (round-2 brief §3): one day's agenda. The five prayers make the day's timeline,
 * with the timed events from the weekly note between them (all-day ones on top) and "now" marked
 * on today; then the tasks due, the habits due with how each went (the day's streak mark beside
 * them, §4), and progress chips for the goals the day's tasks serve. Swipe sideways or use the
 * arrows for the next and previous day.
 */
import { useEffect, useRef } from 'react';
import { FIVE, hm12, PRAYER_LABELS } from '@lifeos/shared';
import { TaskRow } from '../../components/TaskRow';
import { SelectScope } from '../../lib/selection';
import { HabitLogRow } from '../today/cards';
import { motionReduced } from '../../glass/spring';
import { PRIVATE_LABEL } from '../../lib/privacy';
import { Curtained } from '../../components/Private';
import type { CalendarDay, EventItem } from '../../lib/types';
import { useGo } from '../../shell/context';
import { DayMarkButton, EventRow, habitValueLabel, useVisibleHabits } from './parts';

const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

type Item = { kind: 'prayer'; name: string; time: string } | { kind: 'event'; id: string; time: string; text: string; e: EventItem } | { kind: 'now'; time: string };

/** A horizontal swipe on the day (a finger moving sideways more than up or down) moves a day. */
function useDaySwipe(ref: React.RefObject<HTMLElement | null>, onSwipe: (dir: 1 | -1) => void) {
  const cb = useRef(onSwipe);
  cb.current = onSwipe;
  useEffect(() => {
    // the whole Day view listens: while a day slides in (a view transition scoped to the day's
    // content), the content is not hit-tested and a finger lands on its container
    const el = ref.current?.closest<HTMLElement>('.seg-pane') ?? ref.current;
    if (!el) return;
    let id = -1;
    let x0 = 0;
    let y0 = 0;
    let t0 = 0;
    let lock: 'x' | 'y' | null = null;
    const down = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // a row's own swipe (edit, delete) is not a day's
      if ((e.target as Element).closest('input, textarea, .row-meta, .picks, [data-swipe]')) return;
      id = e.pointerId;
      x0 = e.clientX;
      y0 = e.clientY;
      t0 = performance.now();
      lock = null;
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== id || lock) return;
      const dx = e.clientX - x0;
      const dy = e.clientY - y0;
      if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) lock = 'y';
      else if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.4) lock = 'x';
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      id = -1;
      if (lock !== 'x') return;
      const dx = e.clientX - x0;
      const fast = Math.abs(dx) / Math.max(1, performance.now() - t0) > 0.5;
      if (Math.abs(dx) > 70 || (fast && Math.abs(dx) > 36)) cb.current(dx < 0 ? 1 : -1);
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', () => (id = -1));
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
  }, [ref]);
}

export function DayView({ data, nowHm, onMove, contentRef }: { data: CalendarDay | null; nowHm: string; onMove: (dir: 1 | -1) => void; contentRef: React.RefObject<HTMLDivElement | null> }) {
  const go = useGo();
  useDaySwipe(contentRef, onMove);
  const { hidePrivate } = useVisibleHabits(data?.habits ?? []);
  if (!data) {
    return (
      <div className="cal-day" ref={contentRef} data-testid="cal-day">
        <div className="skeleton" aria-busy="true" />
      </div>
    );
  }
  const isToday = data.date === data.today;
  const timed: Item[] = [...FIVE.map((p) => ({ kind: 'prayer' as const, name: p, time: data.prayers[p] })), ...data.events.filter((e) => e.time).map((e) => ({ kind: 'event' as const, id: e.id, time: e.time!, text: e.text, e }))];
  if (isToday) timed.push({ kind: 'now', time: nowHm });
  // events before prayers at the same minute; "now" after both
  const rank = (i: Item) => (i.kind === 'event' ? 0 : i.kind === 'prayer' ? 1 : 2);
  timed.sort((a, b) => toMin(a.time) - toMin(b.time) || rank(a) - rank(b));
  const allDay = data.events.filter((e) => !e.time);
  const open = data.tasks.filter((t) => t.status === 'open');
  const done = data.tasks.filter((t) => t.status === 'done');
  return (
    <div className="cal-day" ref={contentRef} data-testid="cal-day" data-date={data.date}>
      {data.goals.length > 0 && (
        <div className="goal-chips" aria-label="Goals these tasks serve">
          {data.goals.map((g) => (
            <button key={g.slug} type="button" className="goal-chip" onClick={() => go(`/goals/${g.slug}`)} data-testid="goal-chip">
              <span className="goal-chip-title">{g.title}</span>
              <span className="goal-chip-n num">
                {g.done} of {g.total}
              </span>
              <span className="goal-chip-bar" aria-hidden>
                <span style={{ transform: `scaleX(${g.total ? g.done / g.total : 0})` }} />
              </span>
            </button>
          ))}
        </div>
      )}
      <section className="card" aria-labelledby="day-tl-h" data-testid="day-timeline">
        <div className="card-head">
          <h2 id="day-tl-h">Prayers and events</h2>
        </div>
        {allDay.length > 0 && (
          <ul className="tl-allday">
            {allDay.map((e) => (
              <EventRow key={e.id} e={e} testId="day-event">
                <span className="tl-time">All day</span>
                <span className="tl-text">{e.text}</span>
              </EventRow>
            ))}
          </ul>
        )}
        <ol className="timeline">
          {timed.map((i) =>
            i.kind === 'now' ? (
              <li key="now" className="tl-now" aria-label={`Now, ${hm12(i.time)}`}>
                <span className="tl-time num">{hm12(i.time)}</span>
                <span className="tl-text">Now</span>
              </li>
            ) : i.kind === 'prayer' ? (
              <li key={i.name} className={`tl-prayer${isToday && toMin(i.time) <= toMin(nowHm) ? ' passed' : ''}`} data-testid="day-prayer">
                <span className="tl-time num">{hm12(i.time)}</span>
                <span className="tl-text">{PRAYER_LABELS[i.name as keyof typeof PRAYER_LABELS]}</span>
              </li>
            ) : (
              <EventRow key={i.id} e={i.e} className="tl-event" testId="day-event">
                <span className="tl-time num">{hm12(i.time)}</span>
                <span className="tl-text">{i.text}</span>
              </EventRow>
            ),
          )}
        </ol>
      </section>
      <section className="card" aria-labelledby="day-due-h" data-testid="day-tasks">
        <div className="card-head">
          <h2 id="day-due-h">Due</h2>
          {data.tasks.length > 0 && <span className="card-aside">{done.length ? `${done.length} of ${data.tasks.length} done` : data.tasks.length}</span>}
        </div>
        {data.tasks.length === 0 ? (
          <p className="empty">No tasks due this day.</p>
        ) : (
          <SelectScope.Provider value={`day:${data.date}`}>
            <div className="rows">
              {[...open, ...done].map((t) => (
                <TaskRow key={t.id} task={t} today={data.today} />
              ))}
            </div>
          </SelectScope.Provider>
        )}
      </section>
      {data.habits.length > 0 && (
        <section className="card" aria-labelledby="day-hab-h" data-testid="day-habits">
          <div className="card-head">
            <h2 id="day-hab-h">Habits</h2>
            <DayMarkButton date={data.date} habits={data.habits} />
          </div>
          {isToday ? (
            <div className="review-habits">
              {data.habits.map((h) => (
                <HabitLogRow key={h.path} h={{ ...h, status: 'active', started: null, why: null, scheduledToday: true, today: h.value, best: 0, logs: [] }} />
              ))}
            </div>
          ) : (
            <ul className="habit-day-list">
              {data.habits.map((h) => (
                <Curtained as="li" key={h.path} isPrivate={h.private} data-value={h.value ?? 'none'} aria-label={h.private && hidePrivate ? PRIVATE_LABEL : h.title}>
                  <span>{h.title}</span>
                  <span className={`tag${h.value === 'clean' ? ' goal' : h.value === 'slip' ? ' due-over' : ''}`}>{data.date > data.today ? 'Due' : habitValueLabel(h)}</span>
                </Curtained>
              ))}
            </ul>
          )}
        </section>
      )}
      <p className="caption cal-hint">{motionReduced() ? 'Use the arrows for the next and previous day.' : 'Swipe sideways or use the arrows for the next and previous day.'}</p>
    </div>
  );
}
