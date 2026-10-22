/**
 * A screen's side panel on wide screens (round 8f, lib/dock.ts, ADR-107): from 1024 px the screen
 * lays it out beside its content, and a sheet opened on that screen is shown in it (a task, a note,
 * an event, the web search). `children` is what the panel shows while no sheet is in it (nothing:
 * the panel is empty and the screen may fold it away). Under 1024 px there is no panel.
 */
import { type ReactNode, useCallback, useContext } from 'react';
import { registerDock, WIDE } from '../lib/dock';
import { PaneCtx } from '../shell/context';
import { useMedia } from './ui';

export function SidePanel({ children, className, label, testId }: { children?: ReactNode; className?: string; label: string; testId?: string }) {
  const pane = useContext(PaneCtx);
  const wide = useMedia(WIDE);
  const slot = useCallback((el: HTMLElement | null) => registerDock(pane, el), [pane]);
  if (!wide) return null;
  return (
    <aside className={`side-panel${className ? ` ${className}` : ''}`} aria-label={label} data-testid={testId}>
      {children && <div className="side-default">{children}</div>}
      <div className="side-slot" ref={slot} />
    </aside>
  );
}
