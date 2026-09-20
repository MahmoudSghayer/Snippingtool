// API latency percentiles (p50/p95/p99), read from the `prom-client`
// histogram `plugins/metrics.ts` already maintains
// (`http_request_duration_seconds`) — read-only consumption of an existing
// plugin's registry, no new metrics plugin, per this agent's ownership
// boundary (plugins/* is owned by the backend-core agent).

import type { Registry } from 'prom-client';

export interface PerformanceResult {
  sampleCount: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}

const HISTOGRAM_NAME = 'http_request_duration_seconds';

// prom-client's own `MetricValue<T>` type doesn't declare `metricName`
// (only `MetricValueWithName<T>`, used by single-metric `.get()`, does) —
// but `Registry#getMetricsAsJSON()` does include it on every value at
// runtime for histogram/summary metrics (verified against prom-client
// 15.1.3), so this is a widened local type for that field, not a guess.
interface HistogramJsonValue {
  value: number;
  labels: Record<string, string | number | undefined>;
  metricName?: string;
}

/**
 * Approximate p50/p95/p99 latency across every route/method/status label
 * combination the histogram is split by, merged into one cumulative
 * histogram (cumulative bucket counts from independent label series sum
 * validly, since each series counts a disjoint subset of the same
 * underlying request stream) and estimated with the standard Prometheus
 * `histogram_quantile` linear-interpolation method within the bucket that
 * first reaches the target rank. This is a bucket-width-bounded
 * approximation, not an exact percentile — see docs/08-analytics.md
 * "Performance" for the worked example and its stated error bound.
 */
export async function getPerformance(registry: Registry): Promise<PerformanceResult> {
  const metrics = await registry.getMetricsAsJSON();
  const histogram = metrics.find((m) => m.name === HISTOGRAM_NAME);
  const empty: PerformanceResult = { sampleCount: 0, p50Ms: null, p95Ms: null, p99Ms: null };
  if (!histogram || histogram.type !== 'histogram') return empty;

  const values = histogram.values as unknown as HistogramJsonValue[];
  const buckets = new Map<number, number>(); // le (seconds, Infinity for +Inf) -> merged cumulative count
  let totalCount = 0;

  for (const v of values) {
    if (v.metricName === `${HISTOGRAM_NAME}_bucket`) {
      const leRaw = v.labels.le;
      const le = leRaw === '+Inf' ? Number.POSITIVE_INFINITY : Number(leRaw);
      buckets.set(le, (buckets.get(le) ?? 0) + v.value);
    } else if (v.metricName === `${HISTOGRAM_NAME}_count`) {
      totalCount += v.value;
    }
  }
  if (totalCount === 0 || buckets.size === 0) return empty;

  const sorted = [...buckets.entries()].sort((a, b) => a[0] - b[0]);

  const quantileMs = (p: number): number => {
    const target = p * totalCount;
    let prevLe = 0;
    let prevCount = 0;
    for (const [le, cumulative] of sorted) {
      if (cumulative >= target) {
        if (!Number.isFinite(le)) return prevLe * 1000; // target falls in the +Inf overflow bucket
        if (cumulative === prevCount) return le * 1000;
        const fraction = (target - prevCount) / (cumulative - prevCount);
        return (prevLe + fraction * (le - prevLe)) * 1000;
      }
      prevLe = Number.isFinite(le) ? le : prevLe;
      prevCount = cumulative;
    }
    return prevLe * 1000;
  };

  return { sampleCount: totalCount, p50Ms: quantileMs(0.5), p95Ms: quantileMs(0.95), p99Ms: quantileMs(0.99) };
}
