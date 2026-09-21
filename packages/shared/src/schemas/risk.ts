import { z } from 'zod';

/**
 * A decision the safety governor made or logged (docs/01-architecture.md,
 * "safety governor"). `hard_stop` and `kill_switch` are the two the extension
 * treats as absolute; the others are the sliding-window checks that feed the
 * risk budget meter.
 */
export const RISK_EVENT_KINDS = [
  'actions_per_hour',
  'session_length',
  'buy_search_ratio',
  'coin_flow',
  'hard_stop',
  'kill_switch',
] as const;
export type RiskEventKind = (typeof RISK_EVENT_KINDS)[number];

export const riskBudgetEventSchema = z
  .object({
    deviceId: z.string().uuid(),
    sessionId: z.string().uuid(),
    kind: z.enum(RISK_EVENT_KINDS),
    value: z.number(),
    threshold: z.number(),
    occurredAt: z.string().datetime(),
  })
  .strict();
export type RiskBudgetEvent = z.infer<typeof riskBudgetEventSchema>;

export const reportRiskBudgetEventsRequestSchema = z
  .object({
    events: z.array(riskBudgetEventSchema).min(1).max(200),
  })
  .strict();
export type ReportRiskBudgetEventsRequest = z.infer<typeof reportRiskBudgetEventsRequestSchema>;

// ---------------------------------------------------------------------------
// GET history (docs/07-dashboard.md §11 gap #6): only the extension's batch
// ingest (`POST /risk-events` above) existed — the dashboard's "Risk
// posture" card had no live event history to show, only the account's
// configured governor *budget* (`GET /settings`). `GET /risk-events` (the
// caller's own history) and `GET /admin/users/:id/risk-events` (an admin
// looking at one user) close that.
// ---------------------------------------------------------------------------

/** One stored `risk_budget_events` row — `deviceId`/`sessionId` are
 * nullable here (unlike the ingest-time `riskBudgetEventSchema`, where
 * they're required): both columns are `ON DELETE SET NULL`, so a row can
 * outlive the device/session it was logged against. */
export const riskBudgetEventRowSchema = z.object({
  id: z.string().uuid(),
  deviceId: z.string().uuid().nullable(),
  sessionId: z.string().uuid().nullable(),
  kind: z.enum(RISK_EVENT_KINDS),
  value: z.number(),
  threshold: z.number(),
  occurredAt: z.string().datetime(),
});
export type RiskBudgetEventRow = z.infer<typeof riskBudgetEventRowSchema>;

export const riskEventQuerySchema = z
  .object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    kind: z.enum(RISK_EVENT_KINDS).optional(),
    cursor: z.string().min(1).max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();
export type RiskEventQuery = z.infer<typeof riskEventQuerySchema>;
