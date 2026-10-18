// lib/errors.ts sends each warning to the server's error reports once. It
// used to send the logger's oldest 100 warnings on every flush (every five
// minutes) for as long as they stayed in its ring buffer: in the
// userscript, where content and background share one logger, a single
// warning logged once per page load (the late act-channel hand-off, a
// watchdog stall) reached the reports hundreds of times, and anything
// newer than the first 100 never reached them at all.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiJson } = vi.hoisted(() => ({
  apiJson: vi.fn(async (_path: string, _init: RequestInit): Promise<unknown> => ({ accepted: 0 })),
}));
vi.mock('../../src/lib/api.js', () => ({ apiJson }));

async function load() {
  const { logger } = await import('../../src/lib/logger.js');
  const { flushErrors } = await import('../../src/lib/errors.js');
  return { logger, flushErrors };
}

/** The messages the `n`th report carried. */
function sent(n: number): string[] {
  const init = apiJson.mock.calls[n]![1];
  return (JSON.parse(String(init.body)) as { errors: { message: string }[] }).errors.map((e) => e.message);
}

beforeEach(() => {
  vi.resetModules();
  apiJson.mockClear();
});

describe('lib/errors.ts: flushErrors', () => {
  it('sends each warning and error once, oldest first, and never info', async () => {
    const { logger, flushErrors } = await load();
    logger.warn('the act-channel nonce was handed off late', 'adapter');
    logger.info('adapter is reporting again', 'watchdog');
    logger.error('bundle probe failed: x', 'adapter.probe');
    expect(await flushErrors('device-1')).toEqual({ ok: true, sent: 2 });
    expect(sent(0)).toEqual(['the act-channel nonce was handed off late', 'bundle probe failed: x']);

    // Nothing new: nothing sent, however many flushes.
    for (let i = 0; i < 5; i++) expect(await flushErrors('device-1')).toEqual({ ok: true, sent: 0 });
    expect(apiJson).toHaveBeenCalledTimes(1);

    logger.warn('possible MAIN-world stall', 'watchdog');
    await flushErrors('device-1');
    expect(sent(1)).toEqual(['possible MAIN-world stall']);
  });

  it('sends more than 100 over several flushes, none twice', async () => {
    const { logger, flushErrors } = await load();
    for (let i = 0; i < 250; i++) logger.warn(`w${i}`);
    expect((await flushErrors('device-1')).sent).toBe(100);
    expect((await flushErrors('device-1')).sent).toBe(100);
    expect((await flushErrors('device-1')).sent).toBe(50);
    expect((await flushErrors('device-1')).sent).toBe(0);
    const all = [0, 1, 2].flatMap(sent);
    expect(all).toHaveLength(250);
    expect(new Set(all).size).toBe(250);
    expect(all[0]).toBe('w0');
    expect(all[249]).toBe('w249');
  });

  it('sends a report again when the API did not take it', async () => {
    const { logger, flushErrors } = await load();
    logger.warn('EA answered HTTP 429');
    apiJson.mockRejectedValueOnce(new Error('offline'));
    expect(await flushErrors('device-1')).toEqual({ ok: false, sent: 0 });
    expect(await flushErrors('device-1')).toEqual({ ok: true, sent: 1 });
    expect(sent(1)).toEqual(['EA answered HTTP 429']);
  });

  it('sends nothing without a registered device', async () => {
    const { logger, flushErrors } = await load();
    logger.warn('x');
    expect(await flushErrors(null)).toEqual({ ok: false, sent: 0 });
    expect(apiJson).not.toHaveBeenCalled();
  });
});
