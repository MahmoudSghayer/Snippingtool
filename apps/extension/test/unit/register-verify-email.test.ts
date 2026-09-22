// QA suite (owned by the Testing & QA agent — see docs/12-testing.md).
// Regression coverage for defect #3 ("Defects found"): `POST /auth/register`
// never returns tokens — the real response is `{ userId }` (201), and the
// account needs email verification before login works
// (docs/03-api.md §"auth"). `lib/auth.ts`'s `register()` used to be typed
// as `LoginResponse` and only persisted tokens `if (data.status === 'ok')`
// — a field the real response never has — so nothing broke loudly, it just
// silently never logged the user in, and `popup/main.ts` fell straight
// into `renderLoggedIn()` regardless, which then called `license.bootstrap`
// with no access token.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleAuthRegister, handleAuthResendVerification } from '../../src/background/auth.js';
import { isAuthenticated, register, resendVerification } from '../../src/lib/auth.js';

import { useRealChromeStorage } from './chrome-storage-stub.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('lib/auth.ts + background/auth.ts: register() never fakes a session', () => {
  useRealChromeStorage();
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('register() returns the real {userId} shape and persists no tokens', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { userId: '11111111-1111-1111-1111-111111111111' }));

    const result = await register({
      email: 'newuser@example.com',
      password: 'correct-horse-battery-staple-1',
      device: { fingerprint: 'a'.repeat(32) },
    });

    expect(result).toEqual({ userId: '11111111-1111-1111-1111-111111111111' });
    // No `status`/`accessToken`/`refreshToken` field at all — the old code's
    // `data.status === 'ok'` check would silently be false forever; this
    // asserts there's nothing resembling a login response to gate on.
    expect(result).not.toHaveProperty('status');
    expect(result).not.toHaveProperty('accessToken');
    // And, crucially, no session was persisted from a register call.
    expect(await isAuthenticated()).toBe(false);
  });

  it('background/auth.ts handleAuthRegister passes the real {userId} response through untouched (no LoginResponse coercion)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { userId: '22222222-2222-2222-2222-222222222222' }));

    const result = await handleAuthRegister({ email: 'popup-user@example.com', password: 'correct-horse-battery-staple-2' });

    expect(result).toEqual({ userId: '22222222-2222-2222-2222-222222222222' });
    expect(await isAuthenticated()).toBe(false);
  });

  it('resendVerification() posts to /auth/resend-verification and resolves {sent: true}', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { sent: true }));

    const result = await resendVerification('newuser@example.com');

    expect(result).toEqual({ sent: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/auth/resend-verification');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ email: 'newuser@example.com' });
  });

  it('background/auth.ts handleAuthResendVerification relays to lib/auth.ts', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { sent: true }));

    const result = await handleAuthResendVerification({ email: 'someone@example.com' });

    expect(result).toEqual({ sent: true });
  });

  it('register() still throws (and persists nothing) on a non-2xx response, e.g. a duplicate email', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'VALIDATION_FAILED', message: 'Email already registered.' } }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(
      register({ email: 'dup@example.com', password: 'correct-horse-battery-staple-3', device: { fingerprint: 'b'.repeat(32) } }),
    ).rejects.toThrow();
    expect(await isAuthenticated()).toBe(false);
  });
});
