// Runs one source adapter end to end: discover → fetch → store raw → parse →
// resolve → write, with a `collector_runs` row recording what happened.
//
// The bookkeeping is the point, not an afterthought. A collector that quietly
// stops returning data looks exactly like a quiet market
// (docs/14-ml-suggestions.md §14), so every run records what it fetched, what
// actually changed, what it wrote and what failed to parse — and a run that
// fetched documents but wrote nothing is visible as such instead of passing
// for success.

import { collectorRuns, priceObservations, rawDocuments } from '@sl/db';
import { and, desc, eq } from 'drizzle-orm';

import { PoliteFetcher, sha256 } from './fetcher.js';
import { resolveCardRef } from './resolver.js';

import type { CollectorContext, DiscoveredTarget, ParseFailure, SourceAdapter } from './types.js';

export interface RunResult {
  runId: string;
  status: 'success' | 'partial' | 'failed' | 'skipped';
  documentsFetched: number;
  documentsChanged: number;
  rowsWritten: number;
  parseFailures: number;
  blocked: string | null;
}

export interface RunOptions {
  fetcher?: PoliteFetcher;
  /** Overrides the adapter's own cap; mainly for tests and manual runs. */
  maxDocuments?: number;
}

export async function runCollector(
  adapter: SourceAdapter,
  ctx: CollectorContext,
  options: RunOptions = {},
): Promise<RunResult> {
  const { db, log } = ctx;

  const [run] = await db
    .insert(collectorRuns)
    .values({ source: adapter.source, job: adapter.job, status: 'running' })
    .returning({ id: collectorRuns.id });
  const runId = run!.id;

  const fetcher =
    options.fetcher ?? new PoliteFetcher({ minIntervalMs: adapter.minIntervalMs ?? 2000, log });

  let documentsFetched = 0;
  let documentsChanged = 0;
  let rowsWritten = 0;
  const failures: ParseFailure[] = [];
  const disallowed: string[] = [];
  let blocked: string | null = null;

  try {
    let targets: DiscoveredTarget[] = await adapter.discover(ctx);
    const cap = options.maxDocuments ?? adapter.maxDocumentsPerRun ?? 200;
    if (targets.length > cap) {
      log.warn(
        { source: adapter.source, job: adapter.job, found: targets.length, cap },
        'collector discovery exceeded its per-run cap; truncating',
      );
      targets = targets.slice(0, cap);
    }

    for (const target of targets) {
      // A source that has started refusing us is telling us to stop, and
      // continuing to hammer it with the rest of the queue is exactly the
      // behaviour §4e rules out. Abandon the run, record why.
      if (blocked) break;

      const previous = await lastDocumentFor(ctx, adapter, target.url);
      // Only hand the fetcher the previous hash when it is comparable to what
      // it computes: with a canonicaliser the stored hash is of the extract,
      // not the body, so the fetcher's own comparison would never match and
      // the cheap path would just add a confusing always-false check.
      const outcome = await fetcher.fetch(target.url, {
        knownHash: adapter.canonicalise ? undefined : previous?.contentHash,
      });

      if (outcome.kind === 'disallowed') {
        disallowed.push(target.url);
        continue;
      }
      if (outcome.kind === 'blocked') {
        blocked = `${target.url}: ${outcome.reason}`;
        log.warn(
          { source: adapter.source, url: target.url, reason: outcome.reason },
          'collector blocked by source',
        );
        break;
      }
      if (outcome.kind === 'error') {
        failures.push({ url: target.url, reason: outcome.reason });
        continue;
      }

      documentsFetched += 1;
      if (outcome.kind === 'unchanged') continue;

      // The hash that gets stored and compared. For a dynamic page this is a
      // hash of the data we care about, so an unchanged article list counts
      // as unchanged however much the surrounding markup churned.
      const canonical = adapter.canonicalise?.(outcome.body) ?? null;
      const storedHash = canonical === null ? outcome.hash : sha256(canonical);
      if (previous && storedHash === previous.contentHash) continue;

      documentsChanged += 1;

      // The row is always written, because this table is what change
      // detection reads: `storeRawBodies: false` drops the *body*, not the
      // record of having fetched it. Writing only when bodies are stored
      // made detection incoherent — hashes were read from here but never
      // updated, so a page could be parsed and then compared forever against
      // a hash from some earlier adapter's run. That is not hypothetical: it
      // silently cost this collector a whole page of articles, which were
      // skipped as "unchanged" despite never having been written.
      //
      // onConflictDoNothing: the (source, url, hash) unique key means the
      // same content re-fetched later is not a new row, keeping the table
      // bounded on slow-changing pages.
      await db
        .insert(rawDocuments)
        .values({
          source: adapter.source,
          url: target.url,
          contentHash: storedHash,
          contentType: outcome.contentType,
          httpStatus: outcome.status,
          byteSize: Buffer.byteLength(outcome.body, 'utf8'),
          body: adapter.storeRawBodies === false ? null : outcome.body,
          runId,
        })
        .onConflictDoNothing();

      let parsed;
      try {
        parsed = await adapter.parse(
          {
            url: target.url,
            body: outcome.body,
            contentType: outcome.contentType,
            meta: target.meta,
          },
          ctx,
        );
      } catch (err) {
        failures.push({ url: target.url, reason: `parse threw: ${String(err)}` });
        continue;
      }

      for (const f of parsed.failures ?? []) failures.push(f);
      rowsWritten += parsed.rowsWritten ?? 0;

      // Cards first: a price can only be written once its card exists.
      for (const ref of parsed.cards ?? []) {
        await resolveCardRef(ctx, adapter.source, ref);
      }

      for (const price of parsed.prices ?? []) {
        const resolved = await resolveCardRef(ctx, adapter.source, price.cardRef);
        if (!resolved) {
          failures.push({
            url: target.url,
            reason: `unresolved card: ${describeRef(price.cardRef)}`,
          });
          continue;
        }
        await db.insert(priceObservations).values({
          cardId: resolved.cardId,
          source: adapter.source,
          platform: price.platform,
          priceKind: price.priceKind,
          price: price.price,
          runId,
          observedAt: price.observedAt ?? new Date(),
        });
        rowsWritten += 1;
      }
    }

    const status = decideStatus({
      blocked,
      documentsFetched,
      failures: failures.length,
      disallowed: disallowed.length,
    });

    await db
      .update(collectorRuns)
      .set({
        status,
        documentsFetched,
        documentsChanged,
        rowsWritten,
        parseFailures: failures.length,
        error: blocked,
        detail: {
          disallowed: disallowed.slice(0, 20),
          failures: failures.slice(0, 20),
        },
        finishedAt: new Date(),
      })
      .where(eq(collectorRuns.id, runId));

    return {
      runId,
      status,
      documentsFetched,
      documentsChanged,
      rowsWritten,
      parseFailures: failures.length,
      blocked,
    };
  } catch (err) {
    await db
      .update(collectorRuns)
      .set({
        status: 'failed',
        documentsFetched,
        documentsChanged,
        rowsWritten,
        parseFailures: failures.length,
        error: String(err),
        finishedAt: new Date(),
      })
      .where(eq(collectorRuns.id, runId));
    throw err;
  }
}

function decideStatus(input: {
  blocked: string | null;
  documentsFetched: number;
  failures: number;
  disallowed: number;
}): 'success' | 'partial' | 'failed' | 'skipped' {
  if (input.blocked) return 'failed';
  // Every target was off-limits: not a failure of ours, but emphatically not
  // a success either — this is the shape that would otherwise look like "the
  // market was quiet today".
  if (input.documentsFetched === 0 && input.disallowed > 0) return 'skipped';
  if (input.failures > 0) return 'partial';
  return 'success';
}

function describeRef(ref: { externalId?: string; resourceId?: string; name?: string }): string {
  return ref.externalId ?? ref.resourceId ?? ref.name ?? '(empty ref)';
}

/** The most recent stored document for a URL, whose hash lets the next fetch
 * be conditional. */
async function lastDocumentFor(
  ctx: CollectorContext,
  adapter: SourceAdapter,
  url: string,
): Promise<{ contentHash: string } | null> {
  const rows = await ctx.db
    .select({ contentHash: rawDocuments.contentHash })
    .from(rawDocuments)
    .where(and(eq(rawDocuments.source, adapter.source), eq(rawDocuments.url, url)))
    .orderBy(desc(rawDocuments.fetchedAt))
    .limit(1);
  return rows[0] ?? null;
}
