// F8: the metrics `route` label must collapse unmatched requests to a single
// constant so random 404 paths can't grow the label's cardinality without
// bound. This drives the real app and scrapes /metrics after hitting matched
// and unmatched routes.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../app.js';

import type { FastifyInstance } from 'fastify';

describe('metrics route-label cardinality (F8)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: { level: 'error' } });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it('distinct unmatched URLs share one __unmatched__ label, not one series each', async () => {
    // Several distinct non-existent paths (query strings included).
    for (const p of ['/nope-1', '/nope-2?x=1', '/does/not/exist', '/aaa?b=c&d=e']) {
      await app.inject({ method: 'GET', url: p });
    }
    // A matched route for contrast.
    await app.inject({ method: 'GET', url: '/api/v1/plans' });

    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    const body = res.body;

    // The unmatched label appears; none of the raw 404 paths do.
    expect(body).toContain('__unmatched__');
    for (const leaked of ['/nope-1', '/nope-2', '/does/not/exist', '/aaa']) {
      expect(body, `raw path ${leaked} must not become a metrics label`).not.toContain(`route="${leaked}`);
    }
    // The matched route still gets its own real label.
    expect(body).toContain('/api/v1/plans');
  });
});
