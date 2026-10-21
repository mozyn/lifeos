/**
 * Morning plan and evening review (spec §9 jobs 1–2): when they are due, how an approval is written,
 * and the deterministic fallbacks. The AI path (M6) produces the same payloads through the queue;
 * whichever wins, nothing reaches the vault until the owner approves.
 */
import { addDays, fallbackPlan, formatTask, hm12, nextPrayer, normTitle, PRAYER_LABELS, prayerTimes, type TaskLite } from '@lifeos/shared';
import type { Ctx } from './context.js';
import { Drafts, type DraftRow, HERMES_LATE, HERMES_WAITING, type PlanPayload, type ReviewPayload } from './drafts.js';
import { allTasks, capturesView, eventsBetween, habitsView, planBullets, unsortedToday } from './views.js';
import { NotFound, Forbidden } from './vault/ops.js';
import { aiActive, hermesDrafts, offReason } from './ai/endpoint.js';

export type Generator = (kind: 'morning_plan' | 'evening_review', date: string) => void;

export class Planner {
  readonly drafts: Drafts;
  /** set by the AI queue (M6): asked to generate instead of the immediate fallback */
  generator: Generator | null = null;
  /** set by the integration API's jobs (ADR-86): asked first while Hermes writes the drafts */
  agentDraft: Generator | null = null;
  /** drafts being approved right now (their writes are under way): Hermes may not replace them */
  readonly deciding = new Set<string>();

  constructor(private readonly ctx: Ctx) {
    this.drafts = new Drafts(ctx.db, ctx.now);
  }

  /** Morning plan: on first open after 04:00 (or at 05:30 by the scheduler), once a day, unless a plan is already written. */
  ensureMorning(): void {
    const date = this.ctx.today();
    if (this.ctx.hm() < '04:00') return;
    if (planBullets(this.ctx, date).length) return;
    if (this.drafts.latest('morning_plan', date, ['generating', 'pending', 'approved', 'dismissed'])) return;
    this.draft('morning_plan', date);
  }

  /** Evening review: on opening Today after 17:00 (or at 20:00), once a day. */
  ensureEvening(): void {
    const date = this.ctx.today();
    if (this.ctx.hm() < '17:00') return;
    if (this.drafts.latest('evening_review', date, ['generating', 'pending', 'approved', 'dismissed'])) return;
    this.draft('evening_review', date);
  }

  /** A draft now: Hermes's (it is waited for), the model's (queued), else the plain one. */
  draft(kind: 'morning_plan' | 'evening_review', date: string): void {
    if (this.agentDraft && hermesDrafts(this.ctx)) return this.agentDraft(kind, date);
    if (this.generator && aiActive(this.ctx)) return this.generator(kind, date);
    const reason = aiActive(this.ctx) ? null : offReason(this.ctx);
    if (kind === 'morning_plan') this.insertFallbackPlan(date, reason);
    else this.insertFallbackReview(date, reason);
  }

  fallbackPlan(date: string): PlanPayload {
    const s = this.ctx.settings();
    const tasks = allTasks(this.ctx) as TaskLite[];
    const events = eventsBetween(this.ctx, date, date).length;
    const isToday = date === this.ctx.today();
    let next: string;
    if (isToday) {
      const np = nextPrayer(this.ctx.now(), s.prayer);
      next = `${PRAYER_LABELS[np.name]} ${hm12(np.time)}`;
    } else next = `Fajr ${hm12(prayerTimes(date, s.prayer).fajr)}`;
    return fallbackPlan(tasks, date, events, next);
  }

  insertFallbackPlan(date: string, reason: string | null): DraftRow {
    const d = this.drafts.insert({
      kind: 'morning_plan',
      date,
      payload: this.fallbackPlan(date),
      sources: ['index: open tasks due by today', `Weekly Notes (events on ${date})`, 'prayer times (offline)'],
      fallback: true,
      fallbackReason: reason ?? 'model unavailable',
      model: null,
    });
    this.drafts.supersede('morning_plan', date, null, d.id);
    return d;
  }

  fallbackReview(date: string): ReviewPayload {
    const tasks = allTasks(this.ctx);
    const done = tasks.filter((t) => t.status === 'done' && t.done === date).length;
    const open = tasks.filter((t) => t.status === 'open' && !t.readonly && t.kind !== 'archive' && t.due && t.due <= date).length;
    const habits = habitsView(this.ctx, date).filter((h) => h.scheduledToday);
    const logged = habits.filter((h) => h.today).length;
    const review = `Done today: ${done}. Still open and due: ${open}. Habits logged: ${logged} of ${habits.length}.`;
    const unsorted = unsortedToday(capturesView(this.ctx), date)
      .filter((c) => !c.hasTask)
      .map((c) => ({ capture_file: c.path, suggestion: 'task' as const, text: c.title }));
    const tomorrow = this.fallbackPlan(addDays(date, 1));
    return { review, unsorted, tomorrow: { headline: tomorrow.headline, focus: tomorrow.focus.map((f) => f.text) } };
  }

  insertFallbackReview(date: string, reason: string | null): DraftRow {
    const d = this.drafts.insert({
      kind: 'evening_review',
      date,
      payload: this.fallbackReview(date),
      sources: [`Daily Notes/${date}.md`, 'index: tasks done and due', 'Areas/Habits', `Inbox/Ring (captures of ${date})`],
      fallback: true,
      fallbackReason: reason ?? 'model unavailable',
    });
    this.drafts.supersede('evening_review', date, null, d.id);
    return d;
  }

  // ---------------------------------------------------------------- decisions

  private pending(id: string, kind: string): DraftRow {
    const d = this.drafts.get(id);
    if (!d || d.kind !== kind) throw new NotFound('draft not found');
    if (d.status !== 'pending') throw new Forbidden(`This draft was already ${d.status}.`);
    return d;
  }

  /** Approve the morning plan (optionally edited): `## Plan` bullets, headline first; new focus items become tasks. */
  async approvePlan(id: string, edited?: PlanPayload): Promise<void> {
    const d = this.pending(id, 'morning_plan');
    this.deciding.add(id);
    try {
      await this.writePlan(d, edited);
    } finally {
      this.deciding.delete(id);
    }
  }

  private async writePlan(d: DraftRow, edited?: PlanPayload): Promise<void> {
    const id = d.id;
    const p = edited ?? (JSON.parse(d.payload) as PlanPayload);
    const bullets = [p.headline, ...p.focus.map((f) => f.text)].map((b) => b.trim()).filter(Boolean);
    await this.ctx.ops.appendPlan(d.date, bullets);
    for (const f of p.focus.filter((x) => x.new && x.text.trim())) await this.ctx.ops.addTaskToday(d.date, formatTask({ text: f.text, due: d.date }));
    if (edited) this.drafts.update(id, { payload: JSON.stringify(edited) });
    this.drafts.decide(id, 'approved');
  }

  /** Approve the evening review: `## Review`, the chosen capture actions, and tomorrow's plan as the next morning's pending draft. */
  async approveReview(id: string, edited?: ReviewPayload): Promise<void> {
    const d = this.pending(id, 'evening_review');
    this.deciding.add(id);
    try {
      await this.writeReview(d, edited);
    } finally {
      this.deciding.delete(id);
    }
  }

  private async writeReview(d: DraftRow, edited?: ReviewPayload): Promise<void> {
    const id = d.id;
    const p = edited ?? (JSON.parse(d.payload) as ReviewPayload);
    if (p.review.trim()) await this.ctx.ops.writeReview(d.date, p.review.trim());
    for (const u of p.unsorted) await this.resolveCapture(u.capture_file, u.suggestion, u.text, d.date);
    const tomorrow = addDays(d.date, 1);
    const open = allTasks(this.ctx).filter((t) => t.status === 'open');
    const byTitle = new Map(open.map((t) => [normTitle(t.title), t.id]));
    const plan: PlanPayload = {
      headline: p.tomorrow.headline,
      focus: p.tomorrow.focus.map((text) => ({ text, source_task_id: byTitle.get(normTitle(text)) ?? null, new: !byTitle.has(normTitle(text)) })),
      notes: [],
    };
    // tomorrow's plan is the owner's (approved, perhaps edited): never one Hermes may still replace
    const waited = d.fallback_reason === HERMES_LATE || d.fallback_reason === HERMES_WAITING;
    const next = this.drafts.insert({ kind: 'morning_plan', date: tomorrow, payload: plan, sources: [`evening review of ${d.date}`, ...(JSON.parse(d.sources) as string[])], fallback: !!d.fallback, fallbackReason: waited ? 'a plain evening review (Hermes had not answered)' : d.fallback_reason, model: d.model, promptTokens: d.prompt_tokens });
    this.drafts.supersede('morning_plan', tomorrow, null, next.id);
    if (edited) this.drafts.update(id, { payload: JSON.stringify(edited) });
    this.drafts.decide(id, 'approved');
  }

  dismiss(id: string): void {
    const d = this.drafts.get(id);
    if (!d) throw new NotFound('draft not found');
    if (d.status === 'pending' || d.status === 'generating') this.drafts.decide(id, 'dismissed');
  }

  /** "make task / make note / ignore" on a ring capture (spec §6 evening, §5 `lifeos:` key). */
  async resolveCapture(path: string, decision: 'task' | 'note' | 'ignore' | 'ignored', text: string, date = this.ctx.today()): Promise<void> {
    if (decision === 'task') {
      const slug = path.split('/').pop()!.replace(/\.md$/, '');
      await this.ctx.ops.addTaskToday(date, `${formatTask({ text: text.trim() || slug })} — [[${slug}]]`);
      await this.ctx.ops.setCaptureDecision(path, 'task');
    } else await this.ctx.ops.setCaptureDecision(path, decision === 'note' ? 'note' : 'ignored');
  }
}
