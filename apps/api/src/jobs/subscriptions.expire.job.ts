// Every 5 minutes: expire trials past trial_ends_at and paid subscriptions
// past current_period_end with auto_renew=false (docs/05-subscriptions.md
// §9). All the actual state-transition/license-revoke/notify/WS-publish
// logic lives in `modules/subscriptions/service.ts#expireDueSubscriptions`
// so it stays unit-testable independent of BullMQ.

import { expireDueSubscriptions } from '../modules/subscriptions/service.js';

import { defineJob } from './types.js';

export default defineJob({
  name: 'subscriptions.expire',
  schedule: '*/5 * * * *',
  async processor(_job, { db, redis, log }) {
    const result = await expireDueSubscriptions(db, redis);
    log.info({ expiredCount: result.expiredCount }, 'subscriptions.expire completed');
  },
});
