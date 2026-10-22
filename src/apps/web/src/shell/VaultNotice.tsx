/**
 * The notes folder cannot be written (round 8e, ADR-105): while health says `writable:false`, one
 * calm line under the top bar on every screen, with "How to fix" opening the guide's section. A
 * refused write says the rest in its own message (whose the folder is, whom LifeOS runs as, the
 * fix). Health is asked again when a write is refused, when writes settle, on focus and every
 * minute, so the line goes once the folder is fixed. An answer from the device's cache (offline)
 * shows nothing: it may be old.
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import { FolderLock } from 'lucide-react';
import { BASE } from '../lib/api';
import { useResource } from '../lib/store';

/** The guide's section (portable/README.md, served as /lifeos/guide.html). */
export const VAULT_FIX_URL = `${BASE}guide.html#lifeos-cant-save-to-your-notes-folder`;

export function VaultNotice() {
  const { data, stale, reload } = useResource<{ writable?: boolean }>('api/health');
  const show = data?.writable === false && !stale;
  useEffect(() => {
    const again = () => void reload();
    const minute = setInterval(() => document.visibilityState === 'visible' && again(), 60_000);
    window.addEventListener('lifeos:vault-unwritable', again);
    return () => {
      clearInterval(minute);
      window.removeEventListener('lifeos:vault-unwritable', again);
    };
  }, [reload]);
  // the panes start below the line while it shows (shell.css --notice-h): its own height, which
  // grows to two lines when the text is set larger
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const app = el?.closest<HTMLElement>('.app');
    if (!el || !app) return;
    const place = () => app.style.setProperty('--notice-h', `${Math.ceil(el.getBoundingClientRect().height) + 8}px`);
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => {
      ro.disconnect();
      app.style.removeProperty('--notice-h');
    };
  }, [show]);
  if (!show) return null;
  return (
    <div className="vault-notice" ref={ref} role="status" data-testid="vault-notice">
      <FolderLock aria-hidden />
      <p>Can't save to your notes.</p>
      <a href={VAULT_FIX_URL} target="_blank" rel="noopener" data-testid="vault-notice-fix">
        How to fix
      </a>
    </div>
  );
}
