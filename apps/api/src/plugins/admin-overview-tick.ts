// Publishes `admin.overview.tick` (src/ws/admin-tick.ts) every
// `ADMIN_TICK_INTERVAL_MS`, feeding the live tiles on /admin: online users,
// active snipes (1m), errors (1m). The dashboard listens for it
// (apps/dashboard/src/hooks/useWsGateway.ts -> stores/adminLive.ts); before
// this plugin nothing sent it and those tiles always read "—".
//
// Every API instance runs the timer; a per-tick Redis lock makes one of
// them do the work, and a tick with no admin connected anywhere is skipped
// before any query. The timer is unref'd and cleared on close. Off under
// NODE_ENV=test unless a test opts in (`buildApp({ adminOverviewTick: {
// enabled: true } })`), so test apps never publish on their own.

import fp from 'fastify-plugin';

import { ADMIN_TICK_INTERVAL_MS, publishAdminOverviewTick } from '../ws/admin-tick.js';

import type { FastifyInstance } from 'fastify';

export interface AdminOverviewTickOptions {
  /** Defaults to on, except under NODE_ENV=test. */
  enabled?: boolean;
  intervalMs?: number;
}

export default fp<AdminOverviewTickOptions>(
  async function adminOverviewTickPlugin(fastify: FastifyInstance, opts) {
    const enabled = opts.enabled ?? fastify.config.NODE_ENV !== 'test';
    if (!enabled) return;
    const intervalMs = opts.intervalMs ?? ADMIN_TICK_INTERVAL_MS;

    let running = false;
    let failing = false;
    const tick = async () => {
      // A slow tick (DB under load) is not stacked on by the next one.
      if (running) return;
      running = true;
      try {
        await publishAdminOverviewTick(fastify.db, fastify.redis, { intervalMs });
        if (failing) fastify.log.info('admin overview tick recovered');
        failing = false;
      } catch (err) {
        // Logged once per outage, not every 10 seconds.
        if (!failing) fastify.log.warn({ err }, 'admin overview tick failed');
        failing = true;
      } finally {
        running = false;
      }
    };

    let timer: NodeJS.Timeout | undefined;
    fastify.addHook('onReady', async () => {
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref();
    });
    fastify.addHook('onClose', async () => {
      if (timer) clearInterval(timer);
    });
  },
  { name: 'admin-overview-tick', dependencies: ['db', 'redis'] },
);
