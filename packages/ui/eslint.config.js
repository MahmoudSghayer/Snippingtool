// @ts-check
import { base } from '@sl/config/eslint-preset.js';

/** @type {import('eslint').Linter.Config[]} */
export default [
  ...base,
  {
    languageOptions: {
      globals: { window: 'readonly', document: 'readonly', navigator: 'readonly' },
    },
    rules: {
      // Components legitimately export both the component and its variant
      // helpers/types from the same file (shadcn-style file layout).
      'import/no-duplicates': 'error',
    },
  },
  {
    ignores: ['dist/**'],
  },
];
