// publishToUser / publishAdmin: the fan-out seam every other module (admin
// force-logout, feature toggles, kill switch, notifications, and the
// subscriptions agent's own subscription.changed push) uses to push a WS
// event. Publishing is just a Redis PUBLISH — this process's own `/ws`
// gateway (modules/ws) is one of potentially many subscribers (multiple API
// instances), so this works correctly whether the target connection lives on
// this instance or another one.

import { wsEventSchema, type WsEvent } from '@sl/shared';

import type { Redis } from 'ioredis';

export function userChannel(userId: string): string {
  return `ws:user:${userId}`;
}

export const ADMIN_CHANNEL = 'ws:admin:overview';

/** Publishes a validated WS event to one user's channel. Throws if `event`
 * doesn't match `wsEventSchema` — callers pass typed events, so this is a
 * last-line guard against a malformed payload reaching the wire. */
export async function publishToUser(redis: Redis, userId: string, event: WsEvent): Promise<void> {
  const parsed = wsEventSchema.parse(event);
  await redis.publish(userChannel(userId), JSON.stringify(parsed));
}

export async function publishAdmin(redis: Redis, event: WsEvent): Promise<void> {
  const parsed = wsEventSchema.parse(event);
  await redis.publish(ADMIN_CHANNEL, JSON.stringify(parsed));
}
