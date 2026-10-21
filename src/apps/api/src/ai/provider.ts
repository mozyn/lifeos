/**
 * Generic OpenAI-compatible chat provider (ADR-10). Works with a llama.cpp server and any other
 * OpenAI-style endpoint (Ollama's /v1, LM Studio, vLLM, a hosted API) without code changes.
 *
 * - Health: GET {base}/models, short timeout; reports latency, model presence and context size.
 * - Chat: always streamed; only `delta.content` is kept. Reasoning (`reasoning_content`, from
 *   llama.cpp --reasoning-format deepseek) is counted, never stored or shown.
 * - Cancellation and timeouts through AbortSignal; the caller's abort reason is rethrown as is, so
 *   the job runtime can tell a user cancel from a job timeout.
 * - Structured output: the JSON Schema is sent as `response_format` (llama.cpp turns it into a
 *   grammar). If the server refuses that parameter, the call is retried once without it and the
 *   reply is still validated by the caller.
 * - The API key is only ever placed in the Authorization header. It is never logged, returned,
 *   stored or included in errors.
 */

export type AiErrorCode = 'unconfigured' | 'unavailable' | 'timeout' | 'http' | 'bad_response';

export class AiError extends Error {
  constructor(
    public code: AiErrorCode,
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

export interface ProviderConfig {
  baseUrl: string;
  model: string;
  apiKey: string | null;
  /**
   * `local` (default): llama.cpp-style extras (a Qwen thinking switch, a JSON Schema grammar);
   * `openai`: OpenAI's own API (max_completion_tokens, the model's own temperature, JSON mode);
   * `other`: a remote OpenAI-compatible service (no llama.cpp extras).
   */
  kind?: 'local' | 'openai' | 'other';
  /** send `chat_template_kwargs.enable_thinking = false` (Qwen-style templates); default off */
  thinking?: boolean;
}

export interface ProviderHealth {
  ok: boolean;
  latencyMs: number | null;
  models: string[];
  modelPresent: boolean;
  contextTokens: number | null;
  error?: { code: AiErrorCode; message: string };
}

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export interface ChatRequest {
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  jsonSchema?: { name: string; schema: unknown };
  signal: AbortSignal;
  timeoutMs: number;
  /** called as content streams in (characters so far, completion chunks so far) */
  onProgress?: (p: { chars: number; chunks: number }) => void;
}

export interface ChatResult {
  content: string;
  finishReason: string | null;
  model: string | null;
  usage: { promptTokens: number | null; completionTokens: number | null };
  reasoningChars: number;
  firstTokenMs: number | null;
  durationMs: number;
  jsonMode: 'schema' | 'prompt';
}

/** LifeOS: every request goes through the egress wrapper (purpose `ai`, spec §3); tests pass a plain fetch. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class OpenAiCompatibleProvider {
  constructor(
    private readonly cfg: ProviderConfig,
    private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i),
  ) {}

  /** Host and port only, for provenance and diagnostics (never the key, never the full URL). */
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

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (this.cfg.apiKey) h.Authorization = `Bearer ${this.cfg.apiKey}`;
    return h;
  }

  private url(path: string): string {
    return `${this.cfg.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  async health(signal?: AbortSignal, timeoutMs = 5000): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      const res = await this.fetchImpl(this.url('/models'), { headers: this.headers(), signal: combine(signal, timeoutMs) });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new AiError(res.status === 401 || res.status === 403 ? 'http' : 'unavailable', `models endpoint answered ${res.status}`, res.status);
      }
      const body = (await res.json()) as { data?: { id?: string; meta?: { n_ctx?: number; n_ctx_train?: number } }[] };
      const models = (body.data ?? []).map((m) => String(m.id ?? '')).filter(Boolean);
      const mine = (body.data ?? []).find((m) => m.id === this.cfg.model);
      return {
        ok: true,
        latencyMs: Date.now() - started,
        models,
        modelPresent: models.includes(this.cfg.model),
        contextTokens: mine?.meta?.n_ctx ?? null,
      };
    } catch (e) {
      if (signal?.aborted) throw signal.reason ?? e;
      const err = classify(e);
      return { ok: false, latencyMs: null, models: [], modelPresent: false, contextTokens: null, error: { code: err.code, message: err.message } };
    }
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    try {
      return await this.chatOnce(req, req.jsonSchema ? 'schema' : 'prompt');
    } catch (e) {
      // a server that does not understand response_format: retry once relying on the prompt alone
      if (e instanceof AiError && e.code === 'http' && e.status === 400 && req.jsonSchema) return this.chatOnce(req, 'prompt');
      throw e;
    }
  }

  private async chatOnce(req: ChatRequest, jsonMode: 'schema' | 'prompt'): Promise<ChatResult> {
    const started = Date.now();
    const kind = this.cfg.kind ?? 'local';
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: req.messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (kind === 'openai') {
      // OpenAI's current models take max_completion_tokens and only their own temperature; the
      // reply is asked for as a JSON object (the prompt describes it; the caller validates it)
      body.max_completion_tokens = Math.max(req.maxTokens, 4000);
      if (jsonMode === 'schema' && req.jsonSchema) body.response_format = { type: 'json_object' };
    } else {
      body.max_tokens = req.maxTokens;
      body.temperature = req.temperature ?? 0.2;
      if (kind === 'local' && !this.cfg.thinking) body.chat_template_kwargs = { enable_thinking: false };
      if (jsonMode === 'schema' && req.jsonSchema) {
        body.response_format = { type: 'json_schema', json_schema: { name: req.jsonSchema.name, schema: req.jsonSchema.schema, strict: true } };
      }
    }
    let res: Response;
    try {
      res = await this.fetchImpl(this.url('/chat/completions'), { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: combine(req.signal, req.timeoutMs) });
    } catch (e) {
      if (req.signal.aborted) throw req.signal.reason ?? e;
      throw classify(e);
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 300).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/sk-[\w-]{8,}/g, '[redacted]');
      if (res.status === 503 || res.status === 502 || res.status === 504) throw new AiError('unavailable', `model server busy or loading (${res.status})`, res.status);
      throw new AiError('http', `model server answered ${res.status}${text ? `: ${text}` : ''}`, res.status);
    }
    if (!res.body) throw new AiError('bad_response', 'empty response body');

    let content = '';
    let reasoningChars = 0;
    let chunks = 0;
    let finishReason: string | null = null;
    let model: string | null = null;
    let usage: ChatResult['usage'] = { promptTokens: null, completionTokens: null };
    let firstTokenMs: number | null = null;
    const isStream = (res.headers.get('content-type') ?? '').includes('text/event-stream');
    try {
      if (!isStream) {
        // some servers ignore stream:true; accept a single JSON body
        const j = (await res.json()) as ChatCompletion;
        const m = j.choices?.[0]?.message ?? {};
        content = typeof m.content === 'string' ? m.content : '';
        reasoningChars = typeof m.reasoning_content === 'string' ? m.reasoning_content.length : 0;
        finishReason = j.choices?.[0]?.finish_reason ?? null;
        model = j.model ?? null;
        usage = { promptTokens: j.usage?.prompt_tokens ?? null, completionTokens: j.usage?.completion_tokens ?? null };
        firstTokenMs = Date.now() - started;
      } else {
        const decoder = new TextDecoder();
        let buf = '';
        let done = false;
        for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
          buf += decoder.decode(part, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).replace(/\r$/, '');
            buf = buf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data) continue;
            if (data === '[DONE]') {
              done = true;
              break;
            }
            let evt: ChatCompletion;
            try {
              evt = JSON.parse(data) as ChatCompletion;
            } catch {
              continue;
            }
            if (evt.error) throw new AiError('http', `model server error: ${String(evt.error.message ?? 'unknown').slice(0, 200)}`);
            model ??= evt.model ?? null;
            const choice = evt.choices?.[0];
            const delta = choice?.delta ?? {};
            if (typeof delta.reasoning_content === 'string') reasoningChars += delta.reasoning_content.length;
            if (typeof delta.content === 'string' && delta.content) {
              firstTokenMs ??= Date.now() - started;
              content += delta.content;
              chunks++;
              req.onProgress?.({ chars: content.length, chunks });
            }
            if (choice?.finish_reason) finishReason = choice.finish_reason;
            if (evt.usage) usage = { promptTokens: evt.usage.prompt_tokens ?? null, completionTokens: evt.usage.completion_tokens ?? null };
          }
          if (done) break;
        }
      }
    } catch (e) {
      if (req.signal.aborted) throw req.signal.reason ?? e;
      throw e instanceof AiError ? e : classify(e);
    }
    return { content, finishReason, model, usage, reasoningChars, firstTokenMs, durationMs: Date.now() - started, jsonMode };
  }
}

interface ChatCompletion {
  model?: string;
  error?: { message?: string };
  choices?: { delta?: { content?: string | null; reasoning_content?: string | null }; message?: { content?: string | null; reasoning_content?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** The caller's signal plus our own deadline. */
function combine(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const t = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, t]) : t;
}

function classify(e: unknown): AiError {
  if (e instanceof AiError) return e;
  const err = e as { name?: string; message?: string; cause?: { code?: string } };
  if (err?.name === 'TimeoutError') return new AiError('timeout', 'the model did not answer in time');
  if (err?.name === 'AbortError') return new AiError('timeout', 'the request was aborted');
  const code = err?.cause?.code;
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'UND_ERR_SOCKET') {
    return new AiError('unavailable', `model server unreachable (${code})`);
  }
  return new AiError('unavailable', `model request failed: ${(err?.message ?? String(e)).slice(0, 200)}`);
}
