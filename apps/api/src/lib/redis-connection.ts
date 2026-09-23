// One place that knows how to connect to Redis.
//
// This exists because of a real outage. When Redis moved to a TLS-only
// listener, `plugins/redis.ts` was taught to trust the stack CA and
// `worker.ts` was not — it kept building its own `new Redis(url)`. ioredis
// then failed the handshake with "self-signed certificate in certificate
// chain" and, with `maxRetriesPerRequest: null`, retried forever without
// throwing. The worker process stayed up, logged nothing, never reached its
// "worker started" line, and every scheduled job silently stopped running.
//
// The worker's healthcheck opens a raw TCP socket to Redis, which succeeds
// against a TLS port without a handshake, so the container reported healthy
// throughout. Nothing anywhere said the jobs were dead.
//
// Hence: one factory, used by every caller. A second place that constructs a
// Redis client is a second place that can miss the CA.

import { readFileSync } from 'node:fs';

import { Redis, type RedisOptions } from 'ioredis';

export interface RedisConnectionConfig {
  REDIS_URL: string;
  REDIS_TLS_CA_FILE?: string | undefined;
}

/**
 * TLS options for a `rediss://` URL whose certificate is signed by a private
 * CA (the single-VM topology — see infra/scripts/gen-datastore-certs.sh).
 *
 * This *adds* trust rather than removing it: `rejectUnauthorized` keeps its
 * default, and the certificate's SAN is the compose service name, so hostname
 * verification still applies. Against a managed Redis with a publicly-trusted
 * certificate, leave `REDIS_TLS_CA_FILE` unset and the system trust store is
 * used — verification is on either way.
 */
export function redisTlsOptions(config: RedisConnectionConfig): Pick<RedisOptions, 'tls'> {
  const caFile = config.REDIS_TLS_CA_FILE;
  if (!caFile || !config.REDIS_URL.startsWith('rediss://')) return {};
  return { tls: { ca: [readFileSync(caFile)] } };
}

/** Builds a Redis client with the right TLS settings for this deployment. */
export function createRedisConnection(
  config: RedisConnectionConfig,
  options: RedisOptions = {},
): Redis {
  return new Redis(config.REDIS_URL, { ...options, ...redisTlsOptions(config) });
}
