/**
 * Where the owner is (product brief 8 §1, ADR-76): a city from the app's own list (GeoNames, bundled,
 * searched on the device; nothing is fetched), a suggestion from this device's time zone, or
 * coordinates and a zone typed in. Used by the first-run step and Settings → Advanced → Prayer.
 */
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Check, MapPin } from 'lucide-react';
import { type City, cityLabel, loadCities, searchCities, suggestForZone } from '../lib/cities';

export interface Place {
  name: string;
  lat: number;
  lon: number;
  tz: string;
}

const deviceZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
};

const zones = (): string[] => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
};

export const toPlace = (c: City): Place => ({ name: cityLabel(c), lat: c.lat, lon: c.lon, tz: c.tz });

/** "43.65, -79.38" */
export const coords = (lat: number, lon: number, digits = 2) => `${lat.toFixed(digits)}, ${lon.toFixed(digits)}`;

function validManual(lat: string, lon: string, tz: string): Place | null {
  const la = Number(lat);
  const lo = Number(lon);
  if (!lat.trim() || !lon.trim() || !Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    return null;
  }
  if (!tz.trim()) return null;
  return { name: '', lat: la, lon: lo, tz: tz.trim() };
}

/** `detail`: a line under the chosen place (the first-run step shows today's times there). */
export function PlacePicker({ value, onChange, autoFocus, detail }: { value: Place | null; onChange: (p: Place | null) => void; autoFocus?: boolean; detail?: ReactNode }) {
  const [cities, setCities] = useState<City[] | null>(null);
  const [q, setQ] = useState('');
  const [manual, setManual] = useState(false);
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');
  const [tz, setTz] = useState(deviceZone());
  const [label, setLabel] = useState('');
  useEffect(() => {
    void loadCities().then(setCities);
  }, []);
  const suggestion = useMemo(() => (cities ? suggestForZone(cities, deviceZone()) : null), [cities]);
  const results = useMemo(() => (cities ? searchCities(cities, q, 6) : []), [cities, q]);
  const zoneList = useMemo(() => (manual ? zones() : []), [manual]);

  // typed coordinates become the place as soon as they are valid
  useEffect(() => {
    if (!manual) return;
    const p = validManual(lat, lon, tz);
    onChange(p ? { ...p, name: label.trim() || `${coords(p.lat, p.lon)} (${p.tz})` } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manual, lat, lon, tz, label]);

  if (manual) {
    return (
      <div className="place-picker" data-testid="place-manual">
        <div className="place-coords">
          <label className="field">
            <span>Latitude</span>
            <input className="input" inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} placeholder="43.6532" data-testid="place-lat" />
          </label>
          <label className="field">
            <span>Longitude</span>
            <input className="input" inputMode="decimal" value={lon} onChange={(e) => setLon(e.target.value)} placeholder="-79.3832" data-testid="place-lon" />
          </label>
        </div>
        <label className="field">
          <span>Time zone</span>
          <input className="input" list="place-zones" value={tz} onChange={(e) => setTz(e.target.value)} placeholder="America/Toronto" autoCapitalize="off" autoCorrect="off" spellCheck={false} data-testid="place-tz" />
          <datalist id="place-zones">
            {zoneList.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
        </label>
        <label className="field">
          <span>Name (optional)</span>
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Home" maxLength={120} data-testid="place-name" />
        </label>
        <p className="caption">Latitude north is positive, longitude east is positive. Any map app shows both for a place.</p>
        <button
          type="button"
          className="btn btn-quiet place-switch"
          onClick={() => {
            setManual(false);
            onChange(null);
          }}
          data-testid="place-search-instead"
        >
          Search the city list instead
        </button>
      </div>
    );
  }

  return (
    <div className="place-picker" data-testid="place-search">
      {value && (
        <div className="place-chosen" data-testid="place-chosen">
          <Check aria-hidden />
          <span>
            <span className="place-chosen-name">{value.name}</span>
            {detail && <span className="caption place-chosen-detail">{detail}</span>}
          </span>
        </div>
      )}
      <label className="field">
        <span>{value ? 'Another city' : 'Your city'}</span>
        <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search, for example Toronto" autoFocus={autoFocus} autoComplete="off" enterKeyHint="search" aria-controls="place-results" data-testid="place-query" />
      </label>
      {q.trim().length > 1 && (
        <ul className="place-results" id="place-results" role="listbox" aria-label="Cities" data-testid="place-results">
          {!cities && <li className="caption">Loading the city list…</li>}
          {cities && results.length === 0 && <li className="caption">No city by that name in the list. Try a nearby larger city, or enter coordinates.</li>}
          {results.map((c) => (
            <li key={`${c.name}|${c.lat}|${c.lon}`}>
              <button
                type="button"
                role="option"
                aria-selected={value?.lat === c.lat && value?.lon === c.lon}
                className="place-result"
                onClick={() => {
                  onChange(toPlace(c));
                  setQ('');
                }}
                data-testid="place-result"
              >
                <MapPin aria-hidden />
                <span>
                  <span className="place-result-name">{c.name}</span>
                  <span className="caption">{cityLabel(c).slice(c.name.length + 2) || c.country}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {!value && !q.trim() && suggestion && (
        <button type="button" className="place-suggest" onClick={() => onChange(toPlace(suggestion))} data-testid="place-suggest">
          <MapPin aria-hidden />
          <span>
            <span className="place-result-name">{cityLabel(suggestion)}</span>
            <span className="caption">From this device&rsquo;s time zone, {deviceZone()}</span>
          </span>
        </button>
      )}
      <button type="button" className="btn btn-quiet place-switch" onClick={() => setManual(true)} data-testid="place-manual-open">
        Enter coordinates instead
      </button>
    </div>
  );
}
