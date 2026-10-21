/**
 * Rewards (spec §7). Completing feels good; opening the app, approving AI drafts and un-completing
 * never trigger anything.
 *  - small: a two-note chime (a major third, synthesized with Web Audio, ≤ 150 ms, no audio asset)
 *    and a haptic tick (12 ms by default, Settings → Gestures); the checkbox pop itself is CSS (components.css .check[data-pop]).
 *  - big (last focus task, evening session closed, a clean day that extends a streak): a three-note
 *    chime and a particle burst from the element (canvas, ≤ 40 particles, ≤ 600 ms).
 *  - reduced motion: no swell, no particles; the chime still plays unless "mute rewards" is on.
 */
import { motionReduced } from '../glass/spring';
import { haptic } from './gestures';
import { readPrefs } from './prefs';

/** Test and diagnostics hook: counts only (E2E test 2 checks a chime node was created). */
export const audioStats = { contexts: 0, oscillators: 0, chimes: 0, bursts: 0 };
(window as unknown as { __lifeosAudio: typeof audioStats }).__lifeosAudio = audioStats;

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    if (!ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      audioStats.contexts++;
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** One soft bell-like note: a sine with a quick attack and an exponential decay, plus a faint octave. */
function note(ac: AudioContext, freq: number, start: number, dur: number, gain: number) {
  for (const [mult, g] of [
    [1, gain],
    [2, gain * 0.18],
  ] as const) {
    const osc = ac.createOscillator();
    const env = ac.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq * mult, start);
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(g, start + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(env).connect(ac.destination);
    osc.start(start);
    osc.stop(start + dur + 0.02);
    audioStats.oscillators++;
  }
}

// C6, E6, G6: a major third, then the major triad for the bigger moments
const C6 = 1046.5;
const E6 = 1318.51;
const G6 = 1567.98;

export function chime(kind: 'small' | 'big' = 'small'): void {
  if (readPrefs().muteRewards) return;
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime + 0.01;
  if (kind === 'small') {
    // two notes, 150 ms in all
    note(ac, C6, t, 0.075, 0.12);
    note(ac, E6, t + 0.06, 0.09, 0.12);
  } else {
    note(ac, C6, t, 0.11, 0.12);
    note(ac, E6, t + 0.09, 0.12, 0.12);
    note(ac, G6, t + 0.18, 0.26, 0.13);
  }
  audioStats.chimes++;
}

/** The haptic tick at the device's chosen strength (Settings → Gestures; off: none). */
export { haptic };

/** A brief particle burst from an element (canvas, max 40 particles, ≤ 600 ms). */
export function burst(from: Element | null): void {
  if (!from || motionReduced()) return;
  const r = from.getBoundingClientRect();
  const size = 260;
  const canvas = document.createElement('canvas');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.className = 'burst';
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  canvas.style.left = `${r.left + r.width / 2 - size / 2}px`;
  canvas.style.top = `${r.top + r.height / 2 - size / 2}px`;
  canvas.setAttribute('aria-hidden', 'true');
  document.body.appendChild(canvas);
  const g = canvas.getContext('2d');
  if (!g) {
    canvas.remove();
    return;
  }
  g.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  const colors = ['--accent', '--ok-fill', '--warn-fill', '--accent-fill'].map((v) => css.getPropertyValue(v).trim() || '#3b82f6');
  const parts = Array.from({ length: 36 }, (_, i) => {
    const a = (i / 36) * Math.PI * 2 + Math.random() * 0.4;
    const v = 120 + Math.random() * 170;
    return { x: size / 2, y: size / 2, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 40, r: 2 + Math.random() * 2.6, c: colors[i % colors.length], spin: Math.random() > 0.5 };
  });
  audioStats.bursts++;
  const t0 = performance.now();
  let last = t0;
  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const life = (now - t0) / 560;
    g.clearRect(0, 0, size, size);
    if (life >= 1) {
      canvas.remove();
      return;
    }
    // drag per elapsed time, not per frame: 120 Hz and 60 Hz look the same
    const drag = Math.pow(0.92, dt * 60);
    for (const p of parts) {
      p.vx *= drag;
      p.vy = p.vy * drag + 260 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      g.globalAlpha = Math.max(0, 1 - life * life);
      g.fillStyle = p.c;
      g.beginPath();
      if (p.spin) g.arc(p.x, p.y, p.r * (1 - life * 0.5), 0, Math.PI * 2);
      else g.rect(p.x - p.r, p.y - p.r / 2, p.r * 2, p.r);
      g.fill();
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/**
 * Count a number up in an element's text (≈ 450 ms; instant with reduced motion). The text
 * changes once per whole number, never per frame, and each new number rolls in from below by
 * transform and opacity (UI brief 2 §2).
 */
export function countUp(el: HTMLElement | null, from: number, to: number): void {
  if (!el) return;
  if (motionReduced() || from === to) {
    el.textContent = String(to);
    return;
  }
  const steps = Math.min(Math.abs(to - from), 12);
  const every = Math.min(110, 450 / steps);
  for (let i = 1; i <= steps; i++) {
    setTimeout(() => {
      el.textContent = String(Math.round(from + ((to - from) * i) / steps));
      el.animate([{ transform: 'translateY(0.32em)', opacity: 0.35 }, { transform: 'none', opacity: 1 }], { duration: 180, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
    }, (i - 1) * every);
  }
}

/** A short spring pulse on an element (transform only): the progress ring when it fills. */
export function pulse(el: Element | null, scale = 1.06): void {
  if (!el || motionReduced()) return;
  el.animate([{ transform: 'none' }, { transform: `scale(${scale})` }, { transform: 'none' }], { duration: 360, easing: 'cubic-bezier(0.34, 1.4, 0.64, 1)' });
}

/** The small reward on an element: pop (CSS), chime, haptic. */
export function rewardSmall(el: HTMLElement | null): void {
  if (el) {
    delete el.dataset.pop;
    void el.offsetWidth;
    el.dataset.pop = '';
    setTimeout(() => delete el.dataset.pop, 700);
  }
  chime('small');
  haptic();
}

export function rewardBig(el: Element | null): void {
  chime('big');
  haptic();
  burst(el);
}
