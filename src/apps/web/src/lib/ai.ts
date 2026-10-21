/**
 * Bring your own model (product brief 8 §7, ADR-81): the provider choice as Settings and the first
 * run show it, and the same "is this a cloud?" rule as the API, so the warning appears the moment a
 * cloud provider is picked, before anything is saved.
 */
export type ProviderKind = 'off' | 'hermes' | 'local' | 'openai' | 'anthropic' | 'other';

/** GET /api/ai/provider: the choice in use (never the key). */
export interface ProviderView {
  provider: ProviderKind;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  keyFrom: 'settings' | 'env' | null;
  source: 'settings' | 'env' | 'none';
  host: string | null;
  cloud: boolean;
  cloudOk: boolean;
  warning: string | null;
  usable: boolean;
  lifeosAi: boolean;
  active: boolean;
  /** an integration token exists, so Hermes can post its drafts (ADR-86) */
  linked?: boolean;
  defaults: { openai: string; anthropic: string; anthropicModel: string };
}

export interface ProviderDraft {
  provider: ProviderKind;
  baseUrl: string;
  model: string;
  /** typed now; empty keeps a saved key */
  apiKey: string;
}

export const PROVIDERS: { kind: ProviderKind; label: string; hint: string; badge?: string }[] = [
  { kind: 'off', label: 'Off', hint: 'Plain drafts from your tasks, events and prayer times. Nothing is sent.' },
  { kind: 'hermes', label: 'Hermes', hint: 'Your Hermes agent writes the drafts with its own model; you approve each one here' },
  { kind: 'local', label: 'Local', hint: 'llama.cpp, Ollama, LM Studio, vLLM or any OpenAI-compatible server on this computer or your network', badge: 'Recommended: nothing leaves your machine' },
  { kind: 'openai', label: 'OpenAI', hint: 'Your API key and a model' },
  { kind: 'anthropic', label: 'Anthropic Claude', hint: 'Your API key and a model' },
  { kind: 'other', label: 'Another cloud service', hint: 'Any OpenAI-compatible service: its https address, key and model' },
];

const NAMED: Partial<Record<ProviderKind, { name: string; host: string }>> = { openai: { name: 'OpenAI', host: 'api.openai.com' }, anthropic: { name: 'Anthropic', host: 'api.anthropic.com' } };

/** The API's rule (endpoint.ts): this machine, the Docker host, a private network or a tailnet. */
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

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};

/** What Settings → Hermes and the picker say about Hermes's model (product brief 9 §3). */
export const HERMES_PRIVACY = 'Hermes uses whatever model it is set to. For full privacy make sure it is on a local model (Settings → model in Hermes); with a cloud model your notes in the prompt leave your machine.';

/** Who the prompts would go to when this draft is saved, or null when they stay home (Hermes: its own choice, said apart). */
export function cloudWho(d: ProviderDraft): string | null {
  const named = NAMED[d.provider];
  if (named) return `${named.name} (${named.host})`;
  if (d.provider === 'other') return hostOf(d.baseUrl) ?? 'that service';
  if (d.provider === 'local') {
    const host = hostOf(d.baseUrl);
    if (!host) return null;
    return privateHost(new URL(d.baseUrl).hostname) ? null : host;
  }
  return null;
}

export const warningFor = (who: string) => `Your notes, tasks and habit logs in the prompt will be sent to ${who}. Use a local model to keep everything private.`;

export const MODEL_PLACEHOLDER: Record<ProviderKind, string> = { off: '', hermes: '', local: 'for example llama3.1:8b', openai: 'for example gpt-4.1-mini', anthropic: 'claude-opus-5-5', other: 'the model name the service lists' };
export const URL_PLACEHOLDER: Partial<Record<ProviderKind, string>> = { local: 'http://host.docker.internal:11434/v1', other: 'https://api.example.com/v1' };

export function draftFrom(v: ProviderView | null): ProviderDraft {
  if (!v) return { provider: 'off', baseUrl: '', model: '', apiKey: '' };
  return { provider: v.provider, baseUrl: v.provider === 'local' || v.provider === 'other' ? v.baseUrl : '', model: v.model, apiKey: '' };
}

/** The body of PUT /api/ai/provider (an empty key field keeps the saved key). */
export function toBody(d: ProviderDraft): Record<string, unknown> {
  if (d.provider === 'off' || d.provider === 'hermes') return { provider: d.provider };
  return {
    provider: d.provider,
    ...(d.provider === 'local' || d.provider === 'other' ? { baseUrl: d.baseUrl.trim() } : {}),
    model: d.model.trim() || (d.provider === 'anthropic' ? 'claude-opus-5-5' : ''),
    ...(d.apiKey.trim() ? { apiKey: d.apiKey.trim() } : {}),
  };
}
