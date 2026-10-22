/**
 * The long-press menu (round-2 brief §12): Edit, Move, Delete or Archive, Make private where it
 * applies, and Select (bulk). One sheet for the whole app, opened from any row.
 */
import { type ReactNode, useSyncExternalStore } from 'react';
import { emit, on } from '../lib/store';
import { Sheet } from './ui';

export interface MenuItem {
  label: string;
  icon: ReactNode;
  run: () => void;
  tone?: 'danger';
  testId: string;
}

let current: { title: string; items: MenuItem[] } | null = null;
export function openRowMenu(m: { title: string; items: MenuItem[] } | null): void {
  current = m;
  emit('row-menu');
}

export function RowMenuHost() {
  const m = useSyncExternalStore((cb) => on('row-menu', cb), () => current);
  if (!m) return null;
  return (
    <Sheet open onClose={() => openRowMenu(null)} title={m.title} testId="row-menu" className="menu-sheet" dock={false}>
      <div className="menu-list" role="menu" aria-label={m.title}>
        {m.items.map((i) => (
          <button
            key={i.testId}
            type="button"
            role="menuitem"
            className="menu-item"
            data-tone={i.tone}
            onClick={() => {
              openRowMenu(null);
              i.run();
            }}
            data-testid={i.testId}
          >
            {i.icon}
            <span>{i.label}</span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}
