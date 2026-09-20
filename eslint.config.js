// @ts-check
import { base } from './packages/config/eslint-preset.js';

/**
 * Repo-root flat ESLint config. Every workspace package resolves this by
 * walking up from its own directory (ESLint's normal flat-config lookup),
 * so `pnpm --filter <pkg> lint` and `pnpm -r lint` both use it without each
 * package needing its own `eslint.config.js`.
 */
export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'apps/extension/**', // milestone-1 plain JS, kept as-is until the TS migration wave
      'pnpm-lock.yaml',
    ],
  },
  ...base,
];
