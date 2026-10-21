/**
 * Bulk select (round-2 brief §12): while a list is selecting, this glass bar takes the dock's place
 * with what can be done to all of them at once: complete, move, delete (archive, for notes).
 */
import { useEffect } from 'react';
import { Archive, Check, FolderInput, Trash2 } from 'lucide-react';
import { Glass } from '../glass/Glass';
import { archivePaths, completeMany, deleteLines, type LineKind } from '../lib/edits';
import { endSelect, useSelection } from '../lib/selection';
import { openMove } from './MoveSheet';

export function BulkBar() {
  const { scope, items } = useSelection();
  const list = [...items.values()];
  useEffect(() => {
    const root = document.documentElement;
    if (scope) root.dataset.selecting = '';
    else delete root.dataset.selecting;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && endSelect();
    if (scope) window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [scope]);
  // a screen change ends the selection
  useEffect(() => {
    const end = () => endSelect();
    window.addEventListener('popstate', end);
    return () => window.removeEventListener('popstate', end);
  }, []);
  if (!scope) return null;
  const kinds = new Set(list.map((i) => i.kind));
  const one = kinds.size === 1 ? [...kinds][0] : null;
  const n = list.length;
  const canComplete = n > 0 && list.every((i) => (i.kind === 'task' || i.kind === 'item') && i.open);
  const canMove = n > 0 && (one === 'task' || one === 'note' || (one === 'item' && /^(shopping|wishlist)$/.test(scope)));
  const notes = one === 'note';
  const done = () => endSelect();
  return (
    <Glass className="bulkbar" kind="bar" variant="thick" role="toolbar" aria-label={`${n} selected`} data-testid="bulk-bar">
      <span className="bulk-count num" aria-live="polite" data-testid="bulk-count">
        {n} selected
      </span>
      <div className="bulk-actions">
        {canComplete && (
          <button
            type="button"
            className="bulk-btn"
            onClick={() => {
              void completeMany(list.map((i) => ({ ref: i.ref!, kind: i.kind as 'task' | 'item' })));
              done();
            }}
            data-testid="bulk-complete"
          >
            <Check aria-hidden />
            <span>Complete</span>
          </button>
        )}
        {canMove && (
          <button type="button" className="bulk-btn" onClick={() => openMove({ kind: one as 'task' | 'item' | 'note', items: list, from: scope, done })} data-testid="bulk-move">
            <FolderInput aria-hidden />
            <span>Move</span>
          </button>
        )}
        {n > 0 &&
          (notes ? (
            <button
              type="button"
              className="bulk-btn"
              data-tone="danger"
              onClick={() => {
                void archivePaths(list.map((i) => ({ path: i.path!, label: i.label, key: i.key })));
                done();
              }}
              data-testid="bulk-archive"
            >
              <Archive aria-hidden />
              <span>Archive</span>
            </button>
          ) : (
            !kinds.has('note') && (
              <button
                type="button"
                className="bulk-btn"
                data-tone="danger"
                onClick={() => {
                  void deleteLines(list.map((i) => ({ ref: i.ref!, kind: i.kind as LineKind, key: i.key, label: i.label })));
                  done();
                }}
                data-testid="bulk-delete"
              >
                <Trash2 aria-hidden />
                <span>Delete</span>
              </button>
            )
          ))}
      </div>
      <button type="button" className="btn btn-quiet bulk-done" onClick={done} data-testid="bulk-done">
        Done
      </button>
    </Glass>
  );
}
