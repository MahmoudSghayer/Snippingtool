// WebSocket gateway. Answers on two different absolute paths — `POST
// /api/v1/ws/ticket` (issues a ticket) and `GET /ws` (the upgrade itself,
// unprefixed per the PHASE 3 spec) — see the module convention note in
// apps/api/SKELETON_READY for why every route below is a full path rather
// than relying on a computed prefix.
//
// Flow: authenticated client calls POST /api/v1/ws/ticket, gets back a
// single-use, 30s-TTL opaque ticket (Redis-backed, never a JWT — no need to
// verify a signature on the hot upgrade path). It then opens
// `wss://.../ws?ticket=<ticket>`; the ticket is consumed (GETDEL) exactly
// once. Channels: `user:{id}` (always) and `admin:overview` (admin role
// only). Fan-out across API instances is Redis pub/sub (src/ws/router.ts +
// src/ws/publish.ts); presence is tracked in Redis (src/ws/presence.ts).

import { randomBytes } from 'node:crypto';

import fp from 'fastify-plugin';
import { z } from 'zod';

import { markOffline, markOnline, touchPresence } from '../../ws/presence.js';
import { ADMIN_CHANNEL, userChannel } from '../../ws/publish.js';
import { WsChannelRouter } from '../../ws/router.js';

import type { FastifyInstance } from 'fastify';

const TICKET_TTL_SECONDS = 30;
const PRESENCE_TOUCH_INTERVAL_MS = 20_000;

function ticketKey(ticket: string): string {
  return `ws:ticket:${ticket}`;
}

export default fp(
  async function wsModule(fastify: FastifyInstance) {
    const router = new WsChannelRouter(fastify.redisSub);

    fastify.post(
      '/api/v1/ws/ticket',
      {
        onRequest: [fastify.authenticate],
        schema: {
          tags: ['ws'],
          summary: 'Issue a single-use WebSocket auth ticket (30s TTL).',
          response: { 200: z.object({ ticket: z.string(), expiresIn: z.number() }) },
        },
      },
      async (request) => {
        const ticket = randomBytes(24).toString('base64url');
        await fastify.redis.set(
          ticketKey(ticket),
          JSON.stringify({ userId: request.authUser!.id, role: request.authUser!.role }),
          'EX',
          TICKET_TTL_SECONDS,
        );
        return { ticket, expiresIn: TICKET_TTL_SECONDS };
      },
    );

    fastify.get('/ws', { websocket: true }, (socket, request) => {
      void (async () => {
        const query = z.object({ ticket: z.string().min(1) }).safeParse(request.query);
        if (!query.success) {
          socket.close(4400, 'missing ticket');
          return;
        }

        const raw = await fastify.redis.getdel(ticketKey(query.data.ticket));
        if (!raw) {
          socket.close(4401, 'invalid or expired ticket');
          return;
        }

        const { userId, role } = JSON.parse(raw) as { userId: string; role: 'user' | 'admin' };

        const channels = [userChannel(userId)];
        if (role === 'admin') channels.push(ADMIN_CHANNEL);
        await Promise.all(channels.map((channel) => router.subscribe(channel, socket)));
        await markOnline(fastify.redis, userId);

        const touchInterval = setInterval(() => {
          touchPresence(fastify.redis, userId).catch((err) =>
            fastify.log.warn({ err }, 'presence touch failed'),
          );
        }, PRESENCE_TOUCH_INTERVAL_MS);

        socket.on('pong', () => {
          touchPresence(fastify.redis, userId).catch(() => undefined);
        });

        socket.send(JSON.stringify({ type: 'connected', channels }));

        socket.on('close', () => {
          clearInterval(touchInterval);
          void router.unsubscribeAll(socket);
          void markOffline(fastify.redis, userId);
        });

        socket.on('error', (err) => {
          fastify.log.warn({ err, userId }, 'ws connection error');
        });
      })().catch((err) => {
        fastify.log.error({ err }, 'ws upgrade handler failed');
        try {
          socket.close(1011, 'internal error');
        } catch {
          /* already closed */
        }
      });
    });
  },
  { name: 'module:ws', dependencies: ['auth', 'redis', 'websocket'] },
);
