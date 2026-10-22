/**
 * A day in the Calendar's side panel on the big screen (round 8f, ADR-107): what Month's popover
 * and Week's day cards show on a phone, beside the grid. A click on a day in Month or on a day's
 * head in Week opens it here: the Hijri and Gregorian date, the five prayer times, the events
 * (each opens its own sheet in the panel), the tasks due, the habits and how each went, and Open
 * day. A click on an event in a month's cell opens that event straight away.
 */
import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { FIVE, hm12, longDate, PRAYER_LABELS } from '@lifeos/shared';
import { TaskRow } from '../../components/TaskRow';
import { openTaskSheet } from '../../components/TaskSheet';
import { openGroupSheet } from '../../components/GroupRow';
import { Curtained } from '../../components/Private';
import { PRIVATE_LABEL } from '../../lib/privacy';
import { useGone } from '../../lib/edits';
import { SelectScope } from '../../lib/selection';
import { useResource } from '../../lib/store';
import type { CalendarDay } from '../../lib/types';
import { DayMarkButton, EventRow, EventSheet, habitValueLabel, useVisibleHabits } from './parts';

const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

export function DayDetail({ date, item, onItemDone, onOpenDay, onClose, nowHm }: { date: string; item: string | null; onItemDone: () => void; onOpenDay: () => void; onClose: () => void; nowHm: string }) {
  const { data } = useResource<CalendarDay>(`api/calendar/day?d=${date}`);
  const day = data?.date === date ? data : null;
  const { hidePrivate } = useVisibleHabits(day?.habits ?? []);
  const gone = useGone();
  const ref = useRef<HTMLElement>(null);
  // a newly chosen day: the panel is read from its top
  useEffect(() => {
    ref.current?.closest('.side-default')?.scrollTo?.({ top: 0 });
  }, [date]);
  const events = (day?.events ?? []).filter((e) => !gone.has(e.id)).sort((a, b) => (a.time ? toMin(a.time) : -1) - (b.time ? toMin(b.time) : -1));
  const open = day?.tasks.filter((t) => t.status === 'open') ?? [];
  const done = day?.tasks.filter((t) => t.status === 'done') ?? [];
  const isToday = day ? day.date === day.today : false;
  const habits = hidePrivate ? (day?.habits.filter((h) => !h.private) ?? []) : (day?.habits ?? []);
  const hidden = (day?.habits.length ?? 0) - habits.length;
  // an event clicked in a month's cell: its sheet, in the panel, once the day is here (a task: the
  // task's own sheet, which the shell keeps)
  const target = item && day ? day.events.find((e) => e.id === item) : undefined;
  const task = item && day && !target ? day.tasks.find((t) => t.id === item) : undefined;
  useEffect(() => {
    if (!task) return;
    onItemDone();
    if (task.group) openGroupSheet(task);
    else openTaskSheet(task);
  }, [task, onItemDone]);
  return (
    <section ref={ref} className="card day-detail" aria-labelledby="dd-title" data-testid="day-detail" data-date={date}>
      <header className="dd-head">
        <div className="dd-title">
          {day && <p className="hijri">{day.hijri}</p>}
          <h2 id="dd-title">{isToday ? `Today, ${longDate(date).replace(/^\w+, /, '')}` : longDate(date)}</h2>
        </div>
        {day && <DayMarkButton date={date} habits={day.habits} />}
        <button type="button" className="icon-btn" aria-label="Close the day" onClick={onClose} data-testid="day-detail-close">
          <X />
        </button>
      </header>
      {!day ? (
        <div className="skeleton side-skeleton" aria-busy="true" />
      ) : (
        <>
          <ol className="dd-prayers" aria-label="Prayer times" data-testid="dd-prayers">
            {FIVE.map((p) => (
              <li key={p} className={isToday && toMin(day.prayers[p]) <= toMin(nowHm) ? 'passed' : undefined}>
                <span>{PRAYER_LABELS[p]}</span>
                <span className="num">{hm12(day.prayers[p])}</span>
              </li>
            ))}
          </ol>
          <div className="dd-section">
            <h3>Events</h3>
            {events.length === 0 ? (
              <p className="empty">No events.</p>
            ) : (
              <ul className="dd-events" data-testid="dd-events">
                {events.map((e) => (
                  <EventRow key={e.id} e={e} className="dd-event" testId="dd-event" selectable>
                    <span className="dd-when num">{e.time ? hm12(e.time) : 'All day'}</span>
                    <span className="dd-text">{e.text}</span>
                  </EventRow>
                ))}
              </ul>
            )}
          </div>
          <div className="dd-section">
            <h3>Due</h3>
            {day.tasks.length === 0 ? (
              <p className="empty">No tasks due.</p>
            ) : (
              <SelectScope.Provider value={`panel:${date}`}>
                <div className="rows" data-testid="dd-tasks">
                  {[...open, ...done].map((t) => (
                    <TaskRow key={t.id} task={t} today={day.today} />
                  ))}
                </div>
              </SelectScope.Provider>
            )}
          </div>
          {(habits.length > 0 || hidden > 0) && (
            <div className="dd-section">
              <h3>Habits</h3>
              <ul className="habit-day-list" data-testid="dd-habits">
                {habits.map((h) => (
                  <Curtained as="li" key={h.path} isPrivate={h.private} data-value={h.value ?? 'none'} aria-label={h.private && hidePrivate ? PRIVATE_LABEL : h.title}>
                    <span>{h.title}</span>
                    <span className={`tag${h.value === 'clean' ? ' goal' : h.value === 'slip' ? ' due-over' : ''}`}>{day.date > day.today ? 'Due' : habitValueLabel(h)}</span>
                  </Curtained>
                ))}
              </ul>
              {hidden > 0 && <p className="caption">{hidden === 1 ? `One ${PRIVATE_LABEL.toLowerCase()} is` : `${hidden} private habits are`} not shown while Privacy mode is on.</p>}
            </div>
          )}
          <div className="dd-foot">
            <button type="button" className="btn btn-primary btn-block" onClick={onOpenDay} data-testid="dd-open-day">
              Open day
            </button>
          </div>
        </>
      )}
      {target && <EventSheet key={target.id} e={target} focus="edit" onClose={onItemDone} />}
    </section>
  );
}
