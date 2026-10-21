/**
 * In-screen segments that stay mounted (round-2 brief §7), the same pattern as the tab panes
 * (lib/panes.ts) one level down: the Lists switch (Tasks, Notes, Links, Shopping, Wishlist).
 *
 * - Every segment lives in one grid cell of its container. A hidden one is `visibility: hidden` +
 *   `content-visibility: hidden`: its DOM, its state and its data stay, it is skipped by the
 *   renderer, and it adds no height (size containment).
 * - A switch is a 150 ms cross-fade on the compositor (opacity only). For its length both segments
 *   are shown in the same cell, so the container is as tall as the taller of them: the list height
 *   never collapses and nothing below the switch jumps.
 * - Each segment keeps its own scroll position. The screen scrolls as one (the pane), so the switch
 *   moves the pane to the new segment's position and holds the old segment still under the fade
 *   (a translate that cancels the scroll), so nothing moves vertically on screen.
 * - Reduced motion: the switch is instant.
 *
 * Nothing here renders React: the screen calls `switchSegment` from a layout effect.
 */
import { glassFrozen } from '../glass/engine';
import { motionReduced } from '../glass/spring';
import { onSwitch, slideRunning } from './panes';

export const SEGMENT_FADE_MS = 150;

export type SegState = 'active' | 'hidden' | 'in' | 'out';

export function setSegState(el: HTMLElement, s: SegState): void {
  if (el.dataset.state !== s) el.dataset.state = s;
  // a hidden segment is out of the tab order and the accessibility tree
  if (s === 'hidden') el.setAttribute('inert', '');
  else el.removeAttribute('inert');
  el.setAttribute('aria-hidden', s === 'hidden' || s === 'out' ? 'true' : 'false');
}

/**
 * Where the screen scrolls when segment `to` is shown: the position it was left at, or (first
 * visit) where the screen is now; never past the end of the new segment, so nothing is clamped
 * (a jump) when the fade ends and the old segment stops taking room.
 */
export function scrollTarget(o: { saved: number | undefined; current: number; segmentsTop: number; newHeight: number; below: number; viewport: number }): number {
  const want = o.saved ?? o.current;
  const max = Math.max(0, o.segmentsTop + o.newHeight + o.below - o.viewport);
  return Math.max(0, Math.min(want, max));
}

interface Running {
  from: HTMLElement;
  to: HTMLElement;
  anims: Animation[];
  timer: ReturnType<typeof setTimeout>;
}

const running = new WeakMap<HTMLElement, Running>();
const positions = new WeakMap<HTMLElement, Map<string, number>>();

function finish(container: HTMLElement): void {
  const r = running.get(container);
  if (!r) return;
  running.delete(container);
  clearTimeout(r.timer);
  for (const a of r.anims) a.cancel();
  r.from.style.removeProperty('transform');
  if (r.from.dataset.state === 'out') setSegState(r.from, 'hidden');
  if (r.to.dataset.state === 'in') setSegState(r.to, 'active');
}

/** The scrolling ancestor (the pane), or null outside one. */
function scroller(el: HTMLElement): HTMLElement | null {
  return el.closest<HTMLElement>('.pane');
}

/** Offset of `el`'s top inside the scroller's content. */
function topIn(el: HTMLElement, sc: HTMLElement): number {
  return el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
}

/**
 * Show segment `to` in place of `from` inside `container` (both are children of it). `key`s name
 * the segments for their scroll positions.
 */
export function switchSegment(container: HTMLElement, from: HTMLElement | null, to: HTMLElement, keys: { from: string | null; to: string }): void {
  finish(container);
  if (from === to) {
    setSegState(to, 'active');
    return;
  }
  const sc = scroller(container);
  const saved = positions.get(container) ?? new Map<string, number>();
  positions.set(container, saved);
  const current = sc?.scrollTop ?? 0;
  if (from && keys.from) saved.set(keys.from, current);
  const reduced = motionReduced();
  if (!from || reduced || document.visibilityState !== 'visible') {
    if (from) setSegState(from, 'hidden');
    setSegState(to, 'active');
    if (sc) sc.scrollTop = targetFor(container, to, sc, saved.get(keys.to), current);
    return;
  }
  // both in the cell: the container keeps the taller height for the length of the fade
  setSegState(from, 'out');
  setSegState(to, 'in');
  if (sc) {
    const target = targetFor(container, to, sc, saved.get(keys.to), current);
    if (target !== current) {
      // the old segment stays where it is on screen while the pane moves under it
      from.style.transform = `translate3d(0, ${target - current}px, 0)`;
      sc.scrollTop = target;
    }
  }
  const timing: KeyframeAnimationOptions = { duration: SEGMENT_FADE_MS, easing: 'ease-out', fill: 'both' };
  const anims = [to.animate([{ opacity: 0 }, { opacity: 1 }], timing), from.animate([{ opacity: 1 }, { opacity: 0 }], timing)];
  const r: Running = { from, to, anims, timer: setTimeout(() => running.get(container) === r && finish(container), SEGMENT_FADE_MS + 120) };
  running.set(container, r);
  void anims[0].finished.then(
    () => running.get(container) === r && finish(container),
    () => undefined,
  );
}

function targetFor(container: HTMLElement, to: HTMLElement, sc: HTMLElement, saved: number | undefined, current: number): number {
  const segmentsTop = topIn(container, sc);
  const below = sc.scrollHeight - (segmentsTop + container.offsetHeight);
  return scrollTarget({ saved, current, segmentsTop, newHeight: to.offsetHeight, below: Math.max(0, below), viewport: sc.clientHeight });
}

/** Test and diagnostics hook: is a segment switch running in this container? */
export function segmentSwitching(container: HTMLElement | null): boolean {
  return !!container && running.has(container);
}

const idle = (fn: () => void): (() => void) => {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(fn);
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(fn, 200);
  return () => clearTimeout(id);
};

/**
 * Mount a screen's other segments ahead of their first visit: only once the screen's pane is on
 * screen (a screen warmed in the background mounts nothing more), one per idle period, and never
 * while a slide or a scroll runs (a segment's first render must not land inside one). Returns the
 * cleanup.
 */
export function warmSegments<K extends string>(el: Element | null, keys: K[], mount: (k: K) => void): () => void {
  const pane = el?.closest<HTMLElement>('.pane');
  let cancel = () => {};
  let off = () => {};
  let i = 0;
  const step = () => {
    cancel = idle(() => {
      if (slideRunning() || glassFrozen()) {
        step();
        return;
      }
      const k = keys[i++];
      if (!k) return;
      mount(k);
      step();
    });
  };
  const shown = () => !pane || ['active', 'in', 'ready'].includes(pane.dataset.state ?? '');
  if (shown()) step();
  else
    off = onSwitch((to) => {
      if (to === pane?.dataset.pane) {
        off();
        step();
      }
    });
  return () => {
    cancel();
    off();
  };
}
