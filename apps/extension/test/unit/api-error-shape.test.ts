// `apps/api` sends errors as `{ code, message, requestId }` at the top level.
// `toApiError` used to read only a nested `{ error: { code, message } }`, so
// every API error became code INTERNAL with the response's status text as its
// message — and over HTTP/2 the status text is empty. A failed sign-in then
// rendered an empty error: "nothing happens when I click Sign in".

import { describe, expect, it } from 'vitest';

import { toApiError } from '../../src/lib/http.js';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    statusText: '',
    headers: { 'content-type': 'application/json' },
  });

describe('toApiError', () => {
  it("reads the API's top-level { code, message }", async () => {
    const err = await toApiError(
      json(401, {
        code: 'AUTH_INVALID_CREDENTIALS',
        message: 'Invalid email or password.',
        requestId: 'r1',
      }),
    );
    expect(err.status).toBe(401);
    expect(err.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(err.message).toBe('Invalid email or password.');
  });

  it('still reads the nested { error: { code, message } } form', async () => {
    const err = await toApiError(
      json(423, { error: { code: 'AUTH_ACCOUNT_LOCKED', message: 'Locked.' } }),
    );
    expect(err.code).toBe('AUTH_ACCOUNT_LOCKED');
    expect(err.message).toBe('Locked.');
  });

  it('never produces an empty message, even with no body and no status text', async () => {
    const err = await toApiError(new Response('not json', { status: 429, statusText: '' }));
    expect(err.code).toBe('INTERNAL');
    expect(err.message).toBe('Request failed (HTTP 429)');
  });
});
