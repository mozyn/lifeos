/**
 * Frame meter (UI brief 2 §2, UI brief 3): Settings → Advanced → Diagnostics → "Measure frames", and
 * `scripts/perf.mjs` runs the same thing headless. A scripted sequence drives the real controls the
 * way a finger would while every `requestAnimationFrame` delta is recorded:
 * - full (4 s): tab switches ×4, press-and-release ×4, theme flip ×2, Today ↔ Calendar ×2;
 * - tabs (3 s, "Tabs only"): 8 tab switches, each a tap (pointerdown, 60 ms, pointerup, click),
 *   375 ms apart, through every tab and back to Today.
 *
 * - display rate: from the smallest stable delta (the median of the deltas within 12 % of the
 *   10th percentile), snapped to a common panel rate when within 3 %;
 * - "over 1 interval": a delta past 1.5 intervals (at least one refresh missed); "over 2
 *   intervals": past 2.5 intervals (two or more missed). The half interval absorbs timer jitter.
 * - the glass quality in effect (UI brief 4), and the tab slides as this device showed them: how
 *   many frames each slide was on screen mid-way (from the slide animation's own clock), its length
 *   and its travel, so a slide that only ran in a test, or ran inside one long frame, shows here.
 */
import { summarize } from './frame-stats';
import { currentSlide, SLIDE_MS } from './panes';
import { patchPrefs, readPrefs } from './prefs';

export { summarize };

export interface FrameReport {
  at: string;
  hz: number;
  intervalMs: number;
  frames: number;
  durationMs: number;
  avgFps: number;
  p95Ms: number;
  maxMs: number;
  over1: number;
  over2: number;
  viewport: string;
  glass: string;
  /** full | balanced | light (UI brief 4) */
  quality?: string;
  motion: string;
  steps: number;
  hidden: boolean;
  mode?: FrameMode;
  /** the tab slides seen: how many, the fewest and most frames one was on screen mid-way, travel */
  slides?: { count: number; minFrames: number; maxFrames: number; ms: number; travelPx: number };
}

export type FrameMode = 'full' | 'tabs';

const KEY = 'lifeos.frames.last';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "8 tab slides, 13–15 frames each, 250 ms, 412 px" */
export function slidesText(s: NonNullable<FrameReport['slides']>): string {
  const frames = s.minFrames === s.maxFrames ? `${s.minFrames}` : `${s.minFrames}–${s.maxFrames}`;
  return `${s.count} tab slide${s.count === 1 ? '' : 's'}, ${frames} frames each, ${s.ms} ms, ${s.travelPx ? `${s.travelPx} px` : 'fade only'}`;
}

export function reportText(r: FrameReport): string {
  return [
    `LifeOS frames ${r.at.slice(0, 16).replace('T', ' ')}${r.mode === 'tabs' ? ' (tabs only)' : ''}`,
    `${r.viewport}, glass ${r.glass}${r.quality ? `, quality ${cap(r.quality)}` : ''}, motion ${r.motion}`,
    `display ≈ ${r.hz} Hz (${r.intervalMs} ms)`,
    `${r.frames} frames in ${(r.durationMs / 1000).toFixed(1)} s, average ${r.avgFps} fps`,
    `p95 ${r.p95Ms} ms, max ${r.maxMs} ms`,
    `over 1 interval: ${r.over1}, over 2 intervals: ${r.over2}`,
    ...(r.slides ? [slidesText(r.slides)] : []),
    ...(r.hidden ? ['(the app was hidden during the run: numbers are not valid)'] : []),
  ].join('\n');
}

export function lastReport(): FrameReport | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as FrameReport) : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ the scripted sequence

const visible = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)].find((el) => el.offsetParent !== null || el.getClientRects().length > 0) ?? null;

function tab(name: string): HTMLElement | null {
  return visible(`[data-testid="tab-${name}"]`) ?? visible(`[data-testid="rail-${name}"]`);
}

function go(name: string): void {
  tab(name)?.click();
}

/** A finger on a control: pointerdown, held, pointerup (no click, so nothing navigates). */
function press(el: HTMLElement | null, holdMs: number): void {
  if (!el) return;
  const r = el.getBoundingClientRect();
  const init: PointerEventInit = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 41, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1 };
  el.dispatchEvent(new PointerEvent('pointerdown', init));
  setTimeout(() => el.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 })), holdMs);
}

function flipTheme(): void {
  visible('[data-testid="theme-toggle"]')?.click();
}

/** A finger tap on a tab: pointerdown (the pane is parked), 60 ms, pointerup and the click. */
function tapTab(name: string): void {
  const el = tab(name);
  if (!el) return;
  const r = el.getBoundingClientRect();
  const init: PointerEventInit = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 41, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1 };
  el.dispatchEvent(new PointerEvent('pointerdown', init));
  setTimeout(() => {
    el.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
    el.click();
  }, 60);
}

/** [ms from start, step] — about 4 s in all. */
const SEQUENCE: [number, () => void][] = [
  [0, () => go('calendar')],
  [250, () => go('goals')],
  [500, () => go('habits')],
  [750, () => go('lists')],
  [1000, () => go('today')],
  [1300, () => press(tab('today'), 110)],
  [1500, () => press(tab('calendar'), 110)],
  [1700, () => press(tab('today'), 110)],
  [1900, () => press(visible('[data-testid="settings-button"]'), 110)],
  [2150, () => flipTheme()],
  [2700, () => flipTheme()],
  [3250, () => go('calendar')],
  [3450, () => go('today')],
  [3650, () => go('calendar')],
  [3850, () => go('today')],
];
const END_MS = 4100;

/** "Tabs only": 8 switches in 3 s, every tab and back to Today. */
const TABS_ORDER = ['calendar', 'goals', 'habits', 'lists', 'habits', 'goals', 'calendar', 'today'];
const TABS_SEQUENCE: [number, () => void][] = TABS_ORDER.map((name, i) => [i * 375, () => tapTab(name)]);
const TABS_END_MS = 3000;

let running: Promise<FrameReport> | null = null;

/** Run a sequence and record frames. Restores the appearance setting it found. */
export function measureFrames(mode: FrameMode = 'full'): Promise<FrameReport> {
  if (running) return running;
  const sequence = mode === 'tabs' ? TABS_SEQUENCE : SEQUENCE;
  const endMs = mode === 'tabs' ? TABS_END_MS : END_MS;
  running = new Promise<FrameReport>((resolve) => {
    const before = readPrefs().theme;
    const deltas: number[] = [];
    let hidden = document.visibilityState !== 'visible';
    const onVis = () => {
      if (document.visibilityState !== 'visible') hidden = true;
    };
    document.addEventListener('visibilitychange', onVis);
    // the user's fingers stay out of it while it runs
    const shield = document.createElement('div');
    shield.className = 'frame-shield';
    shield.setAttribute('aria-hidden', 'true');
    document.body.appendChild(shield);
    let start = 0;
    let last = 0;
    let done = false;
    // frames each slide was seen in mid-way, by slide number
    const seen = new Map<number, number>();
    let travel = 0;
    const tick = (t: number) => {
      if (done) return;
      if (last) deltas.push(t - last);
      else start = t;
      last = t;
      const sl = currentSlide();
      if (sl && sl.progress > 0 && sl.progress < 1) {
        seen.set(sl.id, (seen.get(sl.id) ?? 0) + 1);
        travel = Math.max(travel, sl.travel);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame((t0) => {
      last = t0;
      start = t0;
      requestAnimationFrame(tick);
      for (const [at, step] of sequence) setTimeout(step, at);
      setTimeout(() => {
        done = true;
        const end = last;
        document.removeEventListener('visibilitychange', onVis);
        shield.remove();
        if (readPrefs().theme !== before) patchPrefs({ theme: before });
        const counts = [...seen.values()];
        const report: FrameReport = {
          at: new Date().toISOString(),
          ...summarize(deltas, end - start),
          viewport: `${window.innerWidth}×${window.innerHeight} @${Math.round(window.devicePixelRatio * 100) / 100}x`,
          glass: document.documentElement.dataset.glass ?? 'liquid',
          quality: document.documentElement.dataset.glassQuality,
          slides: counts.length ? { count: counts.length, minFrames: Math.min(...counts), maxFrames: Math.max(...counts), ms: SLIDE_MS, travelPx: Math.round(travel) } : undefined,
          motion: document.documentElement.dataset.motion ?? (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'reduced (system)' : 'full'),
          steps: sequence.length,
          hidden,
          mode,
        };
        try {
          localStorage.setItem(KEY, JSON.stringify(report));
        } catch {
          /* storage full */
        }
        running = null;
        resolve(report);
      }, endMs);
    });
  });
  return running;
}

if (typeof window !== 'undefined') (window as unknown as { __lifeosFrames: object }).__lifeosFrames = { measure: measureFrames, summarize, modes: ['full', 'tabs'] };
