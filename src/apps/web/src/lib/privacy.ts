/**
 * Privacy mode (round-2 brief §6): a screen-level curtain, kept on this device (localStorage), not a
 * security boundary. While it is on, habits marked `private: true` show as blurred rows with a
 * generic label, their streak marks leave the calendar, and a tap-and-hold reveals one for 3 s.
 */
import { useSyncExternalStore } from 'react';

const KEY = 'lifeos.privacy';
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === 'on';
  } catch {
    return false;
  }
}

let on = typeof localStorage === 'undefined' ? false : read();

export function privacyOn(): boolean {
  return on;
}

export function setPrivacy(v: boolean): void {
  on = v;
  try {
    localStorage.setItem(KEY, v ? 'on' : 'off');
  } catch {
    /* storage off: it holds for this session */
  }
  document.documentElement.toggleAttribute('data-privacy', v);
  for (const l of [...listeners]) l();
}

export function usePrivacy(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      // another tab of the app changed it
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

/** The generic label a private habit shows while Privacy mode is on. */
export const PRIVATE_LABEL = 'Private habit';
