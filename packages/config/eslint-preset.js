// @ts-check
/**
 * Shared ESLint flat-config preset for The Sniper's Ledger monorepo.
 *
 * A consuming package's own `eslint.config.js` spreads this array in and can
 * append (or override) entries after it. Kept dependency-light: only
 * typescript-eslint + eslint-plugin-import, which every TS package in this
 * repo already needs.
 */
import js from '@eslint/js';
import importPlugin from 'eslint-plugin-import';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Forbids building SQL with a tagged template that has interpolated
 * expressions, e.g. `` sql`select * from users where id = ${id}` ``.
 *
 * Drizzle's own `sql` helper parameterises `${}` safely, but this repo's rule
 * (see docs/01-architecture.md, "trust boundary") is stricter than that: SQL
 * text is built with the query builder or with `sql.raw()` fed a **constant**
 * string plus separately-bound params, never with runtime values spliced
 * into a `sql` template literal. That keeps every query, including ones a
 * future contributor writes under time pressure, syntactically incapable of
 * injection — nobody has to remember which interpolation was "safe".
 */
const noSqlTemplateInterpolation = {
  selector:
    "TaggedTemplateExpression[tag.name='sql'][quasi.expressions.length>0], " +
    "TaggedTemplateExpression[tag.property.name='sql'][quasi.expressions.length>0]",
  message:
    'Do not interpolate values into a `sql` tagged template (`sql`...${x}...``). ' +
    'Use the Drizzle query builder, or `sql.raw()` with a constant string and bound params.',
};

/** @type {import('eslint').Linter.Config[]} */
export const base = [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { import: importPlugin },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2023 },
    },
    settings: {
      'import/resolver': {
        typescript: { alwaysTryTypes: true },
      },
    },
    rules: {
      'import/order': [
        'warn',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'type'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      'import/no-duplicates': 'error',
      'no-restricted-syntax': ['error', noSqlTemplateInterpolation],
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'warn',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
];

export default base;
