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
