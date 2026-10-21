/**
 * The shell (spec §4): five tabs on a floating glass tab bar (no "More"), Quick Add as its own
 * trailing glass button, gear and sun/moon always in the top bar. On the fold's inner screen and
 * desktop (≥ 700 px) the tab bar becomes a left glass rail.
 *
 * Screens live in panes (UI brief 3, ADR-37, lib/panes.ts): each stays mounted once shown, and a
 * tab switch slides the two panes on the compositor. The bars never re-render for a switch: the
 * active tab, the lens pill, the top bar's slot and the scroll-edge state are set directly, and
 * nothing in this file reads the router's location while rendering (RouteWatcher does, and
 * renders nothing).
 */
import { type ReactNode, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Outlet, UNSAFE_LocationContext as LocationContext, UNSAFE_RouteContext as RouteContext, useLocation, useNavigate } from 'react-router';
import { CalendarDays, Flame, ListChecks, Plus, Settings, Sun, Target } from 'lucide-react';
import { Glass } from '../glass/Glass';
import { controllerFor } from '../glass/engine';
import { type LensHandle, useLensPill } from '../glass/lens';
import { Toasts } from '../components/ui';
import { TaskSheetHost } from '../components/TaskSheet';
import { SearchSheetHost } from '../components/SearchSheet';
import { GroupSheetHost } from '../components/GroupRow';
import { RowMenuHost } from '../components/RowMenu';
import { MoveSheetHost } from '../components/MoveSheet';
import { BulkBar } from '../components/BulkBar';
import { QuickAdd } from './QuickAdd';
import { ThemeToggle } from './ThemeToggle';
import { PrivacyToggle } from '../components/Private';
import { scrollState, useScrollChrome } from './useScrollChrome';
import { GoCtx, PaneCtx, QuickCtx, SlotsCtx } from './context';
import { BASE } from '../lib/api';
import { useOnline, usePending } from '../lib/store';
import { routeCommitted } from '../lib/transitions';
import { activePane, afterSlide, onSwitch, type PaneKey, PANES, paneOf, prepare, registerPane, setInitial, show } from '../lib/panes';

export const TABS: { key: PaneKey; to: string; label: string; icon: ReactNode }[] = [
  { key: 'today', to: '/today', label: 'Today', icon: <Sun /> },
  { key: 'calendar', to: '/calendar', label: 'Calendar', icon: <CalendarDays /> },
  { key: 'goals', to: '/goals', label: 'Goals', icon: <Target /> },
  { key: 'habits', to: '/habits', label: 'Habits', icon: <Flame /> },
  { key: 'lists', to: '/lists', label: 'Lists', icon: <ListChecks /> },
];

const TITLES: Partial<Record<PaneKey, string>> = { calendar: 'Calendar', goals: 'Goals', habits: 'Habits', lists: 'Lists', settings: 'Settings' };

export type ScreenKey = Exclude<PaneKey, 'route'>;

const tabIndex = (k: PaneKey | null) => TABS.findIndex((t) => t.key === k);

/** The app-relative path of the address bar (the router's basename stripped). */
function here(): string {
  const base = BASE.replace(/\/$/, '');
  const p = window.location.pathname.startsWith(base) ? window.location.pathname.slice(base.length) || '/' : window.location.pathname;
  return p + window.location.search + window.location.hash;
}

// ------------------------------------------------------------------ navigation state (outside React)

/** The router's navigate, kept by RouteWatcher (rendering it here would re-render the shell on every navigation). */
const nav: { navigate: ((to: string, o?: { replace?: boolean }) => void) | null } = { navigate: null };
/** Where each pane was last (a tab tap returns there, the way it was left). */
const lastHref = new Map<PaneKey, string>();

// ------------------------------------------------------------------ tab bar and rail

function TabBarImpl({ initial, onPrepare }: { initial: PaneKey; onPrepare: (k: PaneKey) => void }) {
  const go = useContext(GoCtx);
  const barRef = useRef<HTMLElement | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLElement | null>(null);
  const miniRef = useRef<HTMLElement | null>(null);
  const lens = useRef<LensHandle | null>(null);
  lens.current = useLensPill({ track: trackRef, pill: pillRef, itemSelector: ':scope > a.tab', index: tabIndex(initial), onPick: (i) => go(lastHref.get(TABS[i].key) ?? TABS[i].to), pad: 2, pressScale: 1.16, motionFringe: 'scrub' });
  // a switch moves the selection by attributes and the pill's transform: no render
  useEffect(
    () =>
      onSwitch((to) => {
        const i = tabIndex(to);
        for (const a of trackRef.current?.querySelectorAll<HTMLElement>(':scope > a.tab') ?? []) {
          const on = a.dataset.tab === to;
          a.classList.toggle('active', on);
          if (on) a.setAttribute('aria-current', 'page');
          else a.removeAttribute('aria-current');
        }
        lens.current?.select(i);
        const mini = miniRef.current;
        if (mini) {
          mini.dataset.tab = i >= 0 ? to : 'today';
          mini.setAttribute('aria-label', `Show the tab bar (${TABS[Math.max(0, i)].label})`);
        }
      }),
    [],
  );
  useLayoutEffect(() => {
    const track = trackRef.current;
    const bar = barRef.current;
    if (!track || !bar) return;
    const place = () => {
      // the minimized bar narrows to one capsule by a scaleX of its glass (no width animation)
      if (bar.offsetWidth) bar.style.setProperty('--min-k', String(Math.min(1, 64 / bar.offsetWidth).toFixed(4)));
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(track);
    return () => ro.disconnect();
  }, []);
  // the pill's glass is built while the app is idle, not on the first tap
  useEffect(() => {
    const id = requestIdle(() => controllerFor(pillRef.current)?.prepare());
    return () => cancelIdle(id);
  }, []);
  const i0 = tabIndex(initial);
  return (
    <>
      <Glass as="nav" ref={barRef} className="tabbar" kind="bar" freeze aria-label="Primary" bezel={16} data-testid="tabbar">
        <div className="tabbar-clip">
          <div className="tabbar-track" ref={trackRef}>
            <Glass ref={pillRef} className="lens-pill tab-pill" variant="clear" profile="bezel" bezel={7} dormant scale={18} chroma={0.06} power={2.6} aria-hidden />
            {TABS.map((t, i) => (
              <a
                key={t.key}
                href={`${BASE}${t.to.slice(1)}`}
                className={`tab${i === i0 ? ' active' : ''}`}
                aria-current={i === i0 ? 'page' : undefined}
                draggable={false}
                data-tab={t.key}
                onPointerDown={() => onPrepare(t.key)}
                onClick={(e) => {
                  e.preventDefault();
                  go(lastHref.get(t.key) ?? t.to);
                }}
                data-testid={`tab-${t.label.toLowerCase()}`}
              >
                {t.icon}
                <span className="tab-label">{t.label}</span>
              </a>
            ))}
          </div>
        </div>
      </Glass>
      {/* minimized while scrolling down: one capsule with the current tab; a tap brings the bar back */}
      <Glass
        as="button"
        ref={miniRef}
        className="tabbar-mini"
        press={1.4}
        aria-label={`Show the tab bar (${TABS[Math.max(0, i0)].label})`}
        data-tab={i0 >= 0 ? initial : 'today'}
        onClick={(e: React.MouseEvent<HTMLElement>) => {
          const dock = e.currentTarget.closest<HTMLElement>('.dock');
          if (dock) delete dock.dataset.min;
        }}
        data-testid="tabbar-mini"
      >
        {TABS.map((t) => (
          <span key={t.key} className="mini-icon" data-tab={t.key}>
            {t.icon}
          </span>
        ))}
      </Glass>
    </>
  );
}
const TabBar = memo(TabBarImpl);

function RailImpl({ initial, onQuick, onPrepare }: { initial: PaneKey; onQuick: () => void; onPrepare: (k: PaneKey) => void }) {
  const go = useContext(GoCtx);
  const trackRef = useRef<HTMLDivElement>(null);
  useEffect(
    () =>
      onSwitch((to) => {
        for (const a of trackRef.current?.querySelectorAll<HTMLElement>(':scope > a.rail-tab') ?? []) {
          const on = a.dataset.tab === to;
          a.classList.toggle('active', on);
          if (on) a.setAttribute('aria-current', 'page');
          else a.removeAttribute('aria-current');
        }
      }),
    [],
  );
  return (
    <Glass as="nav" className="rail" kind="bar" aria-label="Primary" data-testid="rail">
      <div className="rail-track" ref={trackRef}>
        {TABS.map((t) => (
          <a
            key={t.key}
            href={`${BASE}${t.to.slice(1)}`}
            className={`rail-tab${t.key === initial ? ' active' : ''}`}
            aria-current={t.key === initial ? 'page' : undefined}
            data-tab={t.key}
            onPointerDown={() => onPrepare(t.key)}
            onClick={(e) => {
              e.preventDefault();
              go(lastHref.get(t.key) ?? t.to);
            }}
            data-testid={`rail-${t.label.toLowerCase()}`}
          >
            {t.icon}
            <span>{t.label}</span>
          </a>
        ))}
      </div>
      <Glass as="button" variant="tinted" className="rail-quick" press={1.5} aria-label="Quick Add" onClick={onQuick} data-testid="quick-add-rail">
        <Plus aria-hidden />
      </Glass>
    </Glass>
  );
}
const Rail = memo(RailImpl);

// ------------------------------------------------------------------ top bar

function SyncState() {
  const online = useOnline();
  const pending = usePending();
  if (online && pending.length === 0) return null;
  return (
    <span className="tag" data-testid="sync-state" title={pending.length ? `${pending.length} change(s) waiting to reach the vault` : 'Offline: showing the last saved view'}>
      {online ? `Saving ${pending.length}` : pending.length ? `Offline, ${pending.length} waiting` : 'Offline'}
    </span>
  );
}

function TopBarImpl({ initial, onSlots }: { initial: PaneKey; onSlots: (m: Map<PaneKey, HTMLElement>) => void }) {
  const go = useContext(GoCtx);
  const leftRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const m = new Map<PaneKey, HTMLElement>();
    for (const el of leftRef.current?.querySelectorAll<HTMLElement>(':scope > .topbar-slot') ?? []) m.set(el.dataset.pane as PaneKey, el);
    onSlots(m);
  }, [onSlots]);
  useEffect(
    () =>
      onSwitch((to, from) => {
        const left = leftRef.current;
        if (!left) return;
        if (from) left.querySelector<HTMLElement>(`:scope > [data-pane="${from}"]`)?.removeAttribute('data-on');
        left.querySelector<HTMLElement>(`:scope > [data-pane="${to}"]`)?.setAttribute('data-on', '');
      }),
    [],
  );
  return (
    <header className="topbar">
      <div className="topbar-left" ref={leftRef}>
        {PANES.map((k) => (
          <div key={k} className="topbar-slot" data-pane={k} data-on={k === initial ? '' : undefined}>
            {TITLES[k] && <span className="topbar-title">{TITLES[k]}</span>}
          </div>
        ))}
      </div>
      <SyncState />
      <Glass className="tb-group" kind="bar" freeze role="group" aria-label="Appearance and settings">
        <PrivacyToggle />
        <ThemeToggle />
        <button type="button" className="icon-btn" data-press="1.5" aria-label="Settings" onClick={() => go(lastHref.get('settings') ?? '/settings')} data-testid="settings-button">
          <Settings />
        </button>
      </Glass>
    </header>
  );
}
const TopBar = memo(TopBarImpl);

// ------------------------------------------------------------------ panes

type LocationValue = React.ContextType<typeof LocationContext>;
type RouteValue = React.ContextType<typeof RouteContext>;

/**
 * A pane holds one screen and gives it the router state of the last address that belonged to it:
 * while another pane is showing, its screen sees no navigation at all (no re-render), and coming
 * back to the same address renders nothing either.
 */
function PaneImpl({ k, children }: { k: PaneKey; children: ReactNode }) {
  const loc = useContext(LocationContext);
  const route = useContext(RouteContext);
  const frozen = useRef<{ href: string; loc: LocationValue; route: RouteValue } | null>(null);
  const href = loc.location.pathname + loc.location.search + loc.location.hash;
  if (paneOf(loc.location.pathname) === k) {
    if (frozen.current?.href !== href) frozen.current = { href, loc, route };
  } else if (!frozen.current) {
    // mounted ahead of its first visit: the pane's own root address
    const pathname = TABS.find((t) => t.key === k)?.to ?? `/${k}`;
    frozen.current = { href: pathname, loc: { ...loc, location: { pathname, search: '', hash: '', state: null, key: `pane-${k}` } }, route };
  }
  const f = frozen.current;
  const ref = useCallback((el: HTMLElement | null) => registerPane(k, el), [k]);
  return (
    <section className="pane" data-pane={k} ref={ref} tabIndex={-1} aria-label={TITLES[k] ?? (k === 'today' ? 'Today' : undefined)}>
      <PaneCtx.Provider value={k}>
        <LocationContext.Provider value={f.loc}>
          <RouteContext.Provider value={f.route}>{children}</RouteContext.Provider>
        </LocationContext.Provider>
      </PaneCtx.Provider>
    </section>
  );
}
const Pane = memo(PaneImpl);

/** Any route outside the tabs and Settings (a task opened from a reminder), live from the router. */
function RoutePaneImpl() {
  const ref = useCallback((el: HTMLElement | null) => registerPane('route', el), []);
  return (
    <section className="pane" data-pane="route" ref={ref} tabIndex={-1}>
      <PaneCtx.Provider value="route">
        <Outlet />
      </PaneCtx.Provider>
    </section>
  );
}
const RoutePane = memo(RoutePaneImpl);

const Screens = memo(function Screens({ screens, mounted, slots }: { screens: Record<ScreenKey, ReactNode>; mounted: ReadonlySet<PaneKey>; slots: Map<PaneKey, HTMLElement> | null }) {
  return (
    <SlotsCtx.Provider value={slots}>
      {(Object.keys(screens) as ScreenKey[]).map((k) =>
        mounted.has(k) ? (
          <Pane key={k} k={k}>
            {screens[k]}
          </Pane>
        ) : null,
      )}
      <RoutePane />
    </SlotsCtx.Provider>
  );
});

/**
 * Renders nothing: keeps the router's navigate for the shell, settles pane switches started by
 * anything other than the shell (the back button, a screen's own navigate, a redirect), and tells
 * transitions that a route has committed.
 */
function RouteWatcher({ onLocation }: { onLocation: (href: string) => void }) {
  const location = useLocation();
  const navigate = useNavigate();
  nav.navigate = navigate;
  const href = location.pathname + location.search + location.hash;
  useLayoutEffect(() => {
    onLocation(href);
    routeCommitted();
  }, [location.key]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

function requestIdle(fn: () => void): number {
  return typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 2000 }) : (setTimeout(fn, 200) as unknown as number);
}
function cancelIdle(id: number): void {
  if (typeof cancelIdleCallback === 'function') cancelIdleCallback(id);
  else clearTimeout(id);
}

// ------------------------------------------------------------------ the shell

export function AppShell({ screens, warm = [] }: { screens: Record<ScreenKey, ReactNode>; warm?: ScreenKey[] }) {
  const mainRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const initial = useMemo(() => paneOf(here().split(/[?#]/)[0]), []);
  const [slots, setSlots] = useState<Map<PaneKey, HTMLElement> | null>(null);
  const [mounted, setMounted] = useState<ReadonlySet<PaneKey>>(() => new Set([initial]));
  const mountedRef = useRef(mounted);
  mountedRef.current = mounted;
  const [quick, setQuick] = useState<{ open: boolean; type?: string }>({ open: false });
  useScrollChrome(contentRef, mainRef, dockRef);
  const openQuick = useCallback((type?: string) => setQuick({ open: true, type }), []);
  const openQuickPlain = useCallback(() => setQuick({ open: true }), []);
  const closeQuick = useCallback(() => setQuick({ open: false }), []);

  useLayoutEffect(() => setInitial(initial), [initial]);

  const ensureMounted = useCallback((k: PaneKey) => {
    if (k === 'route' || mountedRef.current.has(k)) return;
    // a screen not yet mounted (Settings, or a tab before warming finished) renders now, hidden
    flushSync(() => setMounted((m) => new Set(m).add(k)));
  }, []);

  /** Show pane `k` (bars follow through onSwitch). */
  const switchTo = useCallback(
    (k: PaneKey) => {
      ensureMounted(k);
      const dock = dockRef.current;
      if (dock) delete dock.dataset.min;
      show(k);
    },
    [ensureMounted],
  );

  // a finger on a tab: park that pane beside this one so it is painted before the click
  const onPrepare = useCallback((k: PaneKey) => {
    if (mountedRef.current.has(k) && k !== activePane()) prepare(k);
  }, []);

  const go = useCallback(
    (to: string) => {
      const u = new URL(to, 'http://app/');
      const href = u.pathname + u.search + u.hash;
      if (href === here()) return;
      const k = paneOf(u.pathname);
      const navigate = nav.navigate;
      if (!navigate) return;
      if (k === activePane() || k === 'route') {
        navigate(href);
        return;
      }
      const at = lastHref.get(k) ?? TABS.find((t) => t.key === k)?.to ?? `/${k}`;
      if (mountedRef.current.has(k) && at === href) {
        // the pane already shows this address: slide now; the address bar follows
        switchTo(k);
        navigate(href);
        return;
      }
      // a deep link into another pane: the pane renders the new address while hidden, and the
      // commit that brings it slides it in (onLocation)
      ensureMounted(k);
      navigate(href);
    },
    [switchTo, ensureMounted],
  );

  // every address that commits: remember it for its pane, and follow navigations the shell did
  // not start (back/forward, redirects, a screen's own navigate)
  const onLocation = useCallback(
    (href: string) => {
      const k = paneOf(href.split(/[?#]/)[0]);
      lastHref.set(k, href);
      // after the commit (mounting a pane flushes a render, which a layout effect may not do)
      if (k !== activePane()) queueMicrotask(() => k !== activePane() && switchTo(k));
    },
    [switchTo],
  );

  // warm the other tabs while the app is idle, one screen per idle period: each mounts hidden
  // (its data already in memory), so even the first visit to a tab only changes what is visible
  useEffect(() => {
    let id = 0;
    let i = 0;
    const next = () => {
      const k = warm[i++];
      if (!k) return;
      if (!mountedRef.current.has(k)) setMounted((m) => new Set(m).add(k));
      id = requestIdle(next);
    };
    id = requestIdle(next);
    return () => cancelIdle(id);
  }, [warm]);

  // the screen a switch leaves behind loses focus if it had it: focus moves to the new pane
  useEffect(
    () =>
      onSwitch((to, from) => {
        const main = mainRef.current;
        if (main) scrollState(main, to);
        const was = from ? document.querySelector<HTMLElement>(`.pane[data-pane="${from}"]`) : null;
        if (was && was.contains(document.activeElement)) {
          const next = document.querySelector<HTMLElement>(`.pane[data-pane="${to}"]`);
          afterSlide(() => next?.focus({ preventScroll: true }));
        }
      }),
    [],
  );

  return (
    <GoCtx.Provider value={go}>
      <QuickCtx.Provider value={openQuick}>
        <div className="app">
          <Rail initial={initial} onQuick={openQuickPlain} onPrepare={onPrepare} />
          <div className="main" ref={mainRef}>
            <TopBar initial={initial} onSlots={setSlots} />
            <div className="edge edge-top" aria-hidden />
            <main className="content" id="main" tabIndex={-1} ref={contentRef}>
              <Screens screens={screens} mounted={mounted} slots={slots} />
            </main>
            <div className="edge edge-bottom" aria-hidden />
            <div className="dock" ref={dockRef}>
              <TabBar initial={initial} onPrepare={onPrepare} />
              <Glass as="button" variant="tinted" className="quick-fab" press={1.6} aria-label="Quick Add" onClick={openQuickPlain} data-testid="quick-add">
                <Plus aria-hidden />
              </Glass>
            </div>
          </div>
          <RouteWatcher onLocation={onLocation} />
          <QuickAdd open={quick.open} initialType={quick.type} onClose={closeQuick} />
          <TaskSheetHost />
          <SearchSheetHost />
          <GroupSheetHost />
          <RowMenuHost />
          <MoveSheetHost />
          <BulkBar />
          <Toasts />
        </div>
      </QuickCtx.Provider>
    </GoCtx.Provider>
  );
}
