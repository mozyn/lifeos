/**
 * The screens as panes on a horizontal track (UI brief 3, ADR-37). Each top-level screen (the five
 * tabs, Settings, and one pane for any other route) stays mounted in its own pane once it has
 * been shown; switching changes only which pane is visible, so a tab switch never mounts, lays out
 * or restyles a whole screen inside an animation frame.
 *
 * - Hidden panes are `visibility: hidden` + `content-visibility: hidden` (never `display: none`):
 *   their DOM, layout and scroll position are kept, and they cost nothing while hidden.
 * - A switch is a compositor-only slide: the two panes travel together by `transform:
 *   translate3d()` (a Web Animation on layers that are always `will-change: transform`), 250 ms,
 *   ease-out, and the pane that leaves fades as it goes (UI brief 4: a slide that is seen, not
 *   only run). Reduced motion: the new pane fades in over 120 ms, nothing moves.
 * - The target pane is uncovered on pointerdown (`prepare`), parked beside the visible one, so it is
 *   painted and rasterized in the frames before the click starts the slide.
 * - Work that is not the switch itself (data refreshes that land mid-slide, focus, the scroll-edge
 *   state) waits for the end of the slide (`afterSlide`).
 * - The glass bars stay liquid through a slide (UI brief 4, ADR-43): at Balanced they rest on one
 *   pass, and freezing them for 250 ms cost more than it saved (each freeze is two 120 ms
 *   cross-fades with both layers drawn); scrolls and theme reveals freeze them (glassMotion).
 *
 * Nothing here renders React: the shell and the tab bar call it from event handlers.
 */
import { motionReduced } from '../glass/spring';

export const PANES = ['today', 'calendar', 'goals', 'habits', 'lists', 'settings', 'route'] as const;
export type PaneKey = (typeof PANES)[number];

/**
 * The pane a path (inside the app's base) belongs to. `/t/<id>` (a task opened from a reminder) is
 * the route pane; any other unknown path redirects to Today, so it counts as Today's.
 */
export function paneOf(pathname: string): PaneKey {
  const seg = pathname.replace(/^\/+/, '').split('/')[0] ?? '';
  if (seg === 't') return 'route';
  // Week became Calendar (round-2 brief §3): an old /week address is the Calendar's
  if (seg === 'week') return 'calendar';
  return (PANES as readonly string[]).includes(seg) && seg !== 'route' ? (seg as PaneKey) : 'today';
}

/** Slide order: the tabs left to right, Settings and other routes to their right. */
export const order = (k: PaneKey) => PANES.indexOf(k);

export const SLIDE_MS = 250;
export const SLIDE_EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
export const FADE_MS = 120;
/** the opacity the leaving pane fades to while it slides out */
export const SLIDE_OUT_OPACITY = 0.2;

type State = 'active' | 'warming' | 'hidden' | 'ready' | 'in' | 'out';

const els = new Map<PaneKey, HTMLElement>();
let active: PaneKey | null = null;
let width = 0;
let widthRo: ResizeObserver | null = null;
let readyKey: PaneKey | null = null;
let readyTimer: ReturnType<typeof setTimeout> | undefined;
let running: { id: number; from: PaneKey; to: PaneKey; anims: Animation[]; timer: ReturnType<typeof setTimeout>; overlap: boolean; travel: number } | null = null;
let slides = 0;
/** A pane that slid out, held off screen by its finished animation until the main thread is idle. */
let parked: { el: HTMLElement; anim: Animation | null } | null = null;
let deferred: (() => void)[] = [];
/** scrolls under a finger and their flings now running (round 8): a pane's, a sheet's */
const scrolls = new Set<string>();
/** work that waits for the scrolls alone (a refresh's fetch), not for slides */
let afterScrolls: (() => void)[] = [];
/** waiting for a pane to be visible (whenVisible) and to be on screen (whenShown) */
const visibleWaiters = new Map<PaneKey, (() => void)[]>();
const shownWaiters = new Map<PaneKey, (() => void)[]>();
const listeners = new Set<(to: PaneKey, from: PaneKey | null) => void>();

const idle = (fn: () => void) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 200 }) : setTimeout(fn, 16));

function setState(el: HTMLElement, s: State): void {
  if (el.dataset.state !== s) el.dataset.state = s;
}

/** The shell registers each pane element (and null when it unmounts). */
export function registerPane(key: PaneKey, el: HTMLElement | null): void {
  if (!el) {
    els.delete(key);
    return;
  }
  els.set(key, el);
  if (!widthRo && el.parentElement) {
    // the track's width, read by an observer, never in a frame
    widthRo = new ResizeObserver((entries) => {
      const box = entries[0]?.borderBoxSize?.[0];
      width = box ? box.inlineSize : (entries[0]?.target as HTMLElement).offsetWidth;
    });
    widthRo.observe(el.parentElement);
  }
  if (key === active) setState(el, 'active');
  else warm(el);
}

/**
 * A pane mounted ahead of its first visit is laid out once while invisible (its glass measures
 * itself and builds its filters, its style and layout are computed), then the renderer is told to
 * skip it. All of that happens in idle time, not in the switch that first shows it.
 */
function warm(el: HTMLElement): void {
  setState(el, 'warming');
  requestAnimationFrame(() =>
    requestAnimationFrame(() =>
      idle(() => {
        if (el.dataset.state === 'warming') setState(el, 'hidden');
      }),
    ),
  );
}

export function activePane(): PaneKey | null {
  return active;
}

export function paneElement(key: PaneKey): HTMLElement | undefined {
  return els.get(key);
}

export function slideRunning(): boolean {
  return running !== null;
}

/**
 * The slide on screen now: its number, how far it is (0..1, from its animation's clock) and how far
 * the panes travel (px; 0 for the reduced-motion fade). The frame meter samples it in every frame to
 * report how many frames each slide was seen in.
 */
export function currentSlide(): { id: number; progress: number; travel: number } | null {
  const r = running;
  const a = r?.anims[0];
  if (!r || !a) return null;
  const t = a.effect?.getComputedTiming();
  return { id: r.id, progress: typeof t?.progress === 'number' ? t.progress : 0, travel: r.travel };
}

/** Run `fn` once no slide is running and no scroll is under a finger or flinging (now, if none is). */
export function afterSlide(fn: () => void): void {
  if (running || scrolls.size) deferred.push(fn);
  else fn();
}

/**
 * A scroll under a finger starts (`on`) or ends with its fling (round 8): the work held back
 * meanwhile (a data change that would re-render a long list) runs once no scroll and no slide
 * runs and the thread is idle, not in the middle of a fling. `key`: whose scroll (a pane, a sheet);
 * each source ends its own on `scrollend`, with a timer behind it.
 */
export function scrollMotion(key: string, on: boolean): void {
  if (on) {
    scrolls.add(key);
    return;
  }
  if (!scrolls.delete(key) || scrolls.size) return;
  if (deferred.length) flushDeferred();
  if (afterScrolls.length)
    idle(() => {
      if (scrolls.size) return; // a new scroll flushes these when it ends
      const work = afterScrolls;
      afterScrolls = [];
      for (const fn of work) fn();
    });
}

/** Run `fn` once no scroll is under a finger or flinging (now, if none is): a data refresh's fetch and parse. */
export function afterScroll(fn: () => void): void {
  if (scrolls.size) afterScrolls.push(fn);
  else fn();
}

/** Run `fn` when the pane holding `el` is next visible (now, if it is). */
export function whenVisible(el: Element | null, fn: () => void): void {
  const pane = el?.closest<HTMLElement>('.pane');
  const key = pane?.dataset.pane as PaneKey | undefined;
  // a warming pane is laid out (only invisible): what needs its layout can run now
  if (!pane || !key || pane.dataset.state !== 'hidden') {
    fn();
    return;
  }
  const list = visibleWaiters.get(key) ?? [];
  list.push(fn);
  visibleWaiters.set(key, list);
}

/**
 * Run `fn` when the pane holding `el` is on screen (now, if it is): unlike whenVisible, a pane
 * warming in the background waits too. For what must happen where the user will see it, such as a
 * scroll into place (a scroll made while warming is lost when the pane is hidden).
 */
export function whenShown(el: Element | null, fn: () => void): void {
  const pane = el?.closest<HTMLElement>('.pane');
  const key = pane?.dataset.pane as PaneKey | undefined;
  if (!pane || !key || ['active', 'in', 'ready'].includes(pane.dataset.state ?? '')) {
    fn();
    return;
  }
  const list = shownWaiters.get(key) ?? [];
  list.push(fn);
  shownWaiters.set(key, list);
}

/** Called after every switch (the shell updates the bars from here). */
export function onSwitch(fn: (to: PaneKey, from: PaneKey | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The pane is visible from here on (parked or sliding in): what waited for that runs now. */
function uncover(key: PaneKey): void {
  for (const m of [visibleWaiters, shownWaiters]) {
    const waiting = m.get(key);
    if (!waiting) continue;
    m.delete(key);
    for (const fn of waiting) fn();
  }
}

let flushQueued = false;

/** The work held back during a slide runs once the main thread is idle and no slide runs. */
function flushDeferred(): void {
  if (flushQueued) return;
  flushQueued = true;
  idle(() => {
    flushQueued = false;
    if (running || scrolls.size) return; // the slide or scroll running now flushes when it ends
    const work = deferred;
    deferred = [];
    for (const fn of work) fn();
  });
}

/** The first pane: shown at once, no animation. */
export function setInitial(key: PaneKey): void {
  active = key;
  for (const [k, el] of els) {
    if (k === key) setState(el, 'active');
    else if (el.dataset.state === 'active') setState(el, 'hidden');
  }
}

/**
 * Park the pane a finger is going to open beside the visible one (pointerdown on a tab), so the
 * browser paints it in the frames before the click. Undone if no switch follows.
 */
export function prepare(key: PaneKey): void {
  if (key === active || running || motionReduced() || !active) return;
  const el = els.get(key);
  if (!el || !width) return;
  unprepare();
  readyKey = key;
  const dir = order(key) > order(active) ? 1 : -1;
  el.style.transform = `translate3d(${dir * width}px,0,0)`;
  setState(el, 'ready');
  uncover(key);
  readyTimer = setTimeout(unprepare, 900);
}

function unprepare(): void {
  clearTimeout(readyTimer);
  const key = readyKey;
  readyKey = null;
  if (!key || key === active) return;
  const el = els.get(key);
  if (!el || el.dataset.state !== 'ready') return;
  el.style.removeProperty('transform');
  setState(el, 'hidden');
}

/** Hide the pane that slid out (idle time, or at once when another switch starts). */
function unpark(): void {
  const p = parked;
  parked = null;
  if (!p) return;
  if (p.el.dataset.state === 'out') setState(p.el, 'hidden');
  p.anim?.cancel();
}

/**
 * End a running slide now, in its final state. The pane that came in is the active one at once;
 * the pane that went out stays where its animation left it (off screen, clipped) and is hidden
 * when the main thread is idle, so the frame that ends the slide restyles nothing.
 */
export function finishSlide(): void {
  const r = running;
  if (!r) return;
  running = null;
  clearTimeout(r.timer);
  const from = els.get(r.from);
  const to = els.get(r.to);
  const [inAnim, outAnim] = r.anims;
  if (to && r.to === active) setState(to, 'active');
  inAnim?.cancel();
  if (from && r.from !== active) {
    unpark();
    if (outAnim && outAnim.playState !== 'idle') outAnim.finish();
    parked = { el: from, anim: outAnim ?? null };
    // a cross-fade leaves it on top of the new pane (transparent, but it would take the taps)
    if (r.overlap) unpark();
    else idle(() => !running && unpark());
  }
  if (deferred.length) flushDeferred();
}

/**
 * Show `key`. `animate`: slide (or fade, with reduced motion) from the visible pane; otherwise
 * swap at once. `dir` overrides the direction of travel (1: the new pane comes from the right).
 */
export function show(key: PaneKey, { animate = true, dir }: { animate?: boolean; dir?: number } = {}): void {
  if (key === active && !running) return;
  finishSlide();
  unpark();
  if (key === active) return;
  const from = active;
  const fromEl = from ? els.get(from) : undefined;
  const toEl = els.get(key);
  active = key;
  if (readyKey && readyKey !== key) unprepare();
  readyKey = null;
  clearTimeout(readyTimer);
  for (const l of [...listeners]) l(key, from);
  if (!toEl) return;
  if (!fromEl || !animate || !width || document.visibilityState !== 'visible') {
      toEl.style.removeProperty('transform');
    setState(toEl, 'active');
    if (fromEl) setState(fromEl, 'hidden');
    uncover(key);
    return;
  }
  const d = dir ?? (order(key) > order(from!) ? 1 : -1);
  const reduced = motionReduced();
  const anims: Animation[] = [];
  toEl.style.removeProperty('transform');
  setState(toEl, 'in');
  setState(fromEl, 'out');
  uncover(key);
  if (reduced) {
    // a cross-fade in place (the panes overlap here, and neither is stacked above the other)
    anims.push(toEl.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: 'linear', fill: 'both' }));
    anims.push(fromEl.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, easing: 'linear', fill: 'both' }));
  } else {
    const timing: KeyframeAnimationOptions = { duration: SLIDE_MS, easing: SLIDE_EASING, fill: 'both' };
    anims.push(toEl.animate([{ transform: `translate3d(${d * width}px,0,0)` }, { transform: 'translate3d(0,0,0)' }], timing));
    anims.push(
      fromEl.animate(
        [
          { transform: 'translate3d(0,0,0)', opacity: 1 },
          { transform: `translate3d(${-d * width}px,0,0)`, opacity: SLIDE_OUT_OPACITY },
        ],
        timing,
      ),
    );
  }
  const total = reduced ? FADE_MS : SLIDE_MS;
  // the animations' own end, with a backstop: a slide whose animation stopped advancing (the page
  // was hidden mid-slide) is finished; one that is still moving (slowed down, as in DevTools) is not
  let lastT = -1;
  const backstop = () => {
    if (running !== r) return;
    const t = Number(anims[0].currentTime ?? 0);
    if (document.visibilityState === 'visible' && anims[0].playState === 'running' && t > lastT && t < total) {
      lastT = t;
      r.timer = setTimeout(backstop, total);
      return;
    }
    finishSlide();
  };
  const r = { id: ++slides, from: from!, to: key, anims, overlap: reduced, timer: setTimeout(backstop, total + 120), travel: reduced ? 0 : width };
  running = r;
  void anims[0].finished.then(
    () => running === r && finishSlide(),
    () => undefined,
  );
}

/** Test and diagnostics hook. */
if (typeof window !== 'undefined')
  (window as unknown as { __lifeosPanes: object }).__lifeosPanes = {
    get active() {
      return active;
    },
    get sliding() {
      return running !== null;
    },
  };
