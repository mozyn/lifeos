/**
 * Pieces the three Calendar views share: Add event (the weekly note's shape, spec §5.9), the prayer
 * line, the streak mark of a day and the sheet that names its habits (round-2 brief §3, §4).
 */
import { type ReactNode, useEffect, useState } from 'react';
import { CalendarClock, Flame, Pencil, Trash2 } from 'lucide-react';
import { dayMark, FIVE, hm12, longDate, noteLabel, PRAYER_LABELS, shortDateDow, splitPlace } from '@lifeos/shared';
import { Sheet } from '../../components/ui';
import { ApiError } from '../../lib/api';
import { PRIVATE_LABEL, usePrivacy } from '../../lib/privacy';
import { toast, write } from '../../lib/store';
import type { EventItem, HabitDay } from '../../lib/types';
import { SwipeRow } from '../../components/SwipeRow';
import { anchorOf, deleteLines, useGone } from '../../lib/edits';

export function AddEvent({ open, onClose, initialDate }: { open: boolean; onClose: () => void; initialDate: string }) {
  const [date, setDate] = useState(initialDate);
  const [time, setTime] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setDate(initialDate);
      setTime('');
      setText('');
    }
  }, [open, initialDate]);
  const save = async () => {
    if (!text.trim() || !date) return;
    setBusy(true);
    try {
      await write({ path: 'api/events', body: { date, time: time || null, text }, kind: 'event', label: 'Add event' });
      toast(`Added to ${shortDateDow(date)}`);
      onClose();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Not saved.', 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Add event"
      testId="event-sheet"
      initialFocus="input[name=text]"
      footer={
        <button type="button" className="btn btn-primary btn-block" disabled={busy || !text.trim() || !date} onClick={() => void save()} data-testid="event-save">
          Add event
        </button>
      }
    >
      <label className="field">
        <span>What</span>
        <input className="input" name="text" value={text} onChange={(e) => setText(e.target.value)} placeholder="Dinner at the Haddads' — Canton" data-testid="event-text" />
      </label>
      <div className="edit-row">
        <label className="field" style={{ flex: 1 }}>
          <span>Day</span>
          <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} data-testid="event-date" />
        </label>
        <label className="field" style={{ flex: 1 }}>
          <span>Time (optional)</span>
          <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} data-testid="event-time" />
        </label>
      </div>
      <p className="caption">Saved in that week&rsquo;s weekly note, under its day, the way the ring pipeline writes events.</p>
    </Sheet>
  );
}

/**
 * An event (round-2 brief §12): tap, or swipe right, to edit its time, words and place or move it to
 * another day; swipe left deletes its bullet (Undo puts it back); hold for the menu. `selectable`:
 * its menu's Select starts a bulk selection with the tasks around it (the Week agenda, round-3
 * brief §4); Today's event lines are summaries beside its task cards and stay out of a selection.
 */
export function EventRow({ e, as = 'li', className, testId, swipe = true, selectable = false, children }: { e: EventItem; as?: 'li' | 'div'; className?: string; testId: string; swipe?: boolean; selectable?: boolean; children: ReactNode }) {
  const [editing, setEditing] = useState<false | 'edit' | 'move'>(false);
  const gone = useGone();
  if (gone.has(e.id)) return null;
  const remove = () => void deleteLines([{ ref: anchorOf(e), kind: 'event', key: e.id, label: e.text }]);
  return (
    <>
      <SwipeRow
        as={as}
        plain
        rowKey={e.id}
        className={className}
        testId={testId}
        menuTitle={e.text}
        select={selectable ? { key: e.id, kind: 'event', label: e.text, ref: anchorOf(e) } : null}
        right={swipe ? { label: 'Edit', icon: <Pencil aria-hidden />, tone: 'accent', run: () => setEditing('edit') } : null}
        left={swipe ? { label: 'Delete', icon: <Trash2 aria-hidden />, tone: 'danger', away: true, run: remove } : null}
        menu={() => [
          { label: 'Edit', icon: <Pencil aria-hidden />, run: () => setEditing('edit'), testId: 'menu-edit' },
          { label: 'Move to another day', icon: <CalendarClock aria-hidden />, run: () => setEditing('move'), testId: 'menu-move' },
          { label: 'Delete', icon: <Trash2 aria-hidden />, run: remove, tone: 'danger', testId: 'menu-delete' },
        ]}
      >
        <button type="button" className="row-open ev-open" onClick={() => setEditing('edit')} aria-label={`${e.time ? hm12(e.time) : 'All day'}: ${e.text}. Edit`} data-testid="event-open">
          {children}
        </button>
      </SwipeRow>
      {editing && <EventSheet e={e} focus={editing} onClose={() => setEditing(false)} />}
    </>
  );
}

export function EventSheet({ e, focus, onClose }: { e: EventItem; focus: 'edit' | 'move'; onClose: () => void }) {
  const parts = splitPlace(e.text);
  const [text, setText] = useState(parts.text);
  const [place, setPlace] = useState(parts.place ?? '');
  const [date, setDate] = useState(e.date);
  const [time, setTime] = useState(e.time ?? '');
  const [busy, setBusy] = useState(false);
  const dirty = text.trim() !== parts.text || place.trim() !== (parts.place ?? '') || date !== e.date || (time || null) !== e.time;
  const save = async () => {
    setBusy(true);
    try {
      await write({ method: 'PATCH', path: 'api/events', body: { ...anchorOf(e), from: e.date, date, time: time || null, text: text.trim(), place: place.trim() || null }, kind: 'edit', ref: e.id, label: 'Edit event' });
      toast(date !== e.date ? `Moved to ${shortDateDow(date)}` : 'Saved');
      onClose();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Not saved.', 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title="Event"
      testId="event-edit-sheet"
      initialFocus={focus === 'move' ? 'input[type=date]' : 'input[name=text]'}
      footer={
        <button type="button" className="btn btn-primary btn-block" disabled={busy || !dirty || !text.trim() || !date} onClick={() => void save()} data-testid="event-update">
          Save changes
        </button>
      }
    >
      <label className="field">
        <span>What</span>
        <input className="input" name="text" value={text} onChange={(x) => setText(x.target.value)} data-testid="event-edit-text" />
      </label>
      <label className="field">
        <span>Where (optional)</span>
        <input className="input" value={place} onChange={(x) => setPlace(x.target.value)} placeholder="Canton" data-testid="event-edit-place" />
      </label>
      <div className="edit-row">
        <label className="field" style={{ flex: 1 }}>
          <span>Day</span>
          <input className="input" type="date" value={date} onChange={(x) => setDate(x.target.value)} data-testid="event-edit-date" />
        </label>
        <label className="field" style={{ flex: 1 }}>
          <span>Time (optional)</span>
          <input className="input" type="time" value={time} onChange={(x) => setTime(x.target.value)} data-testid="event-edit-time" />
        </label>
      </div>
      <p className="caption">In {noteLabel(e.path)}. Another day moves the bullet to that day (and that week&rsquo;s note).</p>
      <div className="sheet-actions">
        <button
          type="button"
          className="btn btn-ghost btn-danger"
          onClick={() => {
            onClose();
            void deleteLines([{ ref: anchorOf(e), kind: 'event', key: e.id, label: e.text }]);
          }}
          data-testid="event-delete"
        >
          <Trash2 aria-hidden /> Delete
        </button>
      </div>
    </Sheet>
  );
}

export function PrayerLine({ prayers }: { prayers: Record<string, string> }) {
  return (
    <ol className="wk-prayers" aria-label={`Prayer times ${FIVE.map((p) => `${PRAYER_LABELS[p]} ${hm12(prayers[p])}`).join(', ')}`}>
      {FIVE.map((p) => (
        <li key={p}>
          <span className="arc-name">{PRAYER_LABELS[p]}</span>
          <span className="num">{hm12(prayers[p]).replace(/ [AP]M$/, '')}</span>
        </li>
      ))}
    </ol>
  );
}

const VALUE_LABEL = {
  quit: { clean: 'Held', slip: 'Slip', skip: 'Skipped', none: 'Not logged' },
  build: { clean: 'Done', slip: 'Missed', skip: 'Skipped', none: 'Not logged' },
} as const;

/** What a habit's day says, in words. */
export function habitValueLabel(h: Pick<HabitDay, 'kind' | 'value'>): string {
  return VALUE_LABEL[h.kind][h.value ?? 'none'];
}

/** The habits of a day as Privacy mode shows them: private ones out of the marks, named generically. */
export function useVisibleHabits(habits: HabitDay[]): { mark: ReturnType<typeof dayMark>; hidePrivate: boolean } {
  const hidePrivate = usePrivacy();
  return { mark: dayMark(habits, { hidePrivate }), hidePrivate };
}

/** A day's streak mark: a flame when every habit was kept, a muted mark for a slip; tap names the habits. */
export function DayMarkButton({ date, habits, compact }: { date: string; habits: HabitDay[]; compact?: boolean }) {
  const { mark } = useVisibleHabits(habits);
  const [open, setOpen] = useState(false);
  if (!mark) return null;
  const label = mark === 'streak' ? `Every habit kept on ${shortDateDow(date)}` : `A slip on ${shortDateDow(date)}`;
  return (
    <>
      <button type="button" className={`day-mark${compact ? ' compact' : ''}`} data-mark={mark} aria-label={`${label}: show the habits`} onClick={() => setOpen(true)} data-testid="day-mark">
        <Flame aria-hidden />
      </button>
      {open && <HabitDaySheet date={date} habits={habits} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Which habits a day had, and how each went. Private habits are left out while Privacy mode is on. */
export function HabitDaySheet({ date, habits, onClose }: { date: string; habits: HabitDay[]; onClose: () => void }) {
  const { mark, hidePrivate } = useVisibleHabits(habits);
  const shown = hidePrivate ? habits.filter((h) => !h.private) : habits;
  const hidden = habits.length - shown.length;
  return (
    <Sheet open onClose={onClose} title={longDate(date)} testId="habit-day-sheet">
      <p className="secondary">{mark === 'streak' ? 'Every habit due this day was kept.' : mark === 'slip' ? 'A slip this day. It stays in the log; the next day starts fresh.' : 'Habits this day.'}</p>
      <ul className="habit-day-list">
        {shown.map((h) => (
          <li key={h.path} data-value={h.value ?? 'none'}>
            <span>{h.title}</span>
            <span className={`tag${h.value === 'clean' ? ' goal' : h.value === 'slip' ? ' due-over' : ''}`}>{habitValueLabel(h)}</span>
          </li>
        ))}
      </ul>
      {hidden > 0 && <p className="caption">{hidden === 1 ? `One ${PRIVATE_LABEL.toLowerCase()} is` : `${hidden} private habits are`} not shown while Privacy mode is on.</p>}
    </Sheet>
  );
}
