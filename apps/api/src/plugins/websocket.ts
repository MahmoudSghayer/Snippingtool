import websocket from '@fastify/websocket';
import fp from 'fastify-plugin';

import type { FastifyInstance } from 'fastify';

export default fp(
  async function websocketPlugin(fastify: FastifyInstance) {
    await fastify.register(websocket, {
      options: { maxPayload: 64 * 1024 },
    });
  },
  { name: 'websocket' },
);
