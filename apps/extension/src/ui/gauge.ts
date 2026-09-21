/*
 * gauge.ts — the segmented risk-budget gauge's pure math, shared by
 * `popup/main.ts` and `ui/panel.ts` so both surfaces' meters agree on
 * exactly what "approaching the limit" and "at the limit" mean (PHASE 10,
 * "the risk budget meter as a segmented gauge with per-threshold
 * segments"). No DOM here — each caller owns its own markup (the popup
 * builds plain HTML strings, the panel builds a shadow-DOM tree), this file
 * is just the one place the 80%/100% bands and the fill-width math live, so
 * they can't drift apart between the two.
 *
 * Four thresholds, matching `engine/governor.ts`'s `RiskSnapshot` exactly:
 * actions/hour, session length, buy:search ratio, coin flow/hour. Every
 * consumer renders all four, always in this order, so a trader who checks
 * both the popup and the on-page panel sees the same layout in both places.
 */

export type GaugeZone = 'ok' | 'high' | 'over';

/** `ratio >= 1` ("over") and `ratio >= 0.8` ("high") are the same two bands
 * `ui/panel.ts` used before this file existed — kept identical on purpose. */
export function gaugeZone(value: number, limit: number): GaugeZone {
  if (!(limit > 0)) return 'ok';
  const ratio = value / limit;
  if (ratio >= 1) return 'over';
  if (ratio >= 0.8) return 'high';
  return 'ok';
}

/** Fill width as a percent of the track, clamped to 100 — a value past the
 * limit still shows a full bar (the zone color is what communicates "over",
 * not an overflowing bar). */
export function gaugeFillPercent(value: number, limit: number): number {
  if (!(limit > 0)) return 0;
  return Math.max(0, Math.min(100, (value / limit) * 100));
}

export interface GaugeSegmentSpec {
  key: 'actionsPerHour' | 'sessionLength' | 'buyToSearchRatio' | 'coinFlow';
  label: string;
  value: number;
  limit: number;
  /** Pre-formatted "value / limit" text for the row — each segment formats
   * its own units (counts vs. minutes vs. a ratio vs. coins), so this file
   * stays unit-agnostic. */
  text: string;
}

/** Builds the four segments' specs from a `RiskSnapshot`-shaped object.
 * Takes a plain structural type (not `RiskSnapshot` itself) so this module
 * has no import from `engine/governor.ts` — kept fully independent of the
 * engine layer this pass doesn't own, even though the shapes line up. */
export function buildGaugeSegments(snapshot: {
  actionsLastHour: number;
  actionsPerHourLimit: number;
  sessionElapsedMinutes: number;
  sessionLengthLimitMinutes: number;
  buyToSearchRatio: number;
  buyToSearchRatioLimit: number;
  coinFlowLastHour: number;
  coinFlowLimit: number;
}): GaugeSegmentSpec[] {
  const coins = (n: number) => Math.round(n).toLocaleString('en-US');
  return [
    {
      key: 'actionsPerHour',
      label: 'Actions / hour',
      value: snapshot.actionsLastHour,
      limit: snapshot.actionsPerHourLimit,
      text: `${Math.round(snapshot.actionsLastHour)} / ${snapshot.actionsPerHourLimit}`,
    },
    {
      key: 'sessionLength',
      label: 'Session length',
      value: snapshot.sessionElapsedMinutes,
      limit: snapshot.sessionLengthLimitMinutes,
      text: `${Math.round(snapshot.sessionElapsedMinutes)} / ${snapshot.sessionLengthLimitMinutes} min`,
    },
    {
      key: 'buyToSearchRatio',
      label: 'Buy : search ratio',
      value: snapshot.buyToSearchRatio,
      limit: snapshot.buyToSearchRatioLimit,
      text: `${snapshot.buyToSearchRatio.toFixed(2)} / ${snapshot.buyToSearchRatioLimit.toFixed(2)}`,
    },
    {
      key: 'coinFlow',
      label: 'Coin flow / hour',
      value: snapshot.coinFlowLastHour,
      limit: snapshot.coinFlowLimit,
      text: `${coins(snapshot.coinFlowLastHour)} / ${coins(snapshot.coinFlowLimit)}`,
    },
  ];
}
