/**
 * Themes (UI refresh, ADR-19). Each theme is a full token set for light and dark: a mesh background
 * that gives the glass something to bend, surfaces, text, accent and glass tweaks. Applied as CSS
 * custom properties on <html>; tokens.css holds the Default values as the pre-script fallback.
 * Every theme is checked for WCAG AA contrast in themes.test.ts (text on surfaces, on the mesh and
 * on glass; accent text; labels on accent fills and on tinted glass; status colours).
 */
export type ThemeId = 'default' | 'aurora' | 'sunset' | 'ocean' | 'synthwave' | 'forest' | 'paper';
export type Mode = 'light' | 'dark';

export interface Blob {
  /** centre, in % of the window */
  x: number;
  y: number;
  /** radii, in % of the window */
  rx: number;
  ry: number;
  color: string;
}

export interface ThemeTokens {
  bg: string;
  mesh: Blob[];
  surface: string;
  surface2: string;
  sunken: string;
  text: string;
  text2: string;
  text3: string;
  accent: string;
  accentFill: string;
  ok: string;
  warn: string;
  crit: string;
  /** glass: rim brightness and sheen (0..1), for themes that should glare less */
  rim?: number;
  sheen?: number;
}

export interface Theme {
  id: ThemeId;
  name: string;
  blurb: string;
  light: ThemeTokens;
  dark: ThemeTokens;
}

const LIGHT_STATUS = { ok: '#136c35', warn: '#8a5200', crit: '#b8251a' };
const DARK_STATUS = { ok: '#4cd483', warn: '#ffbe45', crit: '#ff6b60' };

export const THEMES: Theme[] = [
  {
    id: 'default',
    name: 'Default',
    blurb: 'Cool neutrals with a soft sky wash',
    light: {
      bg: '#eef1f6',
      mesh: [
        { x: 6, y: 0, rx: 55, ry: 50, color: 'rgba(122, 166, 255, 0.42)' },
        { x: 96, y: 4, rx: 48, ry: 44, color: 'rgba(255, 168, 206, 0.30)' },
        { x: 72, y: 100, rx: 60, ry: 52, color: 'rgba(116, 212, 255, 0.32)' },
        { x: 0, y: 96, rx: 44, ry: 40, color: 'rgba(192, 168, 255, 0.30)' },
      ],
      surface: '#ffffff',
      surface2: '#f7f8fa',
      sunken: '#eceef2',
      text: '#15161a',
      text2: '#454a54',
      text3: '#646a75',
      accent: '#0b5fd9',
      accentFill: '#0a5fe0',
      ...LIGHT_STATUS,
    },
    dark: {
      bg: '#0c0d11',
      mesh: [
        { x: 6, y: 0, rx: 55, ry: 50, color: 'rgba(52, 92, 200, 0.40)' },
        { x: 96, y: 6, rx: 48, ry: 44, color: 'rgba(132, 60, 176, 0.30)' },
        { x: 72, y: 100, rx: 60, ry: 52, color: 'rgba(18, 122, 150, 0.30)' },
        { x: 0, y: 96, rx: 44, ry: 40, color: 'rgba(76, 52, 160, 0.30)' },
      ],
      surface: '#1b1c21',
      surface2: '#222329',
      sunken: '#16171b',
      text: '#eceef2',
      text2: '#b6bac3',
      text3: '#8f949e',
      accent: '#64a9ff',
      accentFill: '#1d64d8',
      ...DARK_STATUS,
    },
  },
  {
    id: 'aurora',
    name: 'Aurora',
    blurb: 'Teal light over violet',
    light: {
      bg: '#ecf6f5',
      mesh: [
        { x: 4, y: 2, rx: 58, ry: 52, color: 'rgba(45, 212, 191, 0.42)' },
        { x: 98, y: 0, rx: 52, ry: 48, color: 'rgba(139, 92, 246, 0.32)' },
        { x: 10, y: 100, rx: 50, ry: 46, color: 'rgba(110, 231, 183, 0.34)' },
        { x: 92, y: 98, rx: 56, ry: 50, color: 'rgba(167, 139, 250, 0.32)' },
      ],
      surface: '#ffffff',
      surface2: '#f5fafa',
      sunken: '#e7f0f0',
      text: '#0e1a1c',
      text2: '#3d4d50',
      text3: '#5a6a6d',
      accent: '#6d28d9',
      accentFill: '#6d28d9',
      ...LIGHT_STATUS,
    },
    dark: {
      bg: '#051315',
      mesh: [
        { x: 4, y: 2, rx: 58, ry: 52, color: 'rgba(20, 184, 166, 0.34)' },
        { x: 98, y: 0, rx: 52, ry: 48, color: 'rgba(124, 58, 237, 0.36)' },
        { x: 10, y: 100, rx: 50, ry: 46, color: 'rgba(8, 145, 178, 0.28)' },
        { x: 92, y: 98, rx: 56, ry: 50, color: 'rgba(91, 33, 182, 0.34)' },
      ],
      surface: '#111b1d',
      surface2: '#162225',
      sunken: '#0c1517',
      text: '#e8f3f2',
      text2: '#b1c3c2',
      text3: '#88999a',
      accent: '#b39dfb',
      accentFill: '#6d28d9',
      ...DARK_STATUS,
    },
  },
  {
    id: 'sunset',
    name: 'Sunset',
    blurb: 'Coral and amber, warm and bright',
    light: {
      bg: '#fff2ea',
      mesh: [
        { x: 2, y: 0, rx: 56, ry: 50, color: 'rgba(255, 122, 89, 0.38)' },
        { x: 98, y: 4, rx: 52, ry: 48, color: 'rgba(255, 183, 77, 0.42)' },
        { x: 90, y: 100, rx: 56, ry: 50, color: 'rgba(255, 95, 143, 0.28)' },
        { x: 6, y: 98, rx: 50, ry: 46, color: 'rgba(255, 204, 160, 0.42)' },
      ],
      surface: '#fffdfb',
      surface2: '#fff6f0',
      sunken: '#f6e9e1',
      text: '#22130e',
      text2: '#573d35',
      text3: '#76594f',
      accent: '#b5175a',
      accentFill: '#b5175a',
      ...LIGHT_STATUS,
    },
    dark: {
      bg: '#160b09',
      mesh: [
        { x: 2, y: 0, rx: 56, ry: 50, color: 'rgba(255, 99, 72, 0.30)' },
        { x: 98, y: 4, rx: 52, ry: 48, color: 'rgba(245, 158, 11, 0.24)' },
        { x: 90, y: 100, rx: 56, ry: 50, color: 'rgba(219, 39, 119, 0.28)' },
        { x: 6, y: 98, rx: 50, ry: 46, color: 'rgba(194, 65, 12, 0.26)' },
      ],
      surface: '#1f1513',
      surface2: '#271b18',
      sunken: '#180f0d',
      text: '#fbeee9',
      text2: '#d6bfb7',
      text3: '#aa928b',
      accent: '#fb86a6',
      accentFill: '#be185d',
      ...DARK_STATUS,
    },
  },
  {
    id: 'ocean',
    name: 'Ocean',
    blurb: 'Deep blue and cyan',
    light: {
      bg: '#ebf4fb',
      mesh: [
        { x: 4, y: 0, rx: 56, ry: 50, color: 'rgba(37, 99, 235, 0.30)' },
        { x: 98, y: 2, rx: 52, ry: 48, color: 'rgba(34, 211, 238, 0.36)' },
        { x: 70, y: 100, rx: 60, ry: 52, color: 'rgba(56, 189, 248, 0.30)' },
        { x: 0, y: 96, rx: 46, ry: 42, color: 'rgba(79, 70, 229, 0.22)' },
      ],
      surface: '#ffffff',
      surface2: '#f5f9fc',
      sunken: '#e6eef5',
      text: '#0a1626',
      text2: '#39485c',
      text3: '#58687b',
      accent: '#0b5cad',
      accentFill: '#0a63bd',
      ...LIGHT_STATUS,
    },
    dark: {
      bg: '#020f1b',
      mesh: [
        { x: 4, y: 0, rx: 56, ry: 50, color: 'rgba(29, 78, 216, 0.36)' },
        { x: 98, y: 2, rx: 52, ry: 48, color: 'rgba(6, 182, 212, 0.26)' },
        { x: 70, y: 100, rx: 60, ry: 52, color: 'rgba(14, 116, 144, 0.32)' },
        { x: 0, y: 96, rx: 46, ry: 42, color: 'rgba(30, 64, 175, 0.32)' },
      ],
      surface: '#0e1a26',
      surface2: '#132231',
      sunken: '#09131d',
      text: '#e5f0fa',
      text2: '#a8bed0',
      text3: '#7e95a9',
      accent: '#45c1f9',
      accentFill: '#0369a1',
      ...DARK_STATUS,
    },
  },
  {
    id: 'synthwave',
    name: 'Synthwave',
    blurb: 'Neon magenta and cyan; best in dark',
    light: {
      bg: '#f6eeff',
      mesh: [
        { x: 2, y: 0, rx: 56, ry: 50, color: 'rgba(255, 113, 206, 0.36)' },
        { x: 98, y: 0, rx: 52, ry: 48, color: 'rgba(1, 205, 254, 0.32)' },
        { x: 8, y: 100, rx: 54, ry: 48, color: 'rgba(185, 103, 255, 0.32)' },
        { x: 94, y: 100, rx: 50, ry: 46, color: 'rgba(255, 184, 108, 0.24)' },
      ],
      surface: '#ffffff',
      surface2: '#fbf7ff',
      sunken: '#efe6fa',
      text: '#1c0a32',
      text2: '#4c3866',
      text3: '#6a5883',
      accent: '#9d1aa9',
      accentFill: '#9d1aa9',
      ...LIGHT_STATUS,
    },
    dark: {
      bg: '#0b041d',
      mesh: [
        { x: 2, y: 0, rx: 56, ry: 50, color: 'rgba(255, 43, 214, 0.32)' },
        { x: 98, y: 0, rx: 52, ry: 48, color: 'rgba(0, 229, 255, 0.24)' },
        { x: 8, y: 100, rx: 54, ry: 48, color: 'rgba(123, 47, 247, 0.38)' },
        { x: 94, y: 100, rx: 50, ry: 46, color: 'rgba(255, 0, 128, 0.22)' },
      ],
      surface: '#160a2c',
      surface2: '#1d0f37',
      sunken: '#110722',
      text: '#f7ebff',
      text2: '#cfbae8',
      text3: '#a48fc0',
      accent: '#ff5fdc',
      accentFill: '#b0179f',
      ...DARK_STATUS,
      rim: 1,
      sheen: 0.9,
    },
  },
  {
    id: 'forest',
    name: 'Forest',
    blurb: 'Moss, fern and sage',
    light: {
      bg: '#edf2e8',
      mesh: [
        { x: 2, y: 0, rx: 56, ry: 50, color: 'rgba(132, 169, 73, 0.36)' },
        { x: 98, y: 4, rx: 52, ry: 48, color: 'rgba(52, 168, 83, 0.26)' },
        { x: 92, y: 100, rx: 56, ry: 50, color: 'rgba(163, 190, 140, 0.40)' },
        { x: 4, y: 98, rx: 50, ry: 46, color: 'rgba(34, 139, 94, 0.22)' },
      ],
      surface: '#fdfefb',
      surface2: '#f5f8f1',
      sunken: '#e8eee2',
      text: '#131f13',
      text2: '#3c4b3b',
      text3: '#596957',
      accent: '#3f6212',
      accentFill: '#456c11',
      ...LIGHT_STATUS,
    },
    dark: {
      bg: '#0a110b',
      mesh: [
        { x: 2, y: 0, rx: 56, ry: 50, color: 'rgba(77, 124, 15, 0.32)' },
        { x: 98, y: 4, rx: 52, ry: 48, color: 'rgba(21, 128, 61, 0.28)' },
        { x: 92, y: 100, rx: 56, ry: 50, color: 'rgba(101, 163, 13, 0.20)' },
        { x: 4, y: 98, rx: 50, ry: 46, color: 'rgba(20, 83, 45, 0.36)' },
      ],
      surface: '#141c15',
      surface2: '#1a241b',
      sunken: '#0f1610',
      text: '#ecf3e8',
      text2: '#b7c5b2',
      text3: '#8b9a87',
      accent: '#a3e635',
      accentFill: '#456c11',
      ...DARK_STATUS,
    },
  },
  {
    id: 'paper',
    name: 'Paper',
    blurb: 'Warm sepia, low glare',
    light: {
      bg: '#f0e8d8',
      mesh: [
        { x: 2, y: 0, rx: 60, ry: 52, color: 'rgba(214, 180, 130, 0.24)' },
        { x: 98, y: 6, rx: 54, ry: 48, color: 'rgba(232, 214, 176, 0.36)' },
        { x: 90, y: 100, rx: 58, ry: 50, color: 'rgba(196, 160, 110, 0.20)' },
      ],
      surface: '#fbf6ec',
      surface2: '#f6efe2',
      sunken: '#ebe2d1',
      text: '#33291d',
      text2: '#594a38',
      text3: '#72624d',
      accent: '#874912',
      accentFill: '#874912',
      ok: '#2f6b2c',
      warn: '#865000',
      crit: '#a8261b',
      rim: 0.45,
      sheen: 0.35,
    },
    dark: {
      bg: '#19150e',
      mesh: [
        { x: 2, y: 0, rx: 60, ry: 52, color: 'rgba(120, 90, 50, 0.20)' },
        { x: 98, y: 6, rx: 54, ry: 48, color: 'rgba(90, 70, 40, 0.24)' },
      ],
      surface: '#231e16',
      surface2: '#2a241b',
      sunken: '#1d1912',
      text: '#eee3cf',
      text2: '#cab99d',
      text3: '#a39177',
      accent: '#e2a660',
      accentFill: '#94561a',
      ...DARK_STATUS,
      rim: 0.4,
      sheen: 0.3,
    },
  },
];

export function themeById(id: string | undefined): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

// ------------------------------------------------------------------ colour maths (sRGB, WCAG 2.x)

export type RGBA = [number, number, number, number];

export function parseColor(c: string): RGBA {
  const s = c.trim();
  if (s.startsWith('#')) {
    const h = s.slice(1);
    const full = h.length === 3 ? [...h].map((x) => x + x).join('') : h;
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16), 1];
  }
  const m = /rgba?\(([^)]+)\)/.exec(s);
  if (!m) throw new Error(`unsupported colour ${c}`);
  const p = m[1].split(',').map((x) => Number(x.trim()));
  return [p[0], p[1], p[2], p[3] ?? 1];
}

/** `top` composited over an opaque `bottom`. */
export function over(top: string | RGBA, bottom: string | RGBA): RGBA {
  const t = typeof top === 'string' ? parseColor(top) : top;
  const b = typeof bottom === 'string' ? parseColor(bottom) : bottom;
  const a = t[3];
  return [t[0] * a + b[0] * (1 - a), t[1] * a + b[1] * (1 - a), t[2] * a + b[2] * (1 - a), 1];
}

export function withAlpha(c: string, alpha: number): RGBA {
  const p = parseColor(c);
  return [p[0], p[1], p[2], alpha];
}

export function luminance(c: string | RGBA): number {
  const [r, g, b] = (typeof c === 'string' ? parseColor(c) : c).map((v, i) => {
    if (i === 3) return 0;
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string | RGBA, b: string | RGBA): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * The mesh exactly as CSS paints it at a point (u, v in 0..1 of the window): each blob is an
 * ellipse fading linearly (premultiplied) from its colour at the centre to transparent at its edge,
 * the first blob on top. Percent geometry makes this independent of the window's aspect ratio.
 */
export function meshAt(t: ThemeTokens, u: number, v: number): RGBA {
  let out = parseColor(t.bg);
  for (const b of [...t.mesh].reverse()) {
    const d = Math.hypot((u * 100 - b.x) / b.rx, (v * 100 - b.y) / b.ry);
    if (d >= 1) continue;
    const c = parseColor(b.color);
    out = over([c[0], c[1], c[2], c[3] * (1 - d)], out);
  }
  return out;
}

/** The mesh sampled on a 41 x 41 grid: every colour text on the background can land on. */
export function meshStops(t: ThemeTokens, n = 41): RGBA[] {
  const stops: RGBA[] = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) stops.push(meshAt(t, i / (n - 1), j / (n - 1)));
  return stops;
}

/** Captions on the page background (not on cards or glass): a blend towards text-2, as CSS color-mix does. */
export const CAPTION_ON_BG = 0.62;
export function captionOnBg(t: ThemeTokens): RGBA {
  const a = parseColor(t.text2);
  const b = parseColor(t.text3);
  return [0, 1, 2].map((i) => a[i] * CAPTION_ON_BG + b[i] * (1 - CAPTION_ON_BG)).concat(1) as RGBA;
}

// ------------------------------------------------------------------ CSS

export function meshCss(t: ThemeTokens): string {
  const blobs = t.mesh.map((b) => `radial-gradient(ellipse ${b.rx}% ${b.ry}% at ${b.x}% ${b.y}%, ${b.color}, transparent)`);
  return [...blobs, t.bg].join(', ');
}

const mix = (a: string, pct: number) => `color-mix(in srgb, ${a} ${pct}%, transparent)`;

/** The custom properties a theme sets on <html>. Accent ones are left out when the user picked an accent override. */
export function themeVars(t: ThemeTokens, mode: Mode, withAccent: boolean): Record<string, string> {
  const ink = mode === 'dark' ? '255, 255, 255' : '20, 24, 33';
  const vars: Record<string, string> = {
    '--bg': t.bg,
    '--bg-content': t.bg,
    '--app-mesh': meshCss(t),
    '--surface': t.surface,
    '--surface-2': t.surface2,
    '--surface-sunken': t.sunken,
    '--text': t.text,
    '--text-2': t.text2,
    '--text-3': t.text3,
    '--text-3-surface': t.text3,
    '--text-3-bg': `color-mix(in srgb, ${t.text2} ${Math.round(CAPTION_ON_BG * 100)}%, ${t.text3})`,
    '--hairline': `rgba(${ink}, ${mode === 'dark' ? 0.08 : 0.09})`,
    '--hairline-strong': `rgba(${ink}, ${mode === 'dark' ? 0.15 : 0.16})`,
    '--hover': `rgba(${ink}, ${mode === 'dark' ? 0.06 : 0.045})`,
    '--press': `rgba(${ink}, ${mode === 'dark' ? 0.1 : 0.08})`,
    '--selection': `rgba(${ink}, ${mode === 'dark' ? 0.09 : 0.075})`,
    '--ok': t.ok,
    '--warn': t.warn,
    '--crit': t.crit,
    '--solid-chrome': t.surface2,
    '--solid-sidebar': t.sunken,
    '--solid-pop': t.surface,
    '--lg-rim-hi': `rgba(255, 255, 255, ${((mode === 'dark' ? 0.5 : 0.95) * (t.rim ?? 1)).toFixed(3)})`,
    '--lg-sheen': `rgba(255, 255, 255, ${((mode === 'dark' ? 0.14 : 0.5) * (t.sheen ?? 1)).toFixed(3)})`,
  };
  if (withAccent) {
    vars['--accent'] = t.accent;
    vars['--accent-fill'] = t.accentFill;
    vars['--accent-soft'] = mix(t.accentFill, mode === 'dark' ? 22 : 11);
    vars['--accent-ring'] = mix(t.accent, mode === 'dark' ? 45 : 35);
  }
  return vars;
}

const APPLIED = new Set<string>();

export function applyTheme(id: ThemeId, mode: Mode, withAccent: boolean, root: HTMLElement = document.documentElement): void {
  const theme = themeById(id);
  const vars = themeVars(theme[mode], mode, withAccent);
  for (const k of APPLIED) if (!(k in vars)) root.style.removeProperty(k);
  APPLIED.clear();
  for (const [k, v] of Object.entries(vars)) {
    root.style.setProperty(k, v);
    APPLIED.add(k);
  }
  root.dataset.themeName = theme.id;
}
