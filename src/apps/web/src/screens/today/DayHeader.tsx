/**
 * Today's header (spec §6): Hijri date, Gregorian date, next prayer with countdown — drawn as the
 * day's arc: the sun's path from sunrise to maghrib over a horizon line, the five prayers at their
 * real times, the sun where it is now. Labels sit in five even columns below so they never collide
 * (Maghrib and Isha are often under an hour apart).
 *
 * Night fidelity (round-2 brief §2): after Maghrib and before Fajr the sun gives way to the moon,
 * in its phase from the Hijri day (new around the 1st, full around the 14th), above a sparse, still
 * pattern of stars; near Fajr and Maghrib the sky behind the arc takes a soft dawn or dusk tint. All
 * of it is a still SVG redrawn when the minute changes: no animation, no per-frame work, no glass.
 * Reduced transparency drops the tint and the sun's glow (both are translucent washes); the moon
 * and the stars are solid.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { countdown, FIVE, hm12, longDate, moonPhase, PRAYER_LABELS } from '@lifeos/shared';
import type { Today } from '../../lib/types';

const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

/** A sparse, still star field: positions as fractions of the sky (width, height above the horizon). */
const STARS: [number, number, number][] = [
  [0.05, 0.22, 1.1],
  [0.13, 0.62, 0.8],
  [0.21, 0.08, 1.3],
  [0.29, 0.42, 0.9],
  [0.37, 0.18, 0.8],
  [0.46, 0.55, 1.2],
  [0.54, 0.12, 0.9],
  [0.62, 0.38, 1.0],
  [0.7, 0.06, 0.8],
  [0.78, 0.5, 1.2],
  [0.86, 0.2, 0.9],
  [0.94, 0.44, 1.1],
];

/** The lit part of the moon as a path (a semicircle and the terminator's half-ellipse). */
export function moonPath(cx: number, cy: number, r: number, hijriDay: number): string {
  const { phase, waxing } = moonPhase(hijriDay);
  const rx = Math.abs(Math.cos(2 * Math.PI * phase)) * r;
  const gibbous = phase > 0.25 && phase < 0.75;
  const top = `${cx.toFixed(2)} ${(cy - r).toFixed(2)}`;
  const bottom = `${cx.toFixed(2)} ${(cy + r).toFixed(2)}`;
  // the limb on the lit side (right while waxing), then back up along the terminator
  const limb = waxing ? 1 : 0;
  const term = waxing ? (gibbous ? 1 : 0) : gibbous ? 0 : 1;
  return `M ${top} A ${r} ${r} 0 0 ${limb} ${bottom} A ${rx.toFixed(2)} ${r} 0 0 ${term} ${top} Z`;
}

/** How strongly the dawn (Fajr to just after sunrise) or dusk (the last 45 minutes to Maghrib) tints the sky, 0..1. */
export function skyTint(nowMin: number, p: { fajr: number; sunrise: number; maghrib: number }): { kind: 'dawn' | 'dusk' | null; amount: number } {
  if (nowMin >= p.fajr && nowMin < p.sunrise + 30) {
    const rise = Math.min(1, (nowMin - p.fajr + 10) / 30);
    const fade = nowMin > p.sunrise ? 1 - (nowMin - p.sunrise) / 30 : 1;
    return { kind: 'dawn', amount: Math.max(0, Math.min(rise, fade)) };
  }
  if (nowMin >= p.maghrib - 45 && nowMin < p.maghrib) return { kind: 'dusk', amount: Math.min(1, (nowMin - (p.maghrib - 45)) / 30) };
  return { kind: null, amount: 0 };
}

export function DayArc({ prayers, nowMin, next, hijriDay }: { prayers: Today['prayers']; nowMin: number; next: string; hijriDay: number }) {
  // drawn at the real width, so dots stay round on the fold's wide screen
  const ref = useRef<SVGSVGElement>(null);
  const [W, setW] = useState(360);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(200, Math.round(el.clientWidth))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = 64;
  const horizon = 46;
  const peak = 10;
  const F = toMin(prayers.fajr);
  const S = toMin(prayers.sunrise);
  const M = toMin(prayers.maghrib);
  const I = toMin(prayers.isha);
  const t0 = F - 40;
  const t1 = I + 40;
  const x = (t: number) => ((Math.min(t1, Math.max(t0, t)) - t0) / (t1 - t0)) * W;
  const y = (t: number) => {
    if (t >= S && t <= M) return horizon - (horizon - peak) * Math.sin((Math.PI * (t - S)) / (M - S));
    const depth = 12;
    if (t < S) return horizon + depth * Math.min(1, (S - t) / (S - t0));
    return horizon + depth * Math.min(1, (t - M) / (t1 - M));
  };
  const pts = (from: number, to: number) => {
    const out: string[] = [];
    const n = 40;
    for (let i = 0; i <= n; i++) {
      const t = from + ((to - from) * i) / n;
      out.push(`${x(t).toFixed(1)},${y(t).toFixed(1)}`);
    }
    return out.join(' ');
  };
  const now = Math.min(t1, Math.max(t0, nowMin));
  const night = nowMin >= M || nowMin < F;
  const tint = night ? { kind: null, amount: 0 } : skyTint(nowMin, { fajr: F, sunrise: S, maghrib: M });
  // the moon rides high over the hour it is now (at the edge of the drawing deep in the night)
  const mx = Math.min(W - 12, Math.max(12, x(now)));
  const my = peak + 4;
  const mr = 7.5;
  const stars = STARS.map(([fx, fy, r]) => ({ cx: fx * W, cy: 2 + fy * (horizon - 10), r })).filter((s) => Math.hypot(s.cx - mx, s.cy - my) > mr + 7);
  return (
    <svg ref={ref} className={`arc${night ? ' is-night' : ''}`} viewBox={`0 -4 ${W} ${H + 8}`} aria-hidden data-sky={night ? 'night' : (tint.kind ?? 'day')} data-testid="day-arc">
      {tint.kind && tint.amount > 0 && (
        <>
          <defs>
            {/* a glow around where the sun rises or sets: an ellipse fading to nothing at its own
                edge, in its own colour (a fade toward "transparent" passes through grey), clipped
                at the horizon */}
            <radialGradient id={`arc-${tint.kind}`}>
              <stop offset="0" className={`arc-tint-core ${tint.kind}`} />
              <stop offset="0.6" className={`arc-tint-mid ${tint.kind}`} />
              <stop offset="1" className={`arc-tint-edge ${tint.kind}`} />
            </radialGradient>
            <clipPath id="arc-sky">
              <rect x={-W} y={-60} width={W * 3} height={horizon + 60} />
            </clipPath>
          </defs>
          <ellipse className="arc-tint" cx={x(tint.kind === 'dawn' ? S : M)} cy={horizon} rx={W * 0.42} ry={horizon * 0.95} fill={`url(#arc-${tint.kind})`} clipPath="url(#arc-sky)" opacity={(0.3 + 0.7 * tint.amount).toFixed(2)} data-testid="arc-tint" />
        </>
      )}
      {night && (
        <g className="arc-stars" data-testid="arc-stars">
          {stars.map((s, i) => (
            <circle key={i} cx={s.cx.toFixed(1)} cy={s.cy.toFixed(1)} r={s.r} className="arc-star" />
          ))}
        </g>
      )}
      <line x1="0" x2={W} y1={horizon} y2={horizon} className="arc-horizon" />
      <polyline points={pts(t0, now)} className="arc-past" />
      <polyline points={pts(now, t1)} className="arc-future" />
      {FIVE.map((p) => {
        const t = toMin(prayers[p]);
        const passed = t <= nowMin;
        const isNext = p === next;
        return <circle key={p} cx={x(t)} cy={y(t)} r={isNext ? 5 : 3.6} className={isNext ? 'arc-dot next' : passed ? 'arc-dot passed' : 'arc-dot'} />;
      })}
      {night ? (
        <g className="arc-moon-g" data-testid="arc-moon" data-hijri-day={hijriDay}>
          <circle cx={mx} cy={my} r={mr} className="arc-moon-dark" />
          <path d={moonPath(mx, my, mr, hijriDay)} className="arc-moon" />
        </g>
      ) : (
        nowMin >= t0 &&
        nowMin <= t1 && (
          <g data-testid="arc-sun">
            <circle cx={x(now)} cy={y(now)} r="11" className="arc-sun-glow" />
            <circle cx={x(now)} cy={y(now)} r="6" className="arc-sun" />
          </g>
        )
      )}
    </svg>
  );
}

export function DayHeader({ today, now }: { today: Today; now: Date }) {
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const nextAt = Date.parse(today.next.at);
  const isToday = today.next.date === today.date;
  const summary = `Prayer times today: ${FIVE.map((p) => `${PRAYER_LABELS[p]} ${hm12(today.prayers[p])}`).join(', ')}. Next: ${today.next.label} in ${countdown(nextAt - now.getTime())}.`;
  return (
    <header className="day-head" data-testid="day-header">
      <p className="hijri" data-testid="hijri">
        {today.hijri}
      </p>
      <h1 className="day-date">{longDate(today.date)}</h1>
      <div className="day-arc" role="img" aria-label={summary}>
        <DayArc prayers={today.prayers} nowMin={nowMin} next={isToday ? today.next.name : 'fajr-tomorrow'} hijriDay={today.hijriDay} />
        <ol className="arc-labels" aria-hidden>
          {FIVE.map((p) => (
            <li key={p} className={isToday && p === today.next.name ? 'next' : toMin(today.prayers[p]) <= nowMin ? 'passed' : undefined}>
              <span className="arc-name">{PRAYER_LABELS[p]}</span>
              <span className="arc-time num">{hm12(today.prayers[p]).replace(' AM', '').replace(' PM', '')}</span>
            </li>
          ))}
        </ol>
      </div>
      <p className="next-prayer" data-testid="next-prayer">
        {today.next.label} in {countdown(nextAt - now.getTime())}
        <span className="secondary"> at {hm12(today.next.time)}</span>
      </p>
    </header>
  );
}
