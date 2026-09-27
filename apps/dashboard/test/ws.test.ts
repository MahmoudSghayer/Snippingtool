import { afterEach, describe, expect, it, vi } from 'vitest';

/** The WS upgrade always goes straight to the API's own origin
 * (`VITE_WS_ORIGIN`), never through Vercel's same-origin `/api` proxy
 * (`vercel.json`), because Vercel cannot proxy a WebSocket upgrade. See
 * docs/07-dashboard.md §5. `API_BASE_URL`/`WS_ORIGIN` are module-level
 * consts read at import time, so each case stubs the env and resets the
 * module registry before importing, the same pattern as
 * test/authBootstrap.test.ts. */
describe('wsUpgradeUrl (src/lib/ws.ts)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  function jsonResponse(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  class FakeWebSocket {
    static lastUrl: string | undefined;
    constructor(url: string) {
      FakeWebSocket.lastUrl = url;
    }
    addEventListener(): void {}
    close(): void {}
  }

  async function connectAndCaptureUrl(): Promise<string | undefined> {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ticket: 'tix' }, 200)),
    );
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.resetModules();
    const { WsConnection } = await import('@/lib/ws.js');
    const conn = new WsConnection(() => {});
    await conn.connect();
    return FakeWebSocket.lastUrl;
  }

  it('connects to VITE_WS_ORIGIN when set, even though VITE_API_ORIGIN differs (the Vercel-proxy case)', async () => {
    // VITE_API_ORIGIN stays absolute here only so the ticket POST resolves
    // under jsdom (which can't resolve a bare relative URL without a real
    // navigation) — the point under test is that VITE_WS_ORIGIN, not
    // VITE_API_ORIGIN, decides the WS upgrade's origin.
    vi.stubEnv('VITE_API_ORIGIN', 'http://localhost:3000');
    vi.stubEnv('VITE_WS_ORIGIN', 'https://api.example.com');
    const url = await connectAndCaptureUrl();
    expect(url).toBe('wss://api.example.com/ws?ticket=tix');
  });

  it('falls back to VITE_API_ORIGIN when VITE_WS_ORIGIN is unset (local dev)', async () => {
    vi.stubEnv('VITE_API_ORIGIN', 'http://localhost:3000');
    vi.stubEnv('VITE_WS_ORIGIN', '');
    const url = await connectAndCaptureUrl();
    expect(url).toBe('ws://localhost:3000/ws?ticket=tix');
  });
});
