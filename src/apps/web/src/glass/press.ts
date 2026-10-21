/**
 * Press physics, delegated (ADR-19). Any element with `data-press` swells while held and springs
 * back with a bounce on release (CSS `scale`, see glass.css). The glass surface that contains it
 * magnifies what is under it (a boost of the displacement strength) and glows at the touch point,
 * and the glow spreads across the rest of that surface. At the balanced glass quality a frosted
 * control turns liquid under the finger (UI brief 4). One capturing listener serves the app.
 *
 * `data-press="1.6"` sets the magnification; an empty value uses 1.35.
 */
import { controllerFor } from './engine';
import { motionReduced } from './spring';

let installed = false;

export function installPressPhysics(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('pointerdown', onDown, { capture: true, passive: true });
}

function onDown(e: PointerEvent): void {
  if (e.button !== 0) return;
  const target = (e.target instanceof Element ? e.target : null)?.closest<HTMLElement>('[data-press]');
  if (!target || target.matches(':disabled, [aria-disabled="true"]')) return;
  const surface = target.closest<HTMLElement>('.lg') ?? target;
  const ctrl = controllerFor(target);
  const reduced = motionReduced();
  // the light follows the finger by its transform: no style recalc or repaint per move
  const dot = surface.querySelector<HTMLElement>(':scope > .lg-glow > .lg-glow-dot');
  const box = surface.getBoundingClientRect();
  const glow = (ev: PointerEvent) => {
    if (dot) dot.style.transform = `translate3d(${(ev.clientX - box.left).toFixed(1)}px, ${(ev.clientY - box.top).toFixed(1)}px, 0)`;
  };
  glow(e);
  target.dataset.pressed = '';
  surface.dataset.glow = '';
  if (!reduced) ctrl?.press(true, Number(target.dataset.press) || 1.35);
  const end = () => {
    delete target.dataset.pressed;
    delete surface.dataset.glow;
    if (!reduced) ctrl?.press(false);
    window.removeEventListener('pointermove', glow);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
  };
  window.addEventListener('pointermove', glow, { passive: true });
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}
