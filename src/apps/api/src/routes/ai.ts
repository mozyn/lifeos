/**
 * Settings → Advanced → AI (spec §4, product brief 8 §7, ADR-81): which model writes the drafts
 * (Off, a local OpenAI-compatible server, OpenAI, Anthropic, another cloud service), its status
 * and the last jobs, and the owner's OK for a cloud provider's first job. A key is stored here
 * (SQLite settings) only when typed in Settings; it is never returned, logged or put in a prompt.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AiProviderKind } from '../config.js';
import { PROVIDER_BASE } from '../config.js';
import type { Ctx } from '../context.js';
import type { Planner } from '../planner.js';
import { HttpError } from '../http.js';
import { aiActive, aiChoice, allowCloud, cloudPending, endpointHostName, hermesLinked, isCloud, providerName, resolveEndpoint, saveChoice, usable, type AiChoice } from '../ai/endpoint.js';
import { type AiService, WAITING_FOR_OK } from '../ai/service.js';

/** The model a new Anthropic choice starts with (the owner may type another). */
export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5-5';

export const cloudWarning = (who: string) => `Your notes, tasks and habit logs in the prompt will be sent to ${who}. Use a local model to keep everything private.`;

function providerView(ctx: Ctx) {
  const e = resolveEndpoint(ctx);
  const cloud = isCloud(e);
  const host = endpointHostName(e);
  return {
    provider: e.provider,
    baseUrl: e.baseUrl,
    model: e.model,
    hasKey: !!e.apiKey,
    keyFrom: e.keyFrom,
    source: e.source,
    host,
    cloud,
    cloudOk: cloud ? aiChoice(ctx)?.cloudOk === host : true,
    warning: cloud ? cloudWarning(providerName(e)) : null,
    usable: usable(e),
    lifeosAi: ctx.config.ai,
    active: aiActive(ctx),
    /** an integration token exists: Hermes can write the drafts (ADR-86) */
    linked: hermesLinked(ctx),
    defaults: { openai: PROVIDER_BASE.openai, anthropic: PROVIDER_BASE.anthropic, anthropicModel: ANTHROPIC_DEFAULT_MODEL },
  };
}

const URL_OK = (https: boolean) => (u: string) => {
  try {
    const x = new URL(u);
    return (x.protocol === 'https:' || (!https && x.protocol === 'http:')) && !x.username && !x.password;
  } catch {
    return false;
  }
};

export function aiRoutes(app: FastifyInstance, ctx: Ctx, ai: AiService, planner: Planner): void {
  // Settings → AI's status: drafts pending, the last 20 jobs; health only for a model on this
  // machine or network (a cloud provider is checked when the owner asks, below)
  app.get('/api/ai', async () => {
    const e = resolveEndpoint(ctx);
    const health = ai.enabled() && !isCloud(e) ? await ai.health() : null;
    const hermes = e.provider === 'hermes' ? (ctx.db.prepare('SELECT last_used_at, last_model FROM integration_tokens WHERE revoked_at IS NULL').get() as { last_used_at: string | null; last_model: string | null } | undefined) : undefined;
    const pending = (ctx.db.prepare("SELECT count(*) n FROM drafts WHERE kind != 'habit_nudge' AND status IN ('pending', 'generating')").get() as { n: number }).n;
    const jobs = ai.queue.recent(20).map((j) => ({ id: j.id, kind: j.kind, status: j.status, createdAt: j.created_at, durationMs: j.duration_ms, model: j.model, promptTokens: j.prompt_tokens, completionTokens: j.completion_tokens, note: j.error }));
    // Hermes runs its own model: what it last named, and whether it can post drafts at all
    const agent = e.provider === 'hermes' ? { linked: !!hermes, active: aiActive(ctx), lastUsedAt: hermes?.last_used_at ?? null, model: hermes?.last_model ?? null } : null;
    return { enabled: ai.enabled(), configured: ctx.config.ai, provider: e.provider, cloud: isCloud(e), model: e.model, endpoint: endpointHostName(e), agent, health, pending, busy: ai.queue.busy(), jobs };
  });
  app.post('/api/ai/jobs/:id/cancel', async (req) => ({ ok: ai.queue.cancel((req.params as { id: string }).id) }));

  app.get('/api/ai/provider', async () => providerView(ctx));

  app.put('/api/ai/provider', async (req) => {
    const b = z
      .object({
        provider: z.enum(['off', 'hermes', 'local', 'openai', 'anthropic', 'other']),
        baseUrl: z.string().trim().max(300).optional(),
        model: z.string().trim().max(120).optional(),
        // a new key; null removes the saved one; absent keeps it (same provider only)
        apiKey: z.string().trim().max(400).nullable().optional(),
      })
      .parse(req.body);
    const prev = aiChoice(ctx);
    const env = ctx.config.aiEnv;
    let next: AiChoice;
    if (b.provider === 'off') next = { provider: 'off' };
    // Hermes needs nothing here: its token is made in Settings → Hermes (the choice before it is kept for Revoke)
    else if (b.provider === 'hermes') next = { provider: 'hermes', prev: prev?.provider === 'hermes' ? (prev.prev ?? null) : (prev ?? null) };
    else {
      const p = b.provider as Exclude<AiProviderKind, 'off' | 'hermes'>;
      const baseUrl = p === 'openai' || p === 'anthropic' ? PROVIDER_BASE[p]! : (b.baseUrl ?? '').replace(/\/+$/, '');
      if (p === 'local' && !URL_OK(false)(baseUrl)) throw new HttpError(400, 'bad_url', 'Give the server address, for example http://host.docker.internal:11434/v1.');
      if (p === 'other' && !URL_OK(true)(baseUrl)) throw new HttpError(400, 'bad_url', 'A cloud service needs its https address, for example https://api.example.com/v1.');
      const model = b.model || (p === 'anthropic' ? ANTHROPIC_DEFAULT_MODEL : '');
      if (!model) throw new HttpError(400, 'no_model', 'Give the model name.');
      const kept = prev?.provider === p ? (prev.apiKey ?? null) : null;
      const apiKey = b.apiKey === undefined ? kept : b.apiKey || null;
      const envKey = env.provider === p ? env.apiKey : null;
      if ((p === 'openai' || p === 'anthropic') && !apiKey && !envKey) throw new HttpError(400, 'no_key', `${p === 'openai' ? 'OpenAI' : 'Anthropic'} needs an API key.`);
      next = { provider: p, baseUrl, model, apiKey };
      // the OK for a first job belongs to one host
      let host: string | null = null;
      try {
        host = new URL(baseUrl).host;
      } catch {
        host = null;
      }
      if (prev?.cloudOk && prev.cloudOk === host) next.cloudOk = prev.cloudOk;
    }
    saveChoice(ctx, next);
    ai.forget();
    return providerView(ctx);
  });

  /** "Check the connection": the models list, with the key, nothing from the notes. */
  app.post('/api/ai/check', async () => {
    if (resolveEndpoint(ctx).provider === 'hermes') throw new HttpError(409, 'hermes', 'Hermes runs its own model; Settings → Hermes shows its last call.');
    if (!usable(resolveEndpoint(ctx))) throw new HttpError(409, 'not_set', 'Choose a provider and a model first.');
    if (!ctx.config.ai) throw new HttpError(409, 'ai_off', 'AI is off for this install (LIFEOS_AI=off).');
    const h = await ai.health();
    return { ok: h.ok, latencyMs: h.latencyMs, modelPresent: h.modelPresent, models: h.models.slice(0, 40), contextTokens: h.contextTokens, error: h.error?.message ?? null };
  });

  /**
   * The owner's OK for a cloud provider's first job (Today shows the warning again before it): the
   * plain drafts that waited for it are drafted again by the model.
   */
  app.post('/api/ai/cloud-ok', async () => {
    const host = cloudPending(ctx) ?? endpointHostName(resolveEndpoint(ctx));
    if (!host || !isCloud(resolveEndpoint(ctx))) throw new HttpError(409, 'not_cloud', 'The model in use is not a cloud provider.');
    allowCloud(ctx);
    let redrafted = 0;
    for (const kind of ['morning_plan', 'evening_review'] as const) {
      const d = ctx.db.prepare("SELECT id, date FROM drafts WHERE kind = ? AND status = 'pending' AND fallback = 1 AND fallback_reason LIKE ? ORDER BY generated_at DESC").all(kind, `${WAITING_FOR_OK}%`) as { id: string; date: string }[];
      for (const row of d) {
        const id = ai.request(kind, row.date);
        planner.drafts.supersede(kind, row.date, null, id);
        redrafted++;
      }
    }
    ctx.vault.notify();
    return { ok: true, host, redrafted };
  });
}
