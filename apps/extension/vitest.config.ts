import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@sl/shared': path.resolve(dirname, '../../packages/shared/src/index.ts'),
      // Tests exercise the full (M3-included) surface — see
      // scripts/build.mjs for the per-target alias used at build time.
      'virtual:autobuyer-loader': path.resolve(dirname, 'src/engine/autobuyer-loader.auto.ts'),
    },
  },
  define: {
    'import.meta.env.VITE_AUTOMATION': JSON.stringify('1'), // exercise the full surface in tests
    'import.meta.env.VITE_BUILD_TARGET': JSON.stringify('ledger-auto'),
    'import.meta.env.VITE_API_ORIGIN': JSON.stringify('https://api.test.local'),
    'import.meta.env.VITE_UPDATE_URL': JSON.stringify(''),
    'import.meta.env.VITE_EXTENSION_VERSION': JSON.stringify('0.1.0'),
    'import.meta.env.VITE_LICENSE_PUBLIC_KEY': JSON.stringify(''),
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
});
