/*
 * bot-safety.ts — reporting a Sniping Bot safety-mode change to the server.
 *
 * Admins need to see who turned the recommended limits off. There is no
 * dedicated telemetry kind for it, and adding one would need an API change,
 * so it travels as the generic `settings_change` activity event with a
 * self-describing field name: `bot.safetyMode=custom` or
 * `bot.safetyMode=recommended`.
 */
import { effectiveSafetyMode, type ActivityEvent, type BotSettings } from '@sl/shared';

export const SAFETY_MODE_FIELD_PREFIX = 'bot.safetyMode=';

type ModeFields = Pick<BotSettings, 'safetyMode' | 'customRiskAcknowledgedAt'>;

/** The event to enqueue when the effective safety mode changed between two
 * saves, or null when it did not. */
export function safetyModeChangeEvent(
  prev: ModeFields | null,
  next: ModeFields,
  occurredAt: string,
  deviceId?: string | null,
): ActivityEvent | null {
  const before = prev ? effectiveSafetyMode(prev) : 'recommended';
  const after = effectiveSafetyMode(next);
  if (before === after) return null;
  return {
    type: 'settings_change',
    occurredAt,
    ...(deviceId ? { deviceId } : {}),
    metadata: { fields: [`${SAFETY_MODE_FIELD_PREFIX}${after}`] },
  };
}
