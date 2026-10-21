/**
 * Bulk select (round-2 brief §12): a long-press menu's "Select" starts it in one list (a scope);
 * taps then add and remove rows, and the bulk bar completes, moves, deletes or archives them all.
 */
import { createContext, useContext, useSyncExternalStore } from 'react';
import type { LineKind, LineRef } from './edits';
import { emit, on } from './store';

export interface Selectable {
  key: string;
  kind: LineKind | 'note';
  label: string;
  /** a line's anchor (tasks, items, links, events) */
  ref?: LineRef;
  /** a task's id (its move route) */
  id?: string;
  /** a note's path */
  path?: string;
  /** an open task or item (it can be completed) */
  open?: boolean;
}

interface SelState {
  scope: string | null;
  items: ReadonlyMap<string, Selectable>;
}

let state: SelState = { scope: null, items: new Map() };
const set = (next: SelState) => {
  state = next;
  emit('selection');
};

export function startSelect(scope: string, first: Selectable): void {
  set({ scope, items: new Map([[first.key, first]]) });
}
export function toggleSelect(s: Selectable): void {
  const items = new Map(state.items);
  if (items.has(s.key)) items.delete(s.key);
  else items.set(s.key, s);
  set({ ...state, items });
}
export function endSelect(): void {
  if (state.scope) set({ scope: null, items: new Map() });
}
/** End a selection only if it started in a scope with this prefix (`today:` when a moment changes). */
export function endSelectIn(prefix: string): void {
  if (state.scope?.startsWith(prefix)) endSelect();
}
export function useSelection(): SelState {
  return useSyncExternalStore((cb) => on('selection', cb), () => state);
}

/** The list a row is in; rows outside a scope have no "Select". */
export const SelectScope = createContext<string | null>(null);
export const useSelectScope = () => useContext(SelectScope);
