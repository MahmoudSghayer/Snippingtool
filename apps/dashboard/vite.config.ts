import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Connect, type Plugin } from 'vite';

// The API origin the dev proxy forwards to. Kept separate from
// VITE_API_ORIGIN (the *client's* base URL, read in src/api/client.ts) —
// see docs/07-dashboard.md "Auth/CSRF across origins" for why: in dev the
// dashboard talks to the API through this same-origin proxy (so `sl_at`
// stays a first-party cookie without needing SameSite=None), which means
// VITE_API_ORIGIN is deliberately left *unset* in apps/dashboard/.env.example
// — the client falls back to relative `/api/v1` requests that this proxy
// intercepts. DEV_API_PROXY_TARGET is what the proxy itself points at.
const DEV_API_PROXY_TARGET = process.env.DEV_API_PROXY_TARGET ?? 'http://localhost:3000';

// Multi-page build: the public marketing site is plain static HTML (no React
// bundle), and the React SPA lives at app.html. Production servers
// (vercel.json, infra/docker/dashboard.nginx.conf) serve these pages as
// themselves and rewrite every other extensionless path to /app.html.
const PAGES = {
  landing: fileURLToPath(new URL('./index.html', import.meta.url)),
  app: fileURLToPath(new URL('./app.html', import.meta.url)),
  terms: fileURLToPath(new URL('./terms/index.html', import.meta.url)),
  refundPolicy: fileURLToPath(new URL('./refund-policy/index.html', import.meta.url)),
};

// Paths that are *not* SPA routes: the static pages, Vite's own dev/internal
// URLs, and the API proxy prefixes. Everything else without a file
// extension is a client-side route and gets app.html.
const STATIC_PAGES = new Set([
  '/',
  '/index.html',
  '/terms',
  '/terms/',
  '/refund-policy',
  '/refund-policy/',
]);
const PASSTHROUGH_PREFIXES = [
  '/@',
  '/src/',
  '/node_modules/',
  '/assets/',
  '/site/',
  '/api',
  '/ws',
  '/health',
];

function isSpaRoute(rawUrl: string): boolean {
  const pathname = rawUrl.split(/[?#]/, 1)[0] ?? '/';
  if (STATIC_PAGES.has(pathname)) return false;
  if (PASSTHROUGH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return false;
  // Any real file (favicon.svg, robots.txt, app.html, main.tsx, ...).
  if (/\.[a-z0-9]+$/i.test(pathname)) return false;
  return true;
}

// Directory pages reached without a trailing slash (/terms): Vite's own
// fallback would otherwise hand back the landing page for these.
const DIRECTORY_PAGES = new Set(['/terms', '/refund-policy']);

const rewriteSpaRoutes: Connect.NextHandleFunction = (req, _res, next) => {
  if ((req.method === 'GET' || req.method === 'HEAD') && req.url) {
    const queryIndex = req.url.indexOf('?');
    const pathname = queryIndex === -1 ? req.url : req.url.slice(0, queryIndex);
    const query = queryIndex === -1 ? '' : req.url.slice(queryIndex);
    if (DIRECTORY_PAGES.has(pathname)) {
      req.url = `${pathname}/index.html${query}`;
    } else if (isSpaRoute(req.url)) {
      req.url = `/app.html${query}`;
    }
  }
  next();
};

// Vite's dev and preview servers fall back to index.html for unknown paths,
// which is now the landing page; send SPA routes to app.html instead,
// mirroring the production rewrites.
function spaFallbackToAppHtml(): Plugin {
  return {
    name: 'sl:spa-fallback-to-app-html',
    configureServer(server) {
      server.middlewares.use(rewriteSpaRoutes);
    },
    configurePreviewServer(server) {
      server.middlewares.use(rewriteSpaRoutes);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [spaFallbackToAppHtml(), react(), tailwindcss()],
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
      // `rolldownOptions` is Vite 8's name for the deprecated `rollupOptions`.
      rolldownOptions: {
        input: PAGES,
      },
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
