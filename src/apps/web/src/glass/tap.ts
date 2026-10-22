/**
 * A tap chooses on pointerup (round 8d, docs/ios-tap-brief.md, ADR-106).
 *
 * iOS Safari does not always send a tap's click. When something appears while the touch begins (a
 * tab parks its screen beside the visible one, visibility hidden → visible, and the lens starts
 * short timers), its content-change check takes the tap for a hover: pointer and touch events
 * come, mousedown, mouseup and click do not, and only a second tap that shows nothing new clicks.
 * A control that chose on click then moved its pill under the finger and slid it back.
 *
 * Here the choice is made on pointerup when the finger stayed within TAP_SLOP of where it went
 * down, or on a pointercancel of a short press that did not move (the browser took a tap). The
 * click the browser may still send for that tap does nothing, wherever it lands: never a second
 * navigation, never a click on what the tap just opened. Keyboard and screen-reader activation is
 * a click with no pointer before it (detail 0) and goes through as before.
 */

/** How far (css px, either way) a finger may move and still tap: also the lens's scrub threshold. */
export const TAP_SLOP = 6;
/** A press the browser cancels after this long was a long press (a menu, a preview: Android's is 400 ms), not a tap. */
export const LONG_PRESS_MS = 350;
/** A tap's own click comes within this (iOS can hold it while it watches the page); later ones are not its. */
const CLICK_WAIT_MS = 1000;

let pending: (() => void) | null = null;

/** The click the browser sends for a tap already chosen does nothing (until the next pointerdown, 1 s at most). */
export function swallowClick(): void {
  pending?.();
  const click = (e: MouseEvent) => {
    // a key (Enter, Space) or a script clicked: not the tap's click
    if (e.detail === 0) return;
    end();
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const end = () => {
    clearTimeout(timer);
    window.removeEventListener('click', click, true);
    window.removeEventListener('pointerdown', end, true);
    if (pending === end) pending = null;
  };
  const timer = setTimeout(end, CLICK_WAIT_MS);
  window.addEventListener('click', click, true);
  window.addEventListener('pointerdown', end, true);
  pending = end;
}

/** Whether a pointerdown can start a tap: the primary button and pointer, no modifier (open in a new tab). */
export const canTap = (e: PointerEvent): boolean => e.button === 0 && e.isPrimary && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;

/** Whether a pointer at (x, y) is still a tap that went down at (x0, y0). */
export const withinSlop = (x0: number, y0: number, x: number, y: number): boolean => Math.abs(x - x0) <= TAP_SLOP && Math.abs(y - y0) <= TAP_SLOP;

/**
 * From a pointerdown on something whose click chooses (a link of the rail): when it turns out a
 * tap, `choose` runs on its pointerup and its click is swallowed. A finger that moved further
 * than TAP_SLOP, or a long press the browser cancelled, leaves the click to decide, as before.
 */
export function tapChooses(down: PointerEvent, choose: () => void): void {
  if (!canTap(down)) return;
  const id = down.pointerId;
  const at = performance.now();
  let moved = false;
  const move = (e: PointerEvent) => {
    if (e.pointerId === id && !withinSlop(down.clientX, down.clientY, e.clientX, e.clientY)) moved = true;
  };
  const end = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', end, true);
    window.removeEventListener('pointercancel', end, true);
    // a cancel's position says nothing (WebKit sends 0, 0): only the moves before it count
    const tap = e.type === 'pointerup' ? !moved && withinSlop(down.clientX, down.clientY, e.clientX, e.clientY) : !moved && performance.now() - at <= LONG_PRESS_MS;
    if (!tap) return;
    swallowClick();
    choose();
  };
  window.addEventListener('pointermove', move, { capture: true, passive: true });
  window.addEventListener('pointerup', end, true);
  window.addEventListener('pointercancel', end, true);
}
