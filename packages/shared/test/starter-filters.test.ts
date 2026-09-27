// The one-click starter filters on /account are posted straight to
// `POST /filters`, so every entry has to be a body the API accepts.

import { describe, expect, it } from 'vitest';

import { createSavedFilterRequestSchema } from '../src/schemas/filters.js';
import { STARTER_FILTERS } from '../src/starter-filters.js';

describe('STARTER_FILTERS', () => {
  it('has four entries', () => {
    expect(STARTER_FILTERS).toHaveLength(4);
  });

  it.each(STARTER_FILTERS.map((s) => [s.key, s] as const))(
    '%s is a valid create-filter request',
    (_key, starter) => {
      const result = createSavedFilterRequestSchema.safeParse({
        name: starter.name,
        filter: starter.filter,
      });
      expect(result.success).toBe(true);
      expect(starter.description.length).toBeGreaterThan(0);
    },
  );

  it('has unique keys', () => {
    const keys = STARTER_FILTERS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('has unique criteria', () => {
    const criteria = STARTER_FILTERS.map((s) => JSON.stringify(s.filter));
    expect(new Set(criteria).size).toBe(criteria.length);
  });

  it('never promises profit', () => {
    for (const s of STARTER_FILTERS) {
      expect(`${s.name} ${s.description}`).not.toMatch(/profit|guarantee|earn/i);
    }
  });
});
