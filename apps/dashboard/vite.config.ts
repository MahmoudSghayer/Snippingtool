import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// The API origin the dev proxy forwards to. Kept separate from
// VITE_API_ORIGIN (the *client's* base URL, read in src/api/client.ts) —
// see docs/07-dashboard.md "Auth/CSRF across origins" for why: in dev the
// dashboard talks to the API through this same-origin proxy (so `sl_at`
// stays a first-party cookie without needing SameSite=None), which means
// VITE_API_ORIGIN is deliberately left *unset* in apps/dashboard/.env.example
// — the client falls back to relative `/api/v1` requests that this proxy
// intercepts. DEV_API_PROXY_TARGET is what the proxy itself points at.
const DEV_API_PROXY_TARGET = process.env.DEV_API_PROXY_TARGET ?? 'http://localhost:3000';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      port: 5173,
      proxy: env.VITE_API_ORIGIN
        ? undefined
        : {
            '/api': { target: DEV_API_PROXY_TARGET, changeOrigin: true },
            '/health': { target: DEV_API_PROXY_TARGET, changeOrigin: true },
            '/ws': { target: DEV_API_PROXY_TARGET, changeOrigin: true, ws: true },
          },
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
    },
    test: {
      environment: 'jsdom',
      globals: false,
      setupFiles: ['./test/setup.ts'],
      include: ['test/**/*.test.{ts,tsx}'],
      css: true,
      // Gives src/api/client.ts an absolute base URL under jsdom, where a
      // bare relative URL (the normal dev/prod behaviour) can't be resolved
      // without a real `window.location` navigation, which jsdom doesn't
      // perform for `Request` construction. Set here (not a gitignored
      // .env.test) so it's committed and reproducible on a clean checkout.
      env: { VITE_API_ORIGIN: 'http://localhost:3000' },
    },
  };
});
