/**
 * Liquid Glass engine (ADR-19).
 *
 * Chromium (Brave, Edge, Chrome, Android Chrome) can feed an SVG filter to `backdrop-filter:
 * url(#id)`, so there the glass really refracts: an `feImage` displacement map drives three
 * `feDisplacementMap` passes, one per colour channel at slightly different strengths (chromatic
 * aberration), recombined with screen blends. Other engines, and the reduced levels, use CSS
 * blur + saturate + rim (glass.css).
 *
 * Each glass surface gets its own filter, because press and motion animate its strength. Maps are
 * rasterized only when the element's size changes (debounced), at one map pixel per CSS pixel, and
 * a rebuilt filter gets a fresh id that is swapped in only after its map has decoded, so nothing
 * ever renders against an empty map. Animation touches only the `scale` attributes (and transforms
 * in CSS), never the map.
 *
 * Glass quality (UI brief 4, ADR-40): every refracting surface re-filters its backdrop whenever
 * anything behind it moves, so the number of refracting surfaces and their passes is the cost.
 * - full: every surface refracts with three passes (the chromatic fringe), at rest and in motion.
 * - balanced (phones): only the bars refract at rest, with one pass; controls (chips, segmented
 *   controls, Quick Add) are frosted until a finger is on them, and the one being pressed, like a
 *   moving lens, refracts with three passes. Glass inside a pane draws no backdrop at rest (see
 *   glass.css). While a scroll or a theme reveal runs, the bars that float over the moving content
 *   cross-fade to their frosted twin and come back when it ends (glassMotion). A tab slide does not
 *   freeze them: 250 ms is too short to win back two 120 ms cross-fades (ADR-43).
 * - light (the frosted level): CSS blur and saturation only, no SVG filter at all.
 *
 * Materializing (UI brief 2 §2): the glass layer's blur, tint and rim are fixed per surface; it
 * eases in and out by its opacity (a Web Animation, run by the compositor) while the bend ramps
 * through the filter's `scale` attributes. Nothing in a frame changes `backdrop-filter` or a
 * custom property. A dormant layer at rest is `visibility: hidden`, so it costs nothing.
 */
import { defaultsFor, type GlassProfile, mapUrl, mapsGenerated } from './displacement';
import { motionReduced, onFrame, Spring, SPRINGS, springEasing } from './spring';

export type GlassEngine = 'svg' | 'css';
/** liquid: refraction (where supported); frosted: blur, more opaque; solid: opaque fills */
export type GlassLevel = 'liquid' | 'frosted' | 'solid';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function detectEngine(): GlassEngine {
  try {
    const forced = localStorage.getItem('lifeos.glassEngine');
    if (forced === 'svg' || forced === 'css') return forced;
  } catch {
    /* storage disabled */
  }
  const brands = (navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] } }).userAgentData?.brands;
  if (brands) return brands.some((b) => /Chromium/i.test(b.brand)) ? 'svg' : 'css';
  // insecure contexts hide userAgentData; iOS browsers are all WebKit
  const ua = navigator.userAgent;
  return /\bChrome\/\d+/.test(ua) && !/\b(CriOS|FxiOS|EdgiOS)\b/.test(ua) && 'chrome' in window ? 'svg' : 'css';
}

// ------------------------------------------------------------------ global state

/** full: three passes everywhere; balanced: the rules above (light is the frosted level) */
export type GlassQuality = 'full' | 'balanced';
/**
 * What a surface is, for the quality rules: a bar (tab bar, top-bar group, rail) refracts at rest;
 * a control (chip, segmented control, button) refracts while pressed; a panel (sheet, toast) is
 * frosted in balanced; a lens (dormant: the pill, a knob, a thumb) refracts whenever it shows.
 */
export type GlassKind = 'bar' | 'control' | 'panel' | 'lens';

const state = { engine: 'css' as GlassEngine, level: 'liquid' as GlassLevel, intensity: 0.7, quality: 'full' as GlassQuality };

/**
 * The rules of UI brief 4 that are on (1 fewer refracting roots, 2 one pass at rest, 3 map and
 * bend sizes, 4 motion freeze, 5 bar layers). All of them, unless the diagnostics override
 * `localStorage['lifeos.glassRules']` (e.g. "1,2") names fewer: the measuring tools switch them on
 * one at a time on one build, so each rule's effect is measured alone.
 */
export const RULES = new Set([1, 2, 3, 4, 5]);

function readRules(): void {
  try {
    const raw = localStorage.getItem('lifeos.glassRules');
    if (raw === null) return;
    RULES.clear();
    for (const n of raw.split(',').map(Number)) if (n >= 1 && n <= 5) RULES.add(n);
  } catch {
    /* storage disabled */
  }
}
const listeners = new Set<() => void>();
let builds = 0;
let liveFilters = 0;

export function glassState() {
  return { ...state, refracts: state.engine === 'svg' && state.level === 'liquid' };
}

export interface GlassPlan {
  /** the surface draws its SVG filter now */
  refract: boolean;
  /** displacement passes: 1 (one channel) or 3 (chromatic) */
  passes: 1 | 3;
  /** cross-fades to its frosted twin while something moves under it */
  freezes: boolean;
}

/**
 * The glass quality rules (UI brief 4 §1, §2, §4) for one surface. `active`: a finger is on it, or
 * its press is still easing out.
 */
export function glassPlan(o: { refracts: boolean; quality: GlassQuality; kind: GlassKind; active: boolean; rules?: ReadonlySet<number> }): GlassPlan {
  const rules = o.rules ?? RULES;
  if (!o.refracts) return { refract: false, passes: 1, freezes: false };
  if (o.quality === 'full' || o.kind === 'lens') return { refract: true, passes: 3, freezes: false };
  const passes = !rules.has(2) || o.active ? 3 : 1;
  const freezes = rules.has(4) && !o.active;
  if (o.kind === 'bar') return { refract: true, passes, freezes };
  // §1: controls are frosted until pressed, panels always (without the rule they refract as bars do)
  if (!rules.has(1)) return { refract: true, passes, freezes: false };
  if (o.kind === 'control') return { refract: o.active, passes: 3, freezes: false };
  return { refract: false, passes: 1, freezes: false };
}

// ------------------------------------------------------------------ motion: the bars freeze

/** After the last motion ends, the bars wait this long before they turn liquid again. */
export const THAW_MS = 60;
/** The cross-fade between a bar's liquid layer and its frosted twin (glass.css). */
export const FREEZE_FADE_MS = 120;

const motions = new Map<string, ReturnType<typeof setTimeout> | null>();
let frozen = false;
let thaw: ReturnType<typeof setTimeout> | undefined;
const freezeListeners = new Set<() => void>();

function setFrozen(f: boolean): void {
  if (f === frozen) return;
  frozen = f;
  for (const l of [...freezeListeners]) l();
}

/**
 * Something that moves under the bars starts (`on`) or ends: a scroll, a theme reveal. While any
 * runs, the bars that freeze show their frosted twin; THAW_MS after the last one ends they turn
 * liquid again. `maxMs`: end it by itself after that long (a motion whose end may never be heard).
 */
export function glassMotion(kind: string, on: boolean, maxMs?: number): void {
  const old = motions.get(kind);
  if (old) clearTimeout(old);
  if (on) {
    motions.set(kind, maxMs ? setTimeout(() => glassMotion(kind, false), maxMs) : null);
    clearTimeout(thaw);
    thaw = undefined;
    setFrozen(true);
    return;
  }
  if (!motions.delete(kind) || motions.size) return;
  clearTimeout(thaw);
  thaw = setTimeout(() => {
    thaw = undefined;
    if (!motions.size) setFrozen(false);
  }, THAW_MS);
}

/** Whether the bars are frozen now (motion running, or ended less than THAW_MS ago). */
export function glassFrozen(): boolean {
  return frozen;
}

export function configureGlass(next: Partial<typeof state>): void {
  const before = JSON.stringify(state);
  Object.assign(state, next);
  state.intensity = Math.min(1, Math.max(0, state.intensity));
  if (JSON.stringify(state) !== before) for (const l of [...listeners]) l();
}

export function subscribeGlass(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function initGlass(): void {
  state.engine = detectEngine();
  readRules();
  document.documentElement.dataset.glassEngine = state.engine;
  document.documentElement.dataset.glassRules = [...RULES].join(' ');
  // test and diagnostics hook: counts only, no content
  (window as unknown as { __lifeosGlass: object }).__lifeosGlass = {
    get engine() {
      return state.engine;
    },
    get level() {
      return state.level;
    },
    get mapsGenerated() {
      return mapsGenerated();
    },
    get filterBuilds() {
      return builds;
    },
    get liveFilters() {
      return liveFilters;
    },
    get quality() {
      return state.quality;
    },
    get frozen() {
      return frozen;
    },
    get motions() {
      return [...motions.keys()];
    },
    get rules() {
      return [...RULES];
    },
  };
}

// ------------------------------------------------------------------ SVG filter registry

let defs: SVGDefsElement | null = null;
let seq = 0;

function ensureDefs(): SVGDefsElement {
  if (defs?.isConnected) return defs;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.setAttribute('data-glass-defs', '');
  svg.style.cssText = 'position:fixed;width:0;height:0;overflow:hidden;pointer-events:none;left:0;top:0';
  defs = document.createElementNS(SVG_NS, 'defs');
  svg.appendChild(defs);
  document.body.appendChild(svg);
  return defs;
}

function node<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

const CHANNELS = [
  '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0',
  '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0',
  '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0',
];

interface FilterParts {
  id: string;
  el: SVGFilterElement;
  image: SVGFEImageElement;
  passes: SVGFEDisplacementMapElement[];
  /** the scale attributes last written ('' until the first write) */
  written: string;
}

/**
 * A filter over the element's own box (the bend only ever samples inward, so the region needs no
 * margin): one displacement pass, or three (one per channel, at slightly different strengths,
 * recombined with screen blends: the chromatic fringe).
 */
function createFilter(w: number, h: number, href: string, count: 1 | 3): FilterParts {
  const id = `lg-${++seq}`;
  const el = node('filter', {
    id, x: 0, y: 0, width: w, height: h, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB',
  });
  const image = node('feImage', { href, x: 0, y: 0, width: w, height: h, preserveAspectRatio: 'none', result: 'map' });
  el.appendChild(image);
  let passes: SVGFEDisplacementMapElement[];
  if (count === 1) {
    passes = [node('feDisplacementMap', { in: 'SourceGraphic', in2: 'map', scale: 0, xChannelSelector: 'R', yChannelSelector: 'G' })];
    el.appendChild(passes[0]);
  } else {
    passes = CHANNELS.map((values, i) => {
      const pass = node('feDisplacementMap', { in: 'SourceGraphic', in2: 'map', scale: 0, xChannelSelector: 'R', yChannelSelector: 'G', result: `d${i}` });
      el.appendChild(pass);
      el.appendChild(node('feColorMatrix', { in: `d${i}`, type: 'matrix', values, result: `c${i}` }));
      return pass;
    });
    el.appendChild(node('feBlend', { in: 'c0', in2: 'c1', mode: 'screen', result: 'c01' }));
    el.appendChild(node('feBlend', { in: 'c01', in2: 'c2', mode: 'screen' }));
  }
  ensureDefs().appendChild(el);
  builds++;
  liveFilters++;
  return { id, el, image, passes, written: '' };
}

function removeFilter(f: FilterParts): void {
  if (!f.el.isConnected) return;
  f.el.remove();
  liveFilters--;
}

function resizeFilter(f: FilterParts, w: number, h: number): void {
  f.el.setAttribute('width', String(w));
  f.el.setAttribute('height', String(h));
  f.image.setAttribute('width', String(w));
  f.image.setAttribute('height', String(h));
}

async function decoded(href: string): Promise<void> {
  const img = new Image();
  img.src = href;
  try {
    await img.decode();
  } catch {
    /* the filter still works once the image arrives */
  }
}

// ------------------------------------------------------------------ per-surface controller

export interface GlassOptions {
  profile?: GlassProfile;
  /** rim width in px (default from size) */
  bezel?: number;
  /** maximum bend in px at full intensity (default from size) */
  scale?: number;
  /** channel spread, 0..0.4 */
  chroma?: number;
  power?: number;
  /** ease the bend in when it first appears (glass materializes, it does not pop) */
  materialize?: boolean;
  /** start invisible (0) until `materialize(1)` is called, e.g. a lens that appears on press */
  dormant?: boolean;
  /** what the surface is, for the quality rules (default: a lens when dormant, else a control) */
  kind?: GlassKind;
  /** a bar over the moving content: it has a frosted twin (`.lg-frost`) and freezes during motion */
  freeze?: boolean;
}

const controllers = new WeakMap<Element, GlassController>();

let fadeEase: { easing: string; ms: number } | null = null;

/** The controller of the glass surface that contains `el` (used by press physics). */
export function controllerFor(el: Element | null): GlassController | undefined {
  for (let n: Element | null = el; n; n = n.parentElement) {
    const c = controllers.get(n);
    if (c) return c;
  }
  return undefined;
}

const half = (n: number) => (Math.round(n * 2) / 2).toFixed(1);

export class GlassController {
  /** the filters built for the current size: one pass, three, or both (balanced bars) */
  private filters: Partial<Record<1 | 3, FilterParts>> = {};
  private pending: FilterParts[] = [];
  /** the filter the backdrop references now (null: none, the surface is frosted) */
  private current: FilterParts | null = null;
  private size = { w: 0, h: 0 };
  private builtKey = '';
  private ro: ResizeObserver | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private mat: Spring;
  private boost = new Spring(1, SPRINGS.bouncy);
  /** how far the bend is in: 0 frosted, 1 refracting (a balanced control eases in under a finger) */
  private liq: Spring;
  /** the chromatic spread: 0 one pass, 1 three (a balanced bar eases it in under a finger) */
  private spread: Spring;
  private pressed = false;
  private extraChroma = 0;
  private stop: (() => void) | null = null;
  private unsubscribe: () => void;
  private unlisten: (() => void) | null = null;
  private destroyed = false;
  private kind: GlassKind;
  /** the opacity fade of the glass layer, and the opacity it is heading to */
  private fade: Animation | null = null;
  private shown = -1;
  /** a dormant surface (a press lens, a thumb) builds its filter on first use, not at mount: a
   * list of rows with a lens each would otherwise put a filter per row into the DOM */
  private wanted: boolean;
  /** when the surface mounted: glass that is ready at once appears at once (see fadeTo) */
  private born = performance.now();
  /** an intensity previewed on this surface alone (the sample in Settings), or null */
  private preview: number | null = null;

  constructor(
    private bg: HTMLElement,
    private host: HTMLElement,
    private opts: GlassOptions = {},
  ) {
    this.kind = opts.kind ?? (opts.dormant ? 'lens' : 'control');
    this.wanted = !opts.dormant;
    this.mat = new Spring(opts.dormant ? 0 : opts.materialize === false || motionReduced() ? 1 : 0, SPRINGS.smooth);
    this.mat.target = opts.dormant ? 0 : 1;
    const rest = this.rest();
    this.liq = new Spring(rest.liq, SPRINGS.smooth);
    this.spread = new Spring(rest.spread, SPRINGS.smooth);
    controllers.set(host, this);
    this.unsubscribe = subscribeGlass(() => this.sync());
    if (opts.freeze) {
      const f = () => this.applyFreeze();
      freezeListeners.add(f);
      this.unlisten = () => freezeListeners.delete(f);
    }
    this.showAt(this.mat.value);
    this.sync();
  }

  // -------------------------------------------------------------- the quality rules

  /** What the rules ask of this surface now. */
  private plan(): GlassPlan {
    const s = glassState();
    const easing = this.kind === 'control' && RULES.has(1) ? this.liq.value > 0.001 : this.kind !== 'lens' ? this.spread.value > 0.001 && RULES.has(2) : false;
    return glassPlan({ refracts: s.refracts, quality: s.quality, kind: this.kind, active: this.pressed || (s.quality === 'balanced' && easing) });
  }

  /** The bend and spread this surface rests at (or holds while pressed). */
  private rest(): { liq: number; spread: number } {
    const s = glassState();
    if (s.quality === 'full' || this.kind === 'lens') return { liq: 1, spread: 1 };
    const spread = this.pressed || !RULES.has(2) ? 1 : 0;
    if (this.kind === 'bar' || !RULES.has(1)) return { liq: 1, spread };
    if (this.kind === 'control') return { liq: this.pressed ? 1 : 0, spread: 1 };
    return { liq: 0, spread: 0 };
  }

  /** The filters this surface needs built (none: it is only ever frosted). */
  private needs(): (1 | 3)[] {
    const s = glassState();
    if (!s.refracts) return [];
    if (s.quality === 'full' || this.kind === 'lens') return [3];
    if (this.kind === 'panel' && RULES.has(1)) return [];
    if (!RULES.has(2)) return [3];
    // a bar rests on one pass and takes three under a finger; a control refracts only when pressed
    return this.kind === 'control' && RULES.has(1) ? [3] : [1, 3];
  }

  // -------------------------------------------------------------- the glass layer's opacity

  /** Set the glass layer's opacity now (no animation). */
  private showAt(v: number): void {
    this.fade?.cancel();
    this.fade = null;
    this.shown = v;
    this.bg.style.opacity = v >= 1 ? '' : String(v);
    this.bg.style.visibility = v <= 0 && this.opts.dormant ? 'hidden' : '';
  }

  /** Fade the glass layer to the materialize target on the compositor (spring-shaped easing). */
  private fadeTo(to: number): void {
    if (to === this.shown) return;
    // a surface whose map was ready within a few frames of mounting (cached maps, the CSS engine)
    // came in with its screen, which the screen's own transition fades: no second fade, so the
    // new view is not repainted in every frame of that transition
    const settling = !this.opts.dormant && this.shown <= 0 && to === 1 && performance.now() - this.born < 150;
    if (motionReduced() || settling) {
      this.showAt(to);
      return;
    }
    const bg = this.bg;
    const from = this.fade ? Number(getComputedStyle(bg).opacity) : this.shown < 0 ? 1 : this.shown;
    this.fade?.cancel();
    this.shown = to;
    bg.style.visibility = '';
    bg.style.opacity = to >= 1 ? '' : String(to);
    fadeEase ??= springEasing(SPRINGS.smooth);
    const a = bg.animate([{ opacity: from }, { opacity: to }], { duration: fadeEase.ms, easing: fadeEase.easing });
    this.fade = a;
    void a.finished
      .then(() => {
        if (this.fade !== a) return;
        this.fade = null;
        if (to <= 0 && this.opts.dormant) bg.style.visibility = 'hidden';
      })
      .catch(() => undefined);
  }

  // -------------------------------------------------------------- filters

  /** Attach or detach the refraction as the engine level and the quality change. */
  private sync(): void {
    if (this.destroyed) return;
    const on = this.needs().length > 0;
    if (on && !this.ro && this.wanted) {
      this.ro = new ResizeObserver((entries) => {
        const box = entries[0]?.borderBoxSize?.[0];
        const w = box ? box.inlineSize : this.bg.offsetWidth;
        const h = box ? box.blockSize : this.bg.offsetHeight;
        this.resized(w, h);
      });
      this.ro.observe(this.bg);
    } else if (!on && this.ro) {
      this.detach();
    } else if (on && this.ro && this.size.w) {
      // the quality changed: build the filters it needs now (no-op when they exist)
      void this.rebuild();
    }
    // the rest values of the new quality, at once (a setting changes, nothing animates)
    if (!this.stop && !this.pressed) {
      const r = this.rest();
      this.liq.snap(r.liq);
      this.spread.snap(r.spread);
    }
    this.reference();
    this.applyFreeze();
    // without a filter to wait for, blur and tint ease in straight away
    if (!on && (this.mat.value !== this.mat.target || this.shown !== this.mat.target)) this.animate();
  }

  private resized(w: number, h: number): void {
    if (w < 2 || h < 2) return;
    const first = !this.size.w;
    this.size = { w, h };
    for (const f of [...Object.values(this.filters), ...this.pending]) resizeFilter(f, w, h); // stretch the old map now, rebuild when it settles
    clearTimeout(this.timer);
    // the first map waits until the frame that shows the surface is painted: a new screen's first
    // frame is not also spent drawing maps (A5); the glass materializes once its map is ready
    if (first) requestAnimationFrame(() => (this.timer = setTimeout(() => void this.rebuild(), 0)));
    else this.timer = setTimeout(() => void this.rebuild(), 140);
  }

  private radius(): number {
    const cs = getComputedStyle(this.bg);
    const raw = cs.borderTopLeftRadius;
    const n = parseFloat(raw);
    const r = raw.endsWith('%') ? (n / 100) * Math.min(this.size.w, this.size.h) : n;
    return Math.min(Number.isFinite(r) ? r : 0, this.size.w / 2, this.size.h / 2);
  }

  private async rebuild(): Promise<void> {
    const { w, h } = this.size;
    const need = this.needs();
    if (!w || !h || this.destroyed || !need.length) return;
    const d = defaultsFor(w, h, RULES.has(3));
    const bezel = Math.min(this.opts.bezel ?? d.bezel, Math.min(w, h) / 2);
    const radius = this.radius();
    // one map pixel per CSS pixel: the map is smooth, so the GPU's filtering fills in between
    // (UI brief 4 §3: maps at twice the element cost 4x the pixels for no visible gain)
    const res = RULES.has(3) || w * h > 40_000 ? 1 : Math.min(2, Math.max(1, Math.round(window.devicePixelRatio || 1)));
    const spec = { width: w, height: h, radius, bezel, profile: this.opts.profile, power: this.opts.power, res };
    const key = `${w}x${h}:${radius}:${bezel}:${this.opts.profile ?? 'bezel'}:${res}:${need.join('+')}`;
    if (key === this.builtKey && need.every((n) => this.filters[n])) return;
    this.builtKey = key;
    const href = await mapUrl(spec);
    // a newer size (or the end of this glass) while the map was built: that rebuild wins
    if (!href || this.destroyed || this.builtKey !== key) return;
    for (const f of this.pending) removeFilter(f);
    const next = need.map((n) => createFilter(w, h, href, n));
    this.pending = next;
    await decoded(href);
    if (this.destroyed || this.pending !== next || !this.needs().length) {
      if (this.pending === next) this.pending = [];
      for (const f of next) removeFilter(f);
      return;
    }
    this.pending = [];
    const old = Object.values(this.filters);
    this.filters = {};
    for (const f of next) this.filters[f.passes.length as 1 | 3] = f;
    this.current = null;
    this.reference();
    if (old.length) requestAnimationFrame(() => requestAnimationFrame(() => old.forEach(removeFilter)));
    if (this.mat.value !== this.mat.target || this.shown !== this.mat.target) this.animate();
  }

  /** Point the backdrop at the filter the plan asks for (one pass or three), or at none. */
  private reference(): void {
    const p = this.plan();
    const f = p.refract ? (this.filters[p.passes] ?? this.filters[p.passes === 3 ? 1 : 3] ?? null) : null;
    if (f) this.write(f);
    if (f === this.current) return;
    this.current = f;
    if (f) {
      this.bg.style.setProperty('--lg-url', `url(#${f.id})`);
      this.host.dataset.liq = '';
    } else {
      this.bg.style.removeProperty('--lg-url');
      delete this.host.dataset.liq;
    }
  }

  /** A bar over moving content shows its frosted twin while the motion runs (glass.css). */
  private applyFreeze(): void {
    if (!this.opts.freeze || this.destroyed) return;
    const s = glassState();
    const on = glassFrozen() && s.refracts && s.quality === 'balanced' && this.plan().freezes;
    if (on === 'frozen' in this.host.dataset) return;
    if (on) this.host.dataset.frozen = '';
    else delete this.host.dataset.frozen;
  }

  /** Write the current strength into the referenced filter (the only per-frame write). */
  private apply(): void {
    if (this.current) this.write(this.current);
  }

  private write(f: FilterParts): void {
    const { w, h } = this.size;
    const s = glassState();
    const base = this.opts.scale ?? defaultsFor(w || 1, h || 1, RULES.has(3)).scale;
    const intensity = this.preview ?? s.intensity;
    // the bend is fixed while the layer fades in or out (its opacity carries the materialize):
    // only a press (boost, and the ease from frosted to liquid) and the motion fringe change it,
    // in half-pixel steps, and an unchanged value is never written again (each write repaints)
    const scale = base * (0.35 + 0.9 * intensity) * this.boost.value * Math.max(0, this.liq.value);
    const chroma = Math.min(0.6, (this.opts.chroma ?? 0.07) * (0.4 + 0.85 * intensity) * Math.max(0, this.spread.value) + this.extraChroma);
    const key = f.passes.length === 1 ? half(scale) : `${half(scale * (1 - chroma))} ${half(scale)} ${half(scale * (1 + chroma))}`;
    if (key === f.written) return;
    f.written = key;
    const vals = key.split(' ');
    f.passes.forEach((p, i) => p.setAttribute('scale', vals[i]));
  }

  private animate(): void {
    this.fadeTo(this.mat.target);
    if (this.stop) return;
    const springs = [this.boost, this.liq, this.spread];
    // the materialize itself is the opacity fade (compositor); only a press bends the glass over
    // time, so without one no frame loop runs (a loop asks the main thread for every frame)
    if (motionReduced() || springs.every((sp) => sp.settled(0.004) && sp.value === sp.target)) {
      this.mat.snap();
      for (const sp of springs) sp.snap();
      this.apply();
      this.reference();
      this.applyFreeze();
      return;
    }
    this.stop = onFrame((dt) => {
      this.mat.step(dt);
      for (const sp of springs) sp.step(dt);
      const done = this.mat.settled(0.004) && springs.every((sp) => sp.settled(0.004));
      if (done) {
        this.mat.snap();
        for (const sp of springs) sp.snap();
      }
      this.apply();
      if (done) {
        this.stop = null;
        // eased out: a control goes back to frosted, a bar back to one pass
        this.reference();
        this.applyFreeze();
      }
      return !done;
    });
  }

  /**
   * Build a dormant surface's filter now, while it stays invisible (the tab bar's lens is built in
   * idle time, so the first tap that raises it does no map or filter work).
   */
  prepare(): void {
    if (this.wanted || this.destroyed) return;
    this.wanted = true;
    this.sync();
  }

  /** Ease the glass in (1) or out (0). Resolves when it has settled. */
  materialize(to: 0 | 1): Promise<void> {
    this.mat.target = to;
    if (to === 1 && !this.wanted) {
      this.wanted = true;
      this.sync();
    }
    // with refraction, the first ramp starts once the map has decoded (rebuild)
    if (!this.needs().length || this.current) this.animate();
    const start = performance.now();
    return new Promise((resolve) => {
      const waiting = () => this.stop || (this.mat.value !== to && this.needs().length > 0 && !this.current && !this.destroyed);
      const done = () => (this.fade ? this.fade.finished.then(() => resolve(), () => resolve()) : resolve());
      const check = () => (waiting() && performance.now() - start < 900 ? requestAnimationFrame(check) : done());
      check();
    });
  }

  /**
   * Preview another intensity on this surface only, or end the preview (null). Dragging the
   * intensity slider previews on one sample instead of re-filtering every surface of the app at
   * every step (A5); the app follows once, on release.
   */
  previewIntensity(i: number | null): void {
    this.preview = i === null ? null : Math.min(1, Math.max(0, i));
    if (this.preview === null) this.bg.style.removeProperty('--glass-intensity');
    else this.bg.style.setProperty('--glass-intensity', String(this.preview));
    this.apply();
  }

  /**
   * A finger on the surface (press physics): the bend swells by `mult` and springs back with a
   * bounce on release. In balanced, a frosted control turns liquid under the finger and a bar takes
   * its three passes; both ease back afterwards.
   */
  press(on: boolean, mult = 1.35): void {
    if (this.destroyed) return;
    this.pressed = on;
    const r = this.rest();
    this.liq.config = on ? SPRINGS.snappy : SPRINGS.smooth;
    this.spread.config = on ? SPRINGS.snappy : SPRINGS.smooth;
    this.liq.target = r.liq;
    this.spread.target = r.spread;
    this.boost.config = on ? SPRINGS.snappy : SPRINGS.bouncy;
    this.boost.target = on ? mult : 1;
    if (on && !this.wanted) {
      this.wanted = true;
      this.sync();
    }
    this.reference();
    this.applyFreeze();
    this.animate();
  }

  /** Extra channel spread while moving (warm and cool fringes that follow velocity). */
  setMotionChroma(extra: number): void {
    // coarse steps: the fringe follows the speed without a repaint in every frame
    const next = Math.round(Math.min(0.15, Math.max(0, extra)) * 20) / 20;
    if (next === this.extraChroma) return;
    this.extraChroma = next;
    this.apply();
  }

  private detach(): void {
    this.fade?.cancel();
    this.fade = null;
    this.ro?.disconnect();
    this.ro = null;
    clearTimeout(this.timer);
    this.stop?.();
    this.stop = null;
    for (const f of [...Object.values(this.filters), ...this.pending]) removeFilter(f);
    this.filters = {};
    this.pending = [];
    this.current = null;
    this.builtKey = '';
    this.size = { w: 0, h: 0 };
    this.bg.style.removeProperty('--lg-url');
    delete this.host.dataset.liq;
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubscribe();
    this.unlisten?.();
    this.detach();
    delete this.host.dataset.frozen;
    controllers.delete(this.host);
  }
}
