/**
 * Liquid Glass displacement maps (ADR-19).
 *
 * A rounded-rectangle signed distance field becomes an RGBA vector field for SVG
 * `feDisplacementMap`: R carries x, G carries y, and 128 means "no bend". The flat centre stays
 * neutral. The bezel bends light inward with a `(1 - t)^power` falloff, so content near the rim is
 * drawn from further in: the convex-glass look, with a compressed, mirrored band at the very edge.
 *
 * Profiles add a radial term:
 * - `bezel`: rim only. Bars, buttons and panels.
 * - `lens`: also magnifies the middle. The selection pill and pressed thumbs.
 * - `lip`: also minifies the middle (convex rim, concave centre). The switch knob.
 *
 * `buildMap` is pure and synchronous, so it is unit-tested in Node. `mapUrl` builds the same map a
 * few rows at a time, giving the main thread back between slices, encodes it with canvas.toBlob
 * (not the blocking toDataURL) and keeps a small cache, because most controls share a handful of
 * sizes: a page opened from cold never spends a long task on its glass (pm-analytics brief A5).
 */
export type GlassProfile = 'bezel' | 'lens' | 'lip';

export interface MapSpec {
  /** element size in CSS px */
  width: number;
  height: number;
  /** corner radius in CSS px (clamped to half the short side) */
  radius: number;
  /** rim width in CSS px */
  bezel: number;
  profile?: GlassProfile;
  /** falloff exponent of the rim (higher = narrower bend band) */
  power?: number;
  /** map pixels per CSS px */
  res?: number;
}

export interface GlassMap {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

const PROFILES: Record<GlassProfile, { rim: number; lens: number }> = {
  bezel: { rim: 1, lens: 0 },
  lens: { rim: 0.38, lens: 0.5 },
  lip: { rim: 0.85, lens: -0.28 },
};

export function mapKey(s: MapSpec): string {
  const q = (n: number) => Math.round(n * 2) / 2;
  return [q(s.width), q(s.height), q(s.radius), q(s.bezel), s.profile ?? 'bezel', s.power ?? 2.2, s.res ?? 1].join(':');
}

export function buildMap(spec: MapSpec): GlassMap {
  const m = startMap(spec);
  m.rows(0, m.map.height);
  return m.map;
}

/** buildMap a few rows at a time, the main thread given back whenever a slice took `budgetMs`. */
export async function buildMapSliced(spec: MapSpec, budgetMs = 4): Promise<GlassMap> {
  const m = startMap(spec);
  const step = Math.max(1, Math.floor(4096 / m.map.width));
  let t = performance.now();
  for (let j = 0; j < m.map.height; j += step) {
    m.rows(j, j + step);
    if (performance.now() - t >= budgetMs) {
      await new Promise<void>((r) => setTimeout(r, 0));
      t = performance.now();
    }
  }
  return m.map;
}

/** The map, and the function that fills its rows. */
function startMap(spec: MapSpec): { map: GlassMap; rows: (j0: number, j1: number) => void } {
  const res = spec.res ?? 1;
  const width = Math.max(1, Math.round(spec.width * res));
  const height = Math.max(1, Math.round(spec.height * res));
  const a = spec.width / 2;
  const b = spec.height / 2;
  const r = Math.min(Math.max(0, spec.radius), a, b);
  const bezel = Math.max(0.5, spec.bezel);
  const power = spec.power ?? 2.2;
  const { rim, lens } = PROFILES[spec.profile ?? 'bezel'];
  const reach = Math.max(a, b);
  const data = new Uint8ClampedArray(width * height * 4);

  // rows [j0, j1) of the map
  const rows = (j0: number, j1: number) => {
    for (let j = j0; j < Math.min(j1, height); j++) {
      const py = (j + 0.5) / res - b;
      const qy = Math.abs(py) - (b - r);
      for (let i = 0; i < width; i++) {
        const px = (i + 0.5) / res - a;
        const qx = Math.abs(px) - (a - r);
        // signed distance to the rounded rectangle, negative inside
        const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
        // outward normal: the corner circle's radius vector, or the nearest straight edge
        let nx = 0;
        let ny = 0;
        if (qx > 0 && qy > 0) {
          const l = Math.hypot(qx, qy);
          nx = ((px < 0 ? -1 : 1) * qx) / l;
          ny = ((py < 0 ? -1 : 1) * qy) / l;
        } else if (qx > qy) nx = px < 0 ? -1 : 1;
        else ny = py < 0 ? -1 : 1;
        const d = Math.max(0, -sd);
        const t = d < bezel ? Math.pow(1 - d / bezel, power) : 0;
        // inward along the rim, plus the profile's radial term (towards the centre magnifies)
        const vx = Math.max(-1, Math.min(1, -nx * rim * t - (px / reach) * lens));
        const vy = Math.max(-1, Math.min(1, -ny * rim * t - (py / reach) * lens));
        const k = (j * width + i) * 4;
        data[k] = Math.round(128 + 127 * vx);
        data[k + 1] = Math.round(128 + 127 * vy);
        data[k + 2] = 128;
        data[k + 3] = 255;
      }
    }
  };
  return { map: { width, height, data }, rows };
}

/**
 * Sensible rim width and bend for a size: the bigger the element, the thicker it reads. Large
 * surfaces bend less per pixel: a sheet or the rail is read by its rim, and the backdrop a filter
 * reads reaches half the bend past its edge (UI brief 4 §3; `lean` false: the bends before it).
 */
export function defaultsFor(width: number, height: number, lean = true): { bezel: number; scale: number } {
  const short = Math.max(1, Math.min(width, height));
  const bezel = Math.min(26, Math.max(8, short * 0.3));
  const area = width * height;
  const big = lean ? (area > 160_000 ? 0.45 : area > 40_000 ? 0.6 : 1) : area > 160_000 ? 0.7 : 1;
  return { bezel, scale: Math.round(Math.min(64, Math.max(22, bezel * 2.6)) * big) };
}

const cache = new Map<string, string>();
const building = new Map<string, Promise<string>>();
const CACHE_MAX = 48;
let generated = 0;

/** A map as a PNG data URL (cached by size, radius, bezel and profile; one build per size at a time). Browser only. */
export function mapUrl(spec: MapSpec): Promise<string> {
  const key = mapKey(spec);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return Promise.resolve(hit);
  }
  const pending = building.get(key);
  if (pending) return pending;
  const job = encode(spec)
    .then((url) => {
      if (url) {
        generated++;
        cache.set(key, url);
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
      }
      return url;
    })
    .finally(() => building.delete(key));
  building.set(key, job);
  return job;
}

async function encode(spec: MapSpec): Promise<string> {
  const map = await buildMapSliced(spec);
  const canvas = document.createElement('canvas');
  canvas.width = map.width;
  canvas.height = map.height;
  // a CPU-backed canvas: toBlob then encodes off the main thread, where a GPU-backed one (Android
  // Chrome accelerates 2D canvases) would first read every pixel back on the main thread
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return '';
  const img = ctx.createImageData(map.width, map.height);
  img.data.set(map.data);
  ctx.putImageData(img, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return '';
  return new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => resolve('');
    reader.readAsDataURL(blob);
  });
}

/** How many maps were rasterized (exposed for tests: maps regenerate only on resize). */
export function mapsGenerated(): number {
  return generated;
}
