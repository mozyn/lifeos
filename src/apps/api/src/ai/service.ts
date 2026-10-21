/**
 * The three AI jobs (spec §9), through the egress wrapper (purpose `ai`), on the endpoint this
 * install chose (ADR-75; a local model unless the owner picked a cloud provider).
 *  1. Morning plan    → { headline, focus[≤5]: { text, source_task_id?, new }, notes }
 *  2. Evening review  → { review (≤120 words), unsorted: [{ capture_file, suggestion, text }], tomorrow: { headline, focus } }
 *  3. Habit nudge     → { pick: 1|2|3, encouragement (≤60 words, own words) } through the scripture guard
 * Prompts carry only what each job needs (§3: never the whole vault): note texts are trimmed,
 * tasks are listed with short ids (T1…), captures as C1…, so the model cannot invent a reference.
 * A private habit is "private habit P1" with its kind and streak only, and no prompt string carries
 * its name or slug (PrivateHabits, ADR-63); the reply's ids become the real name again for the owner.
 * Output is validated (JSON Schema to the server's grammar, then zod and the id maps); on any
 * failure, timeout or a model that is down, the deterministic fallback is used and says so.
 * One job at a time (AiQueue). `content` only; reasoning is never read.
 */
import { z } from 'zod';
import {
  addDays,
  buildCorpus,
  countWords,
  FIVE,
  guardEncouragement,
  hasAttribution,
  hijri,
  hm12,
  longDateYear,
  nextPrayer,
  PRAYER_LABELS,
  prayerTimes,
  normTitle,
  splitLines,
} from '@lifeos/shared';
import type { Ctx } from '../context.js';
import type { PlanPayload, ReviewPayload } from '../drafts.js';
import type { Planner } from '../planner.js';
import type { LibraryEntry, Nudges } from '../nudges.js';
import { allTasks, capturesView, eventsBetween, habitsView, type HabitDto, planBullets, unsortedToday } from '../views.js';
import type { TaskDto } from '../routes/tasks.js';
import { PrivateHabits } from './private.js';
import { OpenAiCompatibleProvider, type ChatMessage, type ProviderHealth } from './provider.js';
import { AnthropicProvider } from './anthropic.js';
import { aiActive, cloudPending, currentEndpoint } from './endpoint.js';

export type ChatProvider = OpenAiCompatibleProvider | AnthropicProvider;

/** A draft made without the model because a cloud provider's first job waits for the owner (ADR-81). */
export const WAITING_FOR_OK = 'waiting for your OK to send to';
export const waitReason = (host: string) => `${WAITING_FOR_OK} ${host}`;
import { AiQueue, type JobOutcome } from './queue.js';

const SYSTEM_RULES =
  'Use only the information given. Never quote, paraphrase or allude to the Qur\'an, hadith or any scripture, and never attribute words to God, a prophet, an imam or a religious figure. No quotation marks around sayings. Reply with JSON only, matching the schema.';

export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', maxLength: 140 },
    focus: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        properties: { text: { type: 'string', maxLength: 160 }, source_task_id: { type: ['string', 'null'] }, new: { type: 'boolean' } },
        required: ['text', 'source_task_id', 'new'],
      },
    },
    notes: { type: 'array', maxItems: 3, items: { type: 'string', maxLength: 200 } },
  },
  required: ['headline', 'focus', 'notes'],
};

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    review: { type: 'string', maxLength: 900 },
    unsorted: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        properties: { capture_file: { type: 'string' }, suggestion: { type: 'string', enum: ['task', 'note', 'ignore'] }, text: { type: 'string', maxLength: 160 } },
        required: ['capture_file', 'suggestion', 'text'],
      },
    },
    tomorrow: {
      type: 'object',
      properties: { headline: { type: 'string', maxLength: 140 }, focus: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 160 } } },
      required: ['headline', 'focus'],
    },
  },
  required: ['review', 'unsorted', 'tomorrow'],
};

export const NUDGE_SCHEMA = {
  type: 'object',
  properties: { pick: { type: 'integer', enum: [1, 2, 3] }, encouragement: { type: 'string', maxLength: 420 } },
  required: ['pick', 'encouragement'],
};

export const PlanOut = z.object({
  headline: z.string().min(1).max(160),
  focus: z.array(z.object({ text: z.string().max(200), source_task_id: z.string().nullable().optional(), new: z.boolean() })).max(5),
  notes: z.array(z.string().max(240)).max(3).default([]),
});
export const ReviewOut = z.object({
  review: z.string().min(1).max(1200),
  unsorted: z.array(z.object({ capture_file: z.string(), suggestion: z.enum(['task', 'note', 'ignore']), text: z.string().max(200) })).max(20),
  tomorrow: z.object({ headline: z.string().min(1).max(160), focus: z.array(z.string().max(200)).max(5) }),
});

export class ModelOutputError extends Error {}

export function parseJson(content: string): unknown {
  const s = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new ModelOutputError('the reply was not JSON');
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    throw new ModelOutputError('the reply was not valid JSON');
  }
}

/** A note's body for a prompt: no frontmatter, no empty template headings, at most `max` characters. */
function trimNote(text: string | null, max: number): string {
  if (!text) return '(none)';
  const lines = splitLines(text).map((l) => l.text);
  let start = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (end > 0) start = end + 1;
  }
  const body = lines.slice(start);
  const kept: string[] = [];
  for (let i = 0; i < body.length; i++) {
    if (/^#{1,6} /.test(body[i])) {
      let j = i + 1;
      while (j < body.length && body[j].trim() === '') j++;
      if (j >= body.length || /^#{1,6} /.test(body[j])) continue; // an empty section
    }
    kept.push(body[i]);
  }
  const out = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return out.length > max ? `${out.slice(0, max)}…` : out || '(empty)';
}

/**
 * A morning plan reply (from the model, or from Hermes through the integration API, ADR-86) made a
 * draft: validated, no attribution to a religious source, private habit ids back to their names,
 * task ids (T1…) back to tasks; an id that was not in the prompt is dropped, a "new" item that is
 * an existing task's words becomes that task. Throws ZodError or ModelOutputError when invalid.
 */
export function planFrom(reply: unknown, ids: Map<string, TaskDto>, priv: PrivateHabits): PlanPayload {
  const raw = PlanOut.parse(reply);
  if (hasAttribution([raw.headline, ...raw.notes, ...raw.focus.map((f) => f.text)].join('\n'))) throw new ModelOutputError('the plan attributed words to a religious source');
  // private habit ids back to their names, for the owner's eyes only
  const out = { headline: priv.relabel(raw.headline), notes: raw.notes.map((n) => priv.relabel(n)), focus: raw.focus.map((f) => ({ ...f, text: priv.relabel(f.text) })) };
  const focus: PlanPayload['focus'] = [];
  for (const f of out.focus) {
    const t = f.source_task_id ? ids.get(f.source_task_id.trim()) : undefined;
    if (f.source_task_id && !t && !f.new) continue; // an id the model invented: dropped
    // a "new" item that is really an existing task (same words) is that task, not a duplicate
    const same = !t ? [...ids.values()].find((x) => normTitle(x.title) === normTitle(f.text)) : undefined;
    if (same) {
      if (!focus.some((x) => x.source_task_id === same.id)) focus.push({ text: same.title, source_task_id: same.id, new: false });
      continue;
    }
    // existing tasks keep their exact title, so the plan bullet matches the task
    focus.push(t ? { text: t.title, source_task_id: t.id, new: false } : { text: f.text.trim(), source_task_id: null, new: true });
  }
  return { headline: out.headline.trim(), focus: focus.slice(0, 5), notes: out.notes.map((n) => n.trim()).filter(Boolean) };
}

/** An evening review reply made a draft (as planFrom): at most 120 words, capture ids (C1…) back to captures. */
export function reviewFrom(reply: unknown, cids: Map<string, { path: string; title: string }>, priv: PrivateHabits): ReviewPayload {
  const raw = ReviewOut.parse(reply);
  if (countWords(raw.review) > 120) throw new ModelOutputError('the review was longer than 120 words');
  if (hasAttribution([raw.review, raw.tomorrow.headline, ...raw.tomorrow.focus, ...raw.unsorted.map((u) => u.text)].join('\n'))) throw new ModelOutputError('the review attributed words to a religious source');
  const out = {
    review: priv.relabel(raw.review),
    unsorted: raw.unsorted.map((u) => ({ ...u, text: priv.relabel(u.text) })),
    tomorrow: { headline: priv.relabel(raw.tomorrow.headline), focus: raw.tomorrow.focus.map((f) => priv.relabel(f)) },
  };
  const unsorted: ReviewPayload['unsorted'] = [];
  for (const u of out.unsorted) {
    const c = cids.get(u.capture_file.trim());
    if (!c || unsorted.some((x) => x.capture_file === c.path)) continue;
    unsorted.push({ capture_file: c.path, suggestion: u.suggestion, text: (u.text || c.title).trim() });
  }
  return { review: out.review.trim(), unsorted, tomorrow: { headline: out.tomorrow.headline.trim(), focus: out.tomorrow.focus.map((f) => f.trim()).filter(Boolean).slice(0, 5) } };
}

const reason = (e: unknown) => {
  const m = (e as Error)?.message ?? String(e);
  if (m.startsWith(WAITING_FOR_OK)) return m;
  if (/abort|timeout|did not answer/i.test(m)) return 'the model did not answer in time';
  if (/unreachable|ECONNREFUSED|busy|loading/i.test(m)) return 'the model server is down or busy';
  return m.slice(0, 160);
};

export class AiService {
  private cached: { key: string; provider: ChatProvider } | null = null;
  readonly queue: AiQueue;
  private results = new Map<string, unknown>();
  private corpus: { sig: string; set: Set<number> } | null = null;

  constructor(
    private readonly ctx: Ctx,
    private readonly planner: Planner,
    private readonly nudges: Nudges,
  ) {
    this.queue = new AiQueue(ctx.db);
    this.queue.on('morning_plan', (p, signal) => this.morning(String(p.date), String(p.draftId), signal));
    this.queue.on('evening_review', (p, signal) => this.evening(String(p.date), String(p.draftId), signal));
    this.queue.on('habit_nudge', async (p, signal, job) => {
      const r = await this.nudge(p.habitPath as string, p.candidates as string[], signal);
      this.results.set(job.id, r);
      return { model: r?.model ?? null, promptTokens: r?.promptTokens ?? null, completionTokens: r?.completionTokens ?? null, fallback: r?.guard?.ok ? null : (r?.guard?.rule ?? 'no answer') };
    });
    // habit encouragement through the queue; none while a cloud provider's first job waits for the
    // owner's OK (ADR-81)
    nudges.encourager = async (habit, candidates) => {
      if (cloudPending(this.ctx)) return null;
      const id = this.queue.enqueue('habit_nudge', { habitPath: habit.path, candidates: candidates.map((c) => c.id) });
      const row = await this.queue.wait(id, 60_000);
      if (row.status === 'queued' || row.status === 'running') this.queue.cancel(id);
      const r = this.results.get(id) as Awaited<ReturnType<AiService['nudge']>> | undefined;
      this.results.delete(id);
      return r ?? null;
    };
    // drafts are requested through the queue (the placeholder shows "drafting" until the job ends);
    // while a cloud provider waits for the OK, the plain draft says so and Today asks
    planner.generator = (kind, date) => {
      const host = cloudPending(this.ctx);
      if (!host) return void this.request(kind, date);
      if (kind === 'morning_plan') planner.insertFallbackPlan(date, waitReason(host));
      else planner.insertFallbackReview(date, waitReason(host));
    };
  }

  /** LifeOS asks a model itself (not while Hermes writes the drafts, ADR-86). */
  enabled(): boolean {
    return aiActive(this.ctx) && currentEndpoint(this.ctx).provider !== 'hermes';
  }

  /** The provider for the endpoint in use (rebuilt when it changes). */
  get provider(): ChatProvider {
    const e = currentEndpoint(this.ctx);
    const key = JSON.stringify([e.provider, e.baseUrl, e.model, e.apiKey ?? '']);
    if (this.cached?.key !== key) {
      const viaEgress = (url: string, init: RequestInit) => this.ctx.egress.fetch(url, { ...init, purpose: 'ai' });
      const cfg = { baseUrl: e.baseUrl, model: e.model, apiKey: e.apiKey };
      const provider = e.provider === 'anthropic' ? new AnthropicProvider(cfg, viaEgress) : new OpenAiCompatibleProvider({ ...cfg, kind: e.provider === 'openai' ? 'openai' : e.provider === 'other' ? 'other' : 'local' }, viaEgress);
      this.cached = { key, provider };
    }
    return this.cached.provider;
  }

  /** Rebuild the next time it is asked for (Settings changed the endpoint). */
  forget(): void {
    this.cached = null;
  }

  private get model(): string {
    return currentEndpoint(this.ctx).model;
  }

  /** What the prompts call the owner (Settings; empty: "the user"). */
  private get owner(): string {
    return this.ctx.settings().ownerName.trim() || 'the user';
  }

  start(): void {
    this.sweep();
    this.queue.start();
  }

  stop(): void {
    this.queue.stop();
  }

  health(): Promise<ProviderHealth> {
    return this.provider.health(undefined, 5000);
  }

  request(kind: 'morning_plan' | 'evening_review', date: string): string {
    const d = this.planner.drafts.insert({ kind, date, payload: {}, sources: [], fallback: false, status: 'generating', model: this.model });
    this.queue.enqueue(kind, { date, draftId: d.id });
    return d.id;
  }

  private async chat(messages: ChatMessage[], schema: { name: string; schema: unknown }, maxTokens: number, signal: AbortSignal) {
    const r = await this.provider.chat({ messages, maxTokens, temperature: 0.3, jsonSchema: schema, signal, timeoutMs: 120_000 });
    if (r.finishReason === 'length') throw new ModelOutputError('the reply was cut off');
    return r;
  }

  // ---------------------------------------------------------------- job 1: morning plan

  morningInput(date: string) {
    const s = this.ctx.settings();
    const open = allTasks(this.ctx).filter((t) => t.status === 'open' && !t.readonly && t.kind !== 'archive');
    const tasks = open.filter((t) => t.due && t.due <= addDays(date, 7));
    tasks.sort((a, b) => (a.due! < b.due! ? -1 : a.due! > b.due! ? 1 : 0));
    // undated tasks captured in the last two daily notes are listed too, so the plan can pick them instead of inventing duplicates
    const recent = new Set([`Daily Notes/${date}.md`, `Daily Notes/${addDays(date, -1)}.md`]);
    const undated = open.filter((t) => !t.due && recent.has(t.path)).slice(0, 10);
    const list = [...tasks.slice(0, 25), ...undated];
    const ids = new Map(list.map((t, i) => [`T${i + 1}`, t]));
    const times = prayerTimes(date, s.prayer);
    const events = eventsBetween(this.ctx, date, date);
    const goals = (this.ctx.db.prepare("SELECT path, title, fm FROM files WHERE kind = 'goal'").all() as { path: string; title: string; fm: string }[])
      .map((g) => ({ ...g, fm: JSON.parse(g.fm) as Record<string, unknown> }))
      .filter((g) => (g.fm.status ?? 'active') === 'active');
    const habits = habitsView(this.ctx, date).filter((h) => h.scheduledToday);
    return { date, times, list, ids, events, goals, habits };
  }

  async morningPrompt(date: string) {
    const i = this.morningInput(date);
    const isToday = date === this.ctx.today();
    const np = isToday ? nextPrayer(this.ctx.now(), this.ctx.settings().prayer) : null;
    const yesterday = await this.ctx.vault.read(`Daily Notes/${addDays(date, -1)}.md`).catch(() => null);
    const today = await this.ctx.vault.read(`Daily Notes/${date}.md`).catch(() => null);
    const priv = this.privateHabits(date);
    const user = [
      `Date: ${longDateYear(date)} (${hijri(date, this.ctx.settings().hijriOffset).label}).${isToday ? ` Now ${this.ctx.hm()}.` : ''}`,
      `Prayer times: ${FIVE.map((p) => `${PRAYER_LABELS[p]} ${i.times[p]}`).join(', ')}.${np ? ` Next: ${PRAYER_LABELS[np.name]} ${hm12(np.time)}.` : ''}`,
      `Events today:\n${i.events.map((e) => `- ${e.time ?? 'all day'} ${e.text}`).join('\n') || '(none)'}`,
      `Open tasks due within 7 days, overdue, or recently noted without a date (id | title | due | priority | goal):\n${[...i.ids].map(([id, t]) => `${id} | ${t.title} | ${t.due ? `${t.due}${t.due < date ? ' (overdue)' : t.due === date ? ' (today)' : ''}` : 'no date'} | ${t.priority ?? '-'} | ${t.slugs.join(',') || '-'}`).join('\n') || '(none)'}`,
      `Active goals:\n${i.goals.map((g) => `- ${g.title}${g.fm.why ? ` (why: ${g.fm.why})` : ''}${g.fm.target ? ` target ${g.fm.target}` : ''}`).join('\n') || '(none)'}`,
      `Habits due today: ${i.habits.map((h) => priv.describe(h)).join(', ') || '(none)'}`,
      `Yesterday's daily note:\n${trimNote(yesterday, 1800)}`,
      `Today's daily note so far:\n${trimNote(today, 1200)}`,
      'Write the morning plan: a one-line headline for the day (under 15 words, plain and specific), then at most 5 focus items in the order to do them. For an existing task give its id in source_task_id and new=false; for something new give source_task_id null and new=true, written as a short imperative. Up to 3 short notes (optional).',
      priv.rule,
    ]
      .filter(Boolean)
      .join('\n\n');
    const messages = priv.messages([
      { role: 'system', content: `You plan the day for ${this.owner}, a busy person who prays five times a day. ${SYSTEM_RULES}` },
      { role: 'user', content: user },
    ]);
    const sources = [`Daily Notes/${addDays(date, -1)}.md`, `Daily Notes/${date}.md`, `index: ${i.list.length} open tasks due by ${addDays(date, 7)}`, ...i.goals.map((g) => g.path), ...new Set(i.habits.map((h) => priv.source(h))), 'prayer times (offline)'];
    if (i.events.length) sources.push(...new Set(i.events.map((e) => e.path)));
    return { messages, sources, ids: i.ids, priv };
  }

  async morning(date: string, draftId: string, signal: AbortSignal): Promise<JobOutcome> {
    const { messages, sources, ids, priv } = await this.morningPrompt(date);
    try {
      if (!this.enabled()) throw new Error('AI is off');
      const waiting = cloudPending(this.ctx);
      if (waiting) throw new Error(waitReason(waiting));
      const r = await this.chat(messages, { name: 'morning_plan', schema: PLAN_SCHEMA }, 700, signal);
      const payload = planFrom(parseJson(r.content), ids, priv);
      this.planner.drafts.update(draftId, { status: 'pending', payload: JSON.stringify(payload), prompt: JSON.stringify(messages), model: r.model ?? this.model, prompt_tokens: r.usage.promptTokens, sources: JSON.stringify(sources), fallback: 0, fallback_reason: null, generated_at: this.ctx.now().toISOString() });
      this.ctx.vault.notify();
      return { draftId, model: r.model, promptTokens: r.usage.promptTokens, completionTokens: r.usage.completionTokens };
    } catch (e) {
      if (signal.aborted && /cancel|shutting/i.test(String((signal.reason as Error)?.message))) throw e;
      const why = reason(e);
      this.planner.drafts.update(draftId, { status: 'pending', payload: JSON.stringify(this.planner.fallbackPlan(date)), prompt: JSON.stringify(messages), model: null, prompt_tokens: null, sources: JSON.stringify(['index: open tasks due by today', `Weekly Notes (events on ${date})`, 'prayer times (offline)']), fallback: 1, fallback_reason: why, generated_at: this.ctx.now().toISOString() });
      this.ctx.vault.notify();
      return { draftId, fallback: why };
    }
  }

  // ---------------------------------------------------------------- job 2: evening review

  async eveningPrompt(date: string) {
    const tasks = allTasks(this.ctx);
    const done = tasks.filter((t) => t.status === 'done' && t.done === date);
    const overdue = tasks.filter((t) => t.status === 'open' && !t.readonly && t.kind !== 'archive' && t.due && t.due <= date);
    const tomorrow = addDays(date, 1);
    const dueTomorrow = tasks.filter((t) => t.status === 'open' && !t.readonly && t.due === tomorrow);
    const habits = habitsView(this.ctx, date).filter((h) => h.scheduledToday);
    const moods = this.ctx.db.prepare("SELECT json FROM daily_entries WHERE date = ? AND kind IN ('mood', 'checkin') ORDER BY line").all(date) as { json: string }[];
    const captures = unsortedToday(capturesView(this.ctx), date).filter((c) => !c.hasTask);
    const cids = new Map(captures.map((c, i) => [`C${i + 1}`, c]));
    const capText = await Promise.all(
      captures.map(async (c, i) => {
        const t = await this.ctx.vault.read(c.path).catch(() => null);
        const tr = t ? (/## Original transcript\s+([\s\S]*?)(\n## |$)/.exec(t)?.[1] ?? '').replace(/^>\s?/gm, '').trim() : '';
        return `C${i + 1} | ${c.title} | ${(tr || c.preview).replace(/\s+/g, ' ').slice(0, 300)}`;
      }),
    );
    const note = await this.ctx.vault.read(`Daily Notes/${date}.md`).catch(() => null);
    const tomorrowEvents = eventsBetween(this.ctx, tomorrow, tomorrow);
    const priv = this.privateHabits(date);
    const user = [
      `Date: ${longDateYear(date)}. Now ${this.ctx.hm()}.`,
      `Done today (${done.length}):\n${done.map((t) => `- ${t.title}`).join('\n') || '(none)'}`,
      `Still open and due by today (${overdue.length}):\n${overdue.slice(0, 15).map((t) => `- ${t.title} (due ${t.due})`).join('\n') || '(none)'}`,
      `Habits today:\n${habits.map((h) => `- ${priv.describe(h)}: ${h.today ?? 'not logged'}`).join('\n') || '(none)'}`,
      `Check-in and mood lines today:\n${moods.map((m) => `- ${JSON.stringify(JSON.parse(m.json))}`).join('\n') || '(none)'}`,
      `Today's ring captures that have no task yet (id | title | what was said):\n${capText.join('\n') || '(none)'}`,
      `Tomorrow (${tomorrow}): events ${tomorrowEvents.map((e) => `${e.time ?? 'all day'} ${e.text}`).join('; ') || 'none'}; tasks due ${dueTomorrow.map((t) => t.title).join('; ') || 'none'}.`,
      `Today's daily note:\n${trimNote(note, 1800)}`,
      'Write: (1) review: a short, kind, factual review of the day in at most 100 words; (2) unsorted: for each capture id above, a suggestion task, note or ignore, with the task text when task (use the capture id as capture_file); (3) tomorrow: at most 5 focus items for tomorrow (carry over unfinished tasks when it makes sense) and a one-line headline that sums up those items.',
      priv.rule,
    ]
      .filter(Boolean)
      .join('\n\n');
    const messages = priv.messages([
      { role: 'system', content: `You help ${this.owner} close the day. ${SYSTEM_RULES}` },
      { role: 'user', content: user },
    ]);
    const sources = [`Daily Notes/${date}.md`, `index: ${done.length} done, ${overdue.length} open`, ...new Set(habits.map((h) => priv.source(h))), ...captures.map((c) => c.path)];
    return { messages, sources, cids, priv };
  }

  async evening(date: string, draftId: string, signal: AbortSignal): Promise<JobOutcome> {
    const { messages, sources, cids, priv } = await this.eveningPrompt(date);
    try {
      if (!this.enabled()) throw new Error('AI is off');
      const waiting = cloudPending(this.ctx);
      if (waiting) throw new Error(waitReason(waiting));
      const r = await this.chat(messages, { name: 'evening_review', schema: REVIEW_SCHEMA }, 800, signal);
      const payload = reviewFrom(parseJson(r.content), cids, priv);
      this.planner.drafts.update(draftId, { status: 'pending', payload: JSON.stringify(payload), prompt: JSON.stringify(messages), model: r.model ?? this.model, prompt_tokens: r.usage.promptTokens, sources: JSON.stringify(sources), fallback: 0, fallback_reason: null, generated_at: this.ctx.now().toISOString() });
      this.ctx.vault.notify();
      return { draftId, model: r.model, promptTokens: r.usage.promptTokens, completionTokens: r.usage.completionTokens };
    } catch (e) {
      if (signal.aborted && /cancel|shutting/i.test(String((signal.reason as Error)?.message))) throw e;
      const why = reason(e);
      this.planner.drafts.update(draftId, { status: 'pending', payload: JSON.stringify(this.planner.fallbackReview(date)), prompt: JSON.stringify(messages), model: null, prompt_tokens: null, sources: JSON.stringify(sources), fallback: 1, fallback_reason: why, generated_at: this.ctx.now().toISOString() });
      this.ctx.vault.notify();
      return { draftId, fallback: why };
    }
  }

  // ---------------------------------------------------------------- job 3: habit nudge

  /**
   * A reply to the nudge job, from the model or from Hermes (ADR-86), through the scripture guard
   * (spec §9, ADR-17): the pick and the encouragement in the reply's own words, or the guard's rule.
   */
  guardNudge(out: { pick?: unknown; encouragement?: unknown }, candidates: LibraryEntry[], priv: PrivateHabits): { pick: number; encouragement: string; guard: { ok: boolean; rule?: string; detail?: string } } {
    const g = guardEncouragement({ pick: out.pick, encouragement: out.encouragement, candidates, corpus: this.libraryCorpus() });
    return {
      pick: g.ok ? g.pick : typeof out.pick === 'number' && out.pick >= 1 && out.pick <= candidates.length ? out.pick : 1,
      encouragement: g.ok ? priv.relabel(g.encouragement) : '',
      guard: g.ok ? { ok: true } : { ok: false, rule: g.rule, detail: g.detail },
    };
  }

  /** The library's 7-word sequences (English and Arabic), rebuilt when the library changes. */
  private libraryCorpus(): Set<number> {
    const sig = JSON.stringify(this.ctx.db.prepare('SELECT count(*) n, sum(length(english)) e, sum(length(arabic)) a FROM hadith').get());
    if (this.corpus?.sig !== sig) {
      const rows = this.ctx.db.prepare('SELECT english, arabic FROM hadith').all() as { english: string; arabic: string }[];
      this.corpus = { sig, set: buildCorpus(rows.flatMap((r) => [r.english, r.arabic])) };
    }
    return this.corpus.set;
  }

  /** Every habit (archived too) seen by a prompt: the private ones are never named in it. */
  privateHabits(date: string): PrivateHabits {
    return new PrivateHabits(habitsView(this.ctx, date, true));
  }

  nudgePrompt(habit: HabitDto, candidates: LibraryEntry[], note: string | null, priv = this.privateHabits(this.ctx.today())): ChatMessage[] {
    const log = habit.logs.slice(-14).map((l) => `- ${l.date} ${l.value}${l.note ? ` — ${l.note}` : ''}`);
    const kind = habit.kind === 'quit' ? 'quitting' : 'building';
    const user = [
      // a private habit: its kind and streak only (no schedule, no log notes)
      priv.isPrivate(habit)
        ? `Habit: ${priv.name(habit)} (${kind}). Current streak ${habit.streak} days, best ${habit.best}.`
        : `Habit: ${habit.title} (${kind}, ${habit.schedule}). Current streak ${habit.streak} days, best ${habit.best}.`,
      priv.isPrivate(habit) ? '' : `Last 14 log lines:\n${log.join('\n') || '(none)'}`,
      note ? `Today's note:\n${trimNote(note, 600)}` : '',
      `Three reminders from the owner's library (shown to them separately, word for word; you only choose one):\n${candidates.map((c, i) => `#${i + 1} (${c.themes.join(', ') || 'general'}): ${c.english.replace(/\s+/g, ' ').slice(0, 500)}`).join('\n')}`,
      'Reply with pick (1, 2 or 3: the reminder that fits this moment best) and encouragement: at most 60 words, warm and practical, in your own plain words about the habit and a small next step. Do not repeat, quote or paraphrase the reminder or any scripture; do not mention God, prophets, imams or religion; no quotation marks.',
      priv.rule,
    ]
      .filter(Boolean)
      .join('\n\n');
    return priv.messages([
      { role: 'system', content: `You write short, kind encouragement after a habit slip. ${SYSTEM_RULES}` },
      { role: 'user', content: user },
    ]);
  }

  async nudge(habitPath: string, candidateIds: string[], signal: AbortSignal) {
    const all = habitsView(this.ctx, this.ctx.today(), true);
    const habit = all.find((h) => h.path === habitPath);
    const candidates = candidateIds.map((id) => this.nudges.library.get(id)).filter((c): c is LibraryEntry => !!c);
    if (!habit || !candidates.length || !this.enabled() || cloudPending(this.ctx)) return null;
    const note = await this.ctx.vault.read(`Daily Notes/${this.ctx.today()}.md`).catch(() => null);
    const priv = new PrivateHabits(all);
    const messages = this.nudgePrompt(habit, candidates, note, priv);
    try {
      const r = await this.chat(messages, { name: 'habit_nudge', schema: NUDGE_SCHEMA }, 300, signal);
      const out = parseJson(r.content) as { pick?: unknown; encouragement?: unknown };
      return {
        ...this.guardNudge(out, candidates, priv),
        model: r.model ?? this.model,
        promptTokens: r.usage.promptTokens,
        completionTokens: r.usage.completionTokens,
        prompt: JSON.stringify(messages),
      };
    } catch (e) {
      return { pick: 1, encouragement: '', guard: { ok: false, rule: 'no-answer', detail: reason(e) }, model: null, promptTokens: null, completionTokens: null, prompt: JSON.stringify(messages) };
    }
  }

  /** On start: a draft left "generating" by a job that no longer exists falls back. */
  sweep(): void {
    // a draft waiting for Hermes is not a job of this queue: the integration's sweep handles it (ADR-86)
    const stale = this.ctx.db.prepare("SELECT id, kind, date FROM drafts WHERE status = 'generating' AND via IS NOT 'hermes'").all() as { id: string; kind: string; date: string }[];
    for (const d of stale) {
      const live = this.ctx.db.prepare("SELECT 1 FROM jobs WHERE status IN ('queued', 'running') AND payload LIKE ?").get(`%${d.id}%`);
      if (live) continue;
      const payload = d.kind === 'evening_review' ? this.planner.fallbackReview(d.date) : this.planner.fallbackPlan(d.date);
      this.planner.drafts.update(d.id, { status: 'pending', payload: JSON.stringify(payload), fallback: 1, fallback_reason: 'the drafting job was interrupted', generated_at: this.ctx.now().toISOString() });
    }
  }
}
