/**
 * Which model endpoint the AI jobs use (ADR-75, ADR-81): the one chosen in Settings → Advanced → AI
 * (or the first run), kept in the SQLite settings with its key, else the one `.env.ai` (or an older
 * `.env.gsq`) describes. The egress allowlist's `ai` purpose follows it: exactly its host, and
 * nothing while AI is off.
 *
 * A cloud provider (OpenAI, Anthropic, any other remote OpenAI-compatible service, or a "local"
 * address that is not on this machine or a private network) gets a warning, and its first job
 * waits for the owner's OK on Today (`cloudOk`, per host): the notes in a prompt leave the box only
 * after that.
 *
 * Hermes (ADR-86) is a provider LifeOS never calls: the owner's agent asks the integration API which
 * jobs are wanted and posts its drafts back. Nothing is allowed out for it, and it is the default
 * while an integration token exists and no other choice was saved.
 */
import { type AiEndpoint, type AiProviderKind, PROVIDER_BASE } from '../config.js';
import type { Ctx } from '../context.js';
import { getSetting, setSetting } from '../db.js';
import { hostPort } from '../egress.js';

/** What Settings stores (key `ai`); the key never leaves the API. */
export interface AiChoice {
  provider: AiProviderKind;
  baseUrl?: string;
  model?: string;
  apiKey?: string | null;
  /** the host whose first job the owner allowed (a cloud provider only) */
  cloudOk?: string | null;
  /** Hermes only: the choice it replaced when its token was created, restored when it is revoked (ADR-86) */
  prev?: AiChoice | null;
}

export const PROVIDER_LABEL: Record<AiProviderKind, string> = { off: 'Off', hermes: 'Hermes', local: 'a local model', openai: 'OpenAI', anthropic: 'Anthropic', other: 'a cloud service' };

export function aiChoice(ctx: Ctx): AiChoice | null {
  const c = getSetting<AiChoice | null>(ctx.db, 'ai', null);
  return c && typeof c.provider === 'string' ? c : null;
}

export function saveChoice(ctx: Ctx, c: AiChoice): void {
  setSetting(ctx.db, 'ai', c);
}

/** An integration token exists (Settings → Hermes, ADR-85): Hermes can reach the integration API. */
export function hermesLinked(ctx: Ctx): boolean {
  return !!ctx.db.prepare('SELECT 1 FROM integration_tokens WHERE revoked_at IS NULL').get();
}

const HERMES: AiEndpoint = { provider: 'hermes', baseUrl: '', model: '', apiKey: null };

/**
 * The endpoint in use, and where it came from. Without a saved choice, Hermes is the default while
 * an integration token exists (ADR-86), else `.env.ai`'s endpoint.
 */
export function resolveEndpoint(ctx: Ctx): AiEndpoint & { source: 'settings' | 'env' | 'none'; keyFrom: 'settings' | 'env' | null } {
  const env = ctx.config.aiEnv;
  const c = aiChoice(ctx);
  if (!c && hermesLinked(ctx)) return { ...HERMES, source: 'settings', keyFrom: null };
  if (!c) return { ...env, source: env.provider === 'off' ? 'none' : 'env', keyFrom: env.apiKey ? 'env' : null };
  if (c.provider === 'off') return { provider: 'off', baseUrl: '', model: '', apiKey: null, source: 'settings', keyFrom: null };
  if (c.provider === 'hermes') return { ...HERMES, source: 'settings', keyFrom: null };
  const baseUrl = (c.baseUrl || PROVIDER_BASE[c.provider] || (env.provider === c.provider ? env.baseUrl : '')).replace(/\/+$/, '');
  // a key typed in Settings wins; otherwise `.env.ai`'s, when it is for the same provider
  const envKey = env.provider === c.provider ? env.apiKey : null;
  const apiKey = c.apiKey ?? envKey;
  return { provider: c.provider, baseUrl, model: c.model || (env.provider === c.provider ? env.model : ''), apiKey, source: 'settings', keyFrom: c.apiKey ? 'settings' : envKey ? 'env' : null };
}

export function currentEndpoint(ctx: Ctx): AiEndpoint {
  const { source: _s, keyFrom: _k, ...e } = resolveEndpoint(ctx);
  return e;
}

/** An endpoint LifeOS can ask itself: a provider, a URL and a model (Hermes runs its own model). */
export function usable(e: AiEndpoint): boolean {
  return e.provider !== 'off' && e.provider !== 'hermes' && !!e.baseUrl && !!e.model;
}

/**
 * AI drafts run: on for this install (LIFEOS_AI), switched on in Settings, and an endpoint to ask, or
 * Hermes with a token to post its drafts with.
 */
export function aiActive(ctx: Ctx): boolean {
  if (!ctx.config.ai || !ctx.settings().ai) return false;
  const e = currentEndpoint(ctx);
  return e.provider === 'hermes' ? hermesLinked(ctx) : usable(e);
}

/** Hermes writes the drafts now (the jobs wait for it through the integration API). */
export function hermesDrafts(ctx: Ctx): boolean {
  return aiActive(ctx) && currentEndpoint(ctx).provider === 'hermes';
}

/** Why a draft was made without a model. */
export function offReason(ctx: Ctx): string {
  if (ctx.config.ai && ctx.settings().ai && currentEndpoint(ctx).provider === 'hermes' && !hermesLinked(ctx)) return 'Hermes is not connected (Settings → Hermes)';
  return 'AI is off';
}

/** This machine, the Docker host, a private network or a tailnet: what "nothing leaves" covers. */
export function privateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === 'host.docker.internal' || h === '::1' || h.endsWith('.localhost')) return true;
  if (/\.(local|lan|home|internal|home\.arpa|ts\.net)$/.test(h) || !h.includes('.')) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
  }
  return /^(fc|fd)[0-9a-f]{2}:/.test(h) || h.startsWith('fe80:');
}

/** Whether prompts would leave this machine and its network for the endpoint. */
export function isCloud(e: AiEndpoint): boolean {
  if (e.provider === 'openai' || e.provider === 'anthropic' || e.provider === 'other') return true;
  if (e.provider !== 'local' || !e.baseUrl) return false;
  try {
    return !privateHost(new URL(e.baseUrl).hostname);
  } catch {
    return false;
  }
}

export function endpointHostName(e: AiEndpoint): string | null {
  try {
    return e.baseUrl ? new URL(e.baseUrl).host : null;
  } catch {
    return null;
  }
}

/** "OpenAI (api.openai.com)": who the warning names. */
export function providerName(e: AiEndpoint): string {
  if (e.provider === 'hermes') return 'Hermes';
  const host = endpointHostName(e) ?? 'its server';
  if (e.provider === 'openai' || e.provider === 'anthropic') return `${PROVIDER_LABEL[e.provider]} (${host})`;
  return host;
}

/** The cloud host whose first job still waits for the owner's OK, else null. */
export function cloudPending(ctx: Ctx): string | null {
  const e = currentEndpoint(ctx);
  if (!aiActive(ctx) || !isCloud(e)) return null;
  const host = endpointHostName(e);
  return host && aiChoice(ctx)?.cloudOk !== host ? host : null;
}

/** The owner allowed the first job for the host in use. */
export function allowCloud(ctx: Ctx): string | null {
  const e = currentEndpoint(ctx);
  const host = endpointHostName(e);
  if (!host) return null;
  const c = aiChoice(ctx) ?? { provider: e.provider, baseUrl: e.baseUrl, model: e.model };
  saveChoice(ctx, { ...c, cloudOk: host });
  return host;
}

/** The egress allowlist for purpose `ai`: the endpoint's host:port, or nothing. */
export function aiHosts(ctx: Ctx): string[] {
  // Hermes calls LifeOS, never the other way round: nothing to allow out
  if (!aiActive(ctx) || currentEndpoint(ctx).provider === 'hermes') return [];
  try {
    return [hostPort(currentEndpoint(ctx).baseUrl)];
  } catch {
    return [];
  }
}
