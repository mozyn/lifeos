/**
 * The time grid of the big screen (round 8f, docs/desktop-layout-brief.md §1, ADR-107): Week's
 * seven days side by side, or Day's one, in hour rows. A day's timed events sit at their hour (an
 * event in a weekly note has a start only, so it is drawn an hour long; events that overlap share
 * the column), the five prayers are marks across the day at their times, and today has a "now"
 * line. Above the hours, each day's all-day events and (in Week) its tasks due. The hours scroll
 * inside the grid while the days' heads stay; it opens a little before the day's first prayer or
 * event. Clicking a day's head or an item opens it in the Calendar's side panel.
 */
import { type CSSProperties, useLayoutEffect, useRef } from 'react';
import { FIVE, hm12, longDate, PRAYER_LABELS, WEEKDAYS_SHORT, weekday } from '@lifeos/shared';
import type { EventItem, Task, WeekDay } from '../../lib/types';
import { whenShown } from '../../lib/panes';
import { openTaskSheet } from '../../components/TaskSheet';
import { openGroupSheet } from '../../components/GroupRow';
import { useGone } from '../../lib/edits';
import { DayMarkButton, EventRow } from './parts';
import { lanes } from './lanes';

const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
const HOURS = Array.from({ length: 24 }, (_, h) => h);

/** Where the grid opens: half an hour before the first prayer or event of the days shown. */
function firstHour(days: WeekDay[]): number {
  let m = 24 * 60;
  for (const d of days) {
    if (d.prayers.fajr) m = Math.min(m, toMin(d.prayers.fajr));
    for (const e of d.events) if (e.time) m = Math.min(m, toMin(e.time));
  }
  return Math.max(0, Math.floor((m - 30) / 60));
}

function TaskChip({ t }: { t: Task }) {
  return (
    <button type="button" className={`tg-task${t.status === 'done' ? ' done' : ''}`} onClick={() => (t.group ? openGroupSheet(t) : openTaskSheet(t))} data-testid="tg-task">
      <span className="tg-tick" aria-hidden />
      <span className="tg-task-text">{t.title}</span>
      {t.status === 'done' && <span className="sr-only"> (done)</span>}
    </button>
  );
}

/** A day's all-day events and tasks due, up to `max` of them; the rest open with the day. */
function AllDay({ d, tasks, max, onSelect }: { d: WeekDay; tasks: boolean; max: number; onSelect: (date: string) => void }) {
  const gone = useGone();
  const allDay = d.events.filter((e) => !e.time && !gone.has(e.id));
  const due = tasks ? d.tasks.filter((t) => !gone.has(t.id)) : [];
  const n = allDay.length + due.length;
  const fit = n > max ? max - 1 : n;
  const evs = allDay.slice(0, fit);
  const ts = due.slice(0, Math.max(0, fit - evs.length));
  return (
    <div className="tg-allday-cell">
      {evs.map((e) => (
        <EventRow key={e.id} e={e} as="div" className="tg-allday-ev" testId="week-event" swipe={false} selectable>
          <span className="tg-ev-text">{e.text}</span>
        </EventRow>
      ))}
      {ts.map((t) => (
        <TaskChip key={t.id} t={t} />
      ))}
      {n > fit && (
        <button type="button" className="tg-more" onClick={() => onSelect(d.date)} data-testid="tg-more">
          +{n - fit} more
        </button>
      )}
    </div>
  );
}

function Event({ e, lane }: { e: EventItem; lane: { lane: number; of: number } }) {
  const style = { '--at': toMin(e.time!) / 60, '--lane': lane.lane, '--lanes': lane.of } as CSSProperties;
  return (
    <div className="tg-ev" style={style}>
      <EventRow e={e} as="div" className="tg-ev-row" testId="week-event" swipe={false} selectable>
        <span className="tg-ev-time num">{hm12(e.time!)}</span>
        <span className="tg-ev-text">{e.text}</span>
      </EventRow>
    </div>
  );
}

function DayColumn({ d, today, nowHm, prayers }: { d: WeekDay; today: string; nowHm: string; prayers: boolean }) {
  const gone = useGone();
  const timed = d.events.filter((e) => e.time && !gone.has(e.id));
  const placed = lanes(timed.map((e) => ({ id: e.id, time: e.time! })));
  const isToday = d.date === today;
  return (
    <div className={`tg-col${isToday ? ' is-today' : ''}${d.date < today ? ' is-past' : ''}`} data-date={d.date} data-testid="tg-col">
      {prayers && (
        <ol className="tg-prayers" aria-label={`Prayer times, ${longDate(d.date)}`}>
          {FIVE.map((p) => (
            <li key={p} className="tg-prayer" style={{ '--at': toMin(d.prayers[p]) / 60 } as CSSProperties} data-testid="tg-prayer">
              <span className="tg-prayer-name">{PRAYER_LABELS[p]}</span> <span className="num">{hm12(d.prayers[p])}</span>
            </li>
          ))}
        </ol>
      )}
      {timed.map((e) => (
        <Event key={e.id} e={e} lane={placed.get(e.id)!} />
      ))}
      {isToday && (
        <span className="tg-now" style={{ '--at': toMin(nowHm) / 60 } as CSSProperties} aria-label={`Now, ${hm12(nowHm)}`} role="img" data-testid="tg-now" />
      )}
    </div>
  );
}

export function TimeGrid({ days, today, nowHm, prayers, tasks, selected, onSelect, onOpen, active, testId }: { days: WeekDay[]; today: string; nowHm: string; prayers: boolean; tasks: boolean; selected: string | null; onSelect: (date: string) => void; onOpen: (date: string) => void; active: boolean; testId: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const opened = useRef<string | null>(null);
  const key = days.map((d) => d.date).join();
  // open on the morning (once per set of days, when the grid is the one on screen)
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !active || opened.current === key) return;
    opened.current = key;
    const h = firstHour(days);
    whenShown(el, () => {
      const hour = parseFloat(getComputedStyle(el).getPropertyValue('--hour')) || 52;
      // the hour's label shows under the days' heads
      el.scrollTop = Math.max(0, h * hour - 12);
    });
  }, [key, active, days]);
  const single = days.length === 1;
  return (
    <div className={`tg${single ? ' tg-single' : ''}`} style={{ '--days': days.length } as CSSProperties} data-testid={testId}>
      <div className="tg-scroll" ref={scrollRef}>
        <div className="tg-top">
          {!single && (
            <div className="tg-row tg-head">
              <span className="tg-corner" />
              {days.map((d) => {
                const isToday = d.date === today;
                return (
                  <section key={d.date} className={`tg-day${isToday ? ' is-today' : ''}${d.date < today ? ' is-past' : ''}${selected === d.date ? ' is-selected' : ''}`} aria-label={longDate(d.date)} data-testid="week-day" data-date={d.date}>
                    <button type="button" className="tg-day-open" onClick={() => onSelect(d.date)} onDoubleClick={() => onOpen(d.date)} aria-label={`${longDate(d.date)}: show the day`} aria-pressed={selected === d.date} data-testid="tg-day-open">
                      <span className="tg-dow">{WEEKDAYS_SHORT[weekday(d.date)]}</span>
                      <span className="tg-dom num">{Number(d.date.slice(8))}</span>
                      <span className="tg-hday">{d.hijri.split(' ').slice(0, 2).join(' ')}</span>
                    </button>
                    <DayMarkButton date={d.date} habits={d.habits} compact />
                  </section>
                );
              })}
            </div>
          )}
          <div className="tg-row tg-allday">
            <span className="tg-corner tg-allday-label">All day</span>
            {days.map((d) => (
              <AllDay key={d.date} d={d} tasks={tasks} max={single ? 6 : 3} onSelect={onSelect} />
            ))}
          </div>
        </div>
        <div className="tg-row tg-body">
          <div className="tg-labels" aria-hidden>
            {HOURS.map((h) => (
              <span key={h} className="tg-hour" style={{ '--at': h } as CSSProperties}>
                {h === 0 ? '' : hm12(`${String(h).padStart(2, '0')}:00`).replace(':00', '')}
              </span>
            ))}
          </div>
          {days.map((d) => (
            <DayColumn key={d.date} d={d} today={today} nowHm={nowHm} prayers={prayers} />
          ))}
          {/* the hour lines across the days: plain lines, cheap to paint as the grid comes on screen */}
          {HOURS.slice(1).map((h) => (
            <span key={h} className="tg-line" style={{ '--at': h } as CSSProperties} aria-hidden />
          ))}
        </div>
      </div>
    </div>
  );
}
