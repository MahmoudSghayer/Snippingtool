// How content/index.ts wires the Sniping Bot into the rest of the page
// (`engine/sniper.ts`). `main()` needs a live EA page and service worker
// (the cross-app e2e journeys cover the live path), so, as in
// engine-state-relay.test.ts, these pin the wiring in the source: while the
// bot runs, its searches are not ranked or priced for assist and do not
// spend assist's governor; its risk events are reported; and every
// attempt's errorCode stays inside the schema.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SNIPE_ERROR_CODE_MAX, snipingAttemptSchema } from '@sl/shared';
import { describe, expect, it } from 'vitest';

import { attemptErrorCode, attemptTiming } from '../../src/engine/types.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const contentSource = readFileSync(path.resolve(dirname, '../../src/content/index.ts'), 'utf8');

describe('content/index.ts while the Sniping Bot runs', () => {
  it("does not count the bot's searches against assist's governor", () => {
    expect(contentSource).toContain('countObservedSearches(adapter, () => (sniper?.isRunning() ? null : governor))');
  });

  it('neither ranks nor prices a search (no `summary` requests) on a search or an engine tick', () => {
    const onSearch = /onCurrentSearch: \(auctions\) => \{([\s\S]*?)\n {6}\},/.exec(contentSource)?.[1] ?? '';
    expect(onSearch).toMatch(/if \(sniper\?\.isRunning\(\)\) \{\s*rankedCandidates = \[\];[\s\S]*\} else void rerank\(\);/);
    const tick = /async function engineTickImpl\(\)[\s\S]*?\n {2}\}/.exec(contentSource)?.[0] ?? '';
    expect(tick.indexOf('if (sniper?.isRunning()) return;')).toBeGreaterThan(-1);
    expect(tick.indexOf('if (sniper?.isRunning()) return;')).toBeLessThan(tick.indexOf('await rerank();'));
  });

  it("reports the bot's risk events as telemetry", () => {
    expect(contentSource).toContain('onRiskEvent: (event) => recordRiskEvents([event]),');
  });
});

describe('an attempt’s errorCode stays inside the schema', () => {
  it('content cuts every engine’s errorCode with attemptErrorCode', () => {
    expect(contentSource).toContain('errorCode: input.errorCode == null ? null : attemptErrorCode(input.errorCode),');
  });

  it('attemptErrorCode gives a code the schema accepts, whatever EA said', () => {
    const attempt = (errorCode: string) =>
      snipingAttemptSchema.safeParse({
        resourceId: 100,
        targetPrice: 1_000,
        listedPrice: 1_000,
        outcome: 'failed',
        latencyMs: 10,
        errorCode,
        occurredAt: new Date().toISOString(),
        deviceId: '00000000-0000-0000-0000-000000000000',
      }).success;
    const long = `bid reported success: false (status 403): ${'detail '.repeat(40)}`;
    expect(attempt(long)).toBe(false);
    expect(attempt(attemptErrorCode(long))).toBe(true);
    expect(attemptErrorCode(long)).toHaveLength(SNIPE_ERROR_CODE_MAX);
    expect(attempt(attemptErrorCode(''))).toBe(true);
  });
});

describe('an attempt’s timings stay inside the schema', () => {
  it('content passes the bot’s search and reaction times through attemptTiming', () => {
    expect(contentSource).toContain('searchMs: attemptTiming(input.searchMs),');
    expect(contentSource).toContain('reactionMs: attemptTiming(input.reactionMs),');
  });

  it('attemptTiming gives timings the schema accepts, or none', () => {
    const attempt = (timings: { searchMs?: number; reactionMs?: number }) =>
      snipingAttemptSchema.safeParse({
        resourceId: 100,
        targetPrice: 1_000,
        listedPrice: 1_000,
        outcome: 'success',
        latencyMs: 10,
        errorCode: null,
        occurredAt: new Date().toISOString(),
        deviceId: '00000000-0000-0000-0000-000000000000',
        ...timings,
      }).success;
    for (const ms of [182.6, 0, 600_000, 600_001, -5, Number.NaN, undefined]) {
      expect(attempt({ searchMs: attemptTiming(ms), reactionMs: attemptTiming(ms) })).toBe(true);
    }
    expect(attempt({ searchMs: 600_001 })).toBe(false);
  });
});
