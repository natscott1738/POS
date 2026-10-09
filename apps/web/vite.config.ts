import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    /**
     * The service worker is what makes offline real. Without it the sale queue
     * survives an outage but the application itself does not load, so a cashier
     * who reloads the page during a network failure is locked out of the till.
     */
    VitePWA({
      // autoUpdate + a guard in the app: the service worker takes over as soon
      // as the till is idle, rather than waiting for someone to notice a prompt.
      // Leaving it on 'prompt' meant a till could stay pinned to old code
      // indefinitely if the prompt was dismissed or never seen.
      registerType: 'autoUpdate',
      // Bump this to force every till to take a new shell on next launch.
      injectRegister: null,
      workbox: {
        globPatterns: ['**/*.{js,css,html,woff2}'],
        // A catalogue-heavy build stays well under this; raise it if fonts grow.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        // Never serve a cached API response: stale prices or stock would be worse
        // than an honest failure, and the till already has its own local copy.
        navigateFallbackDenylist: [/^\/api\//],
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            // The app shell must load offline; everything else is explicit.
            urlPattern: ({ request }) => request.destination === 'document',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'pos-shell',
              networkTimeoutSeconds: 3,
              expiration: { maxEntries: 8 },
            },
          },
        ],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        // The new worker activates immediately; the app decides when to reload,
        // so a sale in progress is never interrupted.
        skipWaiting: true,
      },
      manifest: {
        name: 'Backyard POS',
        short_name: 'Backyard POS',
        description: 'Backyard POS — retail point of sale',
        theme_color: '#0b1220',
        background_color: '#0b1220',
        display: 'standalone',
        orientation: 'landscape',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      devOptions: {
        // Off in dev: a service worker caching a hot-reloading bundle is misery.
        enabled: false,
      },
    }),
  ],
  // `vite preview` needs the same proxy as dev, so browser tests can reach the API.
  preview: {
    port: 4173,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://127.0.0.1:4000',
        changeOrigin: false,
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://127.0.0.1:4000',
        changeOrigin: false,
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
          offline: ['dexie'],
        },
      },
    },
  },
});
