/**
 * The passphrase screens (ADR-11): "Set your passphrase" once on first run, then "Unlock".
 * Above them, once per device, the plain-http banner when LifeOS is open to the network
 * (LIFEOS_BIND=0.0.0.0) and this page came over http (product brief 10 §2, ADR-94).
 */
import { useState } from 'react';
import { api, ApiError, appAddress } from '../lib/api';

const HTTPS_SEEN = 'lifeos:https-banner-seen';

/** The banner is due: the port is open to the network, the page is plain http, not seen here yet. */
export function httpsBannerDue(exposed: boolean, protocol = location.protocol): boolean {
  if (!exposed || protocol !== 'http:') return false;
  try {
    return localStorage.getItem(HTTPS_SEEN) !== '1';
  } catch {
    return true;
  }
}

function markHttpsSeen(): void {
  try {
    localStorage.setItem(HTTPS_SEEN, '1');
  } catch {
    /* private mode: it shows again next time */
  }
}

function HttpsBanner({ onClose }: { onClose: () => void }) {
  return (
    <section className="auth-notice card" role="note" aria-label="Plain http" data-testid="https-banner">
      <p>
        <strong>You are on plain http.</strong> Install to the home screen and notifications need https: use Tailscale Serve, your NAS's reverse proxy, or a local certificate.
      </p>
      <div className="auth-notice-actions">
        <a href={`${import.meta.env.BASE_URL}guide.html#https-on-a-nas`} target="_blank" rel="noopener" data-testid="https-banner-guide">
          README: HTTPS on a NAS
        </a>
        <button type="button" className="btn" onClick={onClose} data-testid="https-banner-ok">
          OK
        </button>
      </div>
    </section>
  );
}

export function AuthScreen({ setup, exposed = false, onDone }: { setup: boolean; exposed?: boolean; onDone: () => void }) {
  const [banner, setBanner] = useState(() => httpsBannerDue(exposed));
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (setup) {
      if ([...pass].length < 4) return setError('Use at least 4 characters.');
      if (pass !== confirm) return setError('The two entries are different.');
    }
    setBusy(true);
    try {
      // this page's own address goes with it: LifeOS learns where it is opened (ADR-104)
      await api(setup ? 'api/auth/setup' : 'api/auth/login', { method: 'POST', json: { passphrase: pass, address: appAddress() } });
      // seen on this device's first open: it does not come back
      if (banner) markHttpsSeen();
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach LifeOS. Check the connection and try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="auth">
      <div className="auth-stack">
        {banner && (
          <HttpsBanner
            onClose={() => {
              markHttpsSeen();
              setBanner(false);
            }}
          />
        )}
        <form className="auth-card card" onSubmit={(e) => void submit(e)} data-testid={setup ? 'setup-form' : 'login-form'}>
          <h1>{setup ? 'Set your passphrase' : 'LifeOS'}</h1>
          <p>
            {setup
              ? 'This is the only key to LifeOS. It is stored on this server as an argon2 hash and asked for once every 90 days on each device. This screen will not appear again.'
              : 'Enter your passphrase to open today.'}
          </p>
          <label className="field">
            <span>Passphrase</span>
            <input
              className="input"
              type="password"
              autoComplete={setup ? 'new-password' : 'current-password'}
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              autoFocus
              data-testid="passphrase"
            />
          </label>
          {setup && (
            <label className="field">
              <span>Same passphrase again</span>
              <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} data-testid="passphrase-confirm" />
            </label>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="btn btn-primary btn-block" disabled={busy || !pass} data-testid="auth-submit">
            {setup ? 'Save passphrase' : 'Unlock'}
          </button>
        </form>
      </div>
    </main>
  );
}
