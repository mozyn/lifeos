/**
 * Calendar → Month (round-2 brief §3, §4): a grid, Monday first. Each day shows its number, the
 * Hijri day small beneath it, up to three dots (an event, a task due, a habit kept) and its streak
 * mark (a flame when every habit due was kept, a muted mark for a slip); today has a ring.
 * Tapping a day opens a small glass popover anchored to it (round-3 brief §2, ADR-64): that day's
 * events, tasks due and habit results; a second tap on the day, or "Open day", opens it in Day.
 * On the big screen (round 8f, ADR-107) the grid fills the screen and each day is a tall cell that
 * lists its events and tasks (as many as fit, then "+3") with its prayer marks (Fajr and Maghrib,
 * computed on the device as the API does, spec §10); a click opens the day, or the event clicked,
 * in the Calendar's side panel, and a second click on the day opens it in Day.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Flame, Sunrise, Sunset } from 'lucide-react';
import { habitKept, hm12, longDate, monthCells, type PrayerMethod, prayerTimes } from '@lifeos/shared';
import { useResource } from '../../lib/store';
import { Glass } from '../../glass/Glass';
import type { CalendarMonth } from '../../lib/types';
import { habitValueLabel, useVisibleHabits } from './parts';
import type { MonthDay } from '../../lib/types';
import { PRIVATE_LABEL, usePrivacy } from '../../lib/privacy';

const DOW = [
  ['M', 'Monday'],
  ['T', 'Tuesday'],
  ['W', 'Wednesday'],
  ['T', 'Thursday'],
  ['F', 'Friday'],
  ['S', 'Saturday'],
  ['S', 'Sunday'],
];

/** Lines a popover section shows before it says how many more there are. */
const SHOW = 4;

function Cell({ d, today, open, onTap }: { d: MonthDay; today: string; open: boolean; onTap: (date: string, el: HTMLElement) => void }) {
  const { mark, hidePrivate } = useVisibleHabits(d.habits);
  const kept = habitKept(d.habits, { hidePrivate });
  const isToday = d.date === today;
  const parts = [longDate(d.date), `${d.hijriDay} ${d.hijriMonth}`];
  if (d.events) parts.push(`${d.events} ${d.events === 1 ? 'event' : 'events'}`);
  if (d.tasks) parts.push(`${d.tasks} ${d.tasks === 1 ? 'task' : 'tasks'} due`);
  if (kept) parts.push('a habit kept');
  if (mark === 'streak') parts.push('every habit kept');
  if (mark === 'slip') parts.push('a slip');
  return (
    <button
      type="button"
      className={`mc${isToday ? ' is-today' : ''}${d.date < today ? ' is-past' : ''}${open ? ' is-open' : ''}`}
      onClick={(e) => onTap(d.date, e.currentTarget)}
      aria-label={parts.join(', ')}
      aria-current={isToday ? 'date' : undefined}
      aria-expanded={open}
      aria-haspopup="dialog"
      data-testid="month-day"
      data-date={d.date}
    >
      <span className="mc-n num">{Number(d.date.slice(8))}</span>
      <span className="mc-h num">{d.hijriDay}</span>
      <span className="mc-dots" aria-hidden>
        {d.events > 0 && <span className="dot dot-event" />}
        {d.tasks > 0 && <span className="dot dot-task" />}
        {kept && <span className="dot dot-habit" />}
      </span>
      {mark && (
        <span className="mc-mark" data-mark={mark} aria-hidden data-testid="month-mark">
          <Flame />
        </span>
      )}
    </button>
  );
}

const hmShort = (hm: string) => hm12(hm).replace(/ [AP]M$/, '');

/** A day on the big screen: its number and Hijri day, its events and tasks as they fit, its prayer marks. */
function TallCell({ d, today, selected, lines, prayer, onTap, onItem }: { d: MonthDay; today: string; selected: boolean; lines: number; prayer: { fajr: string; maghrib: string } | null; onTap: (date: string) => void; onItem: (date: string, id: string) => void }) {
  const { mark } = useVisibleHabits(d.habits);
  const isToday = d.date === today;
  const events = [...(d.list?.events ?? [])].sort((a, b) => (a.time ?? '').localeCompare(b.time ?? ''));
  const tasks = d.list?.tasks ?? [];
  const n = events.length + tasks.length;
  const fit = n > lines ? Math.max(0, lines - 1) : n;
  const evs = events.slice(0, fit);
  const ts = tasks.slice(0, Math.max(0, fit - evs.length));
  const parts = [longDate(d.date), `${d.hijriDay} ${d.hijriMonth}`];
  if (d.events) parts.push(`${d.events} ${d.events === 1 ? 'event' : 'events'}`);
  if (d.tasks) parts.push(`${d.tasks} ${d.tasks === 1 ? 'task' : 'tasks'} due`);
  if (mark === 'streak') parts.push('every habit kept');
  if (mark === 'slip') parts.push('a slip');
  return (
    <div role="gridcell" className={`mc mc-tall${isToday ? ' is-today' : ''}${d.date < today ? ' is-past' : ''}${selected ? ' is-selected' : ''}`} data-testid="month-day" data-date={d.date} aria-current={isToday ? 'date' : undefined}>
      <button type="button" className="mc-hit" onClick={() => onTap(d.date)} aria-label={parts.join(', ')} aria-pressed={selected} data-testid="month-day-open" />
      <span className="mc-top" aria-hidden>
        <span className="mc-n num">{Number(d.date.slice(8))}</span>
        <span className="mc-h num">{d.hijriDay === 1 ? `1 ${d.hijriMonth}` : d.hijriDay}</span>
        {mark && (
          <span className="mc-mark" data-mark={mark} data-testid="month-mark">
            <Flame />
          </span>
        )}
      </span>
      <span className="mc-items">
        {evs.map((e) => (
          <button key={e.id} type="button" className="mc-ev" onClick={() => onItem(d.date, e.id)} data-testid="mc-event">
            {e.time && <span className="mc-time num">{hmShort(e.time)}</span>}
            <span className="mc-text">{e.text}</span>
          </button>
        ))}
        {ts.map((t) => (
          <button key={t.id} type="button" className={`mc-task${t.done ? ' done' : ''}`} onClick={() => onItem(d.date, t.id)} data-testid="mc-task">
            <span className="mc-tick" aria-hidden />
            <span className="mc-text">{t.title}</span>
          </button>
        ))}
        {n > fit && (
          <span className="mc-more" data-testid="mc-more">
            +{n - fit}
          </span>
        )}
      </span>
      {prayer && (
        <span className="mc-prayers" aria-label={`Fajr ${hm12(prayer.fajr)}, Maghrib ${hm12(prayer.maghrib)}`} data-testid="mc-prayers">
          <Sunrise aria-hidden />
          <span className="num">{hmShort(prayer.fajr)}</span>
          <Sunset aria-hidden />
          <span className="num">{hmShort(prayer.maghrib)}</span>
        </span>
      )}
    </div>
  );
}

function More({ n }: { n: number }) {
  return n > 0 ? <li className="dp-more caption">and {n} more</li> : null;
}

/**
 * The day's popover: placed under its day when there is room below (above it otherwise), inside the
 * month's width, growing from the day it belongs to (a fade only, with reduced motion).
 */
function DayPopover({ d, anchor, host, onOpenDay, onClose }: { d: MonthDay; anchor: HTMLElement; host: HTMLElement; onOpenDay: () => void; onClose: (refocus: boolean) => void }) {
  const ref = useRef<HTMLElement | null>(null);
  const [place, setPlace] = useState<{ left: number; top: number; origin: string } | null>(null);
  const { hidePrivate } = useVisibleHabits(d.habits);
  const habits = hidePrivate ? d.habits.filter((h) => !h.private) : d.habits;
  const hidden = d.habits.length - habits.length;
  const events = d.list?.events ?? [];
  const tasks = d.list?.tasks ?? [];

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const hr = host.getBoundingClientRect();
    const ar = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    // what the bars leave of the screen: under the top bar, above the dock (the phone's tab bar)
    const top = document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0;
    const dock = document.querySelector<HTMLElement>('.dock');
    const bottom = dock && dock.offsetParent !== null ? dock.getBoundingClientRect().top : window.innerHeight;
    const below = bottom - ar.bottom >= h + 8 || bottom - ar.bottom >= ar.top - top;
    const left = Math.min(Math.max(8, ar.left + ar.width / 2 - hr.left - w / 2), hr.width - w - 8);
    const y = below ? ar.bottom - hr.top + 6 : ar.top - hr.top - h - 6;
    const next = { left, top: y, origin: `${ar.left + ar.width / 2 - hr.left - left}px ${below ? '0' : '100%'}` };
    setPlace((p) => (p && p.left === next.left && p.top === next.top && p.origin === next.origin ? p : next));
  }, [anchor, host, events.length, tasks.length, habits.length, hidden]);

  // once placed: the popover in view, focus on its action (Escape and the day itself bring it back)
  const placed = !!place;
  useEffect(() => {
    if (!placed) return;
    ref.current?.scrollIntoView({ block: 'nearest' });
    ref.current?.querySelector<HTMLElement>('.dp-open')?.focus({ preventScroll: true });
  }, [placed]);

  // a touch anywhere else closes it (a touch on another day moves it there)
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t || ref.current?.contains(t) || t.closest('.mc')) return;
      onClose(false);
    };
    document.addEventListener('pointerdown', down, true);
    return () => document.removeEventListener('pointerdown', down, true);
  }, [onClose]);

  const empty = !events.length && !tasks.length && !habits.length;
  return (
    <Glass
      ref={ref}
      variant="thick"
      kind="panel"
      className="day-pop"
      role="dialog"
      aria-label={longDate(d.date)}
      data-testid="day-popover"
      data-date={d.date}
      style={place ? { left: place.left, top: place.top, transformOrigin: place.origin } : { visibility: 'hidden' }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose(true);
        }
      }}
    >
      <div className="dp-head">
        <span className="dp-title">{longDate(d.date)}</span>
        <span className="caption">
          {d.hijriDay} {d.hijriMonth}
        </span>
      </div>
      {empty && hidden === 0 && <p className="dp-empty secondary">Nothing on this day.</p>}
      {events.length > 0 && (
        <ul className="dp-list" aria-label="Events" data-testid="dp-events">
          {events.slice(0, SHOW).map((e) => (
            <li key={e.id}>
              <span className="dp-when num">{e.time ? hm12(e.time) : 'All day'}</span>
              <span className="dp-text">{e.text}</span>
            </li>
          ))}
          <More n={events.length - SHOW} />
        </ul>
      )}
      {tasks.length > 0 && (
        <ul className="dp-list" aria-label="Tasks due" data-testid="dp-tasks">
          {tasks.slice(0, SHOW).map((t) => (
            <li key={t.id} data-done={t.done || undefined}>
              <span className="dp-tick" aria-hidden />
              <span className="dp-text">
                {t.title}
                {t.done && <span className="sr-only"> (done)</span>}
              </span>
            </li>
          ))}
          <More n={tasks.length - SHOW} />
        </ul>
      )}
      {habits.length > 0 && (
        <ul className="dp-list" aria-label="Habits" data-testid="dp-habits">
          {habits.map((h) => (
            <li key={h.path} data-value={h.value ?? 'none'}>
              <span className="dp-text">{h.title}</span>
              <span className={`tag${h.value === 'clean' ? ' goal' : h.value === 'slip' ? ' due-over' : ''}`}>{habitValueLabel(h)}</span>
            </li>
          ))}
        </ul>
      )}
      {hidden > 0 && <p className="caption dp-hidden">{hidden === 1 ? `One ${PRIVATE_LABEL.toLowerCase()} is` : `${hidden} private habits are`} not shown while Privacy mode is on.</p>}
      <button type="button" className="btn btn-primary btn-block dp-open" onClick={onOpenDay} data-testid="dp-open-day">
        Open day
      </button>
    </Glass>
  );
}

/** Lines a tall cell's events and tasks take, from the cell's height (the big screen). */
const CELL_TOP = 30;
const CELL_FOOT = 22;
const CELL_LINE = 22;

export function MonthView({ data, ym, today, onOpen, gridRef, active = true, desk = false, selected = null, onSelect, onItem, prayers = true }: { data: CalendarMonth | null; ym: string; today: string; onOpen: (date: string) => void; gridRef: React.RefObject<HTMLDivElement | null>; active?: boolean; desk?: boolean; selected?: string | null; onSelect?: (date: string) => void; onItem?: (date: string, id: string) => void; prayers?: boolean }) {
  usePrivacy();
  const byDate = new Map((data?.days ?? []).map((d) => [d.date, d]));
  const [pop, setPop] = useState<{ date: string; anchor: HTMLElement } | null>(null);
  // the big screen: as many lines as the cells have room for, and the prayer marks (spec §10: the
  // browser computes prayer times as the API does, from the same settings)
  const mgRef = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState(3);
  useLayoutEffect(() => {
    const g = mgRef.current;
    if (!desk || !g) return;
    const fit = () => {
      const cell = g.querySelector<HTMLElement>('.mc-tall');
      if (!cell || !cell.clientHeight) return;
      const n = Math.max(1, Math.floor((cell.clientHeight - CELL_TOP - (prayers ? CELL_FOOT : 4)) / CELL_LINE));
      setLines((x) => (x === n ? x : n));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(g);
    return () => ro.disconnect();
  }, [desk, prayers, data]);
  const { data: settings } = useResource<{ settings: { prayer: { lat: number; lon: number; tz: string; method: PrayerMethod } } }>(desk && prayers ? 'api/settings' : null);
  const place = settings?.settings.prayer;
  // once per month and place, not on every render (42 days of adhan)
  const marks = useMemo(() => {
    const m = new Map<string, { fajr: string; maghrib: string }>();
    if (!desk || !place) return m;
    for (const date of monthCells(ym)) {
      if (!date) continue;
      const t = prayerTimes(date, place);
      m.set(date, { fajr: t.fajr, maghrib: t.maghrib });
    }
    return m;
  }, [desk, ym, place?.lat, place?.lon, place?.tz, place?.method]); // eslint-disable-line react-hooks/exhaustive-deps
  const prayerOf = (date: string) => marks.get(date) ?? null;
  // another month, or another view: the popover goes
  useEffect(() => setPop(null), [ym, active]);
  const tap = (date: string, el: HTMLElement) => {
    if (pop?.date === date) {
      setPop(null);
      onOpen(date);
    } else setPop({ date, anchor: el });
  };
  const close = (refocus: boolean) => {
    if (refocus) pop?.anchor.focus({ preventScroll: true });
    setPop(null);
  };
  const popDay = pop ? byDate.get(pop.date) : undefined;
  if (desk) {
    const cells = monthCells(ym);
    // a click on the chosen day again opens it in Day (a phone's second tap)
    const tapDesk = (date: string) => (selected === date ? onOpen(date) : onSelect?.(date));
    return (
      <div className="cal-month cal-month-desk" ref={gridRef} data-month={data?.month ?? ''} data-testid="cal-month">
        <div className="card month-card">
          <div className="mg mg-tall" ref={mgRef} role="grid" aria-label={`Days of ${ym}`} style={{ '--weeks': cells.length / 7 } as React.CSSProperties}>
            {DOW.map(([, l], i) => (
              <span key={i} className="mg-dow" role="columnheader" aria-label={l}>
                {l.slice(0, 3)}
              </span>
            ))}
            {cells.map((date, i) => {
              const d = date ? byDate.get(date) : undefined;
              if (!date || !d) return <span key={`b${i}`} className="mc-blank" aria-hidden />;
              return <TallCell key={date} d={d} today={today} selected={selected === date} lines={lines} prayer={prayers ? prayerOf(date) : null} onTap={tapDesk} onItem={(x, id) => onItem?.(x, id)} />;
            })}
          </div>
        </div>
        <p className="caption month-legend" aria-hidden>
          {prayers && (
            <>
              <Sunrise className="legend-icon" /> Fajr <Sunset className="legend-icon" /> Maghrib{' '}
            </>
          )}
          <span className="mc-mark" data-mark="streak">
            <Flame />
          </span>{' '}
          every habit kept{' '}
          <span className="mc-mark" data-mark="slip">
            <Flame />
          </span>{' '}
          a slip. Click a day for all of it; click it again to open it.
        </p>
      </div>
    );
  }
  return (
    <div className="cal-month" ref={gridRef} data-month={data?.month ?? ''} data-testid="cal-month">
      <div className="card month-card">
        <div className="mg" role="grid" aria-label={`Days of ${ym}`}>
          {DOW.map(([s, l], i) => (
            <span key={i} className="mg-dow" role="columnheader" aria-label={l}>
              {s}
            </span>
          ))}
          {monthCells(ym).map((date, i) => {
            const d = date ? byDate.get(date) : undefined;
            if (!date || !d) return <span key={`b${i}`} className="mc-blank" aria-hidden />;
            return <Cell key={date} d={d} today={today} open={pop?.date === date} onTap={tap} />;
          })}
        </div>
      </div>
      <p className="caption month-legend" aria-hidden>
        <span className="dot dot-event" /> event <span className="dot dot-task" /> task due <span className="dot dot-habit" /> habit kept{' '}
        <span className="mc-mark" data-mark="streak">
          <Flame />
        </span>{' '}
        every habit kept{' '}
        <span className="mc-mark" data-mark="slip">
          <Flame />
        </span>{' '}
        a slip
      </p>
      {pop && popDay && gridRef.current && (
        <DayPopover
          key={pop.date}
          d={popDay}
          anchor={pop.anchor}
          host={gridRef.current}
          onClose={close}
          onOpenDay={() => {
            const date = pop.date;
            setPop(null);
            onOpen(date);
          }}
        />
      )}
    </div>
  );
}
