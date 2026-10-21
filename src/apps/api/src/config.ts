/**
 * Runtime configuration from the environment (porting guide §4). Nothing here knows the host it
 * runs on: every value comes from compose (`.env`, `env_file`) or is a neutral default.
 *
 * Secrets (AI_API_KEY, TELEGRAM_BOT_TOKEN) arrive via compose `env_file`; they are read here once and
 * never logged, returned or stored.
 *
 * The model endpoint (ADR-75): `.env.ai` sets AI_PROVIDER, AI_BASE_URL, AI_MODEL and AI_API_KEY. An
 * older install's `.env.gsq` (GSQ_BASE_URL, GSQ_MODEL, GSQ_API_KEY) still works as a local endpoint
 * when no AI_* value is set. With neither, AI is off and the deterministic drafts are used.
 */
export type Mode = 'live' | 'demo' | 'e2e' | 'test';

/**
 * Off, the owner's Hermes agent through the integration API (ADR-86: LifeOS calls no model then), a
 * model on this machine or network (recommended), or a cloud provider (ADR-81).
 */
export type AiProviderKind = 'off' | 'hermes' | 'local' | 'openai' | 'anthropic' | 'other';

export interface AiEndpoint {
  provider: AiProviderKind;
  /** OpenAI-style base URL, ending before `/chat/completions` (Anthropic: before `/messages`) */
  baseUrl: string;
  model: string;
  apiKey: string | null;
}

/** Where a cloud provider lives when no base URL is given. */
export const PROVIDER_BASE: Partial<Record<AiProviderKind, string>> = {
  openai: 'https://api.openai.com/v1',
  // the SDK adds /v1/messages itself
  anthropic: 'https://api.anthropic.com',
};

function env(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export interface Config {
  vault: string;
  data: string;
  authFile: string;
  port: number;
  host: string;
  /** LIFEOS_NAME: the compose project, container and network prefix (`<name>-api` on `<name>-net`) */
  name: string;
  /** LIFEOS_PORT: the port the app is published on, on the Docker host (the Hermes prompt's localhost address) */
  webPort: number;
  /** LIFEOS_BIND: the address the port is published on (0.0.0.0: the whole network, over plain http) */
  bind: string;
  /** the starter notes an empty notes folder is filled from on the first start (ADR-91) */
  starterVault: string;
  /** LIFEOS_STARTER=off: never fill an empty notes folder */
  starter: boolean;
  mode: Mode;
  /** LIFEOS_TELEGRAM=off turns delivery off; on, Telegram is used only when a bot is configured */
  telegram: boolean;
  /** LIFEOS_AI=off: deterministic fallbacks only, whatever the provider settings say */
  ai: boolean;
  /** the address a reminder's link opens (Telegram, browser notifications) */
  publicUrl: string;
  searxngUrl: string;
  /** TZ: the time zone until the first-run step chooses a city (whose zone then wins) */
  tz: string;
  /** the model endpoint from `.env.ai` (or the older `.env.gsq`); Settings → AI may choose another */
  aiEnv: AiEndpoint;
  bot: { token: string | null; chatId: string; threadId: string };
  /** LIFEOS_SETUP_SEED: the first-run answers as JSON, applied once when nothing was chosen yet */
  setupSeed: string | null;
  /** browser notifications (ADR-80): VAPID keys from `.env.push`, else generated and kept in SQLite */
  vapid: { publicKey: string | null; privateKey: string | null; subject: string };
}

const KINDS: AiProviderKind[] = ['off', 'hermes', 'local', 'openai', 'anthropic', 'other'];

/** The endpoint `.env.ai` describes, else `.env.gsq`'s, else off. */
export function aiFromEnv(): AiEndpoint {
  const baseUrl = env('AI_BASE_URL');
  const raw = env('AI_PROVIDER').toLowerCase() as AiProviderKind;
  const named = KINDS.includes(raw) ? raw : null;
  if (named === 'off') return { provider: 'off', baseUrl: '', model: '', apiKey: null };
  if (named === 'hermes') return { provider: 'hermes', baseUrl: '', model: '', apiKey: null };
  if (named || baseUrl || env('AI_MODEL') || env('AI_API_KEY')) {
    const provider = named ?? (baseUrl ? 'local' : 'off');
    return { provider, baseUrl: (baseUrl || PROVIDER_BASE[provider] || '').replace(/\/+$/, ''), model: env('AI_MODEL'), apiKey: env('AI_API_KEY') || null };
  }
  const legacy = env('GSQ_BASE_URL');
  if (legacy) return { provider: 'local', baseUrl: legacy.replace(/\/+$/, ''), model: env('GSQ_MODEL'), apiKey: env('GSQ_API_KEY') || null };
  return { provider: 'off', baseUrl: '', model: '', apiKey: null };
}

/** Who runs this push sender (RFC 8292 `sub`): LIFEOS_VAPID_SUBJECT, else the app's https address. */
function vapidSubject(): string {
  const given = env('LIFEOS_VAPID_SUBJECT');
  if (/^(mailto:|https:)/.test(given)) return given;
  const url = env('LIFEOS_PUBLIC_URL');
  return url.startsWith('https://') ? url.replace(/\/+$/, '') : 'mailto:lifeos@localhost.invalid';
}

/** Whether the published port is reachable from other machines (not a loopback address). */
export function exposedBind(bind: string): boolean {
  const b = bind.trim().replace(/^\[|\]$/g, '').toLowerCase();
  return !(b === '' || b === 'localhost' || b === '::1' || /^127\.\d+\.\d+\.\d+$/.test(b));
}

export function loadConfig(over: Partial<Config> = {}): Config {
  const mode = env('LIFEOS_MODE', 'live') as Mode;
  const data = env('LIFEOS_DATA', '/data');
  return {
    vault: env('LIFEOS_VAULT', '/vault'),
    data,
    // compose mounts LIFEOS_AUTH_DIR, or else the data volume, at /auth (ADR-90)
    authFile: env('LIFEOS_AUTH_FILE', `${data.replace(/\/+$/, '')}/.env.auth`),
    port: Number(env('PORT', '8481')),
    host: env('HOST', '0.0.0.0'),
    name: /^[a-z0-9][a-z0-9_.-]{0,40}$/.test(env('LIFEOS_NAME')) ? env('LIFEOS_NAME') : 'lifeos',
    webPort: Number(env('LIFEOS_PORT', '8480')) || 8480,
    bind: env('LIFEOS_BIND', '127.0.0.1'),
    starterVault: env('LIFEOS_STARTER_VAULT', '/repo/starter-vault'),
    starter: env('LIFEOS_STARTER', 'on') !== 'off',
    mode,
    telegram: env('LIFEOS_TELEGRAM', 'on') !== 'off',
    ai: env('LIFEOS_AI', 'on') !== 'off',
    publicUrl: env('LIFEOS_PUBLIC_URL', 'http://localhost:8480/lifeos').replace(/\/+$/, ''),
    searxngUrl: env('LIFEOS_SEARXNG_URL', 'http://lifeos-searxng:8080').replace(/\/+$/, ''),
    tz: env('TZ', 'UTC'),
    aiEnv: aiFromEnv(),
    bot: { token: env('TELEGRAM_BOT_TOKEN') || null, chatId: env('TELEGRAM_CHAT_ID'), threadId: env('TELEGRAM_THREAD_ID') },
    setupSeed: env('LIFEOS_SETUP_SEED') || null,
    vapid: { publicKey: env('LIFEOS_VAPID_PUBLIC_KEY') || null, privateKey: env('LIFEOS_VAPID_PRIVATE_KEY') || null, subject: vapidSubject() },
    ...over,
  };
}
