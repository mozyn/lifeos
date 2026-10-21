/**
 * What screens use from the shell: their slot in the top bar, navigation with the pane slide, and
 * Quick Add. Kept apart from AppShell so screens never import the shell.
 */
import { createContext, type ReactNode, useContext } from 'react';
import { createPortal } from 'react-dom';
import type { PaneKey } from '../lib/panes';

/** The pane a component renders in ('route' for anything outside the five tabs and Settings). */
export const PaneCtx = createContext<PaneKey>('route');
/** Each pane's own slot in the top bar's left side. */
export const SlotsCtx = createContext<Map<PaneKey, HTMLElement> | null>(null);
export const QuickCtx = createContext<(type?: string) => void>(() => undefined);
export const GoCtx = createContext<(to: string) => void>(() => undefined);

/** Put a control in the top bar's left slot (Today's moment switch, Week's arrows). */
export function TopBarSlot({ children }: { children: ReactNode }) {
  const pane = useContext(PaneCtx);
  const el = useContext(SlotsCtx)?.get(pane);
  return el ? createPortal(children, el) : null;
}

export const useQuickAdd = () => useContext(QuickCtx);

/** Go to another screen: a pane slide when it is another tab, a plain navigation inside one. */
export const useGo = () => useContext(GoCtx);
