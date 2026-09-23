// Drains the article backlog into structured signals (docs/14 Phase D).
//
// Every article gets exactly one extraction attempt per prompt version:
// `news_items.signals_extracted_at` is stamped whether or not anything was
// found, because "the model correctly found no signal here" and "not looked
// at yet" are the same row otherwise, and the first would be re-billed on
// every run forever.
//
// The job is a no-op without credentials rather than a crash. Signal
// extraction is an optional capability of this deployment; a worker that
// refuses to start because one feature is unconfigured takes down the
// backups, the rollups and the licence heartbeats with it.

import { newsItems, newsSignals } from '@sl/db';
import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';

import { resolveCardRef } from '../lib/collectors/resolver.js';
import { defaultClient, extractSignals, SignalExtractionError } from '../lib/signals/extract.js';

import { defineJob } from './types.js';

import type { MessagesClient } from '../lib/signals/extract.js';

/** Articles per run. Small on purpose: each is a model call, and a backlog
 * that drains over a few runs is preferable to one run that spends the whole
 * budget before anyone has reviewed a single signal. */
const BATCH = 10;

export interface SignalsExtractData {
  /** Override the batch size for a manual backfill. */
  limit?: number;
  /** Injected by tests. */
  client?: MessagesClient;
}

export default defineJob<SignalsExtractData>({
  name: 'signals.extract',
  // Hourly, offset from the collectors so articles have been fetched first.
  schedule: '42 * * * *',

  async processor(job, { db, log }) {
    const client = job.data?.client ?? defaultClient();
    if (!client) {
      log.warn(
        {},
        'signals.extract: ANTHROPIC_API_KEY not configured — skipping (feature disabled)',
      );
      return;
    }

    const limit = job.data?.limit ?? BATCH;

    const pending = await db
      .select({
        id: newsItems.id,
        title: newsItems.title,
        summary: newsItems.summary,
        body: newsItems.body,
      })
      .from(newsItems)
      .where(and(isNotNull(newsItems.body), isNull(newsItems.signalsExtractedAt)))
      .orderBy(asc(newsItems.publishedAt))
      .limit(limit);

    if (pending.length === 0) {
      log.info({}, 'signals.extract: nothing pending');
      return;
    }

    let extracted = 0;
    let withSignals = 0;
    let failures = 0;

    for (const article of pending) {
      let outcome;
      try {
        outcome = await extractSignals(
          { title: article.title, summary: article.summary, body: article.body! },
          client,
        );
      } catch (err) {
        failures += 1;
        // Deliberately not stamped: a failure is not an answer, so the
        // article stays on the queue for the next run. A persistently
        // failing article shows up as a non-zero failure count rather than
        // silently disappearing.
        log.error(
          { newsItemId: article.id, err: String(err) },
          err instanceof SignalExtractionError
            ? 'signals.extract: untrusted response, leaving article queued'
            : 'signals.extract: extraction threw',
        );
        continue;
      }

      for (const signal of outcome.signals) {
        // A named player is resolved through the same conservative path the
        // collectors use: an unresolvable name yields no card id rather than
        // a guess. The signal is still stored — as an unreviewed one whose
        // target a human can fix — because losing the signal entirely would
        // be worse than storing it unresolved.
        let cardId: string | null = null;
        if (signal.playerName) {
          const resolved = await resolveCardRef({ db, log }, 'ea', { name: signal.playerName });
          cardId = resolved?.cardId ?? null;
        }

        // The DB enforces exactly one target. An unresolved player name
        // becomes a cohort keyed on the name — honestly "whatever cards this
        // name refers to". It used `club` at first, which put Thierry Henry
        // in a club field and made club queries return people.
        const cohort =
          signal.cohort ?? (cardId ? null : { playerName: signal.playerName ?? 'unknown' });

        await db.insert(newsSignals).values({
          newsItemId: article.id,
          direction: signal.direction,
          magnitude: signal.magnitude,
          confidence: signal.confidence.toFixed(3),
          cardId,
          cohort: cardId ? null : cohort,
          evidence: signal.evidence,
          rationale: signal.rationale,
          model: outcome.model,
          promptVersion: outcome.promptVersion,
        });
      }

      await db
        .update(newsItems)
        .set({ signalsExtractedAt: new Date(), signalsModel: outcome.model })
        .where(eq(newsItems.id, article.id));

      extracted += 1;
      if (outcome.signals.length > 0) withSignals += 1;

      log.info(
        {
          newsItemId: article.id,
          signals: outcome.signals.length,
          rejected: outcome.rejected.length,
          inputTokens: outcome.usage.inputTokens,
          cacheReadTokens: outcome.usage.cacheReadTokens,
        },
        'signals.extract: article processed',
      );
    }

    log.info(
      { extracted, withSignals, failures, pending: pending.length },
      'signals.extract: batch finished',
    );
  },
});
