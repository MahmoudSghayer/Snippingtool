// Every few minutes: removes stale entries from the WS presence online-set
// (src/ws/presence.ts) — connections that closed without a clean close frame
// (crash, network drop) leave their TTL key to expire but their set
// membership behind; this catches that up.

import { sweepStalePresence } from '../ws/presence.js';

import { defineJob } from './types.js';

export default defineJob({
  name: 'presence.sweep',
  schedule: '*/5 * * * *', // every 5 minutes
  async processor(_job, { redis, log }) {
    const removed = await sweepStalePresence(redis);
    if (removed > 0) log.info({ removed }, 'presence.sweep removed stale entries');
  },
});
