/**
 * The three AI jobs written by Hermes (product brief 9 §1–2, ADR-86). LifeOS calls no model: a plan
 * or review that is due waits as a draft (Today: "Waiting for Hermes"); `GET /api/integration/jobs`
 * gives Hermes each waiting job with the very prompt LifeOS's own model would get (built by the AI
 * service, private habits already ids, task and capture ids T1…/C1…) and the JSON Schema of the
 * reply; `POST /api/integration/drafts` takes the reply through the same checks as the model's
 * (schema, ids, no attribution to a religious source, the scripture guard for encouragement) and
 * leaves a pending draft for the owner to approve. Nothing is ever applied by Hermes.
 *
 * After the usual 120 s (a model job's deadline, JOB_TIMEOUT_MS) a plan or review that Hermes has
 * not answered becomes the plain draft; it stays wanted, so Hermes's draft still takes its place
 * while nobody has decided on it. A nudge shows the fixed sentence at once and takes Hermes's words
 * when they come and pass the guard.
 */
import { createHash } from 'node:crypto';
import type { Ctx } from '../context.js';
import { type DraftRow, HERMES_LATE, HERMES_WAITING, type PlanPayload, type ReviewPayload } from '../drafts.js';
import { HttpError } from '../http.js';
import type { LibraryEntry, NudgePayload, Nudges } from '../nudges.js';
import type { Planner } from '../planner.js';
import type { TaskDto } from '../routes/tasks.js';
import { allTasks, capturesView, habitsView } from '../views.js';
import { hermesDrafts, offReason } from '../ai/endpoint.js';
import { JOB_TIMEOUT_MS } from '../ai/queue.js';
import { type AiService, ModelOutputError, NUDGE_SCHEMA, parseJson, PLAN_SCHEMA, planFrom, REVIEW_SCHEMA, reviewFrom } from '../ai/service.js';
import type { ChatMessage } from '../ai/provider.js';
import type { AgentOutbox } from './outbox.js';

export type JobKind = 'morning_plan' | 'evening_review' | 'habit_nudge';

/** When Hermes is asked to look for jobs (context `schedule`): the scheduler's own 05:30 and 20:00, and once in the midday moment. */
export const JOB_TIMES = { morning: '05:30', midday: '12:30', evening: '20:00' } as const;

const SCHEMAS: Record<JobKind, { name: string; schema: unknown; maxTokens: number }> = {
  morning_plan: { name: 'morning_plan', schema: PLAN_SCHEMA, maxTokens: 700 },
  evening_review: { name: 'evening_review', schema: REVIEW_SCHEMA, maxTokens: 800 },
  habit_nudge: { name: 'habit_nudge', schema: NUDGE_SCHEMA, maxTokens: 300 },
};

/** What a draft shows as its writer: "Hermes (the model it named)". */
export const hermesLabel = (model: string | null) => (model ? `Hermes (${model})` : 'Hermes');

/** The short ids of one prompt given to Hermes (T1 → task id, C1 → capture path) and its sources. */
interface PromptIds {
  tasks?: Record<string, string>;
  captures?: Record<string, string>;
  sources?: string[];
}

/**
 * What a draft keeps for Hermes (`drafts.ids`): the ids of each prompt version it was given (a job's
 * id carries its version, so a reply is read with the ids of the prompt it answers, even after a
 * later poll numbered the tasks differently), and how many encouragements the guard refused.
 */
interface StoredIds {
  versions?: Record<string, PromptIds>;
  latest?: string;
  rejected?: number;
}

/** A nudge may be answered again after the guard refuses it, up to three times. */
const GUARD_TRIES = 3;

const parseIds = (raw: string | null): StoredIds => {
  try {
    return raw ? (JSON.parse(raw) as StoredIds) : {};
  } catch {
    return {};
  }
};

export interface Job {
  id: string;
  kind: JobKind;
  day: string;
  waiting_since: string;
  messages: ChatMessage[];
  schema: unknown;
  max_tokens: number;
}

export class AgentJobs {
  private timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly ctx: Ctx,
    private readonly planner: Planner,
    private readonly nudges: Nudges,
    private readonly ai: AiService,
    private readonly outbox: AgentOutbox,
  ) {}

  /** A plan or review is due: it waits for Hermes (the planner asks this while Hermes writes the drafts). */
  request(kind: 'morning_plan' | 'evening_review', date: string): void {
    const d = this.planner.drafts.insert({ kind, date, payload: {}, sources: [], fallback: false, status: 'generating', via: 'hermes' });
    this.planner.drafts.supersede(kind, date, null, d.id);
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.sweep();
    }, JOB_TIMEOUT_MS + 1000);
    t.unref?.();
    this.timers.add(t);
    this.ctx.vault.notify();
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  /** Waits older than the usual timeout: the plain draft for a plan or review, "did not answer" on a nudge. */
  sweep(now = this.ctx.now()): number {
    const old = new Date(now.getTime() - JOB_TIMEOUT_MS).toISOString();
    let n = 0;
    const waiting = this.ctx.db.prepare("SELECT * FROM drafts WHERE via = 'hermes' AND status = 'generating' AND generated_at <= ?").all(old) as DraftRow[];
    for (const d of waiting) {
      if (d.kind === 'morning_plan') {
        const sources = ['index: open tasks due by today', `Weekly Notes (events on ${d.date})`, 'prayer times (offline)'];
        this.planner.drafts.update(d.id, { status: 'pending', payload: JSON.stringify(this.planner.fallbackPlan(d.date)), sources: JSON.stringify(sources), fallback: 1, fallback_reason: HERMES_LATE, model: null, generated_at: now.toISOString() });
      } else if (d.kind === 'evening_review') {
        const sources = [`Daily Notes/${d.date}.md`, 'index: tasks done and due', 'Areas/Habits', `Inbox/Ring (captures of ${d.date})`];
        this.planner.drafts.update(d.id, { status: 'pending', payload: JSON.stringify(this.planner.fallbackReview(d.date)), sources: JSON.stringify(sources), fallback: 1, fallback_reason: HERMES_LATE, model: null, generated_at: now.toISOString() });
      }
      n++;
    }
    n += this.ctx.db.prepare("UPDATE drafts SET fallback_reason = ? WHERE via = 'hermes' AND kind = 'habit_nudge' AND status = 'pending' AND fallback = 1 AND fallback_reason = ? AND generated_at <= ?").run(HERMES_LATE, HERMES_WAITING, old).changes;
    if (n) this.ctx.vault.notify();
    return n;
  }

  /** Today's drafts that wait for Hermes (or show the plain one in its place). */
  wanted(date = this.ctx.today()): DraftRow[] {
    return this.ctx.db
      .prepare(
        `SELECT * FROM drafts WHERE via = 'hermes' AND date = ? AND (
           (kind IN ('morning_plan', 'evening_review') AND (status = 'generating' OR (status = 'pending' AND fallback = 1 AND fallback_reason = ?)))
           OR (kind = 'habit_nudge' AND status = 'pending' AND fallback = 1 AND fallback_reason IN (?, ?))
         ) ORDER BY generated_at`,
      )
      .all(date, HERMES_LATE, HERMES_WAITING, HERMES_LATE) as DraftRow[];
  }

  /** `GET /api/integration/jobs`: the jobs wanted now, each with its prompt. */
  async list(): Promise<{ writes: boolean; note: string | null; jobs: Job[] }> {
    if (!hermesDrafts(this.ctx)) {
      const note = this.ctx.config.ai && this.ctx.settings().ai ? 'LifeOS writes its drafts itself (Settings → Advanced → AI in LifeOS); there is nothing for you to run.' : `AI drafts are off in LifeOS (${offReason(this.ctx)}); there is nothing for you to run.`;
      return { writes: false, note, jobs: [] };
    }
    // a plan or review that is due now is asked for here too, so a poll at 05:30 never misses it
    this.planner.ensureMorning();
    this.planner.ensureEvening();
    this.sweep();
    const jobs: Job[] = [];
    for (const d of this.wanted()) {
      const p = await this.prompt(d);
      if (!p) continue;
      const s = SCHEMAS[d.kind as JobKind];
      jobs.push({ id: `${d.id}:${p.version}`, kind: d.kind as JobKind, day: d.date, waiting_since: d.generated_at, messages: p.messages, schema: s.schema, max_tokens: s.maxTokens });
    }
    return { writes: true, note: jobs.length ? null : 'Nothing is wanted right now.', jobs };
  }

  /** The job's prompt as LifeOS's own model would get it now; its ids are kept, by version, for the reply. */
  private async prompt(d: DraftRow): Promise<{ messages: ChatMessage[]; version: string } | null> {
    let messages: ChatMessage[];
    let ids: PromptIds | null = null;
    if (d.kind === 'morning_plan') {
      const p = await this.ai.morningPrompt(d.date);
      messages = p.messages;
      ids = { tasks: Object.fromEntries([...p.ids].map(([k, t]) => [k, t.id])), sources: p.sources };
    } else if (d.kind === 'evening_review') {
      const p = await this.ai.eveningPrompt(d.date);
      messages = p.messages;
      ids = { captures: Object.fromEntries([...p.cids].map(([k, c]) => [k, c.path])), sources: p.sources };
    } else {
      const n = this.nudgeParts(d);
      if (!n) return null;
      const note = await this.ctx.vault.read(`Daily Notes/${this.ctx.today()}.md`).catch(() => null);
      messages = this.ai.nudgePrompt(n.habit, n.candidates, note, n.priv);
    }
    const version = createHash('sha1').update(JSON.stringify(messages)).digest('hex').slice(0, 8);
    // read again: another poll may have stored its version meanwhile
    const stored = parseIds(this.planner.drafts.get(d.id)?.ids ?? null);
    const versions = { ...(stored.versions ?? {}) };
    if (ids) {
      delete versions[version];
      versions[version] = ids;
      // the last five prompts are enough to read any reply still on its way
      for (const k of Object.keys(versions).slice(0, -5)) delete versions[k];
    }
    this.planner.drafts.update(d.id, { prompt: JSON.stringify(messages), ids: JSON.stringify({ ...stored, versions, latest: version }) });
    return { messages, version };
  }

  private nudgeParts(d: DraftRow) {
    const all = habitsView(this.ctx, d.date, true);
    const habit = all.find((h) => h.path === d.ref);
    const p = JSON.parse(d.payload) as NudgePayload;
    const candidates = p.candidates.map((id) => this.nudges.library.get(id)).filter((c): c is LibraryEntry => !!c);
    if (!habit || !candidates.length) return null;
    return { habit, candidates, payload: p, priv: this.ai.privateHabits(d.date) };
  }

  /**
   * `POST /api/integration/drafts`: Hermes's reply to a job. `job` is the id from the job list (or,
   * for a plan or review, its kind for today). The reply is the JSON object the schema describes
   * (or that object as text). Returns the pending draft; throws 404/409/422 with a reason Hermes can
   * act on.
   */
  async accept(b: { job?: string; kind?: JobKind; payload: unknown; model: string | null }): Promise<{ id: string; kind: JobKind; status: 'pending' }> {
    this.sweep();
    let d: DraftRow | null = null;
    let version: string | null = null;
    if (b.job) {
      const [id, v] = b.job.split(':');
      version = v ?? null;
      d = this.planner.drafts.get(id);
      if (!d || d.via !== 'hermes') throw new HttpError(404, 'no_job', 'There is no such job. Ask GET /api/integration/jobs for the current ones.');
    } else if (b.kind && b.kind !== 'habit_nudge') {
      d = this.wanted().find((x) => x.kind === b.kind) ?? null;
      if (!d) throw new HttpError(409, 'not_wanted', `No ${b.kind.replace('_', ' ')} is wanted now (GET /api/integration/jobs lists what is).`);
    } else throw new HttpError(400, 'no_job', 'Give the job id from GET /api/integration/jobs.');
    const draft = d;
    const kind = draft.kind as JobKind;
    const decided = () =>
      new HttpError(409, 'decided', this.planner.deciding.has(draft.id) ? 'The owner is approving this draft right now; nothing to do.' : `The owner already decided on this draft (${this.planner.drafts.get(draft.id)?.status ?? 'gone'}); nothing to do.`);
    if (this.planner.deciding.has(draft.id)) throw decided();
    const open = this.wanted(draft.date).some((x) => x.id === draft.id);
    // a draft Hermes already wrote may be written again while it is pending (a retry)
    const again = draft.status === 'pending' && !draft.fallback && kind !== 'habit_nudge';
    if (!open && !again) throw draft.status === 'pending' ? new HttpError(409, 'decided', 'This job was answered already.') : decided();
    let reply: unknown = b.payload;
    let changed = false;
    try {
      if (typeof reply === 'string') reply = parseJson(reply);
      if (!reply || typeof reply !== 'object') throw new ModelOutputError('the payload is not a JSON object');
      const label = hermesLabel(b.model);
      const now = this.ctx.now().toISOString();
      if (kind === 'morning_plan' || kind === 'evening_review') {
        const ids = await this.idsFor(draft, version);
        const priv = this.ai.privateHabits(draft.date);
        let payload: PlanPayload | ReviewPayload;
        if (kind === 'morning_plan') {
          const byId = new Map(allTasks(this.ctx).map((t) => [t.id, t]));
          const tasks = new Map<string, TaskDto>();
          for (const [k, id] of Object.entries(ids.tasks ?? {})) {
            const t = byId.get(id);
            if (t) tasks.set(k, t);
          }
          payload = planFrom(reply, tasks, priv);
        } else {
          const byPath = new Map(capturesView(this.ctx).map((c) => [c.path, c]));
          const cids = new Map<string, { path: string; title: string }>();
          for (const [k, path] of Object.entries(ids.captures ?? {})) {
            const c = byPath.get(path);
            if (c) cids.set(k, { path: c.path, title: c.title });
          }
          payload = reviewFrom(reply, cids, priv);
        }
        // only while nobody has decided (the owner may have approved during the reads above)
        if (this.planner.deciding.has(draft.id)) throw decided();
        changed = this.planner.drafts.updateOpen(draft.id, { status: 'pending', payload: JSON.stringify(payload), model: label, prompt_tokens: null, sources: JSON.stringify(ids.sources ?? []), fallback: 0, fallback_reason: null, generated_at: now });
      } else {
        const n = this.nudgeParts(draft);
        if (!n) throw new HttpError(409, 'decided', 'That habit or its reminders are no longer there; nothing to do.');
        const g = this.ai.guardNudge(reply as { pick?: unknown; encouragement?: unknown }, n.candidates, n.priv);
        if (!g.guard.ok) {
          const stored = parseIds(draft.ids);
          const tries = (stored.rejected ?? 0) + 1;
          const rule = g.guard.rule ?? 'invalid';
          // refused: Hermes may try again in its own words, up to three times; then the fixed sentence stays
          this.planner.drafts.updateOpen(draft.id, { ids: JSON.stringify({ ...stored, rejected: tries }), ...(tries >= GUARD_TRIES ? { fallback_reason: `the guard rejected Hermes's encouragement ${tries} times (${rule})` } : {}) });
          const left = GUARD_TRIES - tries;
          throw new HttpError(422, 'guard', `The encouragement was refused by the scripture guard (${rule}${g.guard.detail ? `: ${g.guard.detail}` : ''}). Write it in your own plain words, at most 60 words, without quoting, paraphrasing or alluding to any scripture or religious figure. ${left > 0 ? `You may post it ${left === 1 ? 'once' : `${left} times`} more.` : 'No more tries: the fixed sentence stays.'}`);
        }
        const entry = n.candidates[g.pick - 1] ?? n.candidates[0];
        const payload: NudgePayload = { ...n.payload, pick: g.pick, entry, encouragement: g.encouragement, encouragementBy: 'model', guard: g.guard };
        changed = this.planner.drafts.updateOpen(draft.id, { payload: JSON.stringify(payload), model: label, fallback: 0, fallback_reason: null });
        if (changed) {
          this.nudges.library.markShown(entry.id, draft.date, `nudge:${n.habit.slug}`);
          this.outbox.updateNudge(n.habit.path, draft.date, this.nudges.text(payload), this.ctx.now());
        }
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
      const msg = e instanceof ModelOutputError ? e.message : (e as { issues?: { path: (string | number)[]; message: string }[] }).issues ? (e as { issues: { path: (string | number)[]; message: string }[] }).issues.map((i) => `${i.path.join('.') || 'payload'}: ${i.message}`).join('; ') : String((e as Error).message ?? e);
      throw new HttpError(422, 'invalid', `The draft does not match the job's schema (${msg.slice(0, 300)}). Nothing was saved; fix it and post again.`);
    }
    if (!changed) throw decided();
    if (kind !== 'habit_nudge') this.planner.drafts.supersede(kind, draft.date, null, draft.id);
    this.ctx.vault.notify();
    return { id: draft.id, kind, status: 'pending' };
  }

  /** The ids of the prompt version a reply answers (the latest one, or built now when Hermes posts without asking first). */
  private async idsFor(d: DraftRow, version: string | null): Promise<PromptIds> {
    let stored = parseIds(d.ids);
    if (!stored.versions || !Object.keys(stored.versions).length) {
      await this.prompt(d);
      stored = parseIds(this.planner.drafts.get(d.id)?.ids ?? null);
    }
    const versions = stored.versions ?? {};
    return (version ? versions[version] : undefined) ?? (stored.latest ? versions[stored.latest] : undefined) ?? {};
  }
}
