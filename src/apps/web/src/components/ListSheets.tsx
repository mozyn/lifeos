/**
 * Shopping and wishlist items, and links, edited in place (round-2 brief §12). An item: its words,
 * price, link and tags; Move (the other list, a task group); Delete; a bought one back on the list.
 * A link: title, URL, tags and note; Open; Delete. Each is one line, rewritten where it is.
 */
import { useEffect, useState } from 'react';
import { ExternalLink, FolderInput, RotateCcw, Trash2 } from 'lucide-react';
import { Sheet } from './ui';
import { openMove } from './MoveSheet';
import { anchorOf, deleteLines, errText } from '../lib/edits';
import { toast, write } from '../lib/store';
import type { Task } from '../lib/types';

export interface ListItem extends Task {
  label: string;
  extras: { url: string | null; price: string | null };
  bought: boolean;
}

export interface LinkItem {
  line: number;
  hash: string;
  title: string;
  url: string;
  tags: string[];
  note: string | null;
  saved: string | null;
}

export const LINKS_PATH = 'Resources/links.md';
const tagsOf = (s: string) => [...new Set(s.split(/[\s,]+/).map((t) => t.replace(/^#/, '').trim()).filter(Boolean))];
const isUrl = (u: string) => /^https?:\/\/\S+$/i.test(u.trim());

export function unbuy(it: ListItem): Promise<void> {
  return write({ path: 'api/lists/items/unbuy', body: anchorOf(it), kind: 'unbuy', ref: it.id, label: 'Back on the list' })
    .then(() => toast(`${it.label} is back on the list`))
    .catch((e: unknown) => toast(errText(e), 'error'));
}

export function ItemSheet({ it, kind, onClose }: { it: ListItem; kind: 'shopping' | 'wishlist'; onClose: () => void }) {
  const [text, setText] = useState(it.label);
  const [price, setPrice] = useState(it.extras.price?.replace(/^\$/, '') ?? '');
  const [url, setUrl] = useState(it.extras.url ?? '');
  const [tags, setTags] = useState(it.tags.join(' '));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setText(it.label);
    setPrice(it.extras.price?.replace(/^\$/, '') ?? '');
    setUrl(it.extras.url ?? '');
    setTags(it.tags.join(' '));
  }, [it]);
  const tagList = tagsOf(tags);
  const priceOk = !price.trim() || /^\$?\s?\d+(?:[.,]\d{1,2})?$/.test(price.trim());
  const urlOk = !url.trim() || isUrl(url);
  const dirty = text.trim() !== it.label || price.trim() !== (it.extras.price?.replace(/^\$/, '') ?? '') || url.trim() !== (it.extras.url ?? '') || tagList.join(' ') !== it.tags.join(' ');
  const save = async () => {
    setBusy(true);
    try {
      await write({ method: 'PATCH', path: 'api/lists/items', body: { ...anchorOf(it), text: text.trim(), price: price.trim() || null, url: url.trim() || null, tags: tagList }, kind: 'edit', ref: it.id, label: 'Edit item' });
      toast('Saved');
      onClose();
    } catch (e) {
      toast(errText(e, 'Not saved.'), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title={kind === 'shopping' ? 'Shopping item' : 'Wish'}
      testId="item-sheet"
      footer={
        <button type="button" className="btn btn-primary btn-block" disabled={busy || !dirty || !text.trim() || !priceOk || !urlOk} onClick={() => void save()} data-testid="item-save">
          Save changes
        </button>
      }
    >
      <label className="field">
        <span>Item</span>
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} aria-label="Item" data-testid="item-text" />
      </label>
      <div className="edit-row">
        <label className="field" style={{ flex: '0 0 34%' }}>
          <span>Price</span>
          <input className="input" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="12.50" aria-invalid={!priceOk} data-testid="item-price" />
        </label>
        <label className="field" style={{ flex: 1 }}>
          <span>Link</span>
          <input className="input" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" aria-invalid={!urlOk} data-testid="item-url" />
        </label>
      </div>
      <label className="field">
        <span>Tags</span>
        <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="pantry" aria-label="Tags" data-testid="item-tags" />
      </label>
      <div className="sheet-actions">
        {it.bought ? (
          <button
            type="button"
            className="btn"
            onClick={() => {
              onClose();
              void unbuy(it);
            }}
            data-testid="item-unbuy"
          >
            <RotateCcw aria-hidden /> Back on the list
          </button>
        ) : (
          <button type="button" className="btn" onClick={() => openMove({ kind: 'item', from: kind, items: [{ key: it.id, kind: 'item', label: it.label, ref: anchorOf(it), open: it.status === 'open' }], done: onClose })} data-testid="item-move">
            <FolderInput aria-hidden /> Move
          </button>
        )}
        <button
          type="button"
          className="btn btn-ghost btn-danger"
          onClick={() => {
            onClose();
            void deleteLines([{ ref: anchorOf(it), kind: 'item', key: it.id, label: it.label }]);
          }}
          data-testid="item-delete"
        >
          <Trash2 aria-hidden /> Delete
        </button>
      </div>
    </Sheet>
  );
}

export function LinkSheet({ link, onClose }: { link: LinkItem; onClose: () => void }) {
  const [title, setTitle] = useState(link.title);
  const [url, setUrl] = useState(link.url);
  const [tags, setTags] = useState(link.tags.join(' '));
  const [note, setNote] = useState(link.note ?? '');
  const [busy, setBusy] = useState(false);
  const tagList = tagsOf(tags);
  const dirty = title.trim() !== link.title || url.trim() !== link.url || tagList.join(' ') !== link.tags.join(' ') || note.trim() !== (link.note ?? '');
  const save = async () => {
    setBusy(true);
    try {
      await write({ method: 'PATCH', path: 'api/links', body: { path: LINKS_PATH, line: link.line, hash: link.hash, title: title.trim(), url: url.trim(), tags: tagList, note: note.trim() || null }, kind: 'edit', label: 'Edit link' });
      toast('Saved');
      onClose();
    } catch (e) {
      toast(errText(e, 'Not saved.'), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title="Link"
      testId="link-edit-sheet"
      footer={
        <button type="button" className="btn btn-primary btn-block" disabled={busy || !dirty || !title.trim() || !isUrl(url)} onClick={() => void save()} data-testid="link-save">
          Save changes
        </button>
      }
    >
      <label className="field">
        <span>Title</span>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} data-testid="link-title" />
      </label>
      <label className="field">
        <span>Link</span>
        <input className="input" type="url" value={url} onChange={(e) => setUrl(e.target.value)} aria-invalid={!isUrl(url)} data-testid="link-url" />
      </label>
      <label className="field">
        <span>Tags</span>
        <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="recipes" data-testid="link-tags" />
      </label>
      <label className="field">
        <span>Note</span>
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="why it was saved" data-testid="link-note" />
      </label>
      <div className="sheet-actions">
        <a className="btn" href={link.url} target="_blank" rel="noreferrer noopener" data-testid="link-open">
          <ExternalLink aria-hidden /> Open
        </a>
        <button
          type="button"
          className="btn btn-ghost btn-danger"
          onClick={() => {
            onClose();
            void deleteLines([{ ref: { path: LINKS_PATH, line: link.line, hash: link.hash }, kind: 'link', key: `link:${link.hash}`, label: link.title }]);
          }}
          data-testid="link-delete"
        >
          <Trash2 aria-hidden /> Delete
        </button>
      </div>
    </Sheet>
  );
}
