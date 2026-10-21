/**
 * Settings → Hermes (product brief 9 §1, §3; ADR-85): the integration token, from the owner's
 * session only (the token itself can neither create, show nor revoke a token).
 *   GET  /api/hermes         status: no token, waiting for Hermes's first call, or connected (last call, model)
 *   POST /api/hermes/token   a new token, shown once in the answer (an earlier one stops working)
 *   POST /api/hermes/revoke  the token stops working
 * Creating a token makes Hermes the AI provider (the choice it replaces is kept); revoking restores
 * that choice while Hermes is still the one chosen (ADR-86).
 */
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.js';
import { aiChoice, currentEndpoint, hermesDrafts, saveChoice } from '../ai/endpoint.js';
import type { AiService } from '../ai/service.js';
import type { IntegrationTokens } from '../integration/tokens.js';
import type { Scheduler } from '../scheduler.js';
import { HttpError } from '../http.js';

/** Hermes asked for reminders this recently: it is the one sending them to Telegram. */
const REMINDERS_FRESH_MS = 15 * 60_000;

export function hermesStatus(ctx: Ctx, tokens: IntegrationTokens, scheduler: Scheduler) {
  const row = tokens.active();
  const last = row?.last_reminders_at ? Date.parse(row.last_reminders_at) : 0;
  return {
    state: !row ? ('none' as const) : row.last_used_at ? ('connected' as const) : ('waiting' as const),
    token: row ? { createdAt: row.created_at, lastUsedAt: row.last_used_at, lastModel: row.last_model, lastRemindersAt: row.last_reminders_at } : null,
    /** who writes the AI drafts now */
    draftsBy: hermesDrafts(ctx) ? 'hermes' : currentEndpoint(ctx).provider,
    /** Hermes polled reminders in the last 15 minutes */
    sendsReminders: !!row && ctx.now().getTime() - last < REMINDERS_FRESH_MS,
    /** LifeOS's own Telegram bot is on too (each reminder would come twice) */
    ownBot: scheduler.enabled(),
  };
}

export function hermesRoutes(app: FastifyInstance, ctx: Ctx, deps: { tokens: IntegrationTokens; ai: AiService; scheduler: Scheduler; template: () => Promise<string | null>; prompt: (token: string, template: string) => Promise<string> }): void {
  const { tokens, ai, scheduler } = deps;

  app.get('/api/hermes', async () => hermesStatus(ctx, tokens, scheduler));

  app.post('/api/hermes/token', async (_req, reply) => {
    // the prompt is the only place the token is ever shown: no template, no token
    const template = await deps.template();
    if (!template) throw new HttpError(500, 'no_template', 'This build has no Hermes prompt (docs/hermes-prompt.md is missing from the image).');
    // on the stack's clock: reminders are offered from this moment on (ADR-87)
    const { token } = tokens.create(ctx.now());
    // Hermes becomes the one who writes the drafts; the choice it replaces comes back on Revoke
    const prev = aiChoice(ctx);
    if (prev?.provider !== 'hermes') saveChoice(ctx, { provider: 'hermes', prev: prev ?? null });
    ai.forget();
    ctx.vault.notify();
    reply.header('Cache-Control', 'no-store');
    return { token, prompt: await deps.prompt(token, template), status: hermesStatus(ctx, tokens, scheduler) };
  });

  app.post('/api/hermes/revoke', async () => {
    const had = tokens.revoke();
    const c = aiChoice(ctx);
    if (c?.provider === 'hermes') {
      if (c.prev) saveChoice(ctx, c.prev);
      else ctx.db.prepare("DELETE FROM settings WHERE key = 'ai'").run();
    }
    ai.forget();
    ctx.vault.notify();
    return { ok: true, revoked: had, status: hermesStatus(ctx, tokens, scheduler) };
  });
}
