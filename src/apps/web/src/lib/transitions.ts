/**
 * Animated transitions (UI brief 2 §3) on the View Transitions API: short, purposeful,
 * spring-like, never ornamental.
 *
 * - Content changes inside a screen (Today's moment, Week prev/next) run as
 *   element-scoped transitions (`element.startViewTransition`) on the part that changes. The bars
 *   stay outside the scope, so they never re-render and their glass keeps its backdrop: a
 *   document-level transition would capture them in isolation, and isolated glass loses its blur.
 * - Tab switches are not view transitions (UI brief 3): the screens stay mounted in panes and
 *   slide on the compositor (lib/panes.ts).
 * - The light/dark flip is a document transition: the new appearance is revealed in a circle that
 *   grows from the sun/moon button (450 ms, ease-out) over a still image of the old one.
 * - Drill-ins grow the tapped row into its sheet (a shared element), and closing reverses it.
 * - Reduced motion: every one of them is a 120 ms opacity fade.
 * - No View Transitions (Firefox, Safari, older engines): the new content fades in by opacity.
 */
import { flushSync } from 'react-dom';
import { glassMotion } from '../glass/engine';
import { motionReduced } from '../glass/spring';

export type VtKind = 'moment' | 'week' | 'drill' | 'theme';

type Starter = (cb: () => Promise<void> | void) => ViewTransition;
type Host = (Element | Document) & { startViewTransition?: Starter };

const tokens = new WeakMap<object, number>();
let docRunning = false;

/**
 * Resolves once `test` holds or after `ms`. Polled on a timer, not on animation frames: while a
 * view transition's update runs, rendering (and with it requestAnimationFrame) is paused.
 */
export function until(test: () => boolean, ms: number): Promise<void> {
  const end = performance.now() + ms;
  return new Promise((resolve) => {
    const check = () => (test() || performance.now() >= end ? resolve() : setTimeout(check, 12));
    check();
  });
}

// ------------------------------------------------------------------ route commits

let commitWaiters: (() => void)[] = [];

/** AppShell calls this from a layout effect when the location changed (the new route is in the DOM). */
export function routeCommitted(): void {
  const w = commitWaiters;
  commitWaiters = [];
  for (const r of w) r();
}

/** Navigate inside a transition's update and wait until the new route has rendered (≤ 300 ms). */
export function nextRoute(): Promise<void> {
  return new Promise((resolve) => {
    commitWaiters.push(resolve);
    setTimeout(resolve, 300);
  });
}

/** The new content is ready to be shown: no loading skeleton left inside `scope` (≤ 280 ms). */
export function contentReady(scope: Element | null): Promise<void> {
  return until(() => !scope?.querySelector('.skeleton'), 280);
}

// ------------------------------------------------------------------ the transition

export interface TransitionOptions {
  kind: VtKind;
  /** the element whose content changes; none = the whole document */
  scope?: Element | null;
  /** direction of travel: 1 forward (content comes from the right), -1 back */
  dir?: number;
  /** changes the DOM; may be async (navigation, data) */
  update: () => void | Promise<void>;
}

export function supportsScoped(): boolean {
  return typeof (document.documentElement as Host).startViewTransition === 'function';
}

/**
 * Run `update` inside a view transition. Resolves once the update has run (the DOM is in its new
 * state); the animation carries on by itself.
 */
export async function transition({ kind, scope, dir = 1, update }: TransitionOptions): Promise<void> {
  const host: Host = scope ?? document;
  const target = (scope ?? document.documentElement) as HTMLElement;
  const start = host.startViewTransition?.bind(host) as Starter | undefined;
  const reduced = motionReduced();
  // one document transition at a time: a second one would cut the first short mid-frame
  if (!start || (!scope && docRunning) || document.visibilityState !== 'visible') {
    await update();
    if (!reduced && scope instanceof HTMLElement) scope.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
    else if (reduced && scope instanceof HTMLElement) scope.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: 'linear' });
    return;
  }
  const token = (tokens.get(target) ?? 0) + 1;
  tokens.set(target, token);
  target.dataset.vt = reduced ? 'fade' : kind;
  target.style.setProperty('--vt-dir', String(dir < 0 ? -1 : 1));
  if (!scope) docRunning = true;
  const t = start(async () => {
    await update();
  });
  void t.finished
    .catch(() => undefined)
    .then(() => {
      if (!scope) docRunning = false;
      if (tokens.get(target) !== token) return;
      delete target.dataset.vt;
      target.style.removeProperty('--vt-dir');
    });
  await t.updateCallbackDone.catch(() => undefined);
}

// ------------------------------------------------------------------ light / dark: the radial reveal

/** Flip the appearance with a circle growing from `from` (the sun/moon button). */
export async function revealTheme(from: Element | null, apply: () => void): Promise<void> {
  const doc = document as Host;
  if (!doc.startViewTransition || docRunning || document.visibilityState !== 'visible') {
    apply();
    return;
  }
  const reduced = motionReduced();
  const r = from?.getBoundingClientRect();
  const x = r ? r.left + r.width / 2 : window.innerWidth - 40;
  const y = r ? r.top + r.height / 2 : 34;
  const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  const root = document.documentElement;
  root.dataset.vt = reduced ? 'fade' : 'theme';
  docRunning = true;
  // the whole screen changes under the bars: their frosted twins for the length of the reveal
  glassMotion('theme', true);
  const t = doc.startViewTransition(() => {
    flushSync(apply);
  });
  void t.ready
    .then(() => {
      if (reduced) return;
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 450, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', pseudoElement: '::view-transition-new(root)' },
      );
    })
    .catch(() => undefined);
  void t.finished
    .catch(() => undefined)
    .then(() => {
      docRunning = false;
      glassMotion('theme', false);
      if (root.dataset.vt === 'theme' || root.dataset.vt === 'fade') delete root.dataset.vt;
    });
  await t.updateCallbackDone.catch(() => undefined);
}

// ------------------------------------------------------------------ drill-ins: row ⇄ sheet

const DRILL = 'lifeos-drill';
/** the row a sheet grew from, for the way back */
let drillSource: HTMLElement | null = null;
/** set while a drill-in's update runs: the next sheet to open takes the shared name */
let drillPending = false;

function sourceOf(el: Element | null): HTMLElement | null {
  return (el?.closest<HTMLElement>('.row, .card, [data-drill-source]') ?? (el as HTMLElement | null)) || null;
}

/** Open a sheet from the element that was tapped: the row grows into the sheet. */
export async function drillIn(from: Element | null, open: () => void | Promise<void>): Promise<void> {
  const src = sourceOf(from);
  const doc = document as Host;
  if (!src || !doc.startViewTransition || docRunning || document.visibilityState !== 'visible') {
    drillSource = src;
    await open();
    return;
  }
  drillSource = src;
  src.style.viewTransitionName = DRILL;
  await transition({
    kind: 'drill',
    update: async () => {
      src.style.viewTransitionName = '';
      drillPending = true;
      flushSync(() => void open());
      await until(() => !!document.querySelector('.sheet[data-drill], .dock-sheet[data-drill]'), 300);
      drillPending = false;
    },
  });
  // the shared name lives only for the transition: a named element is captured in isolation,
  // and glass inside it would lose its backdrop
  void waitTransitionEnd().then(() => document.querySelector<HTMLElement>('.sheet[data-drill], .dock-sheet[data-drill]')?.style.removeProperty('view-transition-name'));
}

/** Sheet: is this sheet the end of a drill-in? (called once, when it opens) */
export function claimDrill(sheet: HTMLElement): boolean {
  if (!drillPending) return false;
  drillPending = false;
  sheet.dataset.drill = '';
  sheet.style.viewTransitionName = DRILL;
  return true;
}

/** Close a sheet that grew from a row: it shrinks back into the row (if the row is still there). */
export async function drillOut(sheet: HTMLElement | null, close: () => void | Promise<void>): Promise<void> {
  const src = drillSource;
  const doc = document as Host;
  drillSource = null;
  if (!sheet || !('drill' in sheet.dataset) || !src?.isConnected || !doc.startViewTransition || docRunning || document.visibilityState !== 'visible') {
    await close();
    return;
  }
  sheet.style.viewTransitionName = DRILL;
  await transition({
    kind: 'drill',
    update: async () => {
      flushSync(() => void close());
      await until(() => !sheet.isConnected, 300);
      if (src.isConnected) src.style.viewTransitionName = DRILL;
    },
  });
  void waitTransitionEnd().then(() => src.style.removeProperty('view-transition-name'));
}

function waitTransitionEnd(): Promise<void> {
  return until(() => !docRunning, 1200);
}
