// main/adapter.ts's own timers. Production reported thousands of false
// "possible MAIN-world stall" warnings: the adapter only spoke on act calls,
// so every idle minute looked like a stall to content's watchdog. It now
// sends a heartbeat, and, once its startup report is out, reports the probe
// again whenever the outcome changes: a service layer that turns up late (a
// late userscript injection, a slow login) or goes away reaches content
// without waiting for an act call — a failure only once it persists, so a
// page rebuilding `window.services` stops nothing.
//
// adapter.ts wires itself up at import time and captures the timer
// functions it uses then, so fake timers are installed before importing it.
import { ADAPTER_CHANNEL } from '@sl/shared/adapter-channel.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { promiseServices } from '../fixtures/ea-shapes.js';

interface Posted {
  channel: string;
  kind: string;
  data: Record<string, unknown>;
}
let posted: Posted[] = [];
const of = (kind: string) => posted.filter((m) => m.kind === kind);

function install(services: unknown): void {
  (window as unknown as { services?: unknown }).services = services;
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  // Read as it is posted: jsdom would deliver window messages on timers.
  vi.spyOn(window, 'postMessage').mockImplementation(((message: unknown) => {
    const m = message as Posted | null;
    if (m && m.channel === ADAPTER_CHANNEL) posted.push(m);
  }) as typeof window.postMessage);
  install(undefined); // EA's web app has not built its service layer yet
  await import('../../src/main/adapter.js');
  atLoad = posted;
});
let atLoad: Posted[] = [];

afterAll(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

beforeEach(() => {
  posted = [];
});

describe('the adapter at load', () => {
  it('says hello and reports its first probe, then waits for the web app to start', () => {
    expect(atLoad.map((m) => m.kind)).toEqual(['ready', 'probe']);
    expect(atLoad[1]!.data.ok).toBe(false);
    // Not passing yet, and not given up on (that takes ten minutes).
    vi.advanceTimersByTime(4_000);
    expect(of('probe')).toHaveLength(0);
  });
});

describe('the probe after startup', () => {
  it('is reported as soon as the web app builds its service layer, then again only when it changes', () => {
    install(promiseServices().services);
    vi.advanceTimersByTime(2_000);
    expect(of('probe').map((m) => m.data.ok)).toEqual([true]);

    vi.advanceTimersByTime(20_000);
    expect(of('probe')).toHaveLength(1); // unchanged: nothing new to say

    // The service layer goes away: reported only once it is still gone on
    // the next recheck (a rebuild in between stops nothing)...
    install(undefined);
    vi.advanceTimersByTime(2_000);
    expect(of('probe')).toHaveLength(1);
    vi.advanceTimersByTime(2_000);
    expect(of('probe').map((m) => m.data.ok)).toEqual([true, false]);

    // ...and its return at once.
    install(promiseServices().services);
    vi.advanceTimersByTime(2_000);
    expect(of('probe').map((m) => m.data.ok)).toEqual([true, false, true]);
  });

  it('never reports a moment without a service layer that is back by the next recheck', () => {
    install(undefined);
    vi.advanceTimersByTime(2_000);
    install(promiseServices().services);
    vi.advanceTimersByTime(2_000);
    vi.advanceTimersByTime(10_000);
    expect(of('probe')).toHaveLength(0);
  });
});

describe('the heartbeat', () => {
  it('goes out every 20 seconds, whatever the page is doing', () => {
    vi.advanceTimersByTime(60_000);
    const beats = of('heartbeat');
    expect(beats.length).toBeGreaterThanOrEqual(3);
    expect(beats.length).toBeLessThanOrEqual(4);
    const times = beats.map((m) => m.data.at as number);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(20_000);
  });
});
