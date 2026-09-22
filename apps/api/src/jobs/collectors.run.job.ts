// Runs the registered market-data collectors (docs/14-ml-suggestions.md
// Phase A).
//
// One BullMQ job drives every source rather than one job per source, because
// the thing worth serialising is *us*: sources are polled on the same
// schedule, and running them in sequence keeps total outbound request rate
// predictable instead of being whatever the sum of N independent schedules
// happens to be.
//
// A source that fails does not stop the others. Each `runCollector` call
// writes its own `collector_runs` row, so a partial sweep is visible per
// source rather than collapsing into one job-level failure.

import { runCollector } from '../lib/collectors/runner.js';
import { COLLECTOR_SOURCES, enabledSources } from '../lib/collectors/sources/index.js';

import { defineJob } from './types.js';

export interface CollectorsRunData {
  /** Restrict the sweep to these `job` ids (e.g. `['ea.news']`). Omitted, every
   * enabled source runs. Used by the manual/admin trigger. */
  only?: string[];
}

export default defineJob<CollectorsRunData>({
  name: 'collectors.run',
  // Hourly. The sources Phase A can reach change on the order of days, and
  // the conditional-fetch path means an unchanged page costs one cheap
  // request — but there is still no reason to poll faster than the data
  // moves.
  schedule: '17 * * * *',

  async processor(job, { db, log }) {
    const only = job.data?.only;
    const sources = enabledSources().filter((s) => !only || only.includes(s.job));

    if (sources.length === 0) {
      log.warn({ only, registered: COLLECTOR_SOURCES.length }, 'collectors.run matched no sources');
      return;
    }

    for (const source of sources) {
      try {
        const result = await runCollector(source, { db, log });
        log.info(
          {
            source: source.source,
            job: source.job,
            status: result.status,
            fetched: result.documentsFetched,
            changed: result.documentsChanged,
            rows: result.rowsWritten,
            parseFailures: result.parseFailures,
            blocked: result.blocked,
          },
          'collector run finished',
        );
      } catch (err) {
        // Already recorded as a failed collector_runs row by runCollector;
        // swallowed here so one bad source does not abandon the sweep.
        log.error(
          { source: source.source, job: source.job, err: String(err) },
          'collector run threw',
        );
      }
    }
  },
});
