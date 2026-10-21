/**
 * Device-local preferences (spec §4 Settings → Appearance), adapted from Work OS lib/prefs.tsx:
 * light/dark/system, colour theme, glass quality, reduce motion, text size, mute rewards. Kept in
 * localStorage so the theme applies before first paint. Never synced: appearance belongs to the
 * device.
 */
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { configureGlass, type GlassLevel, initGlass } from '../glass/engine';
import { installPressPhysics } from '../glass/press';
import { installSpringEasings } from '../glass/spring';
import { applyTheme, type ThemeId, themeById } from './themes';

/**
 * Glass quality (UI brief 4, Settings → Appearance): full (three passes everywhere), balanced (the
 * bars refract, controls when pressed, one pass at rest, frosted while things move), light (CSS
 * frosting only: what "Reduce glass effects" did). 'auto': balanced on a phone, full elsewhere.
 */
export type GlassQuality = 'full' | 'balanced' | 'light';

export interface Prefs {
  theme: 'system' | 'light' | 'dark';
  themeName: ThemeId;
  glass: boolean;
  glassQuality: GlassQuality | 'auto';
  glassIntensity: number;
  motion: 'system' | 'reduced' | 'full';
  reducedTransparency: boolean;
  textScale: number;
  muteRewards: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  theme: 'system',
  themeName: 'aurora',
  glass: true,
  glassQuality: 'auto',
  glassIntensity: 0.7,
  motion: 'system',
  reducedTransparency: false,
  textScale: 1,
  muteRewards: false,
};

const KEY = 'lifeos.prefs';

export function readPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PREFS;
    const stored = JSON.parse(raw) as Partial<Prefs> & { reduceGlass?: boolean };
    const { reduceGlass, ...rest } = stored;
    // before UI brief 4 the only choice was "Reduce glass effects": on is Light now
    return { ...DEFAULT_PREFS, ...rest, glassQuality: rest.glassQuality ?? (reduceGlass ? 'light' : 'auto') };
  } catch {
    return DEFAULT_PREFS;
  }
}

const mq = (q: string) => window.matchMedia?.(q).matches ?? false;

/** A phone: a coarse pointer, or a narrow viewport (UI brief 4 §2). */
export function phoneLike(match: (q: string) => boolean = mq): boolean {
  return match('(pointer: coarse)') || match('(max-width: 699px)');
}

/** The glass quality in effect: the setting, the device's default for 'auto', and Light when the system asks for reduced transparency. */
export function glassQuality(p: Pick<Prefs, 'glassQuality'>, match: (q: string) => boolean = mq): GlassQuality {
  if (match('(prefers-reduced-transparency: reduce)')) return 'light';
  if (p.glassQuality === 'auto') return phoneLike(match) ? 'balanced' : 'full';
  return p.glassQuality;
}

/** Glass level (Work OS ADR-19): solid, frosted or liquid, from the settings and the system's accessibility preferences. */
export function glassLevel(p: Pick<Prefs, 'glass' | 'reducedTransparency' | 'glassQuality'>, match: (q: string) => boolean = mq): GlassLevel {
  if (!p.glass || p.reducedTransparency || match('(prefers-contrast: more)')) return 'solid';
  if (glassQuality(p, match) === 'light') return 'frosted';
  return 'liquid';
}

export function resolveTheme(p: Pick<Prefs, 'theme'>): 'light' | 'dark' {
  if (p.theme !== 'system') return p.theme;
  return mq('(prefers-color-scheme: dark)') ? 'dark' : 'light';
}

export function motionIsReduced(p: Pick<Prefs, 'motion'>): boolean {
  return p.motion === 'reduced' || (p.motion === 'system' && mq('(prefers-reduced-motion: reduce)'));
}

export function applyAppearance(p: Prefs): void {
  const root = document.documentElement;
  const theme = resolveTheme(p);
  root.dataset.theme = theme;
  applyTheme(p.themeName, theme, true, root);
  const level = glassLevel(p);
  const quality = glassQuality(p);
  const intensity = Math.min(1, Math.max(0, p.glassIntensity));
  root.dataset.glass = level;
  root.dataset.glassQuality = quality;
  root.style.setProperty('--glass-intensity', String(intensity));
  configureGlass({ level, intensity, quality: quality === 'balanced' ? 'balanced' : 'full' });
  if (p.motion === 'system') delete root.dataset.motion;
  else root.dataset.motion = p.motion;
  root.style.setProperty('--text-scale', String(Math.min(1.3, Math.max(0.9, p.textScale))));
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute('content', themeById(p.themeName)[theme].bg);
}

/** Before the first render: glass engine, press physics, spring easings, theme. */
export function bootAppearance(): void {
  initGlass();
  installSpringEasings();
  installPressPhysics();
  applyAppearance(readPrefs());
}

interface PrefsCtx {
  prefs: Prefs;
  setPrefs: (patch: Partial<Prefs>) => void;
  theme: 'light' | 'dark';
  reducedMotion: boolean;
}

const Ctx = createContext<PrefsCtx | null>(null);

let external: ((patch: Partial<Prefs>) => void) | null = null;

/** Change a preference from outside React (the frame meter restores what it found). */
export function patchPrefs(patch: Partial<Prefs>): void {
  external?.(patch);
}

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, setState] = useState<Prefs>(readPrefs);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const qs = ['(prefers-color-scheme: dark)', '(prefers-reduced-motion: reduce)', '(prefers-contrast: more)', '(prefers-reduced-transparency: reduce)', '(pointer: coarse)', '(max-width: 699px)'].map((q) => window.matchMedia?.(q));
    const on = () => setTick((n) => n + 1);
    for (const m of qs) m?.addEventListener('change', on);
    return () => {
      for (const m of qs) m?.removeEventListener('change', on);
    };
  }, []);

  useEffect(() => {
    applyAppearance(prefs);
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {
      /* storage full or disabled */
    }
  }, [prefs, tick]);

  const setPrefs = useCallback((patch: Partial<Prefs>) => setState((cur) => ({ ...cur, ...patch })), []);
  useEffect(() => {
    external = setPrefs;
    return () => {
      external = null;
    };
  }, [setPrefs]);
  const value = useMemo<PrefsCtx>(() => ({ prefs, setPrefs, theme: resolveTheme(prefs), reducedMotion: motionIsReduced(prefs) }), [prefs, setPrefs, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePrefs(): PrefsCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('usePrefs outside PrefsProvider');
  return ctx;
}
