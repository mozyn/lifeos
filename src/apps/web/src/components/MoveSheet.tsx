/**
 * Move (round-2 brief §12), for one row or a bulk selection: a task to another day's note or to a
 * goal or project; a shopping or wishlist item to the other list or into a task group; a note to
 * Inbox, Resources, Areas or Projects.
 */
import { useState, useSyncExternalStore } from 'react';
import { addDays, shortDateDow, todayIn } from '@lifeos/shared';
import { recurText } from './GroupRow';
import { Sheet } from './ui';
import { moveItems, moveNotes, moveTasks, NOTE_FOLDERS, type NoteFolder, errText, anchorOf } from '../lib/edits';
import type { Selectable } from '../lib/selection';
import { emit, on, toast, useResource, write } from '../lib/store';

type Req = { kind: 'task' | 'item' | 'note'; items: Selectable[]; from?: string; done?: () => void };
let current: Req | null = null;
export function openMove(r: Req | null): void {
  current = r;
  emit('move-sheet');
}

export function MoveSheetHost() {
  const r = useSyncExternalStore((cb) => on('move-sheet', cb), () => current);
  if (!r) return null;
  const close = (moved: boolean) => {
    openMove(null);
    if (moved) r.done?.();
  };
  const what = r.items.length === 1 ? r.items[0].label : `${r.items.length} ${r.kind === 'task' ? 'tasks' : r.kind === 'item' ? 'items' : 'notes'}`;
  return (
    <Sheet open onClose={() => close(false)} title={`Move ${r.items.length === 1 ? '' : what}`.trim()} testId="move-sheet" dock={false}>
      {r.items.length === 1 && <p className="sheet-task-title">{what}</p>}
      {r.kind === 'task' && <MoveTask items={r.items} close={close} />}
      {r.kind === 'item' && <MoveItem items={r.items} from={r.from as 'shopping' | 'wishlist'} close={close} />}
      {r.kind === 'note' && <MoveNote items={r.items} close={close} />}
    </Sheet>
  );
}

interface GoalsDto {
  goals: { slug: string; title: string; status: string }[];
  projects: { slug: string; title: string; status: string }[];
}

function MoveTask({ items, close }: { items: Selectable[]; close: (moved: boolean) => void }) {
  const today = todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  const { data } = useResource<GoalsDto>('api/goals');
  const targets = [...(data?.goals ?? []), ...(data?.projects ?? [])].filter((g) => g.status === 'active');
  const go = async (to: { date?: string; slug?: string; title?: string }) => {
    setBusy(true);
    const ok = await moveTasks(
      items.map((i) => ({ ref: i.ref!, id: i.id!, label: i.label })),
      to,
    );
    setBusy(false);
    if (ok) close(true);
  };
  return (
    <>
      <div className="field">
        <span>To a day</span>
        <div className="picks">
          <button type="button" className="pick" disabled={busy} onClick={() => void go({ date: today })} data-testid="move-today">
            Today
          </button>
          <button type="button" className="pick" disabled={busy} onClick={() => void go({ date: addDays(today, 1) })} data-testid="move-tomorrow">
            Tomorrow
          </button>
          <button type="button" className="pick" disabled={busy} onClick={() => void go({ date: addDays(today, 7) })}>
            Next week
          </button>
        </div>
        <div className="edit-row">
          <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Move to this day" data-testid="move-date" />
          <button type="button" className="btn" disabled={busy || !date} onClick={() => void go({ date })} data-testid="move-date-go">
            Move
          </button>
        </div>
        <span className="caption">The task goes under that day&rsquo;s Tasks in its daily note, due that day.</span>
      </div>
      {targets.length > 0 && (
        <div className="field">
          <span>To a goal or project</span>
          <div className="rows">
            {targets.map((g) => (
              <button key={g.slug} type="button" className="row row-button" disabled={busy} onClick={() => void go({ slug: g.slug, title: g.title })} data-testid="move-goal">
                <span className="row-main">
                  <span className="row-title">{g.title}</span>
                  <span className="row-meta">
                    <span className="tag goal">@{g.slug}</span>
                  </span>
                </span>
              </button>
            ))}
          </div>
          <span className="caption">The task goes under that note&rsquo;s Tasks and counts toward it.</span>
        </div>
      )}
    </>
  );
}

function MoveItem({ items, from, close }: { items: Selectable[]; from: 'shopping' | 'wishlist'; close: (moved: boolean) => void }) {
  const other = from === 'shopping' ? 'wishlist' : 'shopping';
  const [busy, setBusy] = useState(false);
  const { data } = useResource<{ groups: { id: string; path: string; line: number; hash: string; title: string; due: string | null; recur: string | null; total: number; done: number }[] }>('api/groups');
  const toList = async () => {
    setBusy(true);
    const ok = await moveItems(
      items.map((i) => ({ ref: i.ref!, label: i.label })),
      other,
    );
    setBusy(false);
    if (ok) close(true);
  };
  const toGroup = async (g: { path: string; line: number; hash: string; title: string }) => {
    setBusy(true);
    try {
      for (const it of items) await write({ path: 'api/groups/items', body: { group: { path: g.path, line: g.line, hash: g.hash }, item: anchorOf(it.ref!) }, kind: 'group-item', label: 'Move to a group' });
      toast(items.length === 1 ? `${items[0].label} moved to ${g.title}` : `${items.length} items moved to ${g.title}`);
      close(true);
    } catch (e) {
      toast(errText(e, 'Not moved.'), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="field">
        <span>To the other list</span>
        <button type="button" className="btn" disabled={busy} onClick={() => void toList()} data-testid={`move-to-${other}`}>
          {other === 'shopping' ? 'Shopping' : 'Wishlist'}
        </button>
      </div>
      {items.length === 1 && (
        <div className="field">
          <span>Into a group</span>
          {!data ? (
            <p className="secondary">Loading…</p>
          ) : data.groups.length === 0 ? (
            <p className="secondary">No open groups yet. Make one in Quick Add: &ldquo;Weekly shopping every saturday: olive oil; dates&rdquo;.</p>
          ) : (
            <div className="rows">
              {data.groups.map((g) => (
                <button key={g.id} type="button" className="row row-button" disabled={busy} onClick={() => void toGroup(g)} data-testid="move-group">
                  <span className="row-main">
                    <span className="row-title">{g.title}</span>
                    <span className="row-meta">
                      <span className="tag">
                        {g.done} of {g.total}
                      </span>
                      {g.due && <span className="tag">{shortDateDow(g.due)}</span>}
                      {g.recur && <span className="tag">{recurText(g.recur)}</span>}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
          <span className="caption">The item is added to the group, then taken off the list; when the group repeats, it comes back unticked each time.</span>
        </div>
      )}
    </>
  );
}

function MoveNote({ items, close }: { items: Selectable[]; close: (moved: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const here = items.length === 1 ? items[0].path!.split('/')[0] : null;
  const go = async (f: NoteFolder) => {
    setBusy(true);
    const ok = await moveNotes(
      items.map((i) => i.path!),
      f,
    );
    setBusy(false);
    if (ok) close(true);
  };
  return (
    <div className="field">
      <span>To a folder</span>
      <div className="picks">
        {NOTE_FOLDERS.map((f) => (
          <button key={f} type="button" className="pick" disabled={busy || here === f} aria-pressed={here === f} onClick={() => void go(f)} data-testid={`move-folder-${f.toLowerCase()}`}>
            {f}
          </button>
        ))}
      </div>
      <span className="caption">Links to the note in your other notes follow it.</span>
    </div>
  );
}
