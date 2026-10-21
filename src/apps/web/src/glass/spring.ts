/**
 * Spring physics for interactive glass (ADR-19): a damped harmonic oscillator integrated with
 * fixed substeps, a shared rAF loop, and CSS `linear()` easings sampled from the same springs, so
 * CSS transitions (press release, bar minimize, popover morph) and JS-driven motion (lens pill,
 * thumbs) share one feel. Reduced motion skips straight to the target.
 */
export interface SpringConfig {
  stiffness: number;
  damping: number;
  mass?: number;
}

/** Damping ratios: bouncy ~0.65 (about 7 % overshoot, settles in ~0.32 s), smooth ~0.95, jelly ~0.45, toggle ~0.72 (0.18 s). */
export const SPRINGS = {
  bouncy: { stiffness: 380, damping: 25 },
  smooth: { stiffness: 260, damping: 31 },
  snappy: { stiffness: 620, damping: 44 },
  jelly: { stiffness: 240, damping: 14 },
  glued: { stiffness: 1400, damping: 75 },
  /** a switch's knob (round-4 brief §1): settles in 180 ms with under 2 % overshoot */
  toggle: { stiffness: 3000, damping: 79 },
} satisfies Record<string, SpringConfig>;

const STEP = 1 / 240;

export class Spring {
  value: number;
  velocity = 0;
  target: number;
  constructor(
    value: number,
    public config: SpringConfig = SPRINGS.bouncy,
  ) {
    this.value = value;
    this.target = value;
  }

  /** Advance by `dt` seconds (clamped, so a background tab cannot explode the integration). */
  step(dt: number): void {
    const { stiffness: k, damping: c, mass: m = 1 } = this.config;
    const total = Math.min(Math.max(dt, 0), 0.064);
    const n = Math.max(1, Math.ceil(total / STEP));
    const h = total / n;
    for (let i = 0; i < n; i++) {
      const force = -k * (this.value - this.target) - c * this.velocity;
      this.velocity += (force / m) * h;
      this.value += this.velocity * h;
    }
  }

  settled(eps = 0.01): boolean {
    return Math.abs(this.velocity) < eps * 10 && Math.abs(this.value - this.target) < eps;
  }

  snap(to = this.target): void {
    this.value = to;
    this.target = to;
    this.velocity = 0;
  }
}

/** Unit step response of a spring: samples of x(t) from 0 to 1 until it settles. */
export function stepResponse(config: SpringConfig, fps = 120, maxSeconds = 2): { samples: number[]; duration: number } {
  const s = new Spring(0, config);
  s.target = 1;
  const samples = [0];
  const dt = 1 / fps;
  let t = 0;
  let calm = 0;
  while (t < maxSeconds) {
    s.step(dt);
    t += dt;
    samples.push(s.value);
    calm = Math.abs(s.value - 1) < 0.002 && Math.abs(s.velocity) < 0.02 ? calm + 1 : 0;
    if (calm >= 3) break;
  }
  samples[samples.length - 1] = 1;
  return { samples, duration: t };
}

/** A CSS `linear()` easing that follows the spring, plus its natural duration in ms. */
export function springEasing(config: SpringConfig, points = 36): { easing: string; ms: number } {
  const { samples, duration } = stepResponse(config);
  const out: string[] = [];
  for (let i = 0; i <= points; i++) {
    const v = samples[Math.round((i / points) * (samples.length - 1))];
    out.push(String(Math.round(v * 1000) / 1000));
  }
  return { easing: `linear(${out.join(', ')})`, ms: Math.round(duration * 1000) };
}

// ------------------------------------------------------------------ shared frame loop

type Tick = (dt: number, now: number) => boolean;
const ticks = new Set<Tick>();
let raf = 0;
let last = 0;

function frame(now: number) {
  const dt = last ? (now - last) / 1000 : 1 / 60;
  last = now;
  for (const t of [...ticks]) if (!t(dt, now)) ticks.delete(t);
  raf = ticks.size ? requestAnimationFrame(frame) : 0;
  if (!raf) last = 0;
}

/** Run `tick` every frame until it returns false. Returns a cancel function. */
export function onFrame(tick: Tick): () => void {
  ticks.add(tick);
  if (!raf) raf = requestAnimationFrame(frame);
  return () => ticks.delete(tick);
}

/** Reduced motion: the app setting wins over the system preference (§12.3). */
export function motionReduced(): boolean {
  const pref = document.documentElement.dataset.motion;
  if (pref === 'reduced') return true;
  if (pref === 'full') return false;
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/** Publish the springs as CSS custom properties (`--spring-bouncy`, `--spring-bouncy-ms`, ...). */
export function installSpringEasings(root: HTMLElement = document.documentElement): void {
  for (const [name, cfg] of Object.entries(SPRINGS)) {
    const { easing, ms } = springEasing(cfg);
    root.style.setProperty(`--spring-${name}`, easing);
    root.style.setProperty(`--spring-${name}-ms`, `${ms}ms`);
  }
}
