/**
 * The sliding lens pill (ADR-19) shared by segmented controls, tabs and the mobile tab bar.
 *
 * At rest the pill is a quiet capsule under the selected option. When the selection changes, or
 * while a finger is down, it turns into a lens: it rises above the labels, its rim refraction eases
 * in, it slides on a bouncy spring, swells while held and stretches with its speed. Press-and-drag
 * scrubs along the options with the lens glued to the finger, and releasing commits the option
 * under it. Reduced motion: the pill jumps, with no lens, stretch or bounce.
 *
 * A tap chooses on pointerup (round 8d, tap.ts): when the finger stayed within TAP_SLOP, the
 * option under it is committed through `onPick` and the click that follows does nothing, so a tap
 * whose click iOS keeps (it took the tap for a hover) still chooses instead of sliding the pill
 * back. Keyboard and screen-reader activation is the option's own click, as before.
 *
 * Every frame is a transform (UI brief 2 §2): the pill translates, swells and stretches by
 * `translate3d() scale()`, and its box width changes only when the option it heads for has another
 * width (never per frame; the tab bar's options are all one width). Its map bends only a narrow
 * rim, so the labels it passes over are sampled without colour fringes. The label under the lens
 * is magnified as text: it gets a CSS scale with a transition, which the browser rasterizes at the
 * final size.
 *
 * The motion runs on the compositor (UI brief 3): the springs are simulated ahead (120 steps a
 * second, time-based) into the keyframes of one Web Animation, and a new target (a finger lifted,
 * another tab) restarts it from where the springs are at that moment. Nothing runs per frame on
 * the main thread, so a tab switch never asks it for a frame. Only a finger scrubbing along the
 * options drives the pill frame by frame (it follows pointer events).
 */
import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react';
import { controllerFor } from './engine';
import { motionReduced, onFrame, Spring, SPRINGS } from './spring';
import { canTap, LONG_PRESS_MS, swallowClick, TAP_SLOP, withinSlop } from './tap';

export interface LensPillOptions {
  /** positioning context: the options' offsetParent, and where pointer scrubbing is listened for */
  track: RefObject<HTMLElement | null>;
  pill: RefObject<HTMLElement | null>;
  /** the options, in order (queried inside the track) */
  itemSelector: string;
  index: number;
  /**
   * Commit an option chosen by scrubbing or by a tap (on its pointerup; its click is then
   * swallowed): it must do what the option's own click does. Keys still go through the click.
   */
  onPick?: (index: number) => void;
  /** the pill reaches this far past the option on each side */
  pad?: number;
  /** balloon factor while held */
  pressScale?: number;
  /**
   * The warm and cool fringe that follows the pill's speed (writes the filter's `scale`). 'scrub':
   * only while a finger drags it; a tab switch then moves the pill by its transform alone (UI
   * brief 3 §3). Default 'always'.
   */
  motionFringe?: 'always' | 'scrub';
}

/** Move the selection without a render (the tab bar on a pane switch). */
export interface LensHandle {
  select(index: number): void;
}

interface Slot {
  x: number;
  w: number;
}

export function useLensPill(o: LensPillOptions): LensHandle {
  const opts = useRef(o);
  opts.current = o;
  const s = useRef({
    /** the selected option (the prop, or the last select()) */
    index: o.index,
    x: new Spring(0, SPRINGS.bouncy),
    w: new Spring(0, SPRINGS.bouncy),
    p: new Spring(1, SPRINGS.bouncy),
    ready: false,
    pressed: false,
    scrubbing: false,
    lens: false,
    downX: 0,
    downY: 0,
    downAt: 0,
    pointer: -1,
    /** the enabled option a finger went down on while it can still be a tap, else -1 */
    tap: -1,
    stop: null as null | (() => void),
    geo: null as null | { el: HTMLElement; x: number; w: number; off: boolean }[],
    /** the pill's box width: set when the target width changes, so a frame only moves a transform */
    boxW: 0,
    /** the option magnified under the lens */
    lensed: null as HTMLElement | null,
    /** the compositor run: its animation, the springs' state at each step, the label timers */
    sim: null as null | { anim: Animation; states: number[]; stepMs: number; timers: ReturnType<typeof setTimeout>[] },
  }).current;

  const items = () => [...(opts.current.track.current?.querySelectorAll<HTMLElement>(opts.current.itemSelector) ?? [])];
  // the options' geometry, read once and kept until something resizes: a frame never reads layout
  const geom = () => (s.geo ??= items().map((el) => ({ el, x: el.offsetLeft, w: el.offsetWidth, off: el.matches(':disabled, [aria-disabled="true"]') })));
  const slot = (i: number): Slot | null => {
    const g = geom()[i];
    if (!g) return null;
    const pad = opts.current.pad ?? 0;
    return { x: g.x - pad, w: g.w + pad * 2 };
  };
  const indexAt = (localX: number): number => {
    let best = -1;
    let dist = Infinity;
    geom().forEach((g, i) => {
      if (g.off) return;
      const d = localX >= g.x && localX <= g.x + g.w ? 0 : Math.abs(localX - (g.x + g.w / 2));
      if (d < dist) {
        dist = d;
        best = i;
      }
    });
    return best;
  };

  /** The pill's transform for a state: translate, swell (p) and stretch (sx, sy); origin left centre. */
  const transformFor = (x: number, w: number, p: number, sx: number, sy: number) => {
    const W = w * sx * p;
    const kx = s.boxW ? W / s.boxW : 1;
    return `translate3d(${(x + (w - W) / 2).toFixed(2)}px,0,0) scale(${kx.toFixed(4)},${(sy * p).toFixed(4)})`;
  };
  const stretch = (vx: number, vw: number): [number, number] => {
    const speed = Math.abs(vx) + Math.abs(vw) * 0.5;
    return [1 + Math.min(0.28, speed / 3200), 1 - Math.min(0.14, speed / 6400)];
  };
  const ensureBox = (pill: HTMLElement) => {
    const target = Math.round(s.w.target * 2) / 2;
    if (target > 0 && target !== s.boxW) {
      s.boxW = target;
      pill.style.width = `${s.boxW}px`;
    }
  };
  /** Place the pill where the springs are now (inline transform). */
  const write = (sx = 1, sy = 1) => {
    const pill = opts.current.pill.current;
    if (!pill) return;
    ensureBox(pill);
    pill.style.transform = transformFor(s.x.value, s.w.value, s.p.value, sx, sy);
    markUnder();
  };

  /** The option under the lens's centre gets data-lensed while the lens is up (its label magnifies). */
  const setLensed = (el: HTMLElement | null) => {
    if (el === s.lensed) return;
    if (s.lensed) delete s.lensed.dataset.lensed;
    s.lensed = el;
    if (el) el.dataset.lensed = '';
  };
  const markUnder = () => setLensed(s.lens ? (geom()[indexAt(s.x.value + s.w.value / 2)]?.el ?? null) : null);

  /** End the compositor run where it is now: the springs take its state, the pill keeps its place. */
  const stopSim = () => {
    const sim = s.sim;
    if (!sim) return;
    s.sim = null;
    for (const t of sim.timers) clearTimeout(t);
    const steps = sim.states.length / 6;
    const k = Math.min(steps - 1, Math.max(0, Math.floor(Number(sim.anim.currentTime ?? 0) / sim.stepMs)));
    const o = k * 6;
    [s.x.value, s.x.velocity, s.w.value, s.w.velocity, s.p.value, s.p.velocity] = sim.states.slice(o, o + 6);
    write(...stretch(s.x.velocity, s.w.velocity));
    sim.anim.cancel();
  };

  /** Simulate the springs to rest and play the path as one Web Animation (compositor). */
  const simulate = () => {
    const pill = opts.current.pill.current;
    if (!pill) return;
    stopSim();
    ensureBox(pill);
    const STEP = 1 / 120;
    const copy = (a: Spring) => {
      const c = new Spring(a.value, a.config);
      c.velocity = a.velocity;
      c.target = a.target;
      return c;
    };
    const x = copy(s.x);
    const w = copy(s.w);
    const p = copy(s.p);
    const frames: Keyframe[] = [];
    const states: number[] = [];
    const marks: { t: number; el: HTMLElement | null }[] = [];
    let last: HTMLElement | null | undefined;
    for (let k = 0; k <= 240; k++) {
      if (k) {
        x.step(STEP);
        w.step(STEP);
        p.step(STEP);
      }
      const rest = k > 0 && x.settled(0.25) && w.settled(0.25) && p.settled(0.002);
      if (rest) {
        x.snap();
        w.snap();
        p.snap();
      }
      frames.push({ transform: transformFor(x.value, w.value, p.value, ...stretch(x.velocity, w.velocity)) });
      states.push(x.value, x.velocity, w.value, w.velocity, p.value, p.velocity);
      const el = s.lens ? (geom()[indexAt(x.value + w.value / 2)]?.el ?? null) : null;
      if (el !== last) {
        marks.push({ t: k * STEP * 1000, el });
        last = el;
      }
      if (rest) break;
    }
    const stepMs = STEP * 1000;
    const done = () => {
      s.x.snap(x.value);
      s.w.snap(w.value);
      s.p.snap(p.value);
      write();
      if (!s.pressed) lensOff();
    };
    if (frames.length < 2) {
      done();
      return;
    }
    const anim = pill.animate(frames, { duration: (frames.length - 1) * stepMs, easing: 'linear', fill: 'forwards' });
    const sim = { anim, states, stepMs, timers: marks.map((m) => setTimeout(() => setLensed(m.el), m.t)) };
    s.sim = sim;
    void anim.finished.then(
      () => {
        if (s.sim !== sim) return;
        s.sim = null;
        done();
        anim.cancel();
      },
      () => undefined,
    );
  };

  const lensOn = () => {
    const pill = opts.current.pill.current;
    if (!pill || s.lens || motionReduced()) return;
    s.lens = true;
    pill.dataset.lens = 'on';
    void controllerFor(pill)?.materialize(1);
  };
  const lensOff = () => {
    const pill = opts.current.pill.current;
    if (!pill || !s.lens) return;
    s.lens = false;
    markUnder();
    // the resting capsule fades back in while the glass fades away; the pill stays above the
    // labels until the glass is gone
    pill.dataset.lens = 'off';
    const c = controllerFor(pill);
    c?.setMotionChroma(0);
    void (c ? c.materialize(0) : Promise.resolve()).then(() => {
      if (!s.lens) delete pill.dataset.lens;
    });
  };

  const run = () => {
    if (motionReduced()) {
      stopSim();
      s.stop?.();
      s.stop = null;
      s.x.snap();
      s.w.snap();
      s.p.snap();
      write();
      return;
    }
    if (!s.scrubbing) {
      // free motion (a tap, a release, a new selection): on the compositor
      s.stop?.();
      s.stop = null;
      simulate();
      return;
    }
    // a finger drags the lens: it follows pointer events, frame by frame
    if (s.stop) return;
    stopSim();
    s.stop = onFrame((dt) => {
      s.x.step(dt);
      s.w.step(dt);
      s.p.step(dt);
      const speed = Math.abs(s.x.velocity) + Math.abs(s.w.velocity) * 0.5;
      write(1 + Math.min(0.28, speed / 3200), 1 - Math.min(0.14, speed / 6400));
      const pill = opts.current.pill.current;
      if (pill && s.lens && (opts.current.motionFringe !== 'scrub' || s.scrubbing)) controllerFor(pill)?.setMotionChroma(speed / 6000);
      const done = s.x.settled(0.25) && s.w.settled(0.25) && s.p.settled(0.002);
      if (done && !s.pressed) {
        s.x.snap();
        s.w.snap();
        s.p.snap();
        write();
        lensOff();
        s.stop = null;
        return false;
      }
      return true;
    });
  };

  const settleOn = (i: number, animate: boolean) => {
    const target = slot(i);
    const pill = opts.current.pill.current;
    if (!pill) return;
    pill.hidden = !target;
    if (!target) return;
    s.x.target = target.x;
    s.w.target = target.w;
    if (!animate || !s.ready) {
      stopSim();
      s.x.snap();
      s.w.snap();
      write();
      s.ready = true;
      return;
    }
    s.x.config = SPRINGS.bouncy;
    s.w.config = SPRINGS.bouncy;
    lensOn();
    run();
  };

  // selection changed (click, keyboard, route): slide there (options may have re-rendered)
  useLayoutEffect(() => {
    if (o.index === s.index && s.ready) return;
    s.index = o.index;
    s.geo = null;
    if (s.scrubbing) return;
    settleOn(o.index, true);
  }, [o.index]); // eslint-disable-line react-hooks/exhaustive-deps

  // layout changed (fonts, resize, labels): follow without animation
  useEffect(() => {
    const track = o.track.current;
    if (!track) return;
    const ro = new ResizeObserver(() => {
      s.geo = null;
      if (!s.stop && !s.pressed) settleOn(s.index, false);
    });
    ro.observe(track);
    for (const el of items()) ro.observe(el);
    return () => ro.disconnect();
  }, [o.track]); // eslint-disable-line react-hooks/exhaustive-deps

  // press, balloon, scrub and tap
  useEffect(() => {
    const track = o.track.current;
    if (!track) return;
    const local = (clientX: number) => clientX - track.getBoundingClientRect().left + track.scrollLeft;
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== s.pointer) return;
      if (!withinSlop(s.downX, s.downY, e.clientX, e.clientY)) s.tap = -1;
      // reduced motion: no pill under the finger, so no scrub (only taps)
      if (!s.pressed) return;
      if (!s.scrubbing && Math.abs(e.clientX - s.downX) > TAP_SLOP) s.scrubbing = true;
      if (!s.scrubbing) return;
      const x = local(e.clientX);
      const i = indexAt(x);
      const w = i >= 0 ? (slot(i)?.w ?? s.w.target) : s.w.target;
      const max = Math.max(0, track.scrollWidth - w);
      s.x.config = SPRINGS.glued;
      s.w.config = SPRINGS.snappy;
      s.w.target = w;
      s.x.target = Math.min(max, Math.max(0, x - w / 2));
      run();
    };
    const finish = (e: PointerEvent, up: boolean) => {
      if (e.pointerId !== s.pointer) return;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      s.pointer = -1;
      // a tap: the finger came up within the slop, or a short press that did not move was
      // cancelled by the browser (a cancel's position says nothing: WebKit sends 0, 0)
      const tap = s.tap >= 0 && !s.scrubbing && (up ? withinSlop(s.downX, s.downY, e.clientX, e.clientY) : performance.now() - s.downAt <= LONG_PRESS_MS) ? s.tap : -1;
      s.tap = -1;
      if (s.pressed) {
        s.pressed = false;
        s.p.config = SPRINGS.bouncy;
        s.p.target = 1;
        s.x.config = SPRINGS.bouncy;
        s.w.config = SPRINGS.bouncy;
        if (s.scrubbing) {
          s.scrubbing = false;
          const i = indexAt(s.x.target + s.w.target / 2);
          swallowClick();
          if (up && i >= 0 && i !== s.index) opts.current.onPick?.(i);
          const back = slot(up && i >= 0 ? i : s.index);
          if (back) {
            s.x.target = back.x;
            s.w.target = back.w;
          }
        }
        run();
        // a press that did not change the selection (or was cancelled) returns the pill home
        setTimeout(() => {
          if (s.pressed || s.scrubbing) return;
          const home = slot(s.index);
          if (home && (home.x !== s.x.target || home.w !== s.w.target)) {
            s.x.target = home.x;
            s.w.target = home.w;
            run();
          }
        }, 80);
      }
      // the tap chooses now, not on a click that may never come; its click then does nothing
      if (tap >= 0) {
        swallowClick();
        opts.current.onPick?.(tap);
      }
    };
    const onUp = (e: PointerEvent) => finish(e, true);
    const onCancel = (e: PointerEvent) => finish(e, false);
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || !e.isPrimary) return;
      // the option under the finger, when it can be chosen (a disabled one has no click either)
      const els = items();
      const hit = els.findIndex((el) => el.contains(e.target as Node));
      const tap = hit >= 0 && canTap(e) && opts.current.onPick && !els[hit].matches(':disabled, [aria-disabled="true"]') ? hit : -1;
      const i = motionReduced() ? -1 : indexAt(local(e.clientX));
      if (i < 0 && tap < 0) return;
      s.pointer = e.pointerId;
      s.downX = e.clientX;
      s.downY = e.clientY;
      s.downAt = performance.now();
      s.tap = tap;
      s.scrubbing = false;
      if (i >= 0) {
        s.pressed = true;
        const target = slot(i);
        if (target) {
          s.x.target = target.x;
          s.w.target = target.w;
        }
        s.p.config = SPRINGS.snappy;
        s.p.target = opts.current.pressScale ?? 1.12;
        lensOn();
        run();
      }
      window.addEventListener('pointermove', onMove, { passive: true });
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
    };
    track.addEventListener('pointerdown', onDown);
    return () => {
      track.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      s.stop?.();
      s.stop = null;
      stopSim();
    };
  }, [o.track]); // eslint-disable-line react-hooks/exhaustive-deps

  // geometry stays cached (the observer above drops it on a resize): a select reads no layout
  return useRef<LensHandle>({
    select(i: number) {
      if (i === s.index) return;
      s.index = i;
      if (s.scrubbing) return;
      settleOn(i, true);
    },
  }).current;
}
