import { releaseOf } from '@lifeos/shared';

/**
 * What this UI build is (round-4 brief §4, Settings → About): the web package's version, the
 * release it was built as (ADR-103: LIFEOS_BUILD, a tag, a commit with "+" when the tree had
 * changes, or dev) and when. Vite defines them at build time (vite.config.ts); anything else (a
 * unit test) sees "dev".
 */
declare const __LIFEOS_VERSION__: string | undefined;
declare const __LIFEOS_BUILD__: string | undefined;
declare const __LIFEOS_BUILT__: string | undefined;

export const BUILD = {
  version: typeof __LIFEOS_VERSION__ === 'string' ? __LIFEOS_VERSION__ : '0.0.0',
  release: releaseOf(typeof __LIFEOS_BUILD__ === 'string' ? __LIFEOS_BUILD__ : 'dev'),
  builtAt: typeof __LIFEOS_BUILT__ === 'string' ? __LIFEOS_BUILT__ : null,
};

/**
 * Load the server's release (About, when the page is another one): the service worker is asked for
 * the new app first, and the page reloads once it has taken over (it skips waiting, vite.config.ts),
 * or at once when there is nothing new or no worker; never more than 8 s on a slow connection.
 */
export async function reloadApp(): Promise<void> {
  const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
  const reg = await sw?.getRegistration().catch(() => undefined);
  if (sw && reg) {
    await reg.update().catch(() => undefined);
    if (reg.installing || reg.waiting) {
      await new Promise<void>((done) => {
        const t = setTimeout(done, 8000);
        sw.addEventListener(
          'controllerchange',
          () => {
            clearTimeout(t);
            done();
          },
          { once: true },
        );
      });
    }
  }
  location.reload();
}
