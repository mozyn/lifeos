/**
 * Bring your own model (product brief 8 §7, ADR-81). `ProviderFields`: Off, Hermes (the owner's agent,
 * product brief 9, ADR-86), Local (recommended), OpenAI, Anthropic Claude or another cloud service,
 * with the address, model and key each needs,
 * and the warning whenever the prompts would leave this machine. Settings → Advanced → AI and the
 * first run use it. `CloudGate`: Today asks again before a cloud provider's first job.
 */
import { useState } from 'react';
import { Cloud, ShieldCheck } from 'lucide-react';
import { ApiError } from '../lib/api';
import { cloudWho, HERMES_PRIVACY, MODEL_PLACEHOLDER, PROVIDERS, type ProviderDraft, type ProviderView, URL_PLACEHOLDER, warningFor } from '../lib/ai';
import { toast, write } from '../lib/store';

export function ProviderFields({ value, onChange, saved, disabled }: { value: ProviderDraft; onChange: (d: ProviderDraft) => void; saved: ProviderView | null; disabled?: boolean }) {
  const set = (patch: Partial<ProviderDraft>) => onChange({ ...value, ...patch });
  const who = cloudWho(value);
  const sameAsSaved = saved?.provider === value.provider;
  const keyHint = sameAsSaved && saved?.hasKey ? (saved.keyFrom === 'env' ? 'From .env.ai (leave empty to keep it)' : 'Saved (leave empty to keep it)') : value.provider === 'local' ? 'Optional' : 'Required';
  return (
    <div className="provider-fields" data-testid="provider-fields">
      <div className="provider-list" role="radiogroup" aria-label="Who writes the drafts">
        {PROVIDERS.map((p) => (
          <label key={p.kind} className="provider-option" data-checked={value.provider === p.kind ? '' : undefined}>
            <input
              type="radio"
              name="ai-provider"
              value={p.kind}
              checked={value.provider === p.kind}
              disabled={disabled}
              onChange={() => onChange({ provider: p.kind, baseUrl: p.kind === saved?.provider ? (saved.provider === 'local' || saved.provider === 'other' ? saved.baseUrl : '') : '', model: p.kind === saved?.provider ? saved.model : '', apiKey: '' })}
              data-testid={`provider-${p.kind}`}
            />
            <span className="provider-text">
              <span className="provider-label">{p.label}</span>
              <span className="caption">{p.hint}</span>
              {p.badge && (
                <span className="provider-badge">
                  <ShieldCheck aria-hidden />
                  {p.badge}
                </span>
              )}
            </span>
          </label>
        ))}
      </div>
      {value.provider === 'hermes' && (
        <div className="provider-inputs" data-testid="provider-hermes-note">
          {!saved?.linked && <p className="caption">Not connected yet: Settings → Hermes gives you a prompt to paste in your Hermes chat.</p>}
          <p className="caption">{HERMES_PRIVACY}</p>
        </div>
      )}
      {value.provider !== 'off' && value.provider !== 'hermes' && (
        <div className="provider-inputs">
          {(value.provider === 'local' || value.provider === 'other') && (
            <label className="field">
              <span>Server address</span>
              <input className="input" value={value.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder={URL_PLACEHOLDER[value.provider]} inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} disabled={disabled} data-testid="provider-url" />
              {value.provider === 'local' && <span className="caption">From inside Docker, this computer is host.docker.internal. The address ends before /chat/completions.</span>}
            </label>
          )}
          <label className="field">
            <span>Model</span>
            <input className="input" value={value.model} onChange={(e) => set({ model: e.target.value })} placeholder={MODEL_PLACEHOLDER[value.provider]} autoCapitalize="off" autoCorrect="off" spellCheck={false} disabled={disabled} data-testid="provider-model" />
          </label>
          <label className="field">
            <span>API key</span>
            <input className="input" type="password" value={value.apiKey} onChange={(e) => set({ apiKey: e.target.value })} placeholder={keyHint} autoComplete="off" disabled={disabled} data-testid="provider-key" />
            <span className="caption">Kept in LifeOS&rsquo;s own settings on this server, never in your notes, never shown again.</span>
          </label>
        </div>
      )}
      {who && (
        <p className="provider-warning" role="note" data-testid="provider-warning">
          <Cloud aria-hidden />
          <span>{warningFor(who)}</span>
        </p>
      )}
    </div>
  );
}

/** Today: a cloud provider's first job waits here, with the warning once more (ADR-81). */
export function CloudGate({ cloud }: { cloud: { host: string; who: string; warning: string } }) {
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  if (hidden) return null;
  return (
    <div className="cloud-gate" role="note" data-testid="cloud-gate">
      <p className="cloud-gate-title">
        <Cloud aria-hidden />
        Draft this with {cloud.who}?
      </p>
      <p className="caption">{cloud.warning}</p>
      <div className="card-foot">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              // the waiting drafts are drafted again; Today refreshes when they are ready
              await write({ path: 'api/ai/cloud-ok', kind: 'ai-cloud-ok', label: 'Allow the model' });
            } catch (e) {
              toast(e instanceof ApiError ? e.message : 'Not allowed.', 'error');
            } finally {
              setBusy(false);
            }
          }}
          data-testid="cloud-gate-send"
        >
          Send to {cloud.who.replace(/ \(.*\)$/, '')}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setHidden(true)} data-testid="cloud-gate-later">
          Not now
        </button>
      </div>
    </div>
  );
}
