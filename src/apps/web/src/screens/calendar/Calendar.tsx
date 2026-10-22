/**
 * Calendar (round-2 brief §3; was Week, spec §4.2): Day, Week and Month on one glass segmented
 * control in the top bar. Events live in the weekly notes only (§5.9); tasks show on their due
 * dates, prayers and Hijri dates are computed, and the habit streak marks are derived from the logs
 * (§4). One primary action on all three: Add event. The views stay mounted and cross-fade like the
 * Lists segments (lib/segments.ts); prev/next slide the view's days.
 * The big screen (round 8f, ADR-107): Month's grid fills the screen with tall cells, Week and Day
 * are time grids, and a side panel beside the grid shows what is clicked (a day, an event, a task)
 * instead of a sheet; Day's panel holds the day's tasks and habits. Keys: D, W, M, ← →, T.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { addDays, addMonths, dateRange, hijriSpan, isIsoDate, isoWeek, longDate, mondayOf, monthYear, todayIn } from '@lifeos/shared';
import { Segmented, useMedia } from '../../components/ui';
import { SidePanel } from '../../components/SidePanel';
import { useResource } from '../../lib/store';
import { closeDocked, WIDE } from '../../lib/dock';
import { isShortcut } from '../../lib/keys';
import { activePane } from '../../lib/panes';
import { setSegState, switchSegment, warmSegments } from '../../lib/segments';
import { transition, until } from '../../lib/transitions';
import type { CalendarDay, CalendarMonth, Week } from '../../lib/types';
import { TopBarSlot } from '../../shell/context';
import { useNow } from '../today/Today';
import { AddEvent } from './parts';
import { DayAside, DayView } from './DayView';
import { DayDetail } from './DayPanel';
import { MonthView } from './MonthView';
import { WeekView } from './WeekView';

export type CalView = 'day' | 'week' | 'month';
const VIEWS: { value: CalView; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
];
const VIEW_KEY = 'lifeos.calendar.view';

const tzToday = () => todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone);

function storedView(): CalView {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === 'day' || v === 'month' ? v : 'week';
  } catch {
    return 'week';
  }
}

export function CalendarScreen() {
  const [params, setParams] = useSearchParams();
  const today = tzToday();
  const viewParam = params.get('view');
  const view: CalView = viewParam === 'day' || viewParam === 'week' || viewParam === 'month' ? viewParam : storedView();
  const dParam = params.get('d');
  const d = dParam && isIsoDate(dParam) ? dParam : today;
  const start = mondayOf(d);
  const ym = d.slice(0, 7);
  const now = useNow();
  const nowHm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const [mounted, setMounted] = useState<ReadonlySet<CalView>>(() => new Set([view]));
  const has = mounted.has(view) ? mounted : new Set([...mounted, view]);
  const day = useResource<CalendarDay>(has.has('day') ? `api/calendar/day?d=${d}` : null);
  const week = useResource<Week>(has.has('week') ? `api/week?start=${start}` : null);
  const month = useResource<CalendarMonth>(has.has('month') ? `api/calendar/month?m=${ym}` : null);

  const [prayers, setPrayers] = useState<'on' | 'off'>(() => (localStorage.getItem('lifeos.week.prayers') === 'off' ? 'off' : 'on'));
  useEffect(() => localStorage.setItem('lifeos.week.prayers', prayers), [prayers]);
  const [adding, setAdding] = useState(false);
  // the big screen: the day (and the item in it) the side panel shows in Week and Month
  const desk = useMedia(WIDE);
  const [sel, setSel] = useState<{ date: string; item: string | null } | null>(null);

  const bodyRef = useRef<HTMLDivElement>(null);
  const dayRef = useRef<HTMLDivElement>(null);
  const weekRef = useRef<HTMLDivElement>(null);
  const monthRef = useRef<HTMLDivElement>(null);
  const segs = useRef(new Map<CalView, HTMLElement>());
  const shown = useRef<CalView>(view);

  // the view on screen is the one the address names; the switch runs before the frame is drawn
  useLayoutEffect(() => {
    if (!mounted.has(view)) setMounted((m) => new Set([...m, view]));
    const body = bodyRef.current;
    const to = segs.current.get(view);
    if (!body || !to || shown.current === view) return;
    switchSegment(body, segs.current.get(shown.current) ?? null, to, { from: shown.current, to: view });
    shown.current = view;
  }, [view, mounted]);
  useEffect(() => warmSegments(bodyRef.current, VIEWS.map((v) => v.value), (k) => setMounted((m) => (m.has(k) ? m : new Set([...m, k])))), []);
  const segRef = useCallback(
    (k: CalView) => (el: HTMLElement | null) => {
      if (!el) {
        segs.current.delete(k);
        return;
      }
      segs.current.set(k, el);
      if (!el.dataset.state) setSegState(el, k === shown.current ? 'active' : 'hidden');
    },
    [],
  );
  const refs = useMemo(() => Object.fromEntries(VIEWS.map((v) => [v.value, segRef(v.value)])) as Record<CalView, (el: HTMLElement | null) => void>, [segRef]);

  /** The address for a view and a date (today's date is left out). */
  const address = (v: CalView, date: string): Record<string, string> => (date === today ? { view: v } : { view: v, d: date });

  const pickView = (v: CalView) => {
    if (v === view) return;
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* not kept */
    }
    setParams(address(v, d));
  };

  /** Prev/next/today: the view's days slide toward the new date; the header and buttons stay. */
  const move = (next: string) => {
    if (next === d) return;
    setSel(null);
    const scope = view === 'day' ? dayRef.current : view === 'week' ? weekRef.current : monthRef.current;
    const key = view === 'day' ? next : view === 'week' ? mondayOf(next) : next.slice(0, 7);
    const attr = view === 'day' ? 'date' : view === 'week' ? 'start' : 'month';
    void transition({
      kind: 'week',
      scope,
      dir: next > d ? 1 : -1,
      update: async () => {
        setParams(address(view, next), { replace: true });
        await until(() => scope?.dataset[attr] === key, 400);
      },
    });
  };
  const step = (dir: 1 | -1) => move(view === 'day' ? addDays(d, dir) : view === 'week' ? addDays(d, 7 * dir) : `${addMonths(`${ym}-01`, dir).slice(0, 7)}-01`);
  const isCurrent = view === 'day' ? d === today : view === 'week' ? start === mondayOf(today) : ym === today.slice(0, 7);
  /** A day tapped in Week (or opened from Month's popover) opens in Day (back returns to where it was). */
  const openDay = (date: string) => {
    try {
      localStorage.setItem(VIEW_KEY, 'day');
    } catch {
      /* not kept */
    }
    setParams(address('day', date));
  };

  /** The big screen: a day chosen in Week or Month opens in the side panel; chosen again, in Day. */
  const select = (date: string) => {
    if (sel?.date === date && !sel.item) {
      openDay(date);
      return;
    }
    closeDocked('calendar');
    setSel({ date, item: null });
  };
  const selectItem = (date: string, item: string) => {
    closeDocked('calendar');
    setSel({ date, item });
  };
  const itemDone = useCallback(() => setSel((x) => (x?.item ? { ...x, item: null } : x)), []);

  // keys (round 8f): D, W and M for the views, the arrows for the previous and next, T for today
  const keys = useRef({ pickView, step, move, today });
  keys.current = { pickView, step, move, today };
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (activePane() !== 'calendar' || !isShortcut(e)) return;
      const k = keys.current;
      const t = e.target instanceof Element ? e.target : null;
      const key = e.key.toLowerCase();
      if (key === 'd' || key === 'w' || key === 'm') k.pickView(key === 'd' ? 'day' : key === 'w' ? 'week' : 'month');
      else if (key === 't') k.move(k.today);
      else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !t?.closest('.segmented, [role="radiogroup"], [role="menu"], .side-panel')) k.step(e.key === 'ArrowLeft' ? -1 : 1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  }, []);

  let title: string;
  let sub: string | null = null;
  let above: string | null = null;
  if (view === 'day') {
    title = longDate(d);
    above = day.data?.date === d ? day.data.hijri : null;
    sub = d === today ? 'Today' : null;
  } else if (view === 'week') {
    title = isCurrent ? 'This week' : dateRange(start, addDays(start, 6));
    sub = `Week ${isoWeek(start).week}${isCurrent ? `, ${dateRange(start, addDays(start, 6))}` : ''}`;
  } else {
    title = monthYear(ym);
    sub = month.data?.month === ym ? month.data.hijri : hijriSpan(ym);
  }
  const unit = view === 'day' ? 'day' : view === 'week' ? 'week' : 'month';

  return (
    <div className="page calendar" data-testid="calendar" data-view={view} data-desk={desk ? '' : undefined}>
      <TopBarSlot>
        <Segmented label="Calendar view" onGlass value={view} onChange={pickView} options={VIEWS.map((v) => ({ ...v, testId: `cal-view-${v.value}` }))} testId="cal-view" />
      </TopBarSlot>
      <header className="cal-head">
        <div className="cal-title">
          {above && <p className="hijri" data-testid="cal-hijri">{above}</p>}
          <h1 data-testid="cal-title">{title}</h1>
          <span className="cal-sub">
            {sub && <span className="secondary">{sub}</span>}
            {!isCurrent && (
              <button type="button" className="btn-link cal-today" onClick={() => move(today)} data-testid="cal-today">
                {view === 'day' ? 'Go to today' : view === 'week' ? 'This week' : 'This month'}
              </button>
            )}
          </span>
        </div>
        <div className="cal-nav" role="group" aria-label={`Choose the ${unit}`}>
          <button type="button" className="icon-btn" aria-label={`Previous ${unit}`} onClick={() => step(-1)} data-testid="cal-prev">
            <ChevronLeft />
          </button>
          <button type="button" className="icon-btn" aria-label={`Next ${unit}`} onClick={() => step(1)} data-testid="cal-next">
            <ChevronRight />
          </button>
        </div>
      </header>
      <div className="wk-actions">
        <button type="button" className="btn btn-primary" onClick={() => setAdding(true)} data-testid="add-event">
          <Plus aria-hidden /> Add event
        </button>
        {(view === 'week' || (desk && view === 'month')) && (
          <Segmented
            label="Prayer times"
            value={prayers}
            onChange={setPrayers}
            options={[
              { value: 'on', label: 'Prayers' },
              { value: 'off', label: 'Hide' },
            ]}
          />
        )}
      </div>
      <div className="cal-split">
        <div className="cal-body" ref={bodyRef}>
          {has.has('day') && (
            <section className="seg-pane" data-seg="day" ref={refs.day} aria-label="Day">
              <DayView data={day.data?.date === d ? day.data : null} nowHm={nowHm} onMove={(dir) => step(dir)} contentRef={dayRef} desk={desk} active={view === 'day'} />
            </section>
          )}
          {has.has('week') && (
            <section className="seg-pane" data-seg="week" ref={refs.week} aria-label="Week">
              <WeekView data={week.data?.start === start ? week.data : null} today={today} start={start} prayers={prayers === 'on'} thisWeek={start === mondayOf(today)} onOpen={openDay} daysRef={weekRef} active={view === 'week'} desk={desk} nowHm={nowHm} selected={sel?.date ?? null} onSelect={select} />
            </section>
          )}
          {has.has('month') && (
            <section className="seg-pane" data-seg="month" ref={refs.month} aria-label="Month">
              <MonthView data={month.data?.month === ym ? month.data : null} ym={ym} today={today} onOpen={openDay} gridRef={monthRef} active={view === 'month'} desk={desk} selected={sel?.date ?? null} onSelect={select} onItem={selectItem} prayers={prayers === 'on'} />
            </section>
          )}
        </div>
        <SidePanel label="Calendar details" testId="cal-panel">
          {view === 'day' ? <DayAside data={day.data?.date === d ? day.data : null} /> : sel ? <DayDetail date={sel.date} item={sel.item} onItemDone={itemDone} onOpenDay={() => openDay(sel.date)} onClose={() => setSel(null)} nowHm={nowHm} /> : null}
        </SidePanel>
      </div>
      <AddEvent open={adding} onClose={() => setAdding(false)} initialDate={desk && sel && view !== 'day' ? sel.date : view === 'week' ? (start <= today && today <= addDays(start, 6) ? today : start) : view === 'month' ? (ym === today.slice(0, 7) ? today : `${ym}-01`) : d} />
    </div>
  );
}
