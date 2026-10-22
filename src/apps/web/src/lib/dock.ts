/**
 * Side panels on wide screens (round 8f, docs/desktop-layout-brief.md, ADR-107). From 1024 px a
 * screen with room beside its content offers a panel (the Calendar, Lists, Goals, Habits): a sheet
 * opened while that screen is shown is laid out in the panel, beside what it belongs to, instead of
 * covering the screen. Everything else (Quick Add, the hold menu, Move, a sheet opened from inside
 * a panel) is a centred dialog. Below 1024 px nothing changes: sheets are sheets.
 *
 * A screen registers its panel's slot; the sheet asks for the slot of the pane it renders in (or,
 * for the app's own sheets in the shell, of the pane on screen when it opens).
 */
import { createContext, useSyncExternalStore } from 'react';
import { activePane, type PaneKey } from './panes';

/** The width from which panels, time grids and the two-column screens take over. */
export const WIDE = '(min-width: 1024px)';

const slots = new Map<PaneKey, HTMLElement>();
const subs = new Set<() => void>();
let version = 0;

function changed(): void {
  version++;
  for (const f of subs) f();
}

/** A screen's panel slot (null when it unmounts). */
export function registerDock(pane: PaneKey, el: HTMLElement | null): void {
  if (el) {
    if (slots.get(pane) === el) return;
    slots.set(pane, el);
  } else if (!slots.delete(pane)) return;
  changed();
}

export function dockOf(pane: PaneKey | null): HTMLElement | null {
  return pane ? (slots.get(pane) ?? null) : null;
}

/** Re-render when panels come and go. */
export function useDocks(): number {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => version,
  );
}

/** The pane a sheet belongs to: its own, or the one on screen for the shell's sheets. */
export function paneFor(own: PaneKey): PaneKey | null {
  return own === 'route' ? activePane() : own;
}

/** Set inside a docked sheet: a sheet opened from it is a centred dialog, never a second panel. */
export const DockedCtx = createContext(false);

/** The sheet each panel shows: one at a time, the newest (the one before it is closed). */
const holders = new Map<HTMLElement, () => void>();

export function claimDock(slot: HTMLElement, close: () => void): () => void {
  const prev = holders.get(slot);
  holders.set(slot, close);
  if (prev && prev !== close) prev();
  return () => {
    if (holders.get(slot) === close) holders.delete(slot);
  };
}

/** Close the sheet a screen's panel shows (a newly chosen day takes its place). */
export function closeDocked(pane: PaneKey): void {
  const slot = slots.get(pane);
  const close = slot ? holders.get(slot) : undefined;
  if (slot) holders.delete(slot);
  close?.();
}
