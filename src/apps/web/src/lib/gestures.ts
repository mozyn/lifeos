/**
 * Gesture tuning (round-3 brief §7): how far a row is swiped before its action commits, how long a
 * touch is held before its menu opens (and before a private habit is revealed), and how strong the
 * haptic tick is. Kept on this device only (localStorage `lifeos.gestures`), nothing on the server;
 * read when a gesture starts, so a change applies to the next touch without a reload. Settings →
 * Gestures edits it as choices (round-4 brief §3: Short / Medium / Long, Quick / Normal / Slow), with
 * a row to try it on.
 */
import { useSyncExternalStore } from 'react';

export type HapticStrength = 'off' | 'light' | 'medium' | 'strong';

export interface Gestures {
  /** px a row travels before its swipe action commits (a fast flick commits from 60 % of it) */
  swipePx: number;
  /** ms a touch is held before its menu opens */
  holdMs: number;
  haptic: HapticStrength;
}

export const GESTURE_DEFAULTS: Gestures = { swipePx: 56, holdMs: 450, haptic: 'light' };
/** The choices (round-4 brief §3): options, not numbers; the stored values stay pixels and ms. */
export const SWIPE_OPTIONS = { short: 40, medium: 56, long: 90 } as const;
export const HOLD_OPTIONS = { quick: 300, normal: 450, slow: 650 } as const;
export type SwipeChoice = keyof typeof SWIPE_OPTIONS;
export type HoldChoice = keyof typeof HOLD_OPTIONS;
/** a vibration's length: the Vibration API has no amplitude, so strength is duration */
export const HAPTIC_MS: Record<HapticStrength, number> = { off: 0, light: 12, medium: 22, strong: 40 };

const KEY = 'lifeos.gestures';
const listeners = new Set<() => void>();

/** The option nearest a number (round 3 stored any step of a slider); a tie goes to the default, the middle one. */
export function nearest(v: unknown, options: Record<string, number>, d: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return d;
  let best = d;
  for (const o of Object.values(options)) if (Math.abs(o - v) < Math.abs(best - v)) best = o;
  return best;
}

/** Which choice a stored value is (null: none, which parseGestures never returns). */
export function choiceOf<K extends string>(v: number, options: Record<K, number>): K | null {
  return (Object.keys(options) as K[]).find((k) => options[k] === v) ?? null;
}

/** What is stored, made safe: each number snapped to its nearest choice, a known strength, defaults for the rest. */
export function parseGestures(raw: string | null): Gestures {
  let o: Partial<Record<keyof Gestures, unknown>> = {};
  try {
    o = raw ? (JSON.parse(raw) as typeof o) : {};
  } catch {
    o = {};
  }
  if (!o || typeof o !== 'object') o = {};
  const haptic = typeof o.haptic === 'string' && o.haptic in HAPTIC_MS ? (o.haptic as HapticStrength) : GESTURE_DEFAULTS.haptic;
  return { swipePx: nearest(o.swipePx, SWIPE_OPTIONS, GESTURE_DEFAULTS.swipePx), holdMs: nearest(o.holdMs, HOLD_OPTIONS, GESTURE_DEFAULTS.holdMs), haptic };
}

/**
 * Read once at start: a value kept by round 3's sliders (any number) is written back as its nearest
 * choice, so the migration happens once and the stored keys stay the same.
 */
export function migrate(storage: Pick<Storage, 'getItem' | 'setItem'>): Gestures {
  const raw = storage.getItem(KEY);
  const g = parseGestures(raw);
  if (raw !== null && JSON.stringify(g) !== raw) storage.setItem(KEY, JSON.stringify(g));
  return g;
}

function read(): Gestures {
  try {
    return parseGestures(localStorage.getItem(KEY));
  } catch {
    return GESTURE_DEFAULTS;
  }
}

let current: Gestures = (() => {
  try {
    return typeof localStorage === 'undefined' ? GESTURE_DEFAULTS : migrate(localStorage);
  } catch {
    return GESTURE_DEFAULTS;
  }
})();

export function gestures(): Gestures {
  return current;
}

export function setGestures(patch: Partial<Gestures>): void {
  current = parseGestures(JSON.stringify({ ...current, ...patch }));
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* storage off: it holds for this session */
  }
  for (const l of [...listeners]) l();
}

export function resetGestures(): void {
  current = GESTURE_DEFAULTS;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing kept */
  }
  for (const l of [...listeners]) l();
}

export function useGestures(): Gestures {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      const onStorage = (e: StorageEvent) => {
        if (e.key === KEY) {
          current = read();
          cb();
        }
      };
      window.addEventListener('storage', onStorage);
      return () => {
        listeners.delete(cb);
        window.removeEventListener('storage', onStorage);
      };
    },
    () => current,
  );
}

/** The haptic tick at the chosen strength (nothing when it is off or the device has no vibration). */
export function haptic(strength: HapticStrength = current.haptic): void {
  const ms = HAPTIC_MS[strength];
  if (!ms) return;
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* not supported */
  }
}
