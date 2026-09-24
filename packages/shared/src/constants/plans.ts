/**
 * Plan catalogue constants. `plans` in the database mirror these codes so an
 * admin can add a new priced plan without a deploy, but the *codes*, device
 * limits and trial length below are the ones every other package (API,
 * extension, dashboard) imports so they never drift out of sync with the
 * seed data. See docs/13-roadmap.md (subscription phase) and the `packages/db`
 * seed for where these become rows.
 */

/** The five plan codes the product ships with. Admins can still create
 * additional `lifetime`-style plans as data (see `packages/db`), but these
 * five are the ones the rest of the system has fixed behaviour for. */
export const PLAN_CODES = ['trial', 'basic', 'pro', 'ultimate', 'lifetime'] as const;

export type PlanCode = (typeof PLAN_CODES)[number];

export function isPlanCode(value: unknown): value is PlanCode {
  return typeof value === 'string' && (PLAN_CODES as readonly string[]).includes(value);
}

/** Concurrent-device limits per plan, enforced at login/device registration
 * (`DEVICE_LIMIT_REACHED` when exceeded — see `errors.ts`). */
export const DEVICE_LIMITS: Readonly<Record<PlanCode, number>> = {
  trial: 1,
  basic: 1,
  pro: 2,
  ultimate: 3,
  lifetime: 3,
};

/** Length of the free trial, in days, from `subscriptions.trial_ends_at`. */
export const TRIAL_LENGTH_DAYS = 7;

/**
 * Feature keys gate behaviour in the extension, API and dashboard. They are
 * intentionally coarse-grained (module-level, not button-level) so a plan's
 * feature list is auditable at a glance.
 *
 * Milestone mapping (see docs/13-roadmap.md):
 *  - `ledger.*`     M1 — recorder (read-only, always on for any paid plan)
 *  - `assist.*`     M2 — human-in-the-loop ranker, filter rotation, risk meter
 *  - `automation.*` M3 — autobuyer, gated behind the safety governor AND its
 *                    own separate extension build (`ledger-auto`); the
 *                    feature key controls *entitlement*, the build controls
 *                    *distribution* — both must be true for it to run.
 */
export const FEATURE_KEYS = [
  'ledger.recorder',
  'ledger.price_model',
  'assist.ranker',
  'assist.filter_rotation',
  'assist.session_pnl',
  'assist.risk_meter',
  'automation.autobuyer',
  'dashboard.analytics',
  'dashboard.multi_device',
  'support.priority',
  'mobile.remote',
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

/** Features unlocked per plan. Every paid plan includes the autobuyer; the
 * plans differ in the mobile companion and in how long the pass lasts
 * (see PLAN_CATALOGUE). `basic` is retired (it had no automation) and kept
 * only so its existing subscriptions keep resolving. */
export const PLAN_FEATURES: Readonly<Record<PlanCode, readonly FeatureKey[]>> = {
  trial: [
    'ledger.recorder',
    'ledger.price_model',
    'assist.ranker',
    'assist.filter_rotation',
    'assist.session_pnl',
    'assist.risk_meter',
  ],
  basic: ['ledger.recorder', 'ledger.price_model'],
  pro: [
    'ledger.recorder',
    'ledger.price_model',
    'assist.ranker',
    'assist.filter_rotation',
    'assist.session_pnl',
    'assist.risk_meter',
    'automation.autobuyer',
    'dashboard.analytics',
  ],
  ultimate: [
    'ledger.recorder',
    'ledger.price_model',
    'assist.ranker',
    'assist.filter_rotation',
    'assist.session_pnl',
    'assist.risk_meter',
    'automation.autobuyer',
    'dashboard.analytics',
    'dashboard.multi_device',
    'support.priority',
    'mobile.remote',
  ],
  lifetime: [
    'ledger.recorder',
    'ledger.price_model',
    'assist.ranker',
    'assist.filter_rotation',
    'assist.session_pnl',
    'assist.risk_meter',
    'automation.autobuyer',
    'dashboard.analytics',
    'dashboard.multi_device',
    'support.priority',
    'mobile.remote',
  ],
};

export function planHasFeature(plan: PlanCode, feature: FeatureKey): boolean {
  return PLAN_FEATURES[plan].includes(feature);
}

/** How each plan code is sold. Plans are passes paid through PayPal.me, not
 * subscriptions: nothing renews, and each purchase is a claim an admin
 * approves (payment_claims, migrations/0031). `coming_soon` plans are shown
 * but can't be bought yet; `retired` plans aren't shown at all. */
export type PlanAvailability = 'available' | 'coming_soon' | 'retired';

export interface PlanCatalogueEntry {
  availability: PlanAvailability;
  /** Days one purchase adds. `null` for Season, which ends at the next FC
   * release rather than after a fixed number of days. */
  passDays: number | null;
}

export const PLAN_CATALOGUE: Readonly<Record<Exclude<PlanCode, 'trial'>, PlanCatalogueEntry>> = {
  basic: { availability: 'retired', passDays: 30 },
  pro: { availability: 'available', passDays: 30 },
  ultimate: { availability: 'coming_soon', passDays: 30 },
  lifetime: { availability: 'coming_soon', passDays: null },
};

export function isPurchasablePlan(code: string): boolean {
  return isPlanCode(code) && code !== 'trial' && PLAN_CATALOGUE[code].availability === 'available';
}

/** Where buyers pay. PayPal.me accepts an amount in the path:
 * `${PAYPAL_ME_URL}/9.99USD`. */
export const PAYPAL_ME_URL = 'https://paypal.me/MSgaier';

export function paypalPaymentUrl(priceCents: number, currency = 'USD'): string {
  return `${PAYPAL_ME_URL}/${(priceCents / 100).toFixed(2)}${currency.toUpperCase()}`;
}

/** Version of docs/legal/terms.md. Bump it when the Terms change, so every
 * user is asked to accept the new version. */
export const TERMS_VERSION = 1;
