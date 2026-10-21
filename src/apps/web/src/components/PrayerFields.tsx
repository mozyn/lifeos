/**
 * The prayer-time choices shared by the first-run step and Settings → Advanced → Prayer (ADR-76):
 * the calculation method (Tehran by default, Qum's Jafari method and the common Sunni ones) and
 * the Hijri date adjustment.
 */
import { METHOD_LABELS, METHOD_SHORT, PRAYER_METHODS, type PrayerMethod } from '@lifeos/shared';
import { ChevronDown } from 'lucide-react';
import { Segmented } from './ui';

export function MethodSelect({ value, onChange, testId = 'prayer-method' }: { value: PrayerMethod; onChange: (m: PrayerMethod) => void; testId?: string }) {
  return (
    <label className="field">
      <span>Calculation method</span>
      <span className="select-wrap">
        <select className="input select" value={value} onChange={(e) => onChange(e.target.value as PrayerMethod)} data-testid={testId}>
          {PRAYER_METHODS.map((m) => (
            <option key={m} value={m}>
              {METHOD_SHORT[m]}
              {m === 'tehran' ? ' (default)' : ''}
            </option>
          ))}
        </select>
        <ChevronDown aria-hidden />
      </span>
      <span className="caption">{METHOD_LABELS[value]}</span>
    </label>
  );
}

export function HijriAdjust({ value, onChange }: { value: -1 | 0 | 1; onChange: (v: -1 | 0 | 1) => void }) {
  return (
    <div className="setting-row setting-stack">
      <span className="setting-label">
        <span>Hijri date adjustment</span>
        <span className="caption">For a local moon sighting a day ahead or behind</span>
      </span>
      <Segmented
        label="Hijri date adjustment"
        fill
        value={String(value) as '-1' | '0' | '1'}
        onChange={(v) => onChange(Number(v) as -1 | 0 | 1)}
        options={[
          { value: '-1', label: '−1 day' },
          { value: '0', label: 'None' },
          { value: '1', label: '+1 day' },
        ]}
        testId="hijri-offset"
      />
    </div>
  );
}
