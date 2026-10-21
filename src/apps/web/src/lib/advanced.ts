/**
 * Settings → Advanced settings (round-4 brief §4): off by default, remembered on this device
 * (localStorage), never sent to the server. While it is off Settings shows the Simple layer only.
 */
import { useSyncExternalStore } from 'react';

const KEY = 'lifeos.settings.advanced';
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === 'on';
  } catch {
    return false;
  }
}

let on = typeof localStorage === 'undefined' ? false : read();

export function advancedOn(): boolean {
  return on;
}

export function setAdvanced(v: boolean): void {
  on = v;
  try {
    if (v) localStorage.setItem(KEY, 'on');
    else localStorage.removeItem(KEY);
  } catch {
    /* storage off: it holds for this session */
  }
  for (const l of [...listeners]) l();
}

export function useAdvanced(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      const onStorage = (e: StorageEvent) => {
        if (e.key === KEY) {
          on = read();
          cb();
        }
      };
      window.addEventListener('storage', onStorage);
      return () => {
        listeners.delete(cb);
        window.removeEventListener('storage', onStorage);
      };
    },
    () => on,
  );
}
