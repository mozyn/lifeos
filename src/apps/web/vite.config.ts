import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const devServer = { host: '127.0.0.1', port: 8483, strictPort: true, proxy: process.env.LIFEOS_DEV_API ? { '/lifeos/api': process.env.LIFEOS_DEV_API } : undefined };

const shared = fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

/**
 * LifeOS is served under /lifeos: the tailnet proxy mounts it there (ADR-9). The service worker
 * precaches the app shell so it opens offline; data never goes through the SW cache (the app keeps
 * its own copy in IndexedDB and queues writes in its outbox, ADR-22), so /lifeos/api is network-only.
 */
export default defineConfig({
  base: '/lifeos/',
  resolve: { alias: { '@lifeos/shared': shared } },
  // Settings → About (round-4 brief §4): the version, the commit and the day of this build
  define: {
    __LIFEOS_VERSION__: JSON.stringify(pkg.version),
    __LIFEOS_BUILD__: JSON.stringify(process.env.LIFEOS_BUILD || 'dev'),
    __LIFEOS_BUILT__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['icons/*.png'],
      manifest: {
        id: '/lifeos/',
        name: 'LifeOS',
        short_name: 'LifeOS',
        description: 'Today, the week, goals, habits and lists over your Obsidian vault.',
        lang: 'en',
        start_url: '/lifeos/today',
        scope: '/lifeos/',
        display: 'standalone',
        orientation: 'any',
        theme_color: '#ecf6f5',
        background_color: '#ecf6f5',
        icons: [
          { src: '/lifeos/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/lifeos/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/lifeos/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,ico,webmanifest}'],
        navigateFallback: '/lifeos/index.html',
        // the API, and the README page the image adds beside the app (ADR-94)
        navigateFallbackDenylist: [/^\/lifeos\/api\//, /^\/api\//, /^\/lifeos\/guide\.html/],
        // browser notifications for reminders (product brief 8 §6): the push and click handlers
        importScripts: ['push-sw.js'],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        runtimeCaching: [],
      },
    }),
  ],
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 900 },
  // UI work against a running stack (loopback only): LIFEOS_DEV_API=http://127.0.0.1:8481 npx vite,
  // or the production bundle with `npx vite build && LIFEOS_DEV_API=… npx vite preview`
  server: devServer,
  preview: devServer,
});
