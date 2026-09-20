// Nightly consistency sweep: expire licenses past `expires_at`, revoke any
// license whose subscription has left every "live" status (see
// docs/05-subscriptions.md §9 and `modules/licenses/service.ts`'s doc
// comment on `revalidateLicenses`).

import { revalidateLicenses } from '../modules/licenses/service.js';

import { defineJob } from './types.js';

export default defineJob({
  name: 'licenses.revalidate',
  schedule: '0 3 * * *', // 03:00 UTC nightly
  async processor(_job, { db, log }) {
    const result = await revalidateLicenses(db);
    log.info(result, 'licenses.revalidate completed');
  },
});
