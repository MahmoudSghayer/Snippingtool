/*
 * bot-safety.ts — reporting the Sniping Bot's risk level to the server.
 *
 * Admins need to see who runs the bot on risky settings. There is no
 * dedicated telemetry kind for it, and adding one would need an API change,
 * so it travels as the generic `settings_change` activity event with a
 * self-describing field name: `bot.riskLevel=<low|moderate|high|very_high>`,
 * sent when a save changes the level.
 */
import { botRiskLevel, type ActivityEvent, type BotSettings } from '@sl/shared';

export const RISK_LEVEL_FIELD_PREFIX = 'bot.riskLevel=';

/** The event to enqueue when a save changed the risk level, or null when it
 * did not. `prev` null = nothing saved before (the defaults, which are low). */
export function riskLevelChangeEvent(
  prev: BotSettings | null,
  next: BotSettings,
  occurredAt: string,
  deviceId?: string | null,
): ActivityEvent | null {
  const before = prev ? botRiskLevel(prev).level : 'low';
  const after = botRiskLevel(next).level;
  if (before === after) return null;
  return {
    type: 'settings_change',
    occurredAt,
    ...(deviceId ? { deviceId } : {}),
    metadata: { fields: [`${RISK_LEVEL_FIELD_PREFIX}${after}`] },
  };
}
