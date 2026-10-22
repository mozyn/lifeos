/**
 * Settings (spec §4, round-4 brief §4): two layers. Simple, always shown: Appearance, Reminders,
 * Hermes (product brief 9 §3), Privacy, Gestures, the Advanced settings switch and About. Advanced,
 * under one header while that switch is on: Look and feel, Prayer, AI, Telegram bot, Search,
 * Diagnostics, Data. Nothing was removed, only moved. Device settings live on the device;
 * everything else is stored by the API (never in the vault).
 */
import { type ReactNode, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { hm12, instantText, localZone, noteLabel, numericDate, type PrayerMethod, releaseName, releasesDiffer, shortDateYear, zonedParts } from '@lifeos/shared';
import { ArrowLeft, ArrowRight, Check, ExternalLink, X } from 'lucide-react';
import { Disclosure, Segmented, Slider, Switch } from '../components/ui';
import { coords, type Place, PlacePicker } from '../components/PlacePicker';
import { HijriAdjust, MethodSelect } from '../components/PrayerFields';
import { ProviderFields } from '../components/AiProvider';
import { HermesSettings, TelegramRow } from '../components/Hermes';
import { draftFrom, type ProviderDraft, type ProviderView, toBody } from '../lib/ai';
import { api, ApiError } from '../lib/api';
import { advancedOn, setAdvanced, useAdvanced } from '../lib/advanced';
import { BUILD, reloadApp } from '../lib/build';
import { type FrameMode, type FrameReport, lastReport, measureFrames, reportText, slidesText } from '../lib/frames';
import { applyAppearance, glassQuality, type Prefs, resolveTheme, usePrefs } from '../lib/prefs';
import { revealTheme } from '../lib/transitions';
import { emit, reopenEvents, toast, useResource, write } from '../lib/store';
import { setPrivacy, usePrivacy } from '../lib/privacy';
import { disablePush, enablePush, type PushState, pushState, refreshPush, testPush } from '../lib/push';
import { choiceOf, GESTURE_DEFAULTS, type HapticStrength, HAPTIC_MS, type HoldChoice, HOLD_OPTIONS, haptic, resetGestures, setGestures, type SwipeChoice, SWIPE_OPTIONS, useGestures } from '../lib/gestures';
import { SwipeRow } from '../components/SwipeRow';
import { whenVisible } from '../lib/panes';
import { THEMES, meshCss } from '../lib/themes';

interface SettingsDto {
  settings: {
    prayer: { method: PrayerMethod; lat: number; lon: number; tz: string };
    place: string | null;
    hijriOffset: -1 | 0 | 1;
    prayerCheck: boolean;
    vaultName: string;
    ownerName: string;
    setupAt: string | null;
    telegram: boolean;
    quietStart: string;
    quietEnd: string;
    search: boolean;
    searchDomains: string[];
    ai: boolean;
  };
  methods: Record<string, string>;
  server: { telegram: boolean; ai: boolean; mode: string; zone: string };
}

type Save = (patch: Record<string, unknown>) => Promise<void>;

interface VerifyResult {
  date: string;
  rows: { prayer: string; offline: string; aladhan: string | null; diffMin: number | null }[];
  maxDiff: number | null;
  agree: boolean;
  timezone: string | null;
}

/** A row of the connection log: a call this server made (out) or one Hermes made to it (in). */
interface LogRow {
  dir: 'in' | 'out';
  at: string;
  who: string;
  what: string;
  method: string;
  status: number | 'refused' | null;
  sent: number;
  received: number;
}

/** The Advanced groups: a link to one of them (`?s=search`) turns Advanced on first. */
const ADVANCED = ['advanced', 'look', 'prayer', 'ai', 'telegram', 'search', 'diagnostics', 'data', 'frames'];
/** where round 3's sections went */
const MOVED: Record<string, string> = { system: 'diagnostics' };

/** The spec, when the notes folder has it: in Obsidian on this device when the vault's name is set (a link to the app, nothing is fetched), else its path. */
const SPEC_PATH = 'Projects/lifeos/lifeos-master-plan';
const specUrl = (vault: string) => `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(SPEC_PATH)}`;

/** One group: its heading and one section (a solid face under a glass rim, rows separated by lines). */
function Section({ title, id, level = 2, testId, children }: { title: string; id: string; level?: 2 | 3; testId?: string; children: ReactNode }) {
  const H = level === 3 ? 'h3' : 'h2';
  return (
    <section className="settings-section" id={id} aria-labelledby={`${id}-h`}>
      <H id={`${id}-h`}>{title}</H>
      <div className="card settings-card" data-testid={testId}>
        {children}
      </div>
    </section>
  );
}

const QUALITY_HINT = {
  full: 'Every glass surface bends light, with colour fringes',
  balanced: 'The bars bend light; controls do under your finger',
  light: 'Frosted glass, no bending',
} as const;

/** Settings → Appearance → Glass quality (UI brief 4): Full, Balanced (a phone's default), Light. */
function GlassQualityRow() {
  const { prefs, setPrefs } = usePrefs();
  const system = window.matchMedia?.('(prefers-reduced-transparency: reduce)').matches ?? false;
  const q = glassQuality(prefs);
  return (
    <div className="setting-row setting-stack">
      <span className="setting-label">
        <span>Glass quality</span>
        <span className="caption" data-testid="glass-quality-hint">
          {system ? 'Light, because your system asks for reduced transparency' : QUALITY_HINT[q]}
        </span>
      </span>
      <Segmented
        label="Glass quality"
        fill
        value={q}
        onChange={(v) => setPrefs({ glassQuality: v })}
        options={[
          { value: 'full', label: 'Full', disabled: system, testId: 'glass-full' },
          { value: 'balanced', label: 'Balanced', disabled: system, testId: 'glass-balanced' },
          { value: 'light', label: 'Light', disabled: system, testId: 'glass-light' },
        ]}
        testId="glass-quality"
      />
    </div>
  );
}

export function SettingsScreen() {
  const { prefs, setPrefs, theme } = usePrefs();
  const { data, reload } = useResource<SettingsDto>('api/settings');
  const [params] = useSearchParams();
  const advanced = useAdvanced();

  // a link to a section scrolls to it; one in Advanced turns Advanced on first (it stays on: the
  // switch shows it, and it is the owner's to turn off)
  useEffect(() => {
    const raw = params.get('s');
    const s = raw ? (MOVED[raw] ?? raw) : null;
    if (!s) return;
    if (ADVANCED.includes(s) && !advancedOn()) {
      setAdvanced(true);
      return;
    }
    const el = document.getElementById(s);
    if (el) whenVisible(el, () => el.scrollIntoView({ block: 'start' }));
  }, [params, data, advanced]);

  const save: Save = async (patch) => {
    try {
      await api('api/settings', { method: 'PUT', json: patch });
      await reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Not saved.', 'error');
    }
  };
  const s = data?.settings;
  // a new look grows in a circle from the control that was tapped (UI brief 2 §3)
  const appearance = (patch: Partial<Prefs>, from: Element | null) => {
    const next = { ...prefs, ...patch };
    if (resolveTheme(next) === resolveTheme(prefs) && next.themeName === prefs.themeName) {
      setPrefs(patch);
      return;
    }
    void revealTheme(from, () => {
      applyAppearance(next);
      setPrefs(patch);
    });
  };
  const loading = <p className="secondary">Loading…</p>;

  return (
    <div className="page settings" data-testid="settings" data-advanced={advanced ? '' : undefined}>
      <h1 className="page-title">Settings</h1>

      <Section title="Appearance" id="appearance">
        <div className="setting-row">
          <span>Theme</span>
          <Segmented
            label="Theme"
            value={prefs.theme}
            onChange={(v) => appearance({ theme: v }, document.querySelector(`[data-testid="appearance-${v}"]`))}
            options={[
              { value: 'light', label: 'Light', testId: 'appearance-light' },
              { value: 'dark', label: 'Dark', testId: 'appearance-dark' },
              { value: 'system', label: 'Auto', testId: 'appearance-system' },
            ]}
            testId="appearance"
          />
        </div>
        <div className="setting-row">
          <span>Text size</span>
          <Slider id="text-size" min={0.9} max={1.3} step={0.05} value={prefs.textScale} onChange={(v) => setPrefs({ textScale: v })} label="Text size" valueText={`${Math.round(prefs.textScale * 100)} percent`} />
        </div>
        <GlassQualityRow />
      </Section>

      <Section title="Reminders" id="reminders">
        {s ? <RemindersSettings s={s} serverTelegram={!!data?.server.telegram} save={save} /> : loading}
      </Section>

      <Section title="Hermes" id="hermes" testId="hermes">
        <HermesSettings />
      </Section>

      <Section title="Privacy" id="privacy">
        <PrivacyModeRow />
        {s && <Switch label="Web search" hint="In Lists and Quick Add; only the words you type leave this server" checked={s.search} onChange={(v) => void save({ search: v })} testId="search-switch" />}
        <CloudNote />
        <ConnectionLog />
      </Section>

      <Section title="Gestures" id="gestures" testId="gestures">
        <GestureSettings />
      </Section>

      <section className="settings-section settings-switch" aria-label="Advanced settings">
        <div className="card settings-card">
          <Switch label="Advanced settings" hint="Prayer, AI, Telegram bot, search, diagnostics, data" checked={advanced} onChange={setAdvanced} testId="advanced-switch" />
        </div>
      </section>

      {advanced && (
        <div className="settings-advanced" id="advanced" role="region" aria-labelledby="advanced-h" data-testid="advanced">
          <div className="settings-advanced-head">
            <h2 id="advanced-h">Advanced</h2>
            <p className="caption">For tuning and diagnostics</p>
          </div>

          <Section title="Look and feel" id="look" level={3}>
            <div className="setting-block">
              <span>Colours</span>
              <div className="theme-grid" role="group" aria-label="Colours">
                {THEMES.map((t) => (
                  <button key={t.id} type="button" className="swatch" aria-pressed={prefs.themeName === t.id} onClick={(e) => appearance({ themeName: t.id }, e.currentTarget)} data-testid={`theme-${t.id}`}>
                    <span className="swatch-art" style={{ background: meshCss(t[theme]) }} aria-hidden />
                    {t.name}
                  </button>
                ))}
              </div>
            </div>
            <Switch label="Solid controls" hint="No transparency at all" checked={prefs.reducedTransparency} onChange={(v) => setPrefs({ reducedTransparency: v })} testId="solid-switch" />
            <div className="setting-row">
              <span>Motion</span>
              <Segmented
                label="Motion"
                value={prefs.motion}
                onChange={(v) => setPrefs({ motion: v })}
                options={[
                  { value: 'system', label: 'System' },
                  { value: 'reduced', label: 'Reduced' },
                  { value: 'full', label: 'Full' },
                ]}
                testId="motion"
              />
            </div>
            <Switch label="Mute rewards" hint="No chime when you complete something" checked={prefs.muteRewards} onChange={(v) => setPrefs({ muteRewards: v })} testId="mute-switch" />
          </Section>

          <Section title="Prayer" id="prayer" level={3}>
            {s ? <PrayerSettings s={s} save={save} /> : loading}
          </Section>

          <Section title="AI" id="ai" level={3}>
            {s && <Switch label="AI drafts" hint="Morning plan, evening review, habit encouragement. Off: plain drafts only." checked={s.ai && !!data?.server.ai} disabled={!data?.server.ai} onChange={(v) => void save({ ai: v })} testId="ai-switch" />}
            <AiProviderSettings />
            <AiStatus />
          </Section>

          <Section title="Telegram bot" id="telegram" level={3}>
            {s ? (
              <Switch
                label="LifeOS's own bot"
                hint={data?.server.telegram ? 'Sends reminders from the bot in .env.telegram. With Hermes you need none.' : 'Not set up (see the README). With Hermes you need none.'}
                checked={s.telegram && !!data?.server.telegram}
                disabled={!data?.server.telegram}
                onChange={(v) => void save({ telegram: v })}
                testId="telegram-switch"
              />
            ) : (
              loading
            )}
          </Section>

          <Section title="Search" id="search" level={3}>
            {!s ? (
              loading
            ) : s.search ? (
              <>
                <Disclosure what="engine health" testId="show-engines" panelTestId="engines-panel">
                  <SearchEngines />
                </Disclosure>
                <PreferredSites domains={s.searchDomains} save={save} />
              </>
            ) : (
              <p className="caption" data-testid="search-off">
                Web search is off (Privacy, above). Its engines and the Islamic search&rsquo;s preferred sites are here while it is on.
              </p>
            )}
          </Section>

          <Section title="Diagnostics" id="diagnostics" level={3}>
            <Disclosure what="frame meter" testId="show-frames" panelTestId="frames-panel">
              <FrameMeter />
            </Disclosure>
            <IndexRows />
            <HealthRows />
            {s && <ReminderChecks />}
          </Section>

          <Section title="Data" id="data" level={3}>
            <RecentlyDeleted />
            <Archived />
          </Section>
        </div>
      )}

      <Section title="About" id="about">
        <AboutRows vaultName={s?.vaultName ?? ''} />
        <div className="setting-block">
          <div className="card-foot">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={async () => {
                await api('api/auth/logout', { method: 'POST', json: {} }).catch(() => undefined);
                reopenEvents();
                window.dispatchEvent(new CustomEvent('lifeos:signed-out'));
              }}
              data-testid="sign-out"
            >
              Sign out
            </button>
          </div>
        </div>
      </Section>
    </div>
  );
}

/**
 * Settings → About: the release this page is and the day it was built (ADR-103), the day LifeOS was
 * set up, the spec (when the notes have it). An update replaces both images, but a phone may hold
 * the old page: when the server's release is another one, the row says so and offers a reload
 * (from a fresh answer only, never from the copy kept on the device).
 */
function AboutRows({ vaultName }: { vaultName: string }) {
  const { data, stale } = useResource<{ version: string; release?: string; setupAt: string | null; spec?: boolean }>('api/system/about');
  const [reloading, setReloading] = useState(false);
  const day = (iso: string) => shortDateYear(zonedParts(new Date(iso), localZone()).date);
  const server = data && !stale && releasesDiffer(BUILD.release, data.release) ? releaseName(data.release!, data.version) : null;
  return (
    <>
      <div className="setting-row">
        <span className="setting-label">
          <span data-testid="about-version">{releaseName(BUILD.release, BUILD.version)}</span>
          {server && (
            <span className="caption" data-testid="about-updated">
              The app was updated to {server}: reload.
            </span>
          )}
        </span>
        {server ? (
          <button
            type="button"
            className="btn"
            disabled={reloading}
            onClick={() => {
              setReloading(true);
              void reloadApp();
            }}
            data-testid="about-reload"
          >
            Reload
          </button>
        ) : (
          BUILD.builtAt && (
            <span className="secondary num" data-testid="about-built">
              {day(BUILD.builtAt)}
            </span>
          )
        )}
      </div>
      <div className="setting-row">
        <span>Set up on</span>
        <span className="secondary" data-testid="about-setup">
          {data?.setupAt ? day(data.setupAt) : '…'}
        </span>
      </div>
      {data?.spec &&
        (vaultName.trim() ? (
          <a className="setting-row setting-link" href={specUrl(vaultName.trim())} data-testid="about-spec">
            <span className="setting-label">
              <span>The plan</span>
              <span className="caption">{SPEC_PATH}.md, in Obsidian</span>
            </span>
            <ExternalLink aria-hidden />
          </a>
        ) : (
          <div className="setting-row" data-testid="about-spec">
            <span className="setting-label">
              <span>The plan</span>
              <span className="caption">{SPEC_PATH}.md, in your notes folder</span>
            </span>
          </div>
        ))}
    </>
  );
}

/** Settings → Advanced → Prayer: the place, the method, the Hijri adjustment, the opt-in comparison with Aladhan. */
function PrayerSettings({ s, save }: { s: SettingsDto['settings']; save: Save }) {
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [moving, setMoving] = useState(false);
  const [place, setPlace] = useState<Place | null>(null);
  const here = s.place ?? `${coords(s.prayer.lat, s.prayer.lon, 3)} (${s.prayer.tz})`;
  return (
    <>
      <div className="setting-block" data-testid="prayer-place">
        <div className="setting-row">
          <span className="setting-label">
            <span>Place</span>
            <span className="caption" data-testid="prayer-place-name">
              {here} · {s.prayer.tz}
            </span>
          </span>
          {!moving && (
            <button type="button" className="btn btn-quiet" onClick={() => setMoving(true)} data-testid="prayer-place-change">
              Change
            </button>
          )}
        </div>
        {moving && (
          <>
            <PlacePicker value={place} onChange={setPlace} autoFocus />
            <div className="card-foot">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setMoving(false);
                  setPlace(null);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!place}
                onClick={async () => {
                  if (!place) return;
                  await save({ place: place.name, lat: place.lat, lon: place.lon, tz: place.tz });
                  setMoving(false);
                  setPlace(null);
                  setVerify(null);
                }}
                data-testid="prayer-place-save"
              >
                Use this place
              </button>
            </div>
          </>
        )}
        <p className="caption">Prayer times and the Hijri date are worked out on this server. The place is kept in LifeOS&rsquo;s settings, not in your notes, and never sent anywhere.</p>
      </div>
      <div className="setting-block">
        <MethodSelect value={s.prayer.method} onChange={(m) => void save({ method: m })} />
      </div>
      <div className="setting-block">
        <HijriAdjust value={s.hijriOffset} onChange={(v) => void save({ hijriOffset: v })} />
      </div>
      <Switch label="Allow the online check" hint={`Sends the date and rounded coordinates (${coords(s.prayer.lat, s.prayer.lon)}) to api.aladhan.com when you tap Verify`} checked={s.prayerCheck} onChange={(v) => void save({ prayerCheck: v })} testId="prayer-check-switch" />
      <div className="setting-block">
        <div className="card-foot">
          <button
            type="button"
            className="btn"
            disabled={verifying || !s.prayerCheck}
            onClick={async () => {
              setVerifying(true);
              try {
                setVerify(await api<VerifyResult>('api/prayer/verify', { method: 'POST', json: {} }));
              } catch (e) {
                toast(e instanceof ApiError ? e.message : 'Verification failed (offline?).', 'error');
              } finally {
                setVerifying(false);
              }
            }}
            data-testid="verify-prayer"
          >
            Verify prayer times online
          </button>
        </div>
        <p className="caption">{s.prayerCheck ? 'Compares once with api.aladhan.com and shows both. Logged in the connection log (Privacy).' : 'Off: nothing about your place leaves this server.'}</p>
        {verify && (
          <table className="verify-table" data-testid="verify-table">
            <thead>
              <tr>
                <th>{numericDate(verify.date)}</th>
                <th>On this server</th>
                <th>Aladhan</th>
                <th>Difference</th>
              </tr>
            </thead>
            <tbody>
              {verify.rows.map((r) => (
                <tr key={r.prayer}>
                  <td>{r.prayer[0].toUpperCase() + r.prayer.slice(1)}</td>
                  <td>{hm12(r.offline)}</td>
                  <td>{r.aladhan ? hm12(r.aladhan) : 'none'}</td>
                  <td>{r.diffMin === null ? 'none' : `${r.diffMin} min`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

/** Settings → Advanced → Diagnostics → Index: what the last scan found, and a rebuild. */
function IndexRows() {
  const [index, setIndex] = useState<{ lastScan: { at: string; ms: number; files: number; tasks: number } | null } | null>(null);
  useEffect(() => {
    void api<{ lastScan: { at: string; ms: number; files: number; tasks: number } | null }>('api/system/index').then(setIndex).catch(() => undefined);
  }, []);
  return (
    <div className="setting-block" data-testid="index">
      <div className="setting-row">
        <span>Index</span>
        <span className="secondary num">{index?.lastScan ? `${index.lastScan.files} notes, ${index.lastScan.tasks} tasks, ${index.lastScan.ms} ms` : 'not scanned'}</span>
      </div>
      <div className="card-foot">
        <button
          type="button"
          className="btn"
          onClick={async () => {
            const r = await api<{ files: number; tasks: number; ms: number }>('api/index/rebuild', { method: 'POST', json: {} });
            toast(`Index rebuilt: ${r.files} notes, ${r.tasks} tasks in ${r.ms} ms`);
            setIndex(await api('api/system/index'));
          }}
          data-testid="rebuild-index"
        >
          Rebuild index
        </button>
      </div>
      <p className="caption">The vault is the backup: everything LifeOS shows is rebuilt from your notes. The app database only holds the index, drafts and settings.</p>
    </div>
  );
}

/** Settings → Advanced → Diagnostics → Health: the server and the local model. */
function HealthRows() {
  const { data: health } = useResource<{ ok: boolean; version: string; mode: string; vault: boolean }>('api/health');
  const { data: ai } = useResource<AiDto>('api/ai');
  const h = ai?.health;
  return (
    <div className="setting-block" data-testid="health">
      <div className="setting-row">
        <span>LifeOS server</span>
        <span className="secondary" data-testid="server-health">
          {!health ? '…' : `${health.ok ? 'Up' : 'Down'}, ${health.vault ? 'vault mounted' : 'no vault'}${health.mode === 'live' ? '' : ` (${health.mode})`}`}
        </span>
      </div>
      <div className="setting-row">
        <span>Model</span>
        <span className="secondary" data-testid="ai-health">
          {!ai ? '…' : ai.agent ? (ai.agent.lastUsedAt ? `Hermes, last call ${instantText(ai.agent.lastUsedAt)}` : 'Hermes, no call yet') : !ai.enabled ? 'Off' : !h ? (ai.cloud ? 'A cloud provider: checked when you ask (AI)' : 'Not checked') : h.ok ? `Up, ${h.latencyMs} ms${h.modelPresent ? '' : ', model not listed'}${h.contextTokens ? `, ${Math.round(h.contextTokens / 1024)}k context` : ''}` : `Down: ${h.error?.message ?? 'no answer'}`}
        </span>
      </div>
    </div>
  );
}

/**
 * Settings → Privacy → the connection log (spec §4, product brief 9 §1): every call this server
 * made (searches you start, reminders, the model when it is elsewhere) and every call Hermes made to
 * it with its token, newest first; fetched fresh each time it is shown.
 */
function ConnectionLog() {
  const [rows, setRows] = useState<LogRow[] | null>(null);
  return (
    <Disclosure what="connection log" testId="show-outbound" panelTestId="outbound-log" note="What this server sent out, and what Hermes asked it for" onOpen={() => void api<{ rows: LogRow[] }>('api/privacy/log').then((r) => setRows(r.rows)).catch(() => setRows([]))}>
      <div className="log-list">
        {!rows && <span>Loading…</span>}
        {rows?.length === 0 && <span>No connections yet.</span>}
        {rows?.map((r, i) =>
          r.dir === 'in' ? (
            <span key={i} data-dir="in">
              {instantText(r.at, { seconds: true })} IN {r.status} {r.who} {r.method} {r.what}, answered {r.sent} B
            </span>
          ) : (
            <span key={i}>
              {instantText(r.at, { seconds: true })} {r.status === 'refused' ? 'REFUSED' : (r.status ?? 'error')} {r.what} {r.who} out {r.sent} B in {r.received} B
            </span>
          ),
        )}
      </div>
    </Disclosure>
  );
}

/**
 * Settings → Advanced → Diagnostics → Measure frames (UI brief 2 §2): the 4 s sequence, or "Tabs
 * only" (UI brief 3: 8 tab switches in 3 s), or "Record 8 s" (round 8: the person's own scroll,
 * from the first one anywhere in the app), the numbers, a copy button.
 */
function FrameMeter() {
  const [report, setReport] = useState<FrameReport | null>(lastReport);
  const [busy, setBusy] = useState<FrameMode | null>(null);
  const navigate = useNavigate();
  const run = async (mode: FrameMode) => {
    setBusy(mode);
    const r = await measureFrames(mode);
    setReport(r);
    setBusy(null);
    // their own scroll: they are where they scrolled, and the toast says the numbers are in
    if (mode === 'scroll') return;
    navigate('/settings#frames');
    requestAnimationFrame(() => document.getElementById('frames')?.scrollIntoView({ block: 'center' }));
  };
  return (
    <div className="frames" id="frames" data-testid="frame-meter">
      <div className="setting-row">
        <span>Frame rate</span>
        <span className="frame-actions">
          <button type="button" className="btn" disabled={busy !== null} onClick={() => void run('tabs')} data-testid="measure-tabs">
            {busy === 'tabs' ? 'Measuring…' : 'Tabs only'}
          </button>
          <button type="button" className="btn" disabled={busy !== null} onClick={() => void run('full')} data-testid="measure-frames">
            {busy === 'full' ? 'Measuring…' : 'Measure frames'}
          </button>
        </span>
      </div>
      <p className="caption">Measure frames runs for 4 seconds: four tab switches, four presses, two theme flips, Today and Calendar twice. Tabs only runs for 3 seconds: eight tab switches. Keep the screen on and do not touch it.</p>
      <div className="setting-row">
        <span>Your own scroll</span>
        <button type="button" className="btn" disabled={busy !== null} onClick={() => void run('scroll')} data-testid="measure-scroll">
          {busy === 'scroll' ? 'Waiting for a scroll…' : 'Record 8 s'}
        </button>
      </div>
      <p className="caption">Record 8 s waits for your first scroll anywhere in LifeOS (Lists, the search results), then records 8 seconds of it. A message says when it is done; the numbers are here.</p>
      {report && (
        <>
          <dl className="frame-stats" data-testid="frame-report">
            <div>
              <dt>Display</dt>
              <dd className="num">≈ {report.hz} Hz</dd>
            </div>
            <div>
              <dt>Average</dt>
              <dd className="num">{report.avgFps} fps</dd>
            </div>
            <div>
              <dt>p95 frame</dt>
              <dd className="num">{report.p95Ms} ms</dd>
            </div>
            <div>
              <dt>Over 1 interval</dt>
              <dd className="num">{report.over1}</dd>
            </div>
            <div>
              <dt>Over 2 intervals</dt>
              <dd className="num">{report.over2}</dd>
            </div>
            <div>
              <dt>Frames</dt>
              <dd className="num">{report.frames}</dd>
            </div>
          </dl>
          <p className="caption" data-testid="frame-caption">
            {report.mode === 'tabs' ? 'Tabs only. ' : report.mode === 'scroll' ? (report.scrolled ? `Your scroll of ${report.scrolled}. ` : 'No scroll came within 2 minutes. ') : ''}
            {report.viewport}, glass {report.glass}
            {report.quality ? `, quality ${report.quality.charAt(0).toUpperCase()}${report.quality.slice(1)}` : ''}, max {report.maxMs} ms, {instantText(report.at, { year: true })}.
            {report.slides ? ` ${slidesText(report.slides)}.` : ''}
            {report.hidden ? ' The app was hidden during the run, so these numbers are not valid.' : ''}
          </p>
          <div className="card-foot">
            <button
              type="button"
              className="btn"
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(reportText(report))
                  .then(() => toast('Copied'))
                  .catch(() => toast('Copy is not available here', 'error'))
              }
              data-testid="copy-frames"
            >
              Copy numbers
            </button>
          </div>
        </>
      )}
    </div>
  );
}

interface ReminderOverview {
  enabled: boolean;
  configured: boolean;
  devices: number;
  upcoming: { id: string; title: string; when: string; urgent: boolean }[];
  recent: { key: string; fire_at: string; status: string; attempts: number; sent_at: string | null; error: string | null }[];
}

const PUSH_HINT: Record<PushState, string> = {
  on: 'On for this device',
  off: 'One per reminder, on this device',
  denied: "Blocked in this browser's site settings",
  insecure: 'Needs the https address (see the README)',
  unsupported: 'This browser cannot show them here',
};

/** Settings → Reminders → Browser notifications (ADR-80): this device's Web Push subscription. */
function BrowserNotifications() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void pushState().then(setState).catch(() => setState('unsupported'));
    void refreshPush();
  }, []);
  const usable = state === 'on' || state === 'off';
  return (
    <Switch
      label="Browser notifications"
      hint={state ? PUSH_HINT[state] : '…'}
      checked={state === 'on'}
      disabled={!usable || busy}
      onChange={async (v) => {
        setBusy(true);
        try {
          const next = v ? await enablePush() : await disablePush();
          setState(next);
          if (v && next !== 'on') toast(PUSH_HINT[next], 'error');
        } catch {
          toast('Browser notifications could not be turned on here.', 'error');
          setState(await pushState().catch(() => 'unsupported' as const));
        } finally {
          setBusy(false);
        }
      }}
      testId="push-switch"
    />
  );
}

/** Settings → Reminders: where they go (in the app always; this browser; Telegram through Hermes or LifeOS's own bot), quiet hours, and a warning while any is undelivered. */
function RemindersSettings({ s, serverTelegram, save }: { s: SettingsDto['settings']; serverTelegram: boolean; save: Save }) {
  const { data } = useResource<ReminderOverview>('api/reminders');
  const [start, setStart] = useState(s.quietStart);
  const [end, setEnd] = useState(s.quietEnd);
  useEffect(() => {
    setStart(s.quietStart);
    setEnd(s.quietEnd);
  }, [s.quietStart, s.quietEnd]);
  const failed = data?.recent.filter((r) => r.status === 'retry' || r.status === 'failed') ?? [];
  return (
    <>
      <div className="setting-row" data-testid="reminders-inapp">
        <span>In-app</span>
        <span className="secondary">Always, on Today</span>
      </div>
      <BrowserNotifications />
      <TelegramRow ownBot={s.telegram && serverTelegram} />
      <div className="setting-block">
        <div className="setting-row setting-stack quiet-hours">
          <span>Quiet hours</span>
          <span className="edit-row">
            <input className="input" type="time" value={start} onChange={(e) => setStart(e.target.value)} aria-label="Quiet hours start" data-testid="quiet-start" />
            <span className="secondary">to</span>
            <input className="input" type="time" value={end} onChange={(e) => setEnd(e.target.value)} aria-label="Quiet hours end" data-testid="quiet-end" />
          </span>
        </div>
        {(start !== s.quietStart || end !== s.quietEnd) && (
          <div className="card-foot">
            <button type="button" className="btn btn-primary" onClick={() => void save({ quietStart: start, quietEnd: end })} data-testid="quiet-save">
              Save quiet hours
            </button>
          </div>
        )}
        <p className="caption">Reminders wait until they end; high-priority (⏫) ones still come.</p>
      </div>
      {failed.length > 0 && (
        <p className="error" data-testid="undelivered">
          {failed.length} {failed.length === 1 ? 'reminder was' : 'reminders were'} not delivered yet: {failed[0].error ?? 'Telegram unreachable'}. LifeOS keeps retrying.
        </p>
      )}
    </>
  );
}

/** Settings → Advanced → Diagnostics → Reminders: what is coming up, and a test message. */
function ReminderChecks() {
  const { data, reload } = useResource<ReminderOverview>('api/reminders');
  const [sending, setSending] = useState(false);
  const n = data?.upcoming.length ?? 0;
  return (
    <div className="setting-block" data-testid="reminder-checks">
      <Disclosure what="reminders coming up" testId="show-upcoming" panelTestId="upcoming-panel" note={n ? `${n} in the next 7 days` : 'None in the next 7 days'}>
        {n ? (
          <ul className="log-list" data-testid="upcoming-reminders">
            {data!.upcoming.map((u) => (
              <li key={u.id + u.when}>
                {u.when}: {u.title}
                {u.urgent ? ' (high priority)' : ''}
              </li>
            ))}
          </ul>
        ) : (
          <span className="caption">No reminders in the next 7 days. Add one with Quick Add (Reminder) or from a task.</span>
        )}
      </Disclosure>
      <div className="card-foot">
        <button
          type="button"
          className="btn"
          disabled={sending || !data?.enabled}
          onClick={async () => {
            setSending(true);
            try {
              await api('api/reminders/test', { method: 'POST', json: {} });
              toast('Test message sent to your reminder topic');
              await reload();
            } catch (e) {
              toast(e instanceof ApiError ? e.message : 'Could not send.', 'error');
            } finally {
              setSending(false);
            }
          }}
          data-testid="send-test"
        >
          Send a test to Telegram
        </button>
        {(data?.devices ?? 0) > 0 && (
          <button
            type="button"
            className="btn"
            onClick={async () => {
              try {
                const r = await testPush();
                toast(r.sent ? 'Test notification sent to this device' : 'The notification was not delivered', r.sent ? 'info' : 'error');
              } catch (e) {
                toast(e instanceof ApiError ? e.message : 'Could not send.', 'error');
              }
            }}
            data-testid="send-test-push"
          >
            Send a test notification
          </button>
        )}
      </div>
    </div>
  );
}

interface AiDto {
  enabled: boolean;
  configured: boolean;
  model: string;
  provider: string;
  cloud?: boolean;
  endpoint: string | null;
  /** Hermes writes the drafts (ADR-86): whether it can, and the model it last named */
  agent?: { linked: boolean; active: boolean; lastUsedAt: string | null; model: string | null } | null;
  health: { ok: boolean; latencyMs: number | null; modelPresent: boolean; contextTokens: number | null; error?: { message: string } } | null;
  pending: number;
  busy: boolean;
  jobs: { id: string; kind: string; status: string; createdAt: string; durationMs: number | null; model: string | null; promptTokens: number | null; completionTokens: number | null; note: string | null }[];
}

const JOB_LABEL: Record<string, string> = { morning_plan: 'Morning plan', evening_review: 'Evening review', habit_nudge: 'Habit encouragement' };

/** Settings → Privacy, while a cloud provider writes the drafts (ADR-81): where they go. */
function CloudNote() {
  const { data } = useResource<ProviderView>('api/ai/provider');
  if (!data?.cloud || !data.active) return null;
  return (
    <p className="caption privacy-cloud" role="note" data-testid="privacy-ai-cloud">
      AI drafts are sent to {data.host}. Every call is listed in the connection log below.
    </p>
  );
}

/** Settings → Advanced → AI → who writes the drafts (product brief 8 §7, ADR-81). */
function AiProviderSettings() {
  const { data, reload } = useResource<ProviderView>('api/ai/provider');
  const status = useResource<AiDto>('api/ai');
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [check, setCheck] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const value = draft ?? draftFrom(data ?? null);
  const changed = !!draft && JSON.stringify(toBody(draft)) !== JSON.stringify(toBody(draftFrom(data ?? null)));
  if (!data) return null;
  return (
    <div className="setting-block ai-provider" data-testid="ai-provider">
      {!data.lifeosAi && <p className="caption">AI is off for this install (LIFEOS_AI=off in .env): every draft is the plain one.</p>}
      <ProviderFields value={value} onChange={(d) => setDraft(d)} saved={data} disabled={!data.lifeosAi || saving} />
      {data.source === 'env' && !draft && <p className="caption">From .env.ai on this server. A choice saved here takes its place.</p>}
      <div className="card-foot">
        {changed && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              try {
                await api('api/ai/provider', { method: 'PUT', json: toBody(value) });
                setDraft(null);
                setCheck(null);
                await reload();
                await status.reload();
                // every other view of the choice (Settings → Privacy's note, Today) refreshes too
                emit('synced');
                toast('Saved');
              } catch (e) {
                toast(e instanceof ApiError ? e.message : 'Not saved.', 'error');
              } finally {
                setSaving(false);
              }
            }}
            data-testid="provider-save"
          >
            Save
          </button>
        )}
        {!changed && data.usable && data.lifeosAi && (
          <button
            type="button"
            className="btn"
            disabled={checking}
            onClick={async () => {
              setChecking(true);
              try {
                const r = await api<{ ok: boolean; latencyMs: number | null; modelPresent: boolean; error: string | null }>('api/ai/check', { method: 'POST', json: {} });
                setCheck(r.ok ? `Answering in ${r.latencyMs} ms${r.modelPresent ? '' : '; the model is not in its list'}` : `Not answering: ${r.error ?? 'no reply'}`);
              } catch (e) {
                setCheck(e instanceof ApiError ? e.message : 'Could not check.');
              } finally {
                setChecking(false);
              }
            }}
            data-testid="provider-check"
          >
            {checking ? 'Checking…' : 'Check the connection'}
          </button>
        )}
      </div>
      {check && (
        <p className="caption" aria-live="polite" data-testid="provider-check-result">
          {check}
        </p>
      )}
      {data.cloud && data.active && !data.cloudOk && <p className="caption">The first draft waits on Today until you say it may go.</p>}
    </div>
  );
}

/** Settings → Advanced → AI: the model, the drafts waiting, the last jobs (its health is under Diagnostics). */
function AiStatus() {
  const { data } = useResource<AiDto>('api/ai');
  if (!data) return null;
  return (
    <div className="ai-status setting-block" data-testid="ai-status">
      <div className="setting-row">
        <span>Model</span>
        <span className="secondary" data-testid="ai-model">
          {data.agent ? `Hermes${data.agent.model ? ` (${data.agent.model})` : ''}${data.agent.active ? '' : ': not connected'}` : data.enabled ? `${data.model} · ${data.endpoint}` : 'None: plain drafts'}
        </span>
      </div>
      <div className="setting-row">
        <span>Drafts waiting</span>
        <span className="secondary num">{data.pending}</span>
      </div>
      <Disclosure what="last jobs" testId="show-jobs" panelTestId="ai-jobs-panel">
        {data.jobs.length === 0 ? (
          <span className="caption">No jobs yet.</span>
        ) : (
          <ul className="log-list" data-testid="ai-jobs">
            {data.jobs.map((j) => (
              <li key={j.id}>
                {instantText(j.createdAt)} {JOB_LABEL[j.kind] ?? j.kind}: {j.status}
                {j.durationMs !== null ? `, ${(j.durationMs / 1000).toFixed(1)} s` : ''}
                {j.promptTokens ? `, ${j.promptTokens} prompt + ${j.completionTokens ?? 0} reply tokens` : ''}
                {j.note ? ` (${j.note})` : ''}
              </li>
            ))}
          </ul>
        )}
      </Disclosure>
      <p className="caption">{data.agent ? 'Hermes runs the jobs with its own model; a plain draft stands in when it has not answered in 120 seconds.' : data.endpoint ? `One job at a time on ${data.endpoint}; each has 120 seconds before LifeOS uses its plain fallback.` : 'No model is set up: every draft is the plain fallback.'}</p>
    </div>
  );
}

/** Settings → Advanced → Search: the sites the Islamic search category puts first (round-2 brief §8). */
function PreferredSites({ domains, save }: { domains: string[]; save: Save }) {
  const [text, setText] = useState('');
  const add = async () => {
    const d = text.trim();
    if (!d) return;
    await save({ searchDomains: [...domains, d] });
    setText('');
  };
  return (
    <div className="field preferred-sites setting-block" data-testid="preferred-sites">
      <span>Islamic search: preferred sites</span>
      <p className="caption">Results from these sites come first. The list stays on this server; searches still send only your words.</p>
      <ul className="site-list">
        {domains.map((d) => (
          <li key={d}>
            <span>{d}</span>
            <button type="button" className="icon-btn" aria-label={`Remove ${d}`} onClick={() => void save({ searchDomains: domains.filter((x) => x !== d) })}>
              <X />
            </button>
          </li>
        ))}
      </ul>
      <div className="edit-row">
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void add()} placeholder="example.org" aria-label="Add a preferred site" data-testid="preferred-site-input" />
        <button type="button" className="btn" disabled={!text.trim()} onClick={() => void add()} data-testid="preferred-site-add">
          Add
        </button>
      </div>
    </div>
  );
}

interface EngineHealth {
  engine: string;
  label: string;
  categories: string[];
  status: 'ok' | 'dropped' | 'refusing' | 'unused';
  until: string | null;
  reason: string | null;
  lastAt: string | null;
  lastTotal: number | null;
  lastFailed: number | null;
  searches: number;
  results: number;
  failed: number;
}

const CAT_LABEL: Record<string, string> = { web: 'Web', islamic: 'Islamic', videos: 'Videos', shopping: 'Shopping' };

/** Settings → Advanced → Search: how each search engine has been answering (round-2 brief §8). */
function SearchEngines() {
  const { data } = useResource<{ engines: EngineHealth[]; shopping?: { sites: string[]; refused: string[] } }>('api/search/engines');
  if (!data) return <span className="caption">Loading…</span>;
  const line = (e: EngineHealth) => {
    if (e.status === 'unused') return 'Not asked yet.';
    if (e.status === 'dropped') return `Set aside until ${instantText(e.until!)}: ${e.reason}.`;
    const last = e.lastTotal === null ? '' : e.lastTotal === 0 ? 'no results last time' : `${e.lastTotal - (e.lastFailed ?? 0)} of ${e.lastTotal} on topic last time`;
    if (e.status === 'refusing') return `Refused the last search (${e.reason})${last ? `; ${last}` : ''}.`;
    return `Answering: ${last}; ${e.searches} ${e.searches === 1 ? 'search' : 'searches'}, ${e.results - e.failed} of ${e.results} results kept.`;
  };
  return (
    <div className="field" data-testid="engine-health">
      <p className="caption">An engine whose results mostly have nothing to do with the search is set aside for 24 hours.</p>
      <ul className="engine-list">
        {data.engines.map((e) => (
          <li key={e.engine} data-status={e.status}>
            <span className="engine-name">
              {e.label}
              <span className="caption"> · {e.categories.map((c) => CAT_LABEL[c] ?? c).join(', ')}</span>
            </span>
            <span className="caption">{line(e)}</span>
          </li>
        ))}
      </ul>
      {data.shopping && (
        <p className="caption" data-testid="shopping-engines">
          Shopping: {data.shopping.refused.join(' and ')}, SearXNG&rsquo;s shopping engines, refuse this server, so Shopping asks the web engines above for your words on {data.shopping.sites.join(', ')} only.
        </p>
      )}
    </div>
  );
}

const HAPTIC_LABEL: Record<HapticStrength, string> = { off: 'Off', light: 'Light', medium: 'Medium', strong: 'Strong' };
const SWIPE_LABEL: Record<SwipeChoice, string> = { short: 'Short', medium: 'Medium', long: 'Long' };
const HOLD_LABEL: Record<HoldChoice, string> = { quick: 'Quick', normal: 'Normal', slow: 'Slow' };

/**
 * Settings → Gestures (round-3 brief §7, round-4 brief §3): how far a row is swiped before it acts
 * and how long a touch is held, as choices like Haptics (no numbers), on this device only
 * (localStorage), with a row to try them on. Each applies to the next touch.
 */
function GestureSettings() {
  const g = useGestures();
  const [tried, setTried] = useState<string | null>(null);
  const changed = g.swipePx !== GESTURE_DEFAULTS.swipePx || g.holdMs !== GESTURE_DEFAULTS.holdMs || g.haptic !== GESTURE_DEFAULTS.haptic;
  return (
    <>
      <div className="setting-row gesture-row">
        <span>Swipe</span>
        <Segmented
          label="Swipe distance before a row acts"
          value={choiceOf(g.swipePx, SWIPE_OPTIONS)}
          onChange={(v) => setGestures({ swipePx: SWIPE_OPTIONS[v] })}
          options={(Object.keys(SWIPE_OPTIONS) as SwipeChoice[]).map((k) => ({ value: k, label: SWIPE_LABEL[k], testId: `gesture-swipe-${k}` }))}
          testId="gesture-swipe"
        />
      </div>
      <div className="setting-row gesture-row">
        <span>Hold</span>
        <Segmented
          label="Hold delay before the menu opens"
          value={choiceOf(g.holdMs, HOLD_OPTIONS)}
          onChange={(v) => setGestures({ holdMs: HOLD_OPTIONS[v] })}
          options={(Object.keys(HOLD_OPTIONS) as HoldChoice[]).map((k) => ({ value: k, label: HOLD_LABEL[k], testId: `gesture-hold-${k}` }))}
          testId="gesture-hold"
        />
      </div>
      <div className="setting-row setting-stack gesture-row">
        <span>Haptics</span>
        <Segmented
          label="Haptic strength"
          fill
          value={g.haptic}
          onChange={(v) => {
            setGestures({ haptic: v });
            haptic(v);
          }}
          options={(Object.keys(HAPTIC_MS) as HapticStrength[]).map((k) => ({ value: k, label: HAPTIC_LABEL[k], testId: `gesture-haptic-${k}` }))}
          testId="gesture-haptic"
        />
      </div>
      <div className="setting-block">
        <div className="rows gesture-try">
          <SwipeRow
            rowKey="gesture-try"
            testId="gesture-try"
            menuTitle="Touch and hold"
            right={{ label: 'Right', icon: <ArrowRight aria-hidden />, tone: 'ok', run: () => setTried('Swiped right: a task would be completed.') }}
            left={{ label: 'Left', icon: <ArrowLeft aria-hidden />, tone: 'danger', run: () => setTried('Swiped left: a row would be deleted (with Undo).') }}
            menu={() => [{ label: 'That was a hold: this is the menu', icon: <Check aria-hidden />, run: () => setTried('Held: the menu opened.'), testId: 'gesture-try-menu' }]}
          >
            <div className="row-main">
              <span className="row-title">Try it here: swipe or hold this row</span>
              <span className="caption" aria-live="polite" data-testid="gesture-try-result">
                {tried ?? 'Nothing is changed by this row.'}
              </span>
            </div>
          </SwipeRow>
        </div>
        <p className="caption">
          This device only. Defaults: {SWIPE_LABEL.medium}, {HOLD_LABEL.normal}, {HAPTIC_LABEL[GESTURE_DEFAULTS.haptic]}.
        </p>
        {changed && (
          <div className="card-foot">
            <button type="button" className="btn btn-ghost" onClick={() => resetGestures()} data-testid="gesture-reset">
              Back to the defaults
            </button>
          </div>
        )}
      </div>
    </>
  );
}

/** Settings → Privacy → Privacy mode (round-2 brief §6): the same switch as the top bar's eye. */
function PrivacyModeRow() {
  const on = usePrivacy();
  return (
    <div className="privacy-mode setting-block">
      <Switch label="Privacy mode" hint="Blurs private habits on this device; hold one to see it" checked={on} onChange={setPrivacy} testId="privacy-switch" />
      <p className="caption" data-testid="privacy-note">
        A curtain, not a security boundary. Telegram never names a private habit.
      </p>
    </div>
  );
}

const KIND_LABEL: Record<string, string> = { habit: 'Habit', goal: 'Goal', project: 'Project', note: 'Note', capture: 'Ring capture' };

/**
 * Settings → Advanced → Data → Archived (round-2 brief §6, §12): habits, goals, projects and notes
 * that were archived, each restorable to where it was (a habit with its whole log).
 */
function Archived() {
  const { data, reload } = useResource<{ items: { path: string; title: string; kind: string; original: string; archived: string }[] }>('api/archive');
  const { data: habits } = useResource<{ habits: { path: string; logs: number }[] }>('api/habits/archived');
  const logs = new Map((habits?.habits ?? []).map((h) => [h.path, h.logs]));
  const n = data?.items.length ?? 0;
  return (
    <Disclosure what="archived" testId="show-archived" panelTestId="archived" note={n ? `${n} ${n === 1 ? 'note' : 'notes'}: habits, goals, projects, notes` : 'Nothing archived'}>
      {!n && <p className="caption">Nothing archived. Archived habits, goals, projects and notes wait here to be restored.</p>}
      <ul className="site-list">
        {data?.items.map((a) => {
          const n = logs.get(a.path);
          const habit = a.kind === 'habit' || a.path.startsWith('Archive/Habits/');
          return (
            <li key={a.path} data-testid="archived-row">
              <span className="archived-name">
                {a.title}
                <span className="caption">
                  {' '}
                  · {KIND_LABEL[a.kind] ?? 'Note'}
                  {habit && n !== undefined ? ` · ${n} ${n === 1 ? 'day' : 'days'} logged` : ` · from ${a.original.split('/').slice(0, -1).join('/') || 'the vault'}`}
                </span>
              </span>
              <button
                type="button"
                className="btn btn-quiet"
                onClick={async () => {
                  try {
                    await write({ path: habit ? 'api/habits/restore' : 'api/archive/restore', body: { path: a.path }, kind: 'restore', label: 'Restore' });
                    toast(`${a.title} is back`);
                    await reload();
                  } catch (e) {
                    toast(e instanceof ApiError ? e.message : 'Not restored.', 'error');
                  }
                }}
                data-testid="archive-restore"
              >
                Restore
              </button>
            </li>
          );
        })}
      </ul>
    </Disclosure>
  );
}

const DELETED_KIND: Record<string, string> = { task: 'Task', item: 'Item', link: 'Link', event: 'Event' };

/** Settings → Advanced → Data → Recently deleted (round-2 brief §12): the last 50 lines removed, for 30 days, for when Undo was missed. */
function RecentlyDeleted() {
  const { data, reload } = useResource<{ items: { id: string; path: string; kind: string; label: string; at: string; lines: number }[] }>('api/deleted');
  const n = data?.items.length ?? 0;
  return (
    <Disclosure what="recently deleted" testId="show-deleted" panelTestId="recently-deleted" note={n ? `${n} in the last 30 days` : 'Nothing in the last 30 days'}>
      {!n ? (
        <p className="caption">Nothing deleted in the last 30 days.</p>
      ) : (
        <ul className="site-list">
          {data!.items.map((d) => (
            <li key={d.id} data-testid="deleted-row">
              <span className="archived-name">
                {d.label}
                <span className="caption">
                  {' '}
                  · {DELETED_KIND[d.kind] ?? 'Line'}
                  {d.lines > 1 ? ` and ${d.lines - 1} under it` : ''} · {noteLabel(d.path)} · {instantText(d.at, { date: true })}
                </span>
              </span>
              <button
                type="button"
                className="btn btn-quiet"
                onClick={async () => {
                  try {
                    await write({ path: 'api/lines/restore', body: { ids: [d.id] }, kind: 'restore', label: 'Restore' });
                    toast(`${d.label} is back in ${noteLabel(d.path)}`);
                    await reload();
                  } catch (e) {
                    toast(e instanceof ApiError ? e.message : 'Not restored.', 'error');
                  }
                }}
                data-testid="deleted-restore"
              >
                Restore
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="caption">Kept here for 30 days (the last 50). Restoring puts the line back where it was in its note.</p>
    </Disclosure>
  );
}
