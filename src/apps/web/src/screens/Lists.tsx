/**
 * Lists (spec §4.5): tasks (all), notes, links, shopping, wishlist — one glass segmented control
 * switches between them. "Search the web" in the header (every segment) opens the find-and-file
 * sheet (components/SearchSheet.tsx, round-2 brief §8).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { Archive, BookOpen, Check as CheckIcon, ExternalLink, FolderInput, GripVertical, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { localZone, shortDate, todayIn, zonedParts } from '@lifeos/shared';
import { Segmented, Sheet } from '../components/ui';
import { SearchButton } from '../components/SearchSheet';
import { Check, checkOf, TaskRow } from '../components/TaskRow';
import { SwipeRow } from '../components/SwipeRow';
import { NoteSheet } from '../components/NoteSheet';
import { ItemSheet, LinkSheet, type LinkItem, LINKS_PATH, type ListItem, unbuy } from '../components/ListSheets';
import { openMove } from '../components/MoveSheet';
import { anchorOf, archivePaths, deleteLines, errText, useGone } from '../lib/edits';
import { endSelect, type Selectable, SelectScope } from '../lib/selection';
import { CaptureSheet } from './today/cards';
import { ApiError } from '../lib/api';
import { toast, useResource, write } from '../lib/store';
import { completeTask, reopenTask, useEffectiveStatus } from '../lib/tasks';
import type { Capture, Task } from '../lib/types';
import { drillIn } from '../lib/transitions';
import { setSegState, switchSegment, warmSegments } from '../lib/segments';

type Tab = 'tasks' | 'notes' | 'links' | 'shopping' | 'wishlist';
const TABS: { value: Tab; label: string }[] = [
  { value: 'tasks', label: 'Tasks' },
  { value: 'notes', label: 'Notes' },
  { value: 'links', label: 'Links' },
  { value: 'shopping', label: 'Shopping' },
  { value: 'wishlist', label: 'Wishlist' },
];

const tzToday = () => todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone);
const host = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return u;
  }
};

// ------------------------------------------------------------------ tasks

function TasksTab() {
  const [status, setStatus] = useState<'open' | 'done'>('open');
  const [q, setQ] = useState('');
  const { data } = useResource<{ today: string; tasks: Task[] }>(`api/lists/tasks?status=${status}&q=${encodeURIComponent(q)}`);
  const today = data?.today ?? tzToday();
  const groups: { title: string; items: Task[] }[] = [];
  if (data) {
    if (status === 'done') groups.push({ title: 'Done', items: data.tasks });
    else {
      groups.push({ title: 'Overdue', items: data.tasks.filter((t) => t.due && t.due < today) });
      groups.push({ title: 'Today', items: data.tasks.filter((t) => t.due === today) });
      groups.push({ title: 'Upcoming', items: data.tasks.filter((t) => t.due && t.due > today) });
      groups.push({ title: 'No date', items: data.tasks.filter((t) => !t.due) });
    }
  }
  return (
    <SelectScope.Provider value="tasks">
      <div className="list-tools">
        <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a task" aria-label="Find a task" />
        <Segmented
          label="Show"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'open', label: 'Open' },
            { value: 'done', label: 'Done' },
          ]}
        />
      </div>
      {data && data.tasks.length === 0 && <p className="empty">{q ? 'No task matches.' : status === 'open' ? 'No open tasks.' : 'Nothing done yet.'}</p>}
      <div className="stack">
        {groups
          .filter((g) => g.items.length)
          .map((g) => (
            <section key={g.title} className="card" aria-label={g.title}>
              <div className="card-head">
                <h2>{g.title}</h2>
                <span className="card-aside">{g.items.length}</span>
              </div>
              <div className="rows">
                {g.items.map((t) => (
                  <TaskRow key={t.id} task={t} today={today} />
                ))}
              </div>
            </section>
          ))}
      </div>
    </SelectScope.Provider>
  );
}

// ------------------------------------------------------------------ notes

interface NoteItem {
  path: string;
  title: string;
  kind: string;
  modified: string;
  date: string | null;
  tags: string[];
  preview: string;
  ring: { needsReview: boolean; decision: string | null; time: string | null } | null;
}

function NewNote({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  useEffect(() => {
    if (open) {
      setTitle('');
      setBody('');
    }
  }, [open]);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="New note"
      testId="new-note-sheet"
      footer={
        <button
          type="button"
          className="btn btn-primary btn-block"
          disabled={!title.trim()}
          onClick={async () => {
            try {
              await write({ path: 'api/quick', body: { type: 'note', text: title, body }, kind: 'quick', label: 'New note' });
              toast('Note created in Inbox');
              onClose();
            } catch (e) {
              toast(e instanceof ApiError ? e.message : 'Not saved.', 'error');
            }
          }}
          data-testid="note-create"
        >
          Create note
        </button>
      }
    >
      <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" aria-label="Title" />
      <textarea className="textarea" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Plain text" aria-label="Note text" rows={10} />
    </Sheet>
  );
}

function NotesTab() {
  const [params, setParams] = useSearchParams();
  const ring = params.get('ring') ?? '';
  const [q, setQ] = useState('');
  const { data } = useResource<{ notes: NoteItem[] }>(`api/lists/notes?q=${encodeURIComponent(q)}&ring=${ring}`);
  const [open, setOpen] = useState<NoteItem | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const gone = useGone();
  const capture: Capture | null = open?.ring
    ? { path: open.path, slug: open.path.split('/').pop()!.replace(/\.md$/, ''), title: open.title, date: open.date, time: open.ring.time, tags: open.tags, needsReview: open.ring.needsReview, hasTask: false, decision: open.ring.decision, preview: open.preview }
    : null;
  return (
    <SelectScope.Provider value="notes">
      <div className="list-tools">
        <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search notes" aria-label="Search notes" />
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)} data-testid="new-note">
          <Plus aria-hidden /> Note
        </button>
      </div>
      {ring && (
        <p className="filter-line">
          {ring === 'review' ? 'Ring captures that need review' : 'Ring captures from today'}.{' '}
          <button type="button" className="btn-link" onClick={() => setParams({})}>
            Show all notes
          </button>
        </p>
      )}
      <section className="card" aria-label="Notes">
        {data && data.notes.length === 0 && <p className="empty">{q ? 'No note matches.' : 'No notes here.'}</p>}
        <div className="rows">
          {data?.notes.filter((n) => !gone.has(n.path)).map((n) => (
            <NoteRow key={n.path} n={n} onOpen={() => setOpen(n)} onEdit={() => setEditing(n.path)} />
          ))}
        </div>
      </section>
      {open && !open.ring && <NoteSheet path={open.path} onClose={() => setOpen(null)} />}
      {editing && <NoteSheet path={editing} onClose={() => setEditing(null)} />}
      <CaptureSheet capture={capture} onClose={() => setOpen(null)} />
      <NewNote open={creating} onClose={() => setCreating(false)} />
    </SelectScope.Provider>
  );
}

/** A note: swipe right opens it, left archives it (a note is never destroyed); hold for the menu. */
function NoteRow({ n, onOpen, onEdit }: { n: NoteItem; onOpen: () => void; onEdit: () => void }) {
  const archive = () => void archivePaths([{ path: n.path, label: n.title }]);
  const select: Selectable = { key: n.path, kind: 'note', label: n.title, path: n.path };
  return (
    <SwipeRow
      rowKey={n.path}
      className="note-row"
      testId="note-row"
      menuTitle={n.title}
      select={select}
      right={{ label: 'Open', icon: <BookOpen aria-hidden />, tone: 'accent', run: onOpen }}
      left={{ label: 'Archive', icon: <Archive aria-hidden />, tone: 'warn', away: true, run: archive }}
      menu={() => [
        { label: n.ring ? 'Edit title and tags' : 'Edit', icon: <Pencil aria-hidden />, run: onEdit, testId: 'menu-edit' },
        ...(n.ring ? [] : [{ label: 'Move', icon: <FolderInput aria-hidden />, run: () => openMove({ kind: 'note', items: [select] }), testId: 'menu-move' }]),
        { label: 'Archive', icon: <Archive aria-hidden />, run: archive, tone: 'danger' as const, testId: 'menu-archive' },
      ]}
    >
      <button type="button" className="row-open row-main" onClick={(e) => void drillIn(e.currentTarget, onOpen)} data-testid="note-open">
        <span className="row-title">{n.title}</span>
        {n.preview && <span className="note-preview">{n.preview}</span>}
        <span className="row-meta">
          <span className="tag">{shortDate(zonedParts(new Date(n.modified), localZone()).date)}</span>
          {n.ring && <span className="tag">Ring{n.ring.time ? ` ${n.ring.time}` : ''}</span>}
          {n.ring?.needsReview && !n.ring.decision && <span className="tag due-over">needs-review</span>}
          {n.ring?.decision && <span className="tag goal">{n.ring.decision}</span>}
        </span>
      </button>
    </SwipeRow>
  );
}

// ------------------------------------------------------------------ links

/** A link: tap or swipe right opens it in the browser; swipe left deletes the line; hold for Edit. */
function LinkRow({ l }: { l: LinkItem }) {
  const [editing, setEditing] = useState(false);
  const key = `link:${l.hash}`;
  const ref = { path: LINKS_PATH, line: l.line, hash: l.hash };
  const remove = () => void deleteLines([{ ref, kind: 'link', key, label: l.title }]);
  const openIt = () => window.open(l.url, '_blank', 'noopener,noreferrer');
  return (
    <>
      <SwipeRow
        rowKey={key}
        className="link-row"
        testId="link-row"
        menuTitle={l.title}
        select={{ key, kind: 'link', label: l.title, ref }}
        right={{ label: 'Open', icon: <ExternalLink aria-hidden />, tone: 'accent', run: openIt }}
        left={{ label: 'Delete', icon: <Trash2 aria-hidden />, tone: 'danger', away: true, run: remove }}
        menu={() => [
          { label: 'Edit', icon: <Pencil aria-hidden />, run: () => setEditing(true), testId: 'menu-edit' },
          { label: 'Open in the browser', icon: <ExternalLink aria-hidden />, run: openIt, testId: 'menu-open' },
          { label: 'Delete', icon: <Trash2 aria-hidden />, run: remove, tone: 'danger', testId: 'menu-delete' },
        ]}
      >
        <a className="row-open row-main" href={l.url} target="_blank" rel="noreferrer noopener" data-testid="link-open-row">
          <span className="row-title">{l.title}</span>
          <span className="row-meta">
            <span className="tag">{host(l.url)}</span>
            {l.tags.map((t) => (
              <span key={t} className="tag">
                #{t}
              </span>
            ))}
            {l.saved && <span className="caption">saved {shortDate(l.saved)}</span>}
          </span>
          {l.note && <span className="note-preview">{l.note}</span>}
        </a>
        <button type="button" className="icon-btn row-edit" aria-label={`Edit ${l.title}`} onClick={() => setEditing(true)} data-testid="link-edit">
          <Pencil aria-hidden />
        </button>
      </SwipeRow>
      {editing && <LinkSheet link={l} onClose={() => setEditing(false)} />}
    </>
  );
}

function LinksTab() {
  const { data } = useResource<{ links: LinkItem[] }>('api/lists/links');
  const gone = useGone();
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  return (
    <SelectScope.Provider value="links">
      <div className="list-tools">
        <button type="button" className="btn btn-primary" onClick={() => setAdding(true)} data-testid="save-link">
          <Plus aria-hidden /> Save link
        </button>
      </div>
      <section className="card" aria-label="Links">
        {data && data.links.length === 0 && <p className="empty">No links yet. They live in Resources/links.md.</p>}
        <div className="rows">
          {data?.links
            .filter((l) => !gone.has(`link:${l.hash}`))
            .map((l) => (
              <LinkRow key={`${l.line}:${l.hash}`} l={l} />
            ))}
        </div>
      </section>
      <Sheet
        open={adding}
        onClose={() => setAdding(false)}
        title="Save link"
        testId="link-sheet"
        footer={
          <button
            type="button"
            className="btn btn-primary btn-block"
            disabled={!/^https?:\/\/\S+$/.test(url.trim())}
            onClick={async () => {
              try {
                await write({ path: 'api/links', body: { url: url.trim(), title: title.trim() || host(url.trim()), tags: [] }, kind: 'link', label: 'Save link' });
                toast('Saved to Resources/links.md');
                setUrl('');
                setTitle('');
                setAdding(false);
              } catch (e) {
                toast(e instanceof ApiError ? e.message : 'Not saved.', 'error');
              }
            }}
          >
            Save link
          </button>
        }
      >
        <input className="input" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" aria-label="Link" />
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional)" aria-label="Title" />
        <p className="caption">LifeOS does not open the page to fetch a title.</p>
      </Sheet>
    </SelectScope.Provider>
  );
}

// ------------------------------------------------------------------ shopping and wishlist

/**
 * An item: tick it (or swipe right), swipe left to delete, hold for the menu, tap its words to edit;
 * the grip reorders it (drag, or the arrow keys when it has focus).
 */
function ItemRow({ it, kind, index, onDrag, onStep }: { it: ListItem; kind: 'shopping' | 'wishlist'; index?: number; onDrag?: (e: React.PointerEvent<HTMLElement>, index: number) => void; onStep?: (index: number, by: -1 | 1) => void }) {
  const done = useEffectiveStatus(it) === 'done';
  const [editing, setEditing] = useState(false);
  const toggle = (el: HTMLElement | null) => {
    const p = done ? reopenTask(it) : completeTask(it, el);
    p.catch((e: unknown) => toast(e instanceof ApiError ? e.message : 'Not saved.', 'error'));
  };
  const remove = () => void deleteLines([{ ref: anchorOf(it), kind: 'item', key: it.id, label: it.label }]);
  const select: Selectable = { key: it.id, kind: 'item', label: it.label, ref: anchorOf(it), open: !done && !it.bought };
  const move = () => openMove({ kind: 'item', from: kind, items: [select] });
  return (
    <>
      <SwipeRow
        rowKey={it.id}
        data-check=""
        data-done={done ? '' : undefined}
        testId="item-row"
        menuTitle={it.label}
        select={select}
        right={it.bought ? { label: 'Back', icon: <RotateCcw aria-hidden />, tone: 'accent', run: () => void unbuy(it) } : { label: done ? 'Untick' : kind === 'shopping' ? 'Got it' : 'Done', icon: done ? <RotateCcw aria-hidden /> : <CheckIcon aria-hidden />, tone: 'ok', run: () => toggle(checkOf(it.id)) }}
        left={{ label: 'Delete', icon: <Trash2 aria-hidden />, tone: 'danger', away: true, run: remove }}
        menu={() => [
          { label: 'Edit', icon: <Pencil aria-hidden />, run: () => setEditing(true), testId: 'menu-edit' },
          it.bought ? { label: 'Back on the list', icon: <RotateCcw aria-hidden />, run: () => void unbuy(it), testId: 'menu-unbuy' } : { label: 'Move', icon: <FolderInput aria-hidden />, run: move, testId: 'menu-move' },
          { label: 'Delete', icon: <Trash2 aria-hidden />, run: remove, tone: 'danger', testId: 'menu-delete' },
        ]}
      >
        <Check checked={done} label={`${done ? 'Untick' : 'Tick'}: ${it.label}`} onToggle={toggle} />
        <div className="row-main">
          <button type="button" className="row-title row-open" onClick={(e) => void drillIn(e.currentTarget, () => setEditing(true))} data-testid="item-open">
            {it.label}
          </button>
          {(it.extras.price || it.extras.url || it.tags.length > 0) && (
            <span className="row-meta">
              {it.extras.price && <span className="tag">{it.extras.price}</span>}
              {it.tags.map((t) => (
                <span key={t} className="tag">
                  #{t}
                </span>
              ))}
              {it.extras.url && (
                <a className="tag" href={it.extras.url} target="_blank" rel="noreferrer noopener">
                  {host(it.extras.url)}
                </a>
              )}
            </span>
          )}
        </div>
        {onDrag && index !== undefined && (
          <button
            type="button"
            className="icon-btn drag-handle"
            data-noswipe
            aria-label={`Reorder ${it.label}: drag, or use the up and down arrow keys`}
            onPointerDown={(e) => onDrag(e, index)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault();
                onStep?.(index, e.key === 'ArrowUp' ? -1 : 1);
              }
            }}
            data-testid="item-drag"
          >
            <GripVertical aria-hidden />
          </button>
        )}
      </SwipeRow>
      {editing && <ItemSheet it={it} kind={kind} onClose={() => setEditing(false)} />}
    </>
  );
}

/**
 * Drag to reorder (round-2 brief §12): the row follows the finger by its grip, the rows it passes
 * make room, and the drop writes the item's line just above the row it landed before (one line
 * moved in the note). Nothing re-renders during the drag; the list takes the new order at once.
 */
function useReorder(rowsRef: React.RefObject<HTMLDivElement | null>, items: ListItem[], kind: 'shopping' | 'wishlist') {
  const [order, setOrder] = useState<string[] | null>(null);
  useEffect(() => setOrder(null), [items]);
  const byId = new Map(items.map((i) => [i.id, i]));
  const shown = order ? order.map((id) => byId.get(id)).filter((x): x is ListItem => !!x) : items;
  const commit = (from: number, to: number) => {
    if (from === to || to < 0 || to >= shown.length) return;
    const next = shown.slice();
    const [moving] = next.splice(from, 1);
    next.splice(to, 0, moving);
    setOrder(next.map((i) => i.id));
    const before = next[to + 1] ?? null;
    write({ path: 'api/lists/items/reorder', body: { ...anchorOf(moving), before: before ? { line: before.line, hash: before.hash } : null }, kind: 'reorder', ref: moving.id, label: `Reorder ${kind}` }).catch((e: unknown) => {
      setOrder(null);
      toast(errText(e, 'Not reordered.'), 'error');
    });
  };
  const onDrag = (e: React.PointerEvent<HTMLElement>, index: number) => {
    const handle = e.currentTarget;
    const box = rowsRef.current;
    if (!box || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const rows = [...box.querySelectorAll<HTMLElement>(':scope > [data-testid="item-row"]')];
    const rects = rows.map((r) => r.getBoundingClientRect());
    const row = rows[index];
    const h = rects[index].height;
    const y0 = e.clientY;
    let target = index;
    box.dataset.dragging = '';
    row.dataset.dragging = '';
    const move = (ev: PointerEvent) => {
      const dy = ev.clientY - y0;
      row.style.transform = `translate3d(0, ${dy}px, 0)`;
      const mid = rects[index].top + h / 2 + dy;
      let t = 0;
      for (let i = 0; i < rects.length; i++) if (i !== index && rects[i].top + rects[i].height / 2 < mid) t++;
      target = t;
      rows.forEach((r, i) => {
        if (i === index) return;
        const shift = index < target && i > index && i <= target ? -h : index > target && i >= target && i < index ? h : 0;
        r.style.transform = shift ? `translate3d(0, ${shift}px, 0)` : '';
      });
    };
    const end = (drop: boolean) => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onCancel);
      delete box.dataset.dragging;
      delete row.dataset.dragging;
      rows.forEach((r) => (r.style.transform = ''));
      if (drop && target !== index) commit(index, target);
    };
    const onUp = () => end(true);
    const onCancel = () => end(false);
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onCancel);
  };
  return { shown, onDrag, onStep: (i: number, by: -1 | 1) => commit(i, i + by) };
}

function ItemsTab({ kind }: { kind: 'shopping' | 'wishlist' }) {
  const { data } = useResource<{ path: string; items: ListItem[] }>(`api/lists/${kind}`);
  const gone = useGone();
  const [text, setText] = useState('');
  const [showBought, setShowBought] = useState(false);
  const rowsRef = useRef<HTMLDivElement>(null);
  const all = useMemo(() => data?.items.filter((i) => !gone.has(i.id)) ?? [], [data, gone]);
  const items = useMemo(() => all.filter((i) => !i.bought), [all]);
  const bought = all.filter((i) => i.bought);
  const ticked = items.filter((i) => i.status === 'done').length;
  const { shown, onDrag, onStep } = useReorder(rowsRef, items, kind);
  const add = async () => {
    if (!text.trim()) return;
    try {
      // the same light syntax as Quick Add: a URL and ~$price are kept with the item
      await write({ path: 'api/quick', body: { type: kind, text }, kind: 'quick', label: kind === 'shopping' ? 'Shopping' : 'Wishlist' });
      setText('');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Not saved.', 'error');
    }
  };
  return (
    <SelectScope.Provider value={kind}>
      <div className="list-tools">
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void add()} placeholder={kind === 'shopping' ? 'Add to shopping' : 'Add a wish (~$45, a link)'} aria-label="New item" data-testid="item-input" />
        <button type="button" className="btn btn-primary" disabled={!text.trim()} onClick={() => void add()} data-testid="item-add">
          Add
        </button>
      </div>
      <section className="card" aria-label={kind}>
        {data && items.length === 0 && <p className="empty">{kind === 'shopping' ? 'Nothing to buy.' : 'The wishlist is empty.'}</p>}
        <div className="rows" ref={rowsRef}>
          {shown.map((it, i) => (
            <ItemRow key={it.id} it={it} kind={kind} index={i} onDrag={shown.length > 1 ? onDrag : undefined} onStep={onStep} />
          ))}
        </div>
        {kind === 'shopping' && ticked > 0 && (
          <div className="card-foot">
            <button
              type="button"
              className="btn"
              onClick={async () => {
                try {
                  await write({ path: 'api/lists/shopping/clear-bought', kind: 'clear', label: 'Clear bought' });
                } catch (e) {
                  toast(e instanceof ApiError ? e.message : 'Not saved.', 'error');
                }
              }}
              data-testid="clear-bought"
            >
              Clear {ticked} bought
            </button>
          </div>
        )}
      </section>
      {kind === 'shopping' && bought.length > 0 && (
        <button type="button" className="btn btn-ghost section-toggle" aria-expanded={showBought} onClick={() => setShowBought(!showBought)} data-testid="show-bought">
          {showBought ? 'Hide' : 'Show'} {bought.length} bought
        </button>
      )}
      {showBought && (
        <section className="card" aria-label="Bought">
          <div className="rows">
            {bought.map((it) => (
              <ItemRow key={it.id} it={it} kind={kind} />
            ))}
          </div>
        </section>
      )}
    </SelectScope.Provider>
  );
}

/** Each segment's screen. */
function Segment({ tab }: { tab: Tab }) {
  if (tab === 'tasks') return <TasksTab />;
  if (tab === 'notes') return <NotesTab />;
  if (tab === 'links') return <LinksTab />;
  return <ItemsTab kind={tab} />;
}

/**
 * Lists (spec §4.5, round-2 brief §7): the five segments stay mounted once shown (the others are
 * mounted while the app is idle, their data already fetched), and a switch is a 150 ms cross-fade
 * that keeps the list's height and each segment's scroll position (lib/segments.ts).
 */
export function ListsScreen() {
  const { tab = 'tasks' } = useParams();
  const navigate = useNavigate();
  const t = (TABS.find((x) => x.value === tab)?.value ?? 'tasks') as Tab;
  const bodyRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState<ReadonlySet<Tab>>(() => new Set([t]));
  const shown = useRef<Tab>(t);
  const segs = useRef(new Map<Tab, HTMLElement>());
  const has = mounted.has(t) ? mounted : new Set([...mounted, t]);
  // a selection belongs to one list
  useEffect(() => endSelect(), [t]);
  // the segment on screen is the one the address names; the switch runs before the frame is drawn
  useLayoutEffect(() => {
    if (!mounted.has(t)) setMounted((m) => new Set([...m, t]));
    const body = bodyRef.current;
    const to = segs.current.get(t);
    if (!body || !to || shown.current === t) return;
    const from = segs.current.get(shown.current) ?? null;
    switchSegment(body, from, to, { from: shown.current, to: t });
    shown.current = t;
  }, [t, mounted]);
  // the other segments are mounted, hidden, once Lists is on screen, one per idle period (their
  // data is already in memory); never while the app warms its other tabs or a slide or scroll runs
  useEffect(() => warmSegments(bodyRef.current, TABS.map((x) => x.value), (k) => setMounted((m) => (m.has(k) ? m : new Set([...m, k])))), []);
  const segRef = useCallback(
    (k: Tab) => (el: HTMLElement | null) => {
      if (!el) {
        segs.current.delete(k);
        return;
      }
      segs.current.set(k, el);
      if (!el.dataset.state) setSegState(el, k === shown.current ? 'active' : 'hidden');
    },
    [],
  );
  const refs = useMemo(() => Object.fromEntries(TABS.map((x) => [x.value, segRef(x.value)])) as Record<Tab, (el: HTMLElement | null) => void>, [segRef]);
  return (
    <div className="page lists" data-testid="lists">
      <div className="page-head">
        <h1>Lists</h1>
        <SearchButton cat={t === 'shopping' || t === 'wishlist' ? 'shopping' : 'web'} />
      </div>
      <div className="lists-switch">
        <Segmented label="List" fill value={t} onChange={(v) => v !== t && navigate(`/lists/${v}`)} options={TABS.map((x) => ({ ...x, testId: `list-${x.value}` }))} testId="lists-switch" />
      </div>
      <div className="lists-body" ref={bodyRef} data-testid="lists-body">
        {TABS.filter((x) => has.has(x.value)).map((x) => (
          <section key={x.value} className="seg-pane" data-seg={x.value} ref={refs[x.value]} aria-label={x.label}>
            <Segment tab={x.value} />
          </section>
        ))}
      </div>
    </div>
  );
}
