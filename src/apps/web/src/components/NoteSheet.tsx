/**
 * A note's sheet (round-2 brief §12): title (the file is renamed to match and links to it follow),
 * the text as plain words in a textarea, tags; Move and Archive (a note's Delete). The text is saved
 * only if the note is unchanged since the sheet opened; an edit in Obsidian or by the ring pipeline
 * meanwhile is never overwritten (the sheet says so and keeps what was typed). A ring capture's text
 * is the ring's: its title and tags can be changed, and it can be archived.
 */
import { useEffect, useState } from 'react';
import { Archive, FolderInput } from 'lucide-react';
import { noteLabel } from '@lifeos/shared';
import { Sheet } from './ui';
import { openMove } from './MoveSheet';
import { archivePaths, errText } from '../lib/edits';
import { toast, useResource, write } from '../lib/store';

interface NoteEdit {
  path: string;
  title: string;
  body: string;
  tags: string[];
  sha: string;
  kind: string;
  can: { title: boolean; body: boolean; tags: boolean; move: boolean; archive: boolean };
}

const tagsOf = (s: string) => [...new Set(s.split(/[\s,]+/).map((t) => t.replace(/^#/, '').trim()).filter(Boolean))];

export function NoteSheet({ path, onClose }: { path: string; onClose: () => void }) {
  const { data, error } = useResource<NoteEdit>(`api/notes/edit?path=${encodeURIComponent(path)}`);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState<string | null>(null);
  useEffect(() => {
    // the fields take the note once; a refresh while typing does not wipe what was typed
    if (!data || loaded === data.path) return;
    setTitle(data.title);
    setBody(data.body);
    setTags(data.tags.join(' '));
    setLoaded(data.path);
  }, [data, loaded]);
  const tagList = tagsOf(tags);
  const can = data?.can;
  const titleChanged = !!data && !!title.trim() && title.trim() !== data.title;
  const bodyChanged = !!data && can?.body && body.trimEnd() !== data.body;
  const tagsChanged = !!data && (tagList.length !== data.tags.length || tagList.some((t, i) => t !== data.tags[i]));
  const dirty = titleChanged || bodyChanged || tagsChanged;
  const capture = data?.kind === 'capture';
  const save = async () => {
    if (!data) return;
    setBusy(true);
    try {
      const r = await write<{ path: string }>({
        method: 'PATCH',
        path: 'api/notes',
        body: { path: data.path, title: titleChanged ? title.trim() : undefined, body: bodyChanged ? body : undefined, sha: bodyChanged ? data.sha : undefined, tags: tagsChanged ? tagList : undefined },
        kind: 'note',
        label: 'Note',
      });
      const moved = r.result?.path && r.result.path !== data.path;
      toast(moved ? `Saved; the file is now ${r.result!.path.split('/').pop()}` : 'Note saved');
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
      title={capture ? 'Ring capture' : 'Note'}
      testId="note-sheet"
      footer={
        can && (can.title || can.body || can.tags) ? (
          <button type="button" className="btn btn-primary btn-block" disabled={busy || !dirty} onClick={() => void save()} data-testid="note-save">
            Save changes
          </button>
        ) : undefined
      }
    >
      {!data ? (
        <p className="secondary">{error ? errText(error, 'This note could not be opened.') : 'Loading…'}</p>
      ) : (
        <>
          {can?.title ? (
            <label className="field">
              <span>Title</span>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" data-testid="note-title" />
            </label>
          ) : (
            <p className="sheet-task-title">{data.title}</p>
          )}
          {can?.body ? (
            <textarea className="textarea note-body" value={body} onChange={(e) => setBody(e.target.value)} aria-label="Note text" rows={12} data-testid="note-body" />
          ) : (
            <pre className="note-text" data-testid="note-text">
              {data.body}
            </pre>
          )}
          {can?.tags && (
            <label className="field">
              <span>Tags</span>
              <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="garden ideas" aria-label="Tags" data-testid="note-tags" />
            </label>
          )}
          <p className="caption">
            {noteLabel(data.path)}.{' '}
            {capture ? 'The words are the ring’s and stay as they were spoken; the title and tags are yours.' : can?.body ? 'Saved only if nothing changed it since you opened it here.' : 'This note is edited in its own place in LifeOS, or in Obsidian.'}
          </p>
          {(can?.move || can?.archive) && (
            <div className="sheet-actions">
              {can.move && (
                <button type="button" className="btn" onClick={() => openMove({ kind: 'note', items: [{ key: data.path, kind: 'note', label: data.title, path: data.path }], done: onClose })} data-testid="note-move">
                  <FolderInput aria-hidden /> Move
                </button>
              )}
              {can.archive && (
                <button
                  type="button"
                  className="btn btn-ghost btn-danger"
                  onClick={() => {
                    onClose();
                    void archivePaths([{ path: data.path, label: data.title }]);
                  }}
                  data-testid="note-archive"
                >
                  <Archive aria-hidden /> Archive
                </button>
              )}
            </div>
          )}
        </>
      )}
    </Sheet>
  );
}
