/**
 * Calendar → Week (spec §4.2; round-2 brief §3 keeps it): seven days of events (the weekly note,
 * §5.9), tasks due, prayer times and Hijri dates; an agenda on the phone, seven columns on the fold
 * (840 px). Each day shows its streak mark (§4). Tasks and events can be selected together
 * (round-3 brief §4). On the big screen (round 8f, ADR-107) it is a time grid: the seven days side
 * by side in hour rows (TimeGrid), a day's head opening the day in the side panel.
 */
import { useEffect, useRef } from 'react';
import { FIVE, hm12, longDate, PRAYER_LABELS, WEEKDAYS_SHORT, weekday } from '@lifeos/shared';
import { useMedia } from '../../components/ui';
import { TaskRow } from '../../components/TaskRow';
import type { Week, WeekDay } from '../../lib/types';
import { whenShown } from '../../lib/panes';
import { SelectScope } from '../../lib/selection';
import { DayMarkButton, EventRow, PrayerLine } from './parts';
import { TimeGrid } from './TimeGrid';

function DayAgenda({ d, today, prayers, onOpen }: { d: WeekDay; today: string; prayers: boolean; onOpen: (date: string) => void }) {
  const isToday = d.date === today;
  return (
    <section className={`card wk-day${isToday ? ' is-today' : ''}${d.date < today ? ' is-past' : ''}`} aria-label={longDate(d.date)} data-testid="week-day">
      <header className="wk-head">
        <h2>
          <button type="button" className="wk-open" onClick={() => onOpen(d.date)}>
            {isToday ? 'Today' : longDate(d.date)}
          </button>
        </h2>
        <DayMarkButton date={d.date} habits={d.habits} />
        <span className="wk-hijri">{d.hijri}</span>
      </header>
      {prayers && <PrayerLine prayers={d.prayers} />}
      {d.events.length === 0 && d.tasks.length === 0 && <p className="empty">Nothing planned.</p>}
      {d.events.length > 0 && (
        <ul className="wk-events">
          {d.events.map((e) => (
            <EventRow key={e.id} e={e} testId="week-event" selectable>
              <span className="wk-time num">{e.time ? hm12(e.time) : 'All day'}</span>
              <span className="wk-text">{e.text}</span>
            </EventRow>
          ))}
        </ul>
      )}
      {d.tasks.length > 0 && (
        <div className="rows">
          {d.tasks.map((t) => (
            <TaskRow key={t.id} task={t} today={today} />
          ))}
        </div>
      )}
    </section>
  );
}

function DayColumn({ d, today, prayers, onOpen }: { d: WeekDay; today: string; prayers: boolean; onOpen: (date: string) => void }) {
  const isToday = d.date === today;
  return (
    <section className={`wk-col${isToday ? ' is-today' : ''}${d.date < today ? ' is-past' : ''}`} aria-label={longDate(d.date)} data-testid="week-day">
      <header className="wk-col-head">
        <button type="button" className="wk-col-open" onClick={() => onOpen(d.date)} aria-label={`${longDate(d.date)}: open the day`}>
          <span className="wk-dow">{WEEKDAYS_SHORT[weekday(d.date)]}</span>
          <span className="wk-dom num">{Number(d.date.slice(8))}</span>
          <span className="wk-hday">{d.hijri.split(' ').slice(0, 2).join(' ')}</span>
        </button>
        <DayMarkButton date={d.date} habits={d.habits} compact />
      </header>
      <div className="wk-col-body">
        {d.events.map((e) => (
          <EventRow key={e.id} e={e} as="div" className="wk-chip" testId="week-event" swipe={false} selectable>
            {e.time && <span className="wk-time num">{hm12(e.time)}</span>}
            <span>{e.text}</span>
          </EventRow>
        ))}
        {d.tasks.map((t) => (
          <div key={t.id} className={`wk-task${t.status === 'done' ? ' done' : ''}`}>
            {t.title}
          </div>
        ))}
      </div>
      {prayers && (
        <ol className="wk-col-prayers" aria-label="Prayer times">
          {FIVE.map((p) => (
            <li key={p}>
              <span>{PRAYER_LABELS[p]}</span>
              <span className="num">{hm12(d.prayers[p]).replace(/ [AP]M$/, '')}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function WeekView({ data, today, start, prayers, thisWeek, onOpen, daysRef, active, desk = false, nowHm = '00:00', selected = null, onSelect }: { data: Week | null; today: string; start: string; prayers: boolean; thisWeek: boolean; onOpen: (date: string) => void; daysRef: React.RefObject<HTMLDivElement | null>; active: boolean; desk?: boolean; nowHm?: string; selected?: string | null; onSelect?: (date: string) => void }) {
  const wide = useMedia('(min-width: 700px)');
  const scrolled = useRef<string | null>(null);
  useEffect(() => {
    // the phone agenda opens on today (on Mondays the top already shows it), once the view is the
    // one on screen and its pane is shown (a pane warming in the background would lose the scroll)
    if (!active || wide || !data || !thisWeek || today === start || scrolled.current === start) return;
    const day = daysRef.current?.querySelector('.wk-day.is-today') ?? null;
    if (!day) return;
    scrolled.current = start;
    whenShown(day, () => day.scrollIntoView({ block: 'start' }));
  }, [active, data, wide, thisWeek, today, start, daysRef]);
  return (
    <div className="wk-days" ref={daysRef} data-start={data?.days[0]?.date ?? ''} data-testid="week">
      {!data ? (
        <div className="skeleton" aria-busy="true" />
      ) : (
        // one selection scope for the week (round-3 brief §4): Select in a row's hold menu, then any
        // task or event of the seven days
        <SelectScope.Provider value={`week:${data.days[0]?.date ?? start}`}>
          {desk ? (
            <TimeGrid days={data.days} today={today} nowHm={nowHm} prayers={prayers} tasks selected={selected} onSelect={(d) => onSelect?.(d)} onOpen={onOpen} active={active} testId="week-grid" />
          ) : wide ? (
            <div className="wk-grid">
              {data.days.map((d) => (
                <DayColumn key={d.date} d={d} today={today} prayers={prayers} onOpen={onOpen} />
              ))}
            </div>
          ) : (
            <div className="stack">
              {data.days.map((d) => (
                <DayAgenda key={d.date} d={d} today={today} prayers={prayers} onOpen={onOpen} />
              ))}
            </div>
          )}
        </SelectScope.Provider>
      )}
    </div>
  );
}
