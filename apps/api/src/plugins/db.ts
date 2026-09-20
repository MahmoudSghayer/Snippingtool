// Decorates the Fastify instance with `db` (Drizzle) and `sqlClient` (the raw
// postgres.js connection, for LISTEN/NOTIFY, REFRESH MATERIALIZED VIEW, etc).
// Closes the pool on server shutdown.

import { createDb, type Database } from '@sl/db';
import fp from 'fastify-plugin';

import type { Sql } from 'postgres';

import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
    sqlClient: Sql;
  }
}

export default fp(
  async function dbPlugin(fastify: FastifyInstance) {
    const { db, sql } = createDb(fastify.config.DATABASE_URL, {
      max: fastify.config.NODE_ENV === 'test' ? 5 : 10,
    });

    fastify.decorate('db', db);
    fastify.decorate('sqlClient', sql);

    fastify.addHook('onClose', async () => {
      await sql.end({ timeout: 5 });
    });
  },
  { name: 'db' },
);
