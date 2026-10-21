import { type RefObject, useEffect } from 'react';
import { glassMotion } from '../glass/engine';
import type { PaneKey } from '../lib/panes';

/**
 * Scroll-driven chrome, written straight to data attributes (no re-render per scroll event):
 * - `data-scrolled` on the main column once content passes under the bars (scroll-edge effect,
 *   compact title on phones);
 * - `data-min` on the phone dock while scrolling down, cleared on the way back up, near the top,
 *   and on every switch. Only the user's own scrolling (touch, wheel, keys, and the fling that
 *   follows) minimizes it: a screen that scrolls itself into place (Week opens on today) does not.
 *
 * Each pane scrolls on its own (UI brief 3): its edge state is kept per pane and put back on the
 * main column when the pane is shown, without reading layout.
 *
 * A scroll of the visible pane by the user is motion under the bars: from its first event to its
 * `scrollend` (after the fling) the glass bars show their frosted twins (UI brief 4 §4).
 */
const flags = new Map<PaneKey, { scrolled: boolean; titled: boolean }>();

/** Show the scroll-edge state of pane `k` (a switch). */
export function scrollState(main: HTMLElement, k: PaneKey): void {
  const f = flags.get(k) ?? { scrolled: false, titled: false };
  if (f.scrolled) main.dataset.scrolled = '';
  else delete main.dataset.scrolled;
  if (f.titled) main.dataset.titled = '';
  else delete main.dataset.titled;
}

export function useScrollChrome(content: RefObject<HTMLElement | null>, main: RefObject<HTMLElement | null>, dock: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = content.current;
    if (!el) return;
    const last = new Map<Element, number>();
    let run = 0;
    let input = -Infinity;
    /** the pane the finger, wheel or keys were on (a scroll of another pane is not the user's) */
    let inputPane: Element | null = null;
    const touched = (e: Event) => {
      input = performance.now();
      inputPane = (e.target as Element | null)?.closest?.('.pane') ?? null;
    };
    let moving = false;
    let still: ReturnType<typeof setTimeout> | undefined;
    const stopped = () => {
      clearTimeout(still);
      if (!moving) return;
      moving = false;
      glassMotion('scroll', false);
    };
    // scrollend ends it; the timer is the backstop (a pane hidden mid-fling, an engine without scrollend)
    const idleMs = 'onscrollend' in window ? 400 : 120;
    // scroll does not bubble: one capturing listener hears every pane
    const onScroll = (e: Event) => {
      const pane = e.target as HTMLElement;
      if (!(pane instanceof HTMLElement) || !pane.classList.contains('pane')) return;
      const k = pane.dataset.pane as PaneKey;
      const y = pane.scrollTop;
      const dy = y - (last.get(pane) ?? y);
      last.set(pane, y);
      const f = { scrolled: y > 4, titled: y > 60 };
      flags.set(k, f);
      // a pane that is sliding out does not speak for the screen
      if (pane.dataset.state !== 'active' && pane.dataset.state !== 'in') return;
      // only the user's own scrolling moves content under the bars: a screen that puts itself in
      // place (Calendar opening on today) jumps in one frame, with nothing to freeze for
      const user = performance.now() - input <= 1500 && (!inputPane || inputPane === pane);
      if (!moving && user) {
        moving = true;
        glassMotion('scroll', true);
      }
      clearTimeout(still);
      still = setTimeout(stopped, idleMs);
      const m = main.current;
      if (m) {
        if (f.scrolled) m.dataset.scrolled = '';
        else delete m.dataset.scrolled;
        if (f.titled) m.dataset.titled = '';
        else delete m.dataset.titled;
      }
      const d = dock.current;
      if (!d) return;
      if (!user) return;
      if (y < 48) {
        run = 0;
        delete d.dataset.min;
        return;
      }
      run = Math.sign(dy) === Math.sign(run) ? run + dy : dy;
      if (run > 28) d.dataset.min = '';
      else if (run < -14) delete d.dataset.min;
    };
    // the end of the visible screen's scroll (a hidden pane putting itself in place is not it)
    const onEnd = (e: Event) => {
      const p = e.target as HTMLElement;
      if (p instanceof HTMLElement && p.classList.contains('pane') && p.dataset.state !== 'active' && p.dataset.state !== 'in') return;
      stopped();
    };
    el.addEventListener('scroll', onScroll, { passive: true, capture: true });
    el.addEventListener('scrollend', onEnd, { passive: true, capture: true });
    const inputs = ['touchstart', 'touchmove', 'wheel', 'pointerdown', 'keydown'] as const;
    for (const t of inputs) el.addEventListener(t, touched, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll, { capture: true });
      el.removeEventListener('scrollend', onEnd, { capture: true });
      stopped();
      for (const t of inputs) el.removeEventListener(t, touched);
    };
  }, [content, main, dock]);
}
