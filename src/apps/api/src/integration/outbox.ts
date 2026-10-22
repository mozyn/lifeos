/**
 * What Hermes delivers to Telegram (product brief 9 §1, ADR-87). Each poll first records the task
 * reminders whose moment has come, by the rules LifeOS's own bot follows (spec §8: the reminder's
 * time, held through quiet hours unless ⏫, never more than 24 h late), then offers everything
 * recorded since the poll's `since` that Hermes has not acknowledged. Habit nudges join when they
 * are made (a slip before 20:00, the 20:00 nudge), with the verbatim library entry and the labelled
 * encouragement exactly as LifeOS's own bot would send them.
 *
 * Once each: an item has the delivery's key (file + line hash for a reminder, habit + day for a
 * nudge). Not before the token: a reminder that came due before Hermes was connected is not offered
 * (a new connection is not flooded with old reminders). Not twice to Telegram: nothing LifeOS's own
 * bot already sent is offered, and the bot leaves to Hermes what it fetched in the last 10 minutes
 * and records as sent what it acknowledged (scheduler.ts, the nudge senders in app.ts and goals.ts).
 */
import { randomBytes } from 'node:crypto';
import { decide, fireTime, isUrgent, MAX_LATE_MS, releaseTime, zonedParts } from '@lifeos/shared';
import { appLink } from '../address.js';
import type { Ctx } from '../context.js';
import type { DB } from '../db.js';
import { reminderText } from '../scheduler.js';
import { allTasks, habitsView } from '../views.js';
import { PrivateHabits } from '../ai/private.js';
import type { IntegrationTokens } from './tokens.js';

export interface OutboxRow {
  key: string;
  id: string;
  kind: 'reminder' | 'nudge';
  ref: string | null;
  title: string;
  text: string;
  link: string;
  fire_at: string | null;
  due_at: string;
  listed_at: string | null;
  acked_at: string | null;
}

export function outboxDto(r: OutboxRow) {
  return { id: r.id, kind: r.kind, title: r.title, text: r.text, link: r.link, due_at: r.due_at, ...(r.fire_at ? { fire_at: r.fire_at } : {}) };
}

export const nudgeKey = (habitPath: string, date: string) => `nudge|${habitPath}|${date}`;

/** How long LifeOS's own bot leaves an item Hermes fetched to Hermes before sending it itself. */
export const HERMES_HOLD_MS = 10 * 60_000;

/**
 * Whether LifeOS's own bot should leave an item to Hermes (ADR-87): 'sent' when Hermes acknowledged
 * it (the bot records it as sent), 'hold' while Hermes fetched it in the last 10 minutes, else null.
 */
export function agentHolds(db: DB, key: string, now: Date): { state: 'sent'; at: string } | { state: 'hold' } | null {
  const r = db.prepare('SELECT listed_at, acked_at FROM hermes_outbox WHERE key = ?').get(key) as { listed_at: string | null; acked_at: string | null } | undefined;
  if (!r) return null;
  if (r.acked_at) return { state: 'sent', at: r.acked_at };
  if (r.listed_at && now.getTime() - Date.parse(r.listed_at) < HERMES_HOLD_MS) return { state: 'hold' };
  return null;
}

export class AgentOutbox {
  constructor(
    private readonly ctx: Ctx,
    private readonly tokens: IntegrationTokens,
  ) {}

  private put(r: Omit<OutboxRow, 'id' | 'acked_at' | 'listed_at'>): boolean {
    const id = `r_${randomBytes(6).toString('hex')}`;
    return (
      this.ctx.db
        .prepare('INSERT OR IGNORE INTO hermes_outbox (key, id, kind, ref, title, text, link, fire_at, due_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(r.key, id, r.kind, r.ref, r.title, r.text, r.link, r.fire_at, r.due_at).changes > 0
    );
  }

  /** Record the task reminders deliverable now (called by each poll, on the stack's clock). */
  collect(now: Date): number {
    const token = this.tokens.active();
    if (!token) return 0;
    const since = Date.parse(token.created_at);
    const s = this.ctx.settings();
    const tz = this.ctx.tz();
    const today = zonedParts(now, tz).date;
    const known = this.ctx.db.prepare('SELECT 1 FROM hermes_outbox WHERE key = ?');
    const priv = new PrivateHabits(habitsView(this.ctx, today, true));
    const botSent = this.ctx.db.prepare("SELECT 1 FROM deliveries WHERE key = ? AND status = 'sent'");
    const url = this.ctx.publicUrl();
    let added = 0;
    for (const t of allTasks(this.ctx)) {
      if (t.status !== 'open' || !t.reminder || t.kind === 'archive') continue;
      const key = `${t.path}|${t.hash}`;
      if (known.get(key)) continue;
      const fire = fireTime({ reminder: t.reminder, due: t.due, priority: t.priority }, today, s.prayer);
      if (!fire) continue;
      const urgent = isUrgent(t.priority);
      if (decide(fire, now, urgent, { start: s.quietStart, end: s.quietEnd, tz }).action !== 'send') continue;
      const release = urgent ? fire : releaseTime(fire, s.quietStart, s.quietEnd, tz);
      if (release.getTime() < since || botSent.get(key)) continue;
      // a task's words pass the same scrub as in the context: Hermes never reads a private habit's name
      if (this.put({ key, kind: 'reminder', ref: t.id, title: priv.scrub(t.title), text: priv.scrub(reminderText(t, today, url)), link: appLink(url, `/t/${t.id}`), fire_at: fire.toISOString(), due_at: now.toISOString() })) added++;
    }
    return added;
  }

  /**
   * A habit nudge for Hermes to send (only while a token exists). `readyAt`: when it may go; a nudge
   * waiting for Hermes's own encouragement waits up to the usual 120 s for it (ADR-86).
   */
  offerNudge(n: { draftId: string; habitPath: string; date: string; title: string; text: string }, readyAt: Date): boolean {
    if (!this.tokens.active()) return false;
    return this.put({ key: nudgeKey(n.habitPath, n.date), kind: 'nudge', ref: n.draftId, title: n.title, text: n.text, link: appLink(this.ctx.publicUrl(), '/habits'), fire_at: null, due_at: readyAt.toISOString() });
  }

  /** Hermes's encouragement arrived: the nudge's text with it, and it may go now (unless already acknowledged). */
  updateNudge(habitPath: string, date: string, text: string, now: Date): void {
    this.ctx.db
      .prepare('UPDATE hermes_outbox SET text = ?, due_at = min(due_at, ?) WHERE key = ? AND acked_at IS NULL')
      .run(text, now.toISOString(), nudgeKey(habitPath, date));
  }

  /**
   * What came due after `since` (and by `now`), not acknowledged, at most 24 h old and none from
   * before the token in force; nothing LifeOS's own bot has sent meanwhile. Marked as fetched.
   */
  list(since: Date, now: Date): OutboxRow[] {
    const token = this.tokens.active();
    if (!token) return [];
    const floor = new Date(Math.max(since.getTime(), now.getTime() - MAX_LATE_MS, Date.parse(token.created_at) - 1)).toISOString();
    const rows = this.ctx.db
      .prepare(
        `SELECT * FROM hermes_outbox o WHERE acked_at IS NULL AND due_at > ? AND due_at <= ?
           AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.key = o.key AND d.status = 'sent')
           AND NOT EXISTS (SELECT 1 FROM nudges n WHERE o.kind = 'nudge' AND o.key = 'nudge|' || n.habit || '|' || n.date)
         ORDER BY due_at, key`,
      )
      .all(floor, now.toISOString()) as OutboxRow[];
    const mark = this.ctx.db.prepare('UPDATE hermes_outbox SET listed_at = ? WHERE id = ? AND listed_at IS NULL');
    for (const r of rows) mark.run(now.toISOString(), r.id);
    return rows;
  }

  /** Hermes delivered these; returns how many were newly acknowledged. */
  ack(ids: string[], now: Date): number {
    const stmt = this.ctx.db.prepare('UPDATE hermes_outbox SET acked_at = ? WHERE id = ? AND acked_at IS NULL');
    const row = this.ctx.db.prepare("SELECT key FROM hermes_outbox WHERE id = ? AND kind = 'nudge'");
    // a nudge Hermes sent counts as the day's sent nudge for that habit (LifeOS's bot stops there)
    const sentNudge = this.ctx.db.prepare('INSERT OR IGNORE INTO nudges (habit, date, kind, at) VALUES (?, ?, ?, ?)');
    let n = 0;
    this.ctx.db.transaction(() => {
      for (const id of ids) {
        const changed = stmt.run(now.toISOString(), id).changes;
        n += changed;
        const k = changed ? (row.get(id) as { key: string } | undefined) : undefined;
        const m = k ? /^nudge\|(.+)\|(\d{4}-\d{2}-\d{2})$/.exec(k.key) : null;
        if (m) sentNudge.run(m[1], m[2], 'hermes', now.toISOString());
      }
    })();
    // a month of history is plenty
    this.ctx.db.prepare('DELETE FROM hermes_outbox WHERE due_at < ?').run(new Date(now.getTime() - 30 * 86400_000).toISOString());
    return n;
  }
}
