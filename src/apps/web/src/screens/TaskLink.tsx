/**
 * A task opened from a reminder's link (spec §8: <LIFEOS_PUBLIC_URL>/t/<id>, from Telegram or a browser notification).
 * Done and snooze happen here, not in Telegram.
 */
import { useParams, useNavigate } from 'react-router';
import { addDays, todayIn } from '@lifeos/shared';
import { TaskRow } from '../components/TaskRow';
import { ApiError } from '../lib/api';
import { toast, useResource, write } from '../lib/store';
import type { Task } from '../lib/types';

export function TaskLink() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, error } = useResource<{ task: Task }>(id ? `api/tasks/${id}` : null);
  const today = todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const t = data?.task;
  const snooze = async (due: string, reminder: string | null) => {
    if (!t) return;
    try {
      await write({ method: 'PATCH', path: `api/tasks/${t.id}`, body: { path: t.path, line: t.line, hash: t.hash, due, reminder }, kind: 'snooze', ref: t.id, label: 'Snooze' });
      toast('Snoozed');
      navigate('/today');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Not saved.', 'error');
    }
  };
  return (
    <div className="page" data-testid="task-link">
      <h1 className="page-title">Reminder</h1>
      {error && (
        <section className="card">
          <p className="secondary">{error instanceof ApiError && error.status === 404 ? 'This task changed or was completed elsewhere since the reminder was sent.' : error.message}</p>
        </section>
      )}
      {t && (
        <section className="card">
          <div className="rows">
            <TaskRow task={t} today={today} />
          </div>
          {t.status === 'open' && !t.readonly && (
            <div className="card-foot">
              <button type="button" className="btn" onClick={() => void snooze(today, `${today} ${new Date(Date.now() + 3600_000).toTimeString().slice(0, 5)}`)}>
                In an hour
              </button>
              <button type="button" className="btn" onClick={() => void snooze(addDays(today, 1), `${addDays(today, 1)} 09:00`)}>
                Tomorrow morning
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
