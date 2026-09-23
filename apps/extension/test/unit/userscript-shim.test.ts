// The userscript build (`node scripts/build.mjs userscript`) runs background/*
// and content/* unchanged inside one Tampermonkey script, with
// `src/userscript/browser-shim.ts` standing in for `webextension-polyfill`
// and `src/userscript/gm-fetch.ts` as the API transport. These tests pin the
// behaviour the extension code relies on: Chrome's messaging rules, storage
// round trips (and that `session` cannot collide with `local`), alarm
// timing, and a fetch-compatible transport that never sends EA's cookies.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import browser, { RUNTIME_ID, setOptionsPageOpener } from '../../src/userscript/browser-shim.js';
import { gmFetch } from '../../src/userscript/gm-fetch.js';

const gmStore = new Map<string, unknown>();
let lastXhr: GmXhrDetails | null = null;

beforeEach(() => {
  gmStore.clear();
  lastXhr = null;
  vi.stubGlobal('GM_getValue', (key: string, fallback?: unknown) =>
    gmStore.has(key) ? structuredClone(gmStore.get(key)) : fallback,
  );
  vi.stubGlobal(
    'GM_setValue',
    (key: string, value: unknown) => void gmStore.set(key, structuredClone(value)),
  );
  vi.stubGlobal('GM_deleteValue', (key: string) => void gmStore.delete(key));
  vi.stubGlobal('GM_openInTab', vi.fn());
  vi.stubGlobal('GM_xmlhttpRequest', (details: GmXhrDetails) => {
    lastXhr = details;
    return { abort: () => undefined };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('userscript browser shim — messaging', () => {
  it('answers with the first listener that returns a promise, as Chrome does', async () => {
    const ignoring = vi.fn(() => undefined);
    const answering = vi.fn(async (message: unknown) => ({ echoed: message }));
    const late = vi.fn(async () => 'never');
    browser.runtime.onMessage.addListener(ignoring);
    browser.runtime.onMessage.addListener(answering);
    browser.runtime.onMessage.addListener(late);
    try {
      await expect(browser.runtime.sendMessage({ type: 'x' })).resolves.toEqual({
        echoed: { type: 'x' },
      });
      expect(ignoring).toHaveBeenCalledWith({ type: 'x' }, { id: RUNTIME_ID });
      expect(late).not.toHaveBeenCalled();
    } finally {
      browser.runtime.onMessage.removeListener(ignoring);
      browser.runtime.onMessage.removeListener(answering);
      browser.runtime.onMessage.removeListener(late);
    }
  });

  it('rejects when nobody answers, so callers see a dead "background" the same way', async () => {
    await expect(browser.runtime.sendMessage({ type: 'nobody' })).rejects.toThrow(
      /Receiving end does not exist/,
    );
  });

  it('structured-clones the message and the reply in both directions', async () => {
    const shared = { n: 1 };
    const listener = async (message: unknown) => {
      (message as { payload: { n: number } }).payload.n = 99; // must not reach the sender's object
      return shared;
    };
    browser.runtime.onMessage.addListener(listener);
    try {
      const payload = { n: 1 };
      const reply = (await browser.runtime.sendMessage({ payload })) as { n: number };
      expect(payload.n).toBe(1);
      reply.n = 42;
      expect(shared.n).toBe(1);
    } finally {
      browser.runtime.onMessage.removeListener(listener);
    }
  });

  it('delivers tabs.sendMessage to this tab and reports it from tabs.query', async () => {
    const listener = vi.fn(() => undefined);
    browser.runtime.onMessage.addListener(listener);
    try {
      const [tab] = await browser.tabs.query({ url: ['https://www.ea.com/*'] });
      await browser.tabs
        .sendMessage(tab!.id!, { type: 'engine.killSwitch' })
        .catch(() => undefined);
      expect(listener).toHaveBeenCalledWith({ type: 'engine.killSwitch' }, { id: RUNTIME_ID });
    } finally {
      browser.runtime.onMessage.removeListener(listener);
    }
  });

  it('routes openOptionsPage to the launcher', async () => {
    const open = vi.fn();
    setOptionsPageOpener(open);
    await browser.runtime.openOptionsPage();
    expect(open).toHaveBeenCalledOnce();
  });
});

describe('userscript browser shim — storage', () => {
  it('round-trips local and session values through GM storage without collisions', async () => {
    await browser.storage.local.set({ k: { a: 1 } });
    await browser.storage.session.set({ k: 'session value' });
    expect(await browser.storage.local.get('k')).toEqual({ k: { a: 1 } });
    expect(await browser.storage.session.get(['k', 'missing'])).toEqual({ k: 'session value' });

    await browser.storage.session.remove('k');
    expect(await browser.storage.session.get('k')).toEqual({});
    expect(await browser.storage.local.get('k')).toEqual({ k: { a: 1 } });
  });
});

describe('userscript browser shim — alarms and install', () => {
  it('fires a periodic alarm one period out, then every period', () => {
    vi.useFakeTimers();
    const onAlarm = vi.fn();
    browser.alarms.onAlarm.addListener(onAlarm);
    browser.alarms.create('test.alarm', { periodInMinutes: 1 });

    vi.advanceTimersByTime(59_999);
    expect(onAlarm).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onAlarm).toHaveBeenCalledWith({ name: 'test.alarm' });
    vi.advanceTimersByTime(60_000);
    expect(onAlarm).toHaveBeenCalledTimes(2);

    // Re-creating an alarm replaces it rather than stacking a second timer.
    browser.alarms.create('test.alarm', { periodInMinutes: 1 });
    vi.advanceTimersByTime(60_000);
    expect(onAlarm).toHaveBeenCalledTimes(3);
  });

  it('reports "install" exactly once per script install', () => {
    vi.useFakeTimers();
    const first = vi.fn();
    const second = vi.fn();
    browser.runtime.onInstalled.addListener(first);
    browser.runtime.onInstalled.addListener(second);
    vi.runAllTimers();
    expect(first).toHaveBeenCalledWith({ reason: 'install' });
    expect(second).not.toHaveBeenCalled();
  });
});

describe('gmFetch', () => {
  it('sends method, headers and body anonymously and builds a Response', async () => {
    const pending = gmFetch('https://api.test.local/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
      body: '{"a":1}',
    });
    expect(lastXhr).toMatchObject({
      method: 'POST',
      url: 'https://api.test.local/api/v1/auth/login',
      data: '{"a":1}',
      anonymous: true,
      headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
    });

    lastXhr!.onload!({
      status: 201,
      statusText: 'Created',
      responseHeaders: 'content-type: application/json\r\nx-request-id: r1\r\n',
      responseText: '{"ok":true}',
      finalUrl: '',
    });
    const res = await pending;
    expect(res.status).toBe(201);
    expect(res.headers.get('x-request-id')).toBe('r1');
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it('rejects like fetch on network errors and blocked (status 0) requests', async () => {
    const failed = gmFetch('https://api.test.local/x');
    lastXhr!.onerror!({
      status: 0,
      statusText: '',
      responseHeaders: '',
      responseText: '',
      finalUrl: '',
    });
    await expect(failed).rejects.toBeInstanceOf(TypeError);

    const blocked = gmFetch('https://api.test.local/x');
    lastXhr!.onload!({
      status: 0,
      statusText: '',
      responseHeaders: '',
      responseText: '',
      finalUrl: '',
    });
    await expect(blocked).rejects.toBeInstanceOf(TypeError);
  });

  it('handles a bodiless 204', async () => {
    const pending = gmFetch('https://api.test.local/x', { method: 'DELETE' });
    lastXhr!.onload!({
      status: 204,
      statusText: 'No Content',
      responseHeaders: '',
      responseText: '',
      finalUrl: '',
    });
    expect((await pending).status).toBe(204);
  });
});
