import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@sl/shared/adapter-channel.js': path.resolve(dirname, '../../packages/shared/src/adapter-channel.ts'),
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
    // A test-only Ed25519 public key (private half in
    // test/unit/license-test-keys.ts), in the same SPKI PEM form as the API's
    // ENTITLEMENT_PUBLIC_KEY, so licence verification runs for real in tests.
    'import.meta.env.VITE_LICENSE_PUBLIC_KEY': JSON.stringify(
      '-----BEGIN PUBLIC KEY-----\\nMCowBQYDK2VwAyEAh0+wT0NW0GyjaaZGmHy7w4D7eZrMxwukv8+wiTdc7c8=\\n-----END PUBLIC KEY-----',
    ),
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
