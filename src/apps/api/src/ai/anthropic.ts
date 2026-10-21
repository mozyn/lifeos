/**
 * Anthropic Claude as a provider for the three AI jobs (product brief 8 §7, ADR-81), through the
 * official SDK whose `fetch` is the egress wrapper (purpose `ai`), so each call is allowlisted and
 * logged like every other. Same contract as the OpenAI-compatible provider: `health()` lists the
 * models, `chat()` returns the reply's text only.
 *
 * - Structured output: the job's JSON Schema as `output_config.format` (made strict: objects closed,
 *   length bounds left to the caller's zod check). A 400 is retried once without it (and without
 *   the fallbacks below); the caller validates the reply either way.
 * - Effort `low` where the model takes it (short drafts); thinking is left at the model's default.
 * - Refusal fallbacks: on the current models the server re-runs a declined request on another
 *   model (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`); a final `refusal`
 *   counts as no answer, so the job uses its deterministic fallback.
 * - No retries inside the SDK (the job queue decides), the caller's abort and deadline apply, and
 *   the key only travels in the `x-api-key` header: never logged, returned or put in an error.
 */
import Anthropic from '@anthropic-ai/sdk';
import { AiError, type ChatRequest, type ChatResult, type FetchLike, type ProviderConfig, type ProviderHealth } from './provider.js';

/** Models that take `output_config.effort`. */
const EFFORT = /^claude-(opus-4-[5-9]|opus-5|sonnet-4-[6-9]|sonnet-5|haiku-5|fable|mythos)/;
/** Models with server-side refusal fallbacks ("default" routing). */
const FALLBACKS = /^claude-(fable-5-1|opus-5-5|opus-5$|sonnet-5-5)/;

/** A schema as structured outputs take it: every object closed, unions as anyOf, no length bounds. */
export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k === 'maxLength' || k === 'minLength' || k === 'maxItems' || k === 'minItems') continue;
    if (k === 'type' && Array.isArray(v)) continue;
    out[k] = k === 'properties' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([p, s]) => [p, strictSchema(s)])) : strictSchema(v);
  }
  const t = (schema as { type?: unknown }).type;
  if (Array.isArray(t)) return { anyOf: t.map((x) => ({ ...out, type: x })) };
  if (t === 'object') out.additionalProperties = false;
  return out;
}

function redact(s: string): string {
  return s.replace(/sk-ant-[\w-]+/g, '[redacted]').slice(0, 200);
}

function classify(e: unknown): AiError {
  if (e instanceof AiError) return e;
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new AiError('timeout', 'the model did not answer in time');
  if (e instanceof Anthropic.APIConnectionError) return new AiError('unavailable', 'model server unreachable');
  if (e instanceof Anthropic.APIError) {
    const status = e.status ?? undefined;
    if (status === 529 || status === 503 || status === 502 || status === 504) return new AiError('unavailable', `model server busy (${status})`, status);
    return new AiError('http', `model server answered ${status ?? '?'}: ${redact(e.message)}`, status);
  }
  const err = e as { name?: string; message?: string };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return new AiError('timeout', 'the model did not answer in time');
  return new AiError('unavailable', `model request failed: ${redact(err?.message ?? String(e))}`);
}

function combine(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const t = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, t]) : t;
}

export class AnthropicProvider {
  private readonly client: Anthropic;

  constructor(
    private readonly cfg: ProviderConfig,
    fetchImpl: FetchLike,
  ) {
    this.client = new Anthropic({
      apiKey: cfg.apiKey ?? 'missing',
      baseURL: cfg.baseUrl,
      maxRetries: 0,
      fetch: ((url: string | URL | Request, init?: RequestInit) => fetchImpl(String(url instanceof Request ? url.url : url), init ?? {})) as typeof fetch,
    });
  }

  get endpointHost(): string {
    try {
      return new URL(this.cfg.baseUrl).host;
    } catch {
      return 'invalid';
    }
  }

  get model(): string {
    return this.cfg.model;
  }

  async health(signal?: AbortSignal, timeoutMs = 8000): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      if (!this.cfg.apiKey) throw new AiError('unconfigured', 'no API key');
      const page = await this.client.models.list({ limit: 100 }, { signal: combine(signal, timeoutMs) });
      const models = page.data.map((m) => m.id);
      const mine = page.data.find((m) => m.id === this.cfg.model) as { max_input_tokens?: number } | undefined;
      return { ok: true, latencyMs: Date.now() - started, models, modelPresent: models.includes(this.cfg.model), contextTokens: mine?.max_input_tokens ?? null };
    } catch (e) {
      if (signal?.aborted) throw signal.reason ?? e;
      const err = classify(e);
      return { ok: false, latencyMs: null, models: [], modelPresent: false, contextTokens: null, error: { code: err.code, message: err.message } };
    }
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    try {
      return await this.chatOnce(req, true);
    } catch (e) {
      if (e instanceof AiError && e.code === 'http' && e.status === 400 && req.jsonSchema) return this.chatOnce(req, false);
      throw e;
    }
  }

  private async chatOnce(req: ChatRequest, full: boolean): Promise<ChatResult> {
    if (!this.cfg.apiKey) throw new AiError('unconfigured', 'no API key');
    const started = Date.now();
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const messages = req.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    const outputConfig: Anthropic.OutputConfig = {};
    if (EFFORT.test(this.cfg.model)) outputConfig.effort = 'low';
    if (full && req.jsonSchema) outputConfig.format = { type: 'json_schema', schema: strictSchema(req.jsonSchema.schema) as Record<string, unknown> };
    const params = { model: this.cfg.model, max_tokens: 16000, ...(system ? { system } : {}), messages, ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}) };
    const opts = { signal: combine(req.signal, req.timeoutMs) };
    let msg: Anthropic.Message;
    try {
      msg =
        full && FALLBACKS.test(this.cfg.model)
          ? ((await this.client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } as Anthropic.Beta.MessageCreateParamsNonStreaming, opts)) as unknown as Anthropic.Message)
          : await this.client.messages.create(params as Anthropic.MessageCreateParamsNonStreaming, opts);
    } catch (e) {
      if (req.signal.aborted) throw req.signal.reason ?? e;
      throw classify(e);
    }
    if (msg.stop_reason === 'refusal') throw new AiError('bad_response', 'the model declined to answer');
    const content = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    req.onProgress?.({ chars: content.length, chunks: 1 });
    return {
      content,
      finishReason: msg.stop_reason === 'max_tokens' ? 'length' : (msg.stop_reason ?? null),
      model: msg.model ?? null,
      usage: { promptTokens: msg.usage?.input_tokens ?? null, completionTokens: msg.usage?.output_tokens ?? null },
      reasoningChars: 0,
      firstTokenMs: Date.now() - started,
      durationMs: Date.now() - started,
      jsonMode: full && req.jsonSchema ? 'schema' : 'prompt',
    };
  }
}
