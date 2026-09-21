// Feature usage: counts of `user_activity` rows within [from, to] whose
// `metadata` carries a `feature` key (a free-form string the extension/
// dashboard tags an activity event with — e.g. `{ feature: 'ranker' }` on a
// `settings_change`/`other` row), grouped by that feature name.

import { userActivity, type Database } from '@sl/db';
import { and, gte, lt } from 'drizzle-orm';

import { endOfDayUtc, parseDayUtc } from './dates.js';

export interface FeatureUsageParams {
  from: string;
  to: string;
}

export async function getFeatureUsage(
  db: Database,
  params: FeatureUsageParams,
): Promise<Record<string, number>> {
  const rows = await db.query.userActivity.findMany({
    where: and(
      gte(userActivity.occurredAt, parseDayUtc(params.from)),
      lt(userActivity.occurredAt, endOfDayUtc(params.to)),
    ),
    columns: { metadata: true },
  });
  const byFeature: Record<string, number> = {};
  for (const row of rows) {
    const feature = row.metadata?.feature;
    if (typeof feature === 'string' && feature.length > 0) {
      byFeature[feature] = (byFeature[feature] ?? 0) + 1;
    }
  }
  return byFeature;
}
