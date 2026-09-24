// lib/clock.ts: the server-clock offset the extension stamps ingest data with.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useRealChromeStorage } from './chrome-storage-stub.js';

import type * as ClockModule from '../../src/lib/clock.js';
import type * as StorageModule from '../../src/lib/storage.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const OFFSET_KEY = 'sl.clock.serverOffsetMs.v1';

describe('lib/clock.ts', () => {
  useRealChromeStorage();
  let clock: typeof ClockModule;
  let storage: typeof StorageModule;

  beforeEach(async () => {
    vi.resetModules();
    clock = await import('../../src/lib/clock.js');
    storage = await import('../../src/lib/storage.js');
  });

  const offsetNow = () => clock.serverNow() - Date.now();

  it('ignores a reading more than 24 hours off, keeping the previous offset', async () => {
    const now = Date.now();
    await clock.recordServerTime(new Date(now + 10 * MINUTE).toISOString(), now, now);
    expect(Math.abs(offsetNow() - 10 * MINUTE)).toBeLessThan(1000);

    await clock.recordServerTime(new Date(now + 25 * HOUR).toISOString(), now, now);
    expect(Math.abs(offsetNow() - 10 * MINUTE)).toBeLessThan(1000);
    expect(await storage.getLocal<number>(OFFSET_KEY, 0)).toBeCloseTo(10 * MINUTE, -3);
  });

  it('a stored offset loading late never overwrites a newer reading', async () => {
    await storage.setLocal(OFFSET_KEY, 5 * MINUTE);
    const loading = clock.ensureClockLoaded(); // storage read still pending
    const now = Date.now();
    await clock.recordServerTime(new Date(now - 3 * MINUTE).toISOString(), now, now);
    await loading;
    expect(Math.abs(offsetNow() + 3 * MINUTE)).toBeLessThan(1000);
  });
});
