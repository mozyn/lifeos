/**
 * The part of the window the user can see while the software keyboard is up (UI brief 2 §1).
 *
 * Android Chrome is asked to resize the page for the keyboard (`interactive-widget=
 * resizes-content` in index.html): the layout viewport then ends at the keyboard's top edge and a
 * fixed overlay already sits above it. Browsers that only shrink the visual viewport (the default
 * `resizes-visual`, older Chrome, Safari) are covered here: the visible rectangle comes from
 * `visualViewport`, and every registered overlay is fitted to it, so a sheet's field and primary
 * action stay above the keyboard either way. Pinch zoom (scale ≠ 1) leaves overlays alone.
 *
 * The root gets `data-kb` while the keyboard is up (an editable element has focus and the visible
 * height dropped well below the tallest seen at this width), which hides the dock.
 */

export interface Visible {
  /** top of the visible area in layout-viewport px */
  top: number;
  height: number;
  /** layout-viewport px hidden below the visible area (a resizes-visual keyboard) */
  hidden: number;
  keyboard: boolean;
}

type Listener = (v: Visible) => void;
const listeners = new Set<Listener>();
let current: Visible = { top: 0, height: 0, hidden: 0, keyboard: false };
/** tallest visible height seen per layout width (the keyboard-down height of each orientation) */
const tallest = new Map<number, number>();
/** test hook: a simulated resizes-visual keyboard of this height (px), or null */
let simulated: number | null = null;
let installed = false;

function editable(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly;
  if (el instanceof HTMLInputElement) return !el.readOnly && !/^(button|checkbox|radio|range|submit|reset|file|color|image|hidden)$/.test(el.type);
  return el instanceof HTMLSelectElement;
}

const editableFocused = () => editable(document.activeElement);

function measure(): Visible {
  const ih = window.innerHeight;
  const vv = window.visualViewport;
  let top = 0;
  let height = ih;
  if (simulated !== null) height = Math.max(0, ih - simulated);
  else if (vv && Math.abs(vv.scale - 1) < 0.01) {
    top = Math.max(0, Math.min(vv.offsetTop, ih));
    height = Math.max(0, Math.min(vv.height, ih - top));
  }
  const w = window.innerWidth;
  const focused = editableFocused();
  if (!focused || !tallest.has(w)) tallest.set(w, Math.max(tallest.get(w) ?? 0, height));
  const keyboard = focused && (tallest.get(w) ?? height) - height > 120;
  return { top: Math.round(top), height: Math.round(height), hidden: Math.max(0, Math.round(ih - top - height)), keyboard };
}

function update(): void {
  const next = measure();
  if (next.top === current.top && next.height === current.height && next.hidden === current.hidden && next.keyboard === current.keyboard) return;
  current = next;
  const root = document.documentElement;
  if (next.keyboard) root.dataset.kb = '';
  else delete root.dataset.kb;
  for (const l of [...listeners]) l(next);
}

/** Start tracking (once, before the first render). */
/**
 * A phone under 400 css px wide (round-3 brief §5): decided once, when the app starts, from the
 * viewport width (never on a resize, so a rotation or the Fold's cover/inner switch does not
 * re-lay the top bar under a finger). The root gets `data-narrow`; Today's moment switch shows an
 * icon over a short label there, the Calendar's switch sits a little tighter.
 */
export const NARROW_PX = 400;
let narrow = false;
export function isNarrow(): boolean {
  return narrow;
}

export function installViewport(): void {
  if (installed) return;
  installed = true;
  narrow = window.innerWidth > 0 && window.innerWidth < NARROW_PX;
  document.documentElement.toggleAttribute('data-narrow', narrow);
  const vv = window.visualViewport;
  vv?.addEventListener('resize', update);
  vv?.addEventListener('scroll', update);
  window.addEventListener('resize', update);
  // focus moves before or after the keyboard animates: look again on both edges. Only a field
  // brings the keyboard up: focus moving between links and buttons (a tab tapped) reads nothing,
  // since reading the viewport would force the layout of the frame that starts a pane slide
  const onFocus = (e: FocusEvent) => {
    if (current.keyboard || editable(e.target as Element | null)) requestAnimationFrame(update);
  };
  document.addEventListener('focusin', onFocus);
  document.addEventListener('focusout', onFocus);
  update();
  (window as unknown as { __lifeosViewport: object }).__lifeosViewport = {
    get visible() {
      return { ...current };
    },
    /** emulate a keyboard that shrinks only the visual viewport (null ends it) */
    simulateKeyboard(px: number | null) {
      simulated = px;
      update();
    },
  };
}

export function visible(): Visible {
  return current;
}

export function onVisibleChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
