/**
 * The minute scheduler (spec §8, §9): delivers `⏰` reminders whose time has passed (once each,
 * keyed by file + line hash), holds them through quiet hours (⏫ bypasses), retries Telegram with
 * backoff, and starts the timed AI jobs (morning plan at 05:30, evening review and habit nudges at
 * 20:00). Reminders more than 24 h late are recorded as expired, never sent.
 */
import { backoffMs, dateTimeText, decide, fireTime, hm12, instantText, isUrgent, MAX_LATE_MS, shortDateDow, zonedParts } from '@lifeos/shared';
import type { Ctx } from './context.js';
import type { Planner } from './planner.js';
import type { Sender } from './telegram.js';
import type { BrowserPush } from './browser-push.js';
import type { TaskDto } from './routes/tasks.js';
import { allTasks } from './views.js';
import { agentHolds } from './integration/outbox.js';

export interface DeliveryRow {
  key: string;
  task_id: string | null;
  path: string;
  fire_at: string;
  status: 'sent' | 'held' | 'retry' | 'failed' | 'expired';
  attempts: number;
  next_attempt_at: string | null;
  sent_at: string | null;
  error: string | null;
  text: string;
  kind: string;
}

export function reminderText(t: TaskDto, today: string, publicUrl: string): string {
  const parts: string[] = [];
  if (t.due) parts.push(t.due === today ? 'Due today' : t.due < today ? `Overdue since ${shortDateDow(t.due)}` : `Due ${shortDateDow(t.due)}`);
  if (t.slugs.length) parts.push(`Goal: ${t.slugs.join(', ')}`);
  return [`⏰ ${t.title}`, parts.join('. '), `${publicUrl}/t/${t.id}`].filter(Boolean).join('\n');
}

/** A browser notification's second line: when it is due and its goal (the link is the tap). */
export function reminderBody(t: TaskDto, today: string): string {
  const parts: string[] = [];
  if (t.due) parts.push(t.due === today ? 'Due today' : t.due < today ? `Overdue since ${shortDateDow(t.due)}` : `Due ${shortDateDow(t.due)}`);
  if (t.slugs.length) parts.push(`Goal: ${t.slugs.join(', ')}`);
  return parts.join('. ') || 'Reminder';
}

export class Scheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  /** extra work for each tick (the AI nudges, M6) */
  readonly hooks: ((now: Date) => Promise<void> | void)[] = [];

  constructor(
    private readonly ctx: Ctx,
    private readonly planner: Planner,
    private readonly sender: Sender,
    /** browser notifications (ADR-80): one push per reminder to each subscribed device */
    private readonly push: BrowserPush | null = null,
  ) {}

  start(): void {
    const loop = () => {
      void this.tick().finally(() => {
        const ms = 60_000 - (Date.now() % 60_000) + 500;
        this.timer = setTimeout(loop, ms);
        this.timer.unref?.();
      });
    };
    this.timer = setTimeout(loop, 5_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  enabled(): boolean {
    return this.ctx.config.telegram && this.ctx.settings().telegram && this.sender.configured;
  }

  /**
   * One pass. `timed` runs the clock-driven jobs (morning plan, evening review, nudge hooks). The
   * demo and e2e stacks run on a simulated clock carried by each request, so their background loop
   * (real time) leaves those jobs to the requests; otherwise it would draft "today" at the wrong hour.
   */
  async tick(now: Date = new Date(), timed = this.ctx.config.mode !== 'demo' && this.ctx.config.mode !== 'e2e'): Promise<{ sent: number; held: number; failed: number; expired: number }> {
    const stats = { sent: 0, held: 0, failed: 0, expired: 0 };
    if (this.running) return stats;
    this.running = true;
    try {
      const { time } = zonedParts(now, this.ctx.tz());
      // timed AI jobs (they no-op when today's draft exists)
      if (timed) {
        try {
          if (time >= '05:30') this.planner.ensureMorning();
          if (time >= '20:00') this.planner.ensureEvening();
        } catch {
          /* a draft failure must not stop reminders */
        }
      }
      await this.deliver(now, stats);
      if (timed) for (const h of this.hooks) await Promise.resolve(h(now)).catch(() => undefined);
    } finally {
      this.running = false;
    }
    return stats;
  }

  private async deliver(now: Date, stats: { sent: number; held: number; failed: number; expired: number }) {
    const s = this.ctx.settings();
    const today = zonedParts(now, this.ctx.tz()).date;
    const get = this.ctx.db.prepare('SELECT * FROM deliveries WHERE key = ?');
    const upsert = this.ctx.db.prepare(
      `INSERT INTO deliveries (key, task_id, path, fire_at, status, attempts, next_attempt_at, sent_at, error, text, kind)
       VALUES (@key, @task_id, @path, @fire_at, @status, @attempts, @next_attempt_at, @sent_at, @error, @text, 'task')
       ON CONFLICT(key) DO UPDATE SET task_id = excluded.task_id, fire_at = excluded.fire_at, status = excluded.status, attempts = excluded.attempts,
         next_attempt_at = excluded.next_attempt_at, sent_at = excluded.sent_at, error = excluded.error, text = excluded.text`,
    );
    const tasks = allTasks(this.ctx).filter((t) => t.status === 'open' && t.reminder && t.kind !== 'archive');
    for (const t of tasks) {
      const key = `${t.path}|${t.hash}`;
      const row = get.get(key) as DeliveryRow | undefined;
      if (row && (row.status === 'sent' || row.status === 'expired' || row.status === 'failed')) continue;
      if (row?.status === 'retry' && row.next_attempt_at && Date.parse(row.next_attempt_at) > now.getTime()) continue;
      const fire = fireTime({ reminder: t.reminder!, due: t.due, priority: t.priority }, today, s.prayer);
      if (!fire) continue;
      const d = decide(fire, now, isUrgent(t.priority), { start: s.quietStart, end: s.quietEnd, tz: this.ctx.tz() });
      const base = { key, task_id: t.id, path: t.path, fire_at: fire.toISOString(), attempts: row?.attempts ?? 0, next_attempt_at: null as string | null, sent_at: null as string | null, error: null as string | null, text: reminderText(t, today, this.ctx.config.publicUrl) };
      if (d.action === 'wait') continue;
      if (d.action === 'expire') {
        upsert.run({ ...base, status: 'expired' });
        stats.expired++;
        continue;
      }
      if (d.action === 'hold') {
        if (row?.status !== 'held') upsert.run({ ...base, status: 'held', next_attempt_at: d.until.toISOString() });
        stats.held++;
        continue;
      }
      // the in-app surfaces need nothing; a device with browser notifications gets one push (once
      // per reminder, retried on its own), whether or not Telegram is set up
      if (this.push && this.push.devices().length) {
        await this.push.send({ title: `⏰ ${t.title}`, body: reminderBody(t, today), url: `t/${t.id}`, tag: key }, { key, urgency: isUrgent(t.priority) ? 'high' : 'normal' }).catch(() => undefined);
      }
      if (!this.enabled()) continue;
      // Hermes sends this one to Telegram (integration API, ADR-87): once is enough. Acknowledged:
      // recorded as sent; fetched in the last 10 minutes: left to Hermes for now
      const viaHermes = agentHolds(this.ctx.db, key, now);
      if (viaHermes?.state === 'sent') {
        upsert.run({ ...base, status: 'sent', sent_at: viaHermes.at });
        continue;
      }
      if (viaHermes?.state === 'hold') continue;
      try {
        await this.sender.send(base.text);
        upsert.run({ ...base, status: 'sent', attempts: base.attempts + 1, sent_at: now.toISOString() });
        stats.sent++;
      } catch (e) {
        const attempts = base.attempts + 1;
        const giveUp = now.getTime() - fire.getTime() > MAX_LATE_MS;
        upsert.run({ ...base, status: giveUp ? 'failed' : 'retry', attempts, next_attempt_at: new Date(now.getTime() + backoffMs(attempts)).toISOString(), error: (e as Error).message.slice(0, 300) });
        stats.failed++;
      }
    }
  }

  /** A labelled test message (Settings → Reminders, and M3's one real delivery check). */
  async sendTest(): Promise<{ messageId: number | null }> {
    const when = instantText(new Date(), { tz: this.ctx.tz(), year: true });
    return this.sender.send(`🧪 LifeOS test message (${when}). This is a delivery check, not a reminder: reminders will arrive in this topic. You can ignore it.\n${this.ctx.config.publicUrl}/today`);
  }

  /** Upcoming reminders (next 7 days) and recent deliveries, for Settings → Reminders. */
  overview(now: Date = new Date()) {
    const s = this.ctx.settings();
    const today = zonedParts(now, this.ctx.tz()).date;
    const upcoming = allTasks(this.ctx)
      .filter((t) => t.status === 'open' && t.reminder && t.kind !== 'archive')
      .map((t) => ({ t, fire: fireTime({ reminder: t.reminder!, due: t.due, priority: t.priority }, today, s.prayer) }))
      .filter((x) => x.fire && x.fire.getTime() > now.getTime() - 3600_000 && x.fire.getTime() < now.getTime() + 7 * 86400_000)
      .sort((a, b) => a.fire!.getTime() - b.fire!.getTime())
      .slice(0, 30)
      .map(({ t, fire }) => {
        const p = zonedParts(fire!, this.ctx.tz());
        return { id: t.id, title: t.title, when: p.date === today ? `Today ${hm12(p.time)}` : dateTimeText(p.date, p.time), at: fire!.toISOString(), urgent: isUrgent(t.priority) };
      });
    const recent = this.ctx.db.prepare('SELECT key, task_id, fire_at, status, attempts, sent_at, error FROM deliveries ORDER BY coalesce(sent_at, fire_at) DESC LIMIT 20').all();
    return { enabled: this.enabled(), configured: this.sender.configured, devices: this.push?.devices().length ?? 0, upcoming, recent };
  }
}
