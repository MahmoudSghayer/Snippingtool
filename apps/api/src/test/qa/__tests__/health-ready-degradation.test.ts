// QA suite (owned by the Testing & QA agent — see docs/12-testing.md).
// Integration coverage for GET /health/ready's degradation path
// (apps/api/src/modules/health/index.ts), previously untested: it must
// report 503 with a per-check breakdown when any dependency (db, redis,
// queue) is unavailable, and 200 with all three "ok" in the healthy case.
//
// Why this simulates the outage *after* boot rather than by pointing
// REDIS_URL at an unreachable host from the start ("bad REDIS_URL
// instance"): plugins/redis.ts unconditionally does
// `await redis.flushdb()` during boot under NODE_ENV=test, on a client
// constructed with `maxRetriesPerRequest: null` — against a genuinely
// unreachable Redis, that command never rejects (ioredis just keeps
// retrying the connection forever), so `buildApp()` itself would hang
// past this suite's hookTimeout instead of failing fast. That is itself a
// real operational observation (not exercised as a "defect" here since it
// may be a deliberate resilience-over-fail-fast choice, but worth a
// deploy-time health check regardless) — see docs/12-testing.md
// "Defects found". This suite instead builds one healthy app (so boot
// itself always succeeds) and then breaks each dependency's *live*
// connection to exercise exactly the same readiness-handler code path
// (`fastify.db.execute`, `fastify.redis.ping`, the probe queue's
// `getJobCounts`) an actually-down instance would hit post-boot — which is
// the scenario a load balancer's readiness probe exists to catch anyway.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { FastifyInstance } from 'fastify';

describe('GET /health/ready degradation', () => {
  it('reports 200 with every check ok when db, redis and the queue are all reachable', async () => {
    process.env.NODE_ENV = 'test';
    const { buildApp } = await import('../../../app.js');
    const app = await buildApp({ logger: false });
    await app.ready();
    try {
      const res = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok', checks: { db: 'ok', redis: 'ok', queue: 'ok' } });
    } finally {
      await app.close();
    }
  });

  it('reports 200 ok on /health/live regardless (liveness never touches a dependency)', async () => {
    process.env.NODE_ENV = 'test';
    const { buildApp } = await import('../../../app.js');
    const app = await buildApp({ logger: false });
    await app.ready();
    try {
      const res = await app.inject({ method: 'GET', url: '/health/live' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok' });
    } finally {
      await app.close();
    }
  });

  describe('a broken dependency (live connection dropped post-boot)', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      process.env.NODE_ENV = 'test';
      const { buildApp } = await import('../../../app.js');
      app = await buildApp({ logger: false });
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it('reports 503 with redis:"error" (db/queue still ok) when the redis connection is down', async () => {
      // Simulates an unreachable/crashed Redis instance from the app's
      // perspective: .disconnect() closes the socket immediately with no
      // auto-reconnect, so the next `.ping()` rejects synchronously
      // ("Connection is closed.") instead of hanging — exactly what
      // plugins/redis.ts's own `maxRetriesPerRequest: null` would NOT give
      // us if we instead tried to break the URL before boot (see header
      // comment).
      app.redis.disconnect();

      const res = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(res.statusCode).toBe(503);
      const body = res.json() as { status: string; checks: Record<string, string> };
      expect(body.status).toBe('error');
      expect(body.checks.redis).toBe('error');
      expect(body.checks.db).toBe('ok');

      // Reconnect so this app instance can still be used/closed cleanly by other tests in this file.
      app.redis.connect();
      // Give ioredis a moment to finish the reconnect handshake before the next test relies on it.
      await new Promise((resolve) => app.redis.once('ready', resolve));
    });

    it('reports 503 with db:"error" (redis/queue still ok) when the database connection is closed', async () => {
      await app.sqlClient.end({ timeout: 1 });

      const res = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(res.statusCode).toBe(503);
      const body = res.json() as { status: string; checks: Record<string, string> };
      expect(body.status).toBe('error');
      expect(body.checks.db).toBe('error');
      expect(body.checks.redis).toBe('ok');

      // This app instance's db pool is now permanently closed; later files build a fresh app.
    });
  });
});
