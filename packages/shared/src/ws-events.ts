import { z } from 'zod';

import { featureToggleDtoSchema } from './schemas/admin.js';
import { subscriptionDtoSchema } from './schemas/subscriptions.js';

/**
 * Server-push events over the `/ws` gateway (docs/01-architecture.md, "WS
 * push" sequence). Channel routing: `user:{id}` gets everything except
 * `admin.overview.tick`, which is `admin:overview` only.
 */

export const subscriptionChangedEventSchema = z.object({
  type: z.literal('subscription.changed'),
  subscription: subscriptionDtoSchema,
});

export const sessionRevokedEventSchema = z.object({
  type: z.literal('session.revoked'),
  sessionId: z.string().uuid(),
  reason: z.enum(['admin_force_logout', 'password_changed', 'token_reuse_detected', 'user']),
});

export const notificationNewEventSchema = z.object({
  type: z.literal('notification.new'),
  notification: z.object({
    id: z.string().uuid(),
    type: z.string().min(1).max(80),
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(2000),
    data: z.record(z.unknown()).optional(),
  }),
});

export const featureTogglesChangedEventSchema = z.object({
  type: z.literal('feature_toggles.changed'),
  toggles: z.array(featureToggleDtoSchema),
});

/** The one event every build, including `ledger-auto`, must treat as
 * absolute and immediate — see docs/01-architecture.md, "safety governor". */
export const killSwitchEventSchema = z.object({
  type: z.literal('kill_switch'),
  active: z.boolean(),
  reason: z.string().min(1).max(500).optional(),
});

export const adminOverviewTickEventSchema = z.object({
  type: z.literal('admin.overview.tick'),
  onlineUsers: z.number().int().min(0),
  activeSnipesLastMinute: z.number().int().min(0),
  errorsLastMinute: z.number().int().min(0),
  generatedAt: z.string().datetime(),
});

export const wsEventSchema = z.discriminatedUnion('type', [
  subscriptionChangedEventSchema,
  sessionRevokedEventSchema,
  notificationNewEventSchema,
  featureTogglesChangedEventSchema,
  killSwitchEventSchema,
  adminOverviewTickEventSchema,
]);
export type WsEvent = z.infer<typeof wsEventSchema>;
export type WsEventType = WsEvent['type'];
