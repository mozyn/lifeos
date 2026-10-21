/**
 * Settings → Hermes (product brief 9 §3, ADR-88): one job, connect Hermes. The status (not
 * connected, waiting for its first call, connected with its last call and model), Create token or
 * Revoke, and the prompt to paste in the Hermes chat with a Copy button. The prompt holds the token,
 * which the server shows once: it is kept in this page's memory only (never on the device's disk),
 * so after a reload a new token is the way to a new prompt. `TelegramRow`: Settings → Reminders says
 * who sends reminders to Telegram.
 */
import { useRef, useState } from 'react';
import { instantText } from '@lifeos/shared';
import { api, ApiError } from '../lib/api';
import { HERMES_PRIVACY } from '../lib/ai';
import { type ConnectionStatus, statusText, telegramText } from '../lib/hermes';
import { emit, toast, useResource } from '../lib/store';

/** The prompt of the token made in this page's life (memory only: the token is shown once). */
let fresh: string | null = null;

async function copyText(text: string, box: HTMLTextAreaElement | null): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // no clipboard API outside a secure context (a plain http address on the home network)
    if (!box) return false;
    box.focus();
    box.select();
    return document.execCommand('copy');
  }
}

export function HermesSettings() {
  const { data, reload } = useResource<ConnectionStatus>('api/hermes');
  const [prompt, setPrompt] = useState<string | null>(fresh);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  if (!data) return <p className="secondary">Loading…</p>;
  const linked = data.state !== 'none';
  const shown = linked ? prompt : null;

  const create = async () => {
    setBusy(true);
    try {
      const r = await api<{ token: string; prompt: string }>('api/hermes/token', { method: 'POST', json: {} });
      fresh = r.prompt;
      setPrompt(r.prompt);
      setCopied(false);
      await reload();
      // the AI provider is Hermes now: Settings → AI and Today follow
      emit('synced');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not make a token.', 'error');
    } finally {
      setBusy(false);
    }
  };
  const revoke = async () => {
    setBusy(true);
    try {
      await api('api/hermes/revoke', { method: 'POST', json: {} });
      fresh = null;
      setPrompt(null);
      await reload();
      emit('synced');
      toast('Token revoked: Hermes can no longer reach LifeOS');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not revoke the token.', 'error');
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    if (!shown) return;
    const ok = await copyText(shown, box.current);
    setCopied(ok);
    toast(ok ? 'Copied: paste it in your Hermes chat' : 'Select the text and copy it', ok ? 'info' : 'error');
  };

  return (
    <>
      <div className="setting-row">
        <span className="setting-label">
          <span data-testid="hermes-status">{statusText(data)}</span>
          {!linked && <span className="caption">Your own AI agent can write your drafts, add tasks from chat and send reminders on Telegram</span>}
          {linked && data.draftsBy !== 'hermes' && <span className="caption">AI drafts are LifeOS&rsquo;s own (Advanced → AI); Hermes adds tasks and sends reminders</span>}
        </span>
        {!linked && (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void create()} data-testid="hermes-create">
            Create token
          </button>
        )}
      </div>
      {shown && (
        <div className="setting-block connect-prompt">
          <label className="field">
            <span>Paste this in your Hermes chat</span>
            <textarea ref={box} className="textarea connect-prompt-box" readOnly value={shown} rows={9} spellCheck={false} onFocus={(e) => e.currentTarget.select()} data-testid="hermes-prompt" />
          </label>
          <p className="caption" data-testid="hermes-privacy">
            {HERMES_PRIVACY}
          </p>
          <div className="card-foot">
            <button type="button" className="btn btn-primary" onClick={() => void copy()} data-testid="hermes-copy">
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void revoke()} data-testid="hermes-revoke">
              Revoke
            </button>
          </div>
          <p className="caption">The prompt holds the token once; LifeOS does not show it again.</p>
        </div>
      )}
      {linked && !shown && (
        <div className="setting-block">
          <p className="caption">
            The token was shown once, in the prompt, on {instantText(data.token!.createdAt)}. To connect Hermes again, make a new token; the old one stops working.
          </p>
          <p className="caption" data-testid="hermes-privacy">
            {HERMES_PRIVACY}
          </p>
          <div className="card-foot">
            <button type="button" className="btn" disabled={busy} onClick={() => void create()} data-testid="hermes-new">
              New token
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void revoke()} data-testid="hermes-revoke">
              Revoke
            </button>
          </div>
        </div>
      )}
      {linked && data.ownBot && <TwoBots reload={reload} />}
    </>
  );
}

/** LifeOS's own Telegram bot is on too: each reminder could come twice (ADR-87). */
function TwoBots({ reload }: { reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="setting-block" data-testid="hermes-two-bots">
      <p className="caption">LifeOS&rsquo;s own Telegram bot sends reminders too (Advanced → Telegram bot). Once Hermes sends them, turn it off so each comes once.</p>
      <div className="card-foot">
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api('api/settings', { method: 'PUT', json: { telegram: false } });
              await reload();
              emit('synced');
            } catch (e) {
              toast(e instanceof ApiError ? e.message : 'Not saved.', 'error');
            } finally {
              setBusy(false);
            }
          }}
          data-testid="hermes-bot-off"
        >
          Turn off LifeOS&rsquo;s bot
        </button>
      </div>
    </div>
  );
}

/** Settings → Reminders → Telegram: Hermes sends them, or LifeOS's own bot, or nobody yet. */
export function TelegramRow({ ownBot }: { ownBot: boolean }) {
  const { data } = useResource<ConnectionStatus>('api/hermes');
  const text = telegramText(data ?? null, ownBot);
  return (
    <div className="setting-row" data-testid="reminders-telegram">
      <span>Telegram</span>
      <span className="secondary">{text}</span>
    </div>
  );
}
