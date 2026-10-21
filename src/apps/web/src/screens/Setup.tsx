/**
 * The first run after the passphrase (product brief 8 §1, ADR-76), shown once: where you are (for
 * prayer times and the day's boundaries), the method, the Hijri adjustment, whether the times may be
 * compared online once, then the Obsidian vault's name for links and who writes the AI drafts (Off
 * unless chosen; a cloud provider is named in a warning, ADR-81). Everything is stored by this
 * server's API in its own settings, never in the notes and never sent anywhere; Settings changes it
 * later.
 */
import { useEffect, useMemo, useState } from 'react';
import { hm12, type PrayerMethod, prayerTimes, todayIn } from '@lifeos/shared';
import { coords, type Place, PlacePicker } from '../components/PlacePicker';
import { HijriAdjust, MethodSelect } from '../components/PrayerFields';
import { Switch } from '../components/ui';
import { ProviderFields } from '../components/AiProvider';
import { draftFrom, type ProviderDraft, type ProviderView, toBody } from '../lib/ai';
import { api, ApiError } from '../lib/api';

interface Check {
  agree: boolean;
  maxDiff: number | null;
}

export function SetupScreen({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<1 | 2>(1);
  const [place, setPlace] = useState<Place | null>(null);
  const [method, setMethod] = useState<PrayerMethod>('tehran');
  const [hijriOffset, setHijri] = useState<-1 | 0 | 1>(0);
  const [prayerCheck, setPrayerCheck] = useState(false);
  const [vaultName, setVaultName] = useState('');
  const [check, setCheck] = useState<Check | 'failed' | null>(null);
  const [aiView, setAiView] = useState<ProviderView | null>(null);
  const [ai, setAi] = useState<ProviderDraft>(draftFrom(null));
  useEffect(() => {
    void api<ProviderView>('api/ai/provider')
      .then((v) => {
        setAiView(v);
        setAi(draftFrom(v));
      })
      .catch(() => undefined);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const preview = useMemo(() => {
    if (!place) return null;
    try {
      const t = prayerTimes(todayIn(place.tz), { lat: place.lat, lon: place.lon, tz: place.tz, method });
      return `Fajr ${hm12(t.fajr)} · Dhuhr ${hm12(t.dhuhr)} · Maghrib ${hm12(t.maghrib)}`;
    } catch {
      return null;
    }
  }, [place, method]);

  const savePlace = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!place) return setError('Choose your city, or enter coordinates and a time zone.');
    setError(null);
    setBusy(true);
    try {
      await api('api/settings', { method: 'PUT', json: { place: place.name, lat: place.lat, lon: place.lon, tz: place.tz, method, hijriOffset, prayerCheck } });
      if (prayerCheck) {
        // the one comparison the owner allowed: rounded coordinates and the date to Aladhan
        const r = await api<Check>('api/prayer/verify', { method: 'POST', json: {} }).catch(() => 'failed' as const);
        setCheck(r);
      }
      setStep(2);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach LifeOS. Check the connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const finish = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      // the AI choice first (Off unless chosen): a provider needs its fields, the server says which
      if (JSON.stringify(toBody(ai)) !== JSON.stringify(toBody(draftFrom(aiView)))) await api('api/ai/provider', { method: 'PUT', json: toBody(ai) });
      await api('api/setup', { method: 'POST', json: { vaultName: vaultName.trim() } });
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) return onDone();
      setError(err instanceof ApiError ? err.message : 'Could not reach LifeOS. Check the connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  if (step === 1)
    return (
      <main className="auth setup">
        <form className="auth-card card setup-card" onSubmit={(e) => void savePlace(e)} data-testid="setup-place">
          <p className="setup-step">Step 1 of 2</p>
          <h1>Where are you?</h1>
          <p>For prayer times, the Hijri date and when your day begins. The city list is built in: nothing is looked up online.</p>
          <PlacePicker value={place} onChange={setPlace} autoFocus detail={preview ? <span data-testid="setup-preview">Today: {preview}</span> : null} />
          <MethodSelect value={method} onChange={setMethod} />
          <HijriAdjust value={hijriOffset} onChange={setHijri} />
          <Switch
            label="Check these times online once"
            hint={`Sends the date and rounded coordinates${place ? ` (${coords(place.lat, place.lon)})` : ''} to api.aladhan.com to compare. Off: nothing is sent.`}
            checked={prayerCheck}
            onChange={setPrayerCheck}
            testId="setup-check"
          />
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="btn btn-primary btn-block" disabled={busy || !place} data-testid="setup-continue">
            Continue
          </button>
        </form>
      </main>
    );

  return (
    <main className="auth setup">
      <form className="auth-card card setup-card" onSubmit={(e) => void finish(e)} data-testid="setup-finish">
        <p className="setup-step">Step 2 of 2</p>
        <h1>Two last choices</h1>
        {check && (
          <p className={check !== 'failed' && check.agree ? 'setup-check-ok' : 'caption'} data-testid="setup-check-result">
            {check === 'failed' ? 'Aladhan could not be reached. You can compare later in Settings → Advanced → Prayer.' : check.agree ? `Checked online: Aladhan's times agree within ${check.maxDiff ?? 0} min.` : `Checked online: Aladhan differs by up to ${check.maxDiff ?? '?'} min. The method may differ from your mosque's; Settings → Advanced → Prayer changes it.`}
          </p>
        )}
        <label className="field">
          <span>Obsidian vault name (optional)</span>
          <input className="input" value={vaultName} onChange={(e) => setVaultName(e.target.value)} placeholder="Leave empty if you don't use Obsidian" maxLength={100} autoCapitalize="off" data-testid="setup-vault" />
          <span className="caption">Your notes are plain .md files in a folder; any editor opens them. With Obsidian on this device, its name here lets LifeOS open a note there.</span>
        </label>
        <div className="field setup-ai">
          <span>AI drafts</span>
          <span className="caption">A model can draft the morning plan, the evening review and habit encouragement for you to approve. Without one, LifeOS drafts them plainly from your tasks and times.</span>
          {aiView?.lifeosAi === false ? <span className="caption">AI is off for this install (LIFEOS_AI=off).</span> : <ProviderFields value={ai} onChange={setAi} saved={aiView} disabled={busy} />}
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy} data-testid="setup-done">
          Open LifeOS
        </button>
        <button type="button" className="btn btn-quiet" onClick={() => setStep(1)} data-testid="setup-back">
          Back
        </button>
      </form>
    </main>
  );
}
