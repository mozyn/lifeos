/**
 * Quick Add (spec §4): one text field and a type picker. The light syntax (tomorrow 5pm, every
 * monday, #tag, @goal, after maghrib) is read as you type and shown as chips, with the same parser
 * the server uses, so what you see is what lands in the vault.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { hm12, parseQuickAdd, type QuickType, shortDateDow, splitGroupInput, takeRepeat, todayIn } from '@lifeos/shared';
import { Search } from 'lucide-react';
import { Sheet } from '../components/ui';
import { openSearch, useSearchEnabled } from '../components/SearchSheet';
import { ApiError } from '../lib/api';
import { toast, write } from '../lib/store';
import { reminderLabel } from '../lib/tasks';

const TYPES: { value: QuickType; label: string; action: string; placeholder: string }[] = [
  { value: 'task', label: 'Task', action: 'Add task', placeholder: 'Call the mosque tomorrow 5pm #family' },
  { value: 'reminder', label: 'Reminder', action: 'Add reminder', placeholder: 'Pay rent on the 1st 9am' },
  { value: 'note', label: 'Note', action: 'Create note', placeholder: 'Note title' },
  { value: 'link', label: 'Link', action: 'Save link', placeholder: 'https://… and a title' },
  { value: 'shopping', label: 'Shopping', action: 'Add to shopping', placeholder: 'Olive oil' },
  { value: 'wishlist', label: 'Wishlist', action: 'Add to wishlist', placeholder: 'Pixel Watch band ~$45 #gift' },
];

const DONE: Record<QuickType, string> = { task: 'Task added', reminder: 'Reminder added', note: 'Note created', link: 'Link saved', shopping: 'Added to shopping', wishlist: 'Added to wishlist' };

export function QuickAdd({ open, onClose, initialType }: { open: boolean; onClose: () => void; initialType?: string }) {
  const [type, setType] = useState<QuickType>('task');
  const [text, setText] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const searchOn = useSearchEnabled();
  useEffect(() => {
    if (open) {
      setType((initialType as QuickType) ?? 'task');
      setText('');
      setBody('');
      setError(null);
    }
  }, [open, initialType]);
  const now = new Date();
  const today = todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone, now);
  const q = useMemo(() => parseQuickAdd(text, { today, now: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}` }), [text, today]); // eslint-disable-line react-hooks/exhaustive-deps
  const t = TYPES.find((x) => x.value === type)!;
  const understood: string[] = [];
  // a group (round-2 brief §10): "Weekly shopping every saturday: olive oil; call the butcher"
  const group = type === 'task' ? splitGroupInput(text) : null;
  const shown = group ? parseQuickAdd(group.head, { today, now: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}` }) : q;
  if (group) {
    understood.push(`Group of ${group.items.length}`);
    const own = group.items.filter((i) => takeRepeat(i).recur).length;
    if (own) understood.push(own === 1 ? '1 item repeats on its own' : `${own} items repeat on their own`);
  }
  if (type === 'task' || type === 'reminder') {
    if (shown.date) understood.push(shown.date === today ? 'Today' : shortDateDow(shown.date));
    if (shown.reminder) understood.push(shown.reminder.includes(' ') ? `Remind ${hm12(shown.reminder.slice(11))}` : `Remind ${reminderLabel(shown.reminder)?.toLowerCase()}`);
    if (shown.recur) understood.push(shown.recur.replace(/^every/, 'Every'));
    if (shown.priority) understood.push(shown.priority === 'low' || shown.priority === 'lowest' ? 'Low priority' : 'High priority');
  }
  if (q.url && (type === 'link' || type === 'wishlist')) understood.push('Link');
  for (const s of shown.slugs) understood.push(`@${s}`);
  for (const tag of shown.tags) understood.push(`#${tag}`);

  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await write<{ ok: boolean }>({ path: 'api/quick', body: { type, text, body: type === 'note' ? body : undefined }, kind: 'quick', label: t.action });
      toast(r.queued ? `${DONE[type]} (offline: it will be saved when you are back online)` : DONE[type]);
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Quick Add"
      initialFocus="input"
      testId="quick-add-sheet"
      className="sheet-quick"
      dock={false}
      footer={
        <button type="button" className="btn btn-primary btn-block" disabled={!text.trim() || busy} onClick={() => void submit()} data-testid="quick-add-submit">
          {group ? 'Add group' : t.action}
        </button>
      }
      tools={
        <div className="chips" role="radiogroup" aria-label="Type" data-testid="quick-add-types">
          {TYPES.map((x) => (
            <button
              key={x.value}
              type="button"
              role="radio"
              aria-checked={type === x.value}
              className="pick"
              // the field keeps focus (and the keyboard stays up) while the type changes
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setType(x.value);
                input.current?.focus({ preventScroll: true });
              }}
              data-testid={`quick-type-${x.value}`}
            >
              {x.label}
            </button>
          ))}
        </div>
      }
    >
      <label className="field">
        <span className="sr-only">{t.label}</span>
        <input
          ref={input}
          className="input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && type !== 'note') {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={t.placeholder}
          autoComplete="off"
          enterKeyHint="done"
          data-testid="quick-add-input"
        />
      </label>
      {type === 'note' && <textarea className="textarea" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write the note (plain text)" aria-label="Note text" />}
      {understood.length > 0 && (
        <div className="row-meta" aria-label="Understood">
          {understood.map((u) => (
            <span key={u} className="tag due-today">
              {u}
            </span>
          ))}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {searchOn && (
        <button
          type="button"
          className="btn btn-ghost quick-search"
          onClick={() => {
            // find it on the web first, then file it from the result (round-2 brief §8)
            const words = (q.text || text).trim();
            onClose();
            openSearch({ q: words, cat: type === 'shopping' || type === 'wishlist' ? 'shopping' : 'web' });
          }}
          data-testid="quick-search"
        >
          <Search aria-hidden />
          {text.trim() ? `Search the web for “${(q.text || text).trim().slice(0, 40)}”` : 'Search the web'}
        </button>
      )}
    </Sheet>
  );
}
