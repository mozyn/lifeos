/**
 * What this UI build is (round-4 brief §4, Settings → About): the web package's version, the commit
 * it was built from ("+" when the tree had changes) and when. Vite defines them at build time
 * (vite.config.ts); anything else (a unit test) sees "dev".
 */
declare const __LIFEOS_VERSION__: string | undefined;
declare const __LIFEOS_BUILD__: string | undefined;
declare const __LIFEOS_BUILT__: string | undefined;

export const BUILD = {
  version: typeof __LIFEOS_VERSION__ === 'string' ? __LIFEOS_VERSION__ : '0.0.0',
  commit: typeof __LIFEOS_BUILD__ === 'string' ? __LIFEOS_BUILD__ : 'dev',
  builtAt: typeof __LIFEOS_BUILT__ === 'string' ? __LIFEOS_BUILT__ : null,
};
