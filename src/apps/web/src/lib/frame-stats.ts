/**
 * The frame meter's arithmetic (UI brief 2 §2), pure so it is unit-tested: display rate from the
 * smallest stable delta, average fps, p95, and frames over 1 and 2 display intervals (a missed
 * refresh is a delta past 1.5 intervals, two or more past 2.5: the half interval absorbs jitter).
 */
import type { FrameReport } from './frames';

const RATES = [48, 50, 60, 72, 75, 90, 96, 100, 120, 144, 165, 240];

export function summarize(deltas: number[], durationMs: number): Pick<FrameReport, 'hz' | 'intervalMs' | 'frames' | 'durationMs' | 'avgFps' | 'p95Ms' | 'maxMs' | 'over1' | 'over2'> {
  const s = [...deltas].sort((a, b) => a - b);
  const q = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0);
  const p10 = q(0.1);
  const stable = s.filter((d) => Math.abs(d - p10) <= p10 * 0.12);
  let interval = stable.length ? stable[Math.floor(stable.length / 2)] : p10;
  let hz = interval > 0 ? 1000 / interval : 0;
  const near = RATES.find((r) => Math.abs(r - hz) / r <= 0.03);
  if (near) {
    hz = near;
    interval = 1000 / near;
  }
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return {
    hz: Math.round(hz),
    intervalMs: r1(interval),
    frames: deltas.length,
    durationMs: Math.round(durationMs),
    avgFps: durationMs > 0 ? r1((deltas.length / durationMs) * 1000) : 0,
    p95Ms: r1(q(0.95)),
    maxMs: r1(s[s.length - 1] ?? 0),
    over1: deltas.filter((d) => d > interval * 1.5).length,
    over2: deltas.filter((d) => d > interval * 2.5).length,
  };
}
