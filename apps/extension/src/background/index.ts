/*
 * background/index.ts — the service worker. Owns no loops (rule 5): message
 * handlers, `chrome.alarms` (heartbeat, telemetry flush, error flush),
 * storage, auth. Every long-lived thing — the engine loop, the ranker, the
 * governor — lives in the content script instead (docs/01-architecture.md,
 * "MV3 service worker owns no loops").
 *
 * It still owns the observation database (`record`/`summary`/`counts`,
 * ported from milestone 1's `background.js`) because the extension's own
 * origin survives a clear of ea.com's site data — that part of milestone 1
 * is unchanged, just typed and merged into this larger message router.
 */
import {
  backgroundMessageEnvelopeSchemaFor,
  extBackgroundEngineLockPayloadSchema,
  extBackgroundEngineStatePayloadSchema,
  extBackgroundBotBudgetSetPayloadSchema,
  extBackgroundBotModeSetPayloadSchema,
  extBackgroundBotGallerySetPayloadSchema,
  extBackgroundBotSettingsSetPayloadSchema,
  extBackgroundBotUsageSetPayloadSchema,
  extBackgroundCardNamesPayloadSchema,
  extBackgroundCatalogSavePayloadSchema,
  extBackgroundEngineStateSetPayloadSchema,
  extBackgroundFiltersSavePayloadSchema,
  extBackgroundFutbinPricePayloadSchema,
  extBackgroundFutggLineupPayloadSchema,
  extBackgroundLicenseHeartbeatPayloadSchema,
  extBackgroundLifecycleBuyPayloadSchema,
  extBackgroundLifecyclePilePayloadSchema,
  extBackgroundLoginPayloadSchema,
  extBackgroundLogoutPayloadSchema,
  extBackgroundRecordPayloadSchema,
  extBackgroundRegisterPayloadSchema,
  extBackgroundResendVerificationPayloadSchema,
  extBackgroundSummaryPayloadSchema,
  extBackgroundTelemetryEnqueuePayloadSchema,
  mfaVerifyRequestSchema,
  putRecentSearchesRequestSchema,
  updateUserSettingsRequestSchema,
} from '@sl/shared';
import browser from 'webextension-polyfill';

import { refreshOnStartup } from '../lib/auth.js';
import { logger } from '../lib/logger.js';
import { recentMarketPrice } from '../model/market-price.js';
import { margin, maxSnipePrice, summarise } from '../model/prices.js';
import * as db from '../store/db.js';

import { handleAuthLogin, handleAuthLogout, handleAuthMfaVerify, handleAuthRegister, handleAuthResendVerification, handleAuthStatus } from './auth.js';
import {
  handleBotBudgetGet,
  handleBotBudgetSet,
  handleBotGalleryGet,
  handleBotGallerySet,
  handleBotModeGet,
  handleBotModeSet,
  handleBotSettingsGet,
  handleBotSettingsSet,
  handleBotUsageGet,
  handleBotUsageSet,
  handleCardNames,
  handleCatalogGet,
  handleCatalogSave,
} from './bot.js';
import {
  handleEngineLockAcquire,
  handleEngineLockRelease,
  handleEngineResetSession,
  handleEngineState,
} from './engine-lease.js';
import { installGlobalErrorHandlers, handleErrorsReport, ensureErrorFlushAlarm, onErrorFlushAlarm } from './errors.js';
import { handleFutbinPrice } from './futbin.js';
import { handleFutggLineup, handleFutggSets } from './futgg.js';
import { handleEngineStateGet, handleEngineStateSet } from './governor.js';
import { handleKillSwitchGet } from './kill-switch.js';
import { ensureHeartbeatAlarm, handleLicenseBootstrap, handleLicenseHeartbeat, onHeartbeatAlarm, runBootstrap } from './license.js';
import {
  BOT_START_SEED_MAX_AGE_MS,
  ensureLifecycleSeedAlarm,
  handleLifecycleBuy,
  handleLifecyclePile,
  handleLifecycleSessionPnl,
  handleLifecycleCosts,
  handleLifecycleStats,
  handleLifecycleTodayPnl,
  LIFECYCLE_SEED_ALARM,
  onLifecycleSeedAlarm,
  retryUnreportedSales,
  seedOpenTrades,
} from './lifecycle.js';
import { handleRecentSearchesGet, handleRecentSearchesSet } from './recent-searches.js';
import {
  handleDevicesList,
  handleFiltersList,
  handleFiltersSave,
  handleLogsExport,
  handleSettingsGet,
  handleSettingsSet,
} from './settings.js';
import { ensureFlushAlarm, handleTelemetryEnqueue, handleTelemetryFlush, onFlushAlarm } from './telemetry.js';
import { installUpdateHandler } from './update.js';
import { installWelcomeHandler } from './welcome.js';


import type { BackgroundResponse } from '@sl/shared';
import type { Runtime } from 'webextension-polyfill';

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // a week of history per card

/** Automation builds only: the Sniping Bot's handlers below. The listable
 * `ledger` build registers none of them (constant-folded at build time, so
 * `background/bot.ts` and these message names never enter its bundle —
 * test/unit/ledger-build-adapter.test.ts greps for them). */
const AUTOMATION_ENABLED = import.meta.env.VITE_AUTOMATION === '1';

type Handler = (payload: unknown) => Promise<unknown>;

const handlers: Record<string, Handler> = {
  async record(payload) {
    const { auctions } = payload as { auctions: Parameters<typeof db.recordSightings>[0] };
    return db.recordSightings(auctions);
  },

  async summary(payload) {
    const { resourceId, minProfit } = payload as { resourceId: number; minProfit?: number };
    const rows = await db.auctionsForResource(resourceId, WINDOW_MS);
    const s = summarise(rows);
    return {
      resourceId,
      summary: s,
      margin: s.floor == null ? null : margin(s, s.floor),
      maxSnipe: maxSnipePrice(s, minProfit || 1000),
      // What the card sells for now (model/market-price.ts), for Nova AI.
      market: recentMarketPrice(rows),
    };
  },

  async counts() {
    return db.counts();
  },

  'auth.login': (payload) => handleAuthLogin(payload as never),
  'auth.register': (payload) => handleAuthRegister(payload as never),
  'auth.resendVerification': (payload) => handleAuthResendVerification(payload as never),
  'auth.mfa': (payload) => handleAuthMfaVerify(payload as never),
  'auth.logout': (payload) => handleAuthLogout(payload as never),
  'auth.refresh': async () => ({ ok: true }), // refresh is transparent (lib/api.ts's interceptor); exposed for the popup's manual "retry" button
  'auth.status': () => handleAuthStatus(),

  'license.bootstrap': () => handleLicenseBootstrap(),
  'license.heartbeat': (payload) => handleLicenseHeartbeat((payload as { engineState: 'idle' | 'running' | 'paused' | 'halted' }).engineState),
  'license.killSwitchGet': () => handleKillSwitchGet(),

  'settings.get': () => handleSettingsGet(),
  'settings.set': (payload) => handleSettingsSet(payload as never),

  'filters.list': () => handleFiltersList(),
  'filters.save': (payload) => handleFiltersSave((payload as { filters: Parameters<typeof handleFiltersSave>[0] }).filters),

  'devices.list': () => handleDevicesList(),
  'logs.export': async () => handleLogsExport(),

  'telemetry.enqueue': async (payload) => handleTelemetryEnqueue(payload as never),
  'telemetry.flush': () => handleTelemetryFlush(),

  'errors.report': () => handleErrorsReport(),


  'engine.stateSet': (payload) => handleEngineStateSet(payload as never),
  'engine.stateGet': () => handleEngineStateGet(),

  'lifecycle.buy': (payload) => handleLifecycleBuy(payload as never),
  'lifecycle.pile': (payload) => handleLifecyclePile(payload as never),
  'lifecycle.costs': (payload) => handleLifecycleCosts(payload as never),
  'lifecycle.sessionPnl': () => handleLifecycleSessionPnl(),
  'lifecycle.stats': () => handleLifecycleStats(),
  'lifecycle.todayPnl': () => handleLifecycleTodayPnl(),

  // The per-profile engine lease and the live engine state (P0 Task 13,
  // background/engine-lease.ts), and the popup's "New session".
  'engine.lockAcquire': (payload) => handleEngineLockAcquire(payload as never),
  'engine.lockRelease': (payload) => handleEngineLockRelease(payload as never),
  'engine.state': async (payload) => {
    const result = await handleEngineState(payload as never);
    // The bot (or the autobuyer) just started: follow the cards the account
    // bought in other browsers too (background/lifecycle.ts).
    if (result.started) void seedOpenTrades(BOT_START_SEED_MAX_AGE_MS);
    return result;
  },
  'engine.resetSession': () => handleEngineResetSession(),

};

// The Sniping Bot page's handlers (@sl/shared `AUTOMATION_BACKGROUND_MESSAGE_TYPES`).
if (AUTOMATION_ENABLED) {
  Object.assign(handlers, {
    'bot.settingsGet': () => handleBotSettingsGet(),
    'bot.settingsSet': (payload) => handleBotSettingsSet(payload as never),
    'bot.modeGet': () => handleBotModeGet(),
    'bot.modeSet': (payload) => handleBotModeSet(payload as never),
    'bot.galleryGet': () => handleBotGalleryGet(),
    'bot.gallerySet': (payload) => handleBotGallerySet(payload as never),
    'bot.usageGet': () => handleBotUsageGet(),
    'bot.usageSet': (payload) => handleBotUsageSet(payload as never),
    'bot.budgetGet': () => handleBotBudgetGet(),
    'bot.budgetSet': (payload) => handleBotBudgetSet(payload as never),
    'cards.names': (payload) => handleCardNames((payload as { resourceIds: number[] }).resourceIds),
    'catalog.get': () => handleCatalogGet(),
    'catalog.save': (payload) => handleCatalogSave(payload as never),
    'price.futbin': (payload) => handleFutbinPrice(payload as never),
    'gallery.futggSets': () => handleFutggSets(),
    'gallery.futggLineup': (payload) => handleFutggLineup(payload as never),
    'recentSearches.get': () => handleRecentSearchesGet(),
    'recentSearches.set': (payload) => handleRecentSearchesSet(payload as never),
  } satisfies Record<string, Handler>);
}

/** The envelope accepts exactly the registered handlers' types. */
const envelopeSchema = backgroundMessageEnvelopeSchemaFor(Object.keys(handlers));

// Per-type payload validation (docs/09-security.md "Extension"): every
// handler that takes a payload now has a dedicated `@sl/shared` zod schema
// here — either the exact server-side request/DTO schema where the shape
// matches, or a purpose-built `extBackground*PayloadSchema`
// (`packages/shared/src/ext-messages.ts`) where it doesn't (e.g.
// `auth.login` carries no `device` field the way the server's
// `loginRequestSchema` does — the fingerprint is computed inside
// `background/auth.ts` itself). A handler with no payload (`auth.refresh`,
// `auth.status`, `license.bootstrap`, `settings.get`, `filters.list`,
// `devices.list`, `logs.export`, `telemetry.flush`, `errors.report`,
// `engine.stateGet`, `license.killSwitchGet`, `engine.resetSession`,
// `lifecycle.todayPnl`, `counts`) has nothing to validate and is deliberately
// left out — every handler still gets the envelope-level check above plus
// the try/catch's crash safety net (an `async` handler's thrown `TypeError`
// from a malformed payload always becomes a rejected promise, never an
// uncaught exception in the service worker).
const payloadSchemas: Partial<Record<string, { safeParse: (v: unknown) => { success: boolean } }>> = {
  record: extBackgroundRecordPayloadSchema,
  summary: extBackgroundSummaryPayloadSchema,
  'auth.login': extBackgroundLoginPayloadSchema,
  'auth.register': extBackgroundRegisterPayloadSchema,
  'auth.resendVerification': extBackgroundResendVerificationPayloadSchema,
  'auth.mfa': mfaVerifyRequestSchema,
  'auth.logout': extBackgroundLogoutPayloadSchema,
  'license.heartbeat': extBackgroundLicenseHeartbeatPayloadSchema,
  'settings.set': updateUserSettingsRequestSchema,
  'filters.save': extBackgroundFiltersSavePayloadSchema,
  'telemetry.enqueue': extBackgroundTelemetryEnqueuePayloadSchema,
  'engine.stateSet': extBackgroundEngineStateSetPayloadSchema,
  'lifecycle.buy': extBackgroundLifecycleBuyPayloadSchema,
  'lifecycle.pile': extBackgroundLifecyclePilePayloadSchema,
  'engine.lockAcquire': extBackgroundEngineLockPayloadSchema,
  'engine.lockRelease': extBackgroundEngineLockPayloadSchema,
  'engine.state': extBackgroundEngineStatePayloadSchema,
};
if (AUTOMATION_ENABLED) {
  Object.assign(payloadSchemas, {
    'bot.settingsSet': extBackgroundBotSettingsSetPayloadSchema,
    'bot.modeSet': extBackgroundBotModeSetPayloadSchema,
    'bot.gallerySet': extBackgroundBotGallerySetPayloadSchema,
    'bot.usageSet': extBackgroundBotUsageSetPayloadSchema,
    'bot.budgetSet': extBackgroundBotBudgetSetPayloadSchema,
    'cards.names': extBackgroundCardNamesPayloadSchema,
    'catalog.save': extBackgroundCatalogSavePayloadSchema,
    'price.futbin': extBackgroundFutbinPricePayloadSchema,
    'gallery.futggLineup': extBackgroundFutggLineupPayloadSchema,
    'recentSearches.set': putRecentSearchesRequestSchema,
  });
}

// webextension-polyfill's promise-based `onMessage` API: a listener that
// returns a `Promise<unknown>` (rather than the raw MV3 callback +
// `return true` dance) resolves as the response. Any message type this
// router doesn't recognise is left for another listener by returning
// `undefined` synchronously.
browser.runtime.onMessage.addListener((message: unknown, sender: Runtime.MessageSender): Promise<BackgroundResponse> | undefined => {
  // Origin check (docs/09-security.md "Extension"): only ever act on a
  // message this exact extension install sent itself — `sender.id` is set
  // by the browser, not by the sender, so a content script cannot spoof it.
  // `externally_connectable` is never declared in the manifest, so in
  // practice no other extension/page can reach this listener at all; this
  // is defense in depth against that assumption ever quietly changing.
  if (sender.id !== browser.runtime.id) return undefined;

  const parsed = envelopeSchema.safeParse(message);
  if (!parsed.success) return undefined;
  const envelope = parsed.data;
  if (!Object.hasOwn(handlers, envelope.type)) return undefined;
  const handler = handlers[envelope.type];
  if (!handler) return undefined;
  const type = envelope.type;

  const payloadSchema = payloadSchemas[type];
  if (payloadSchema && !payloadSchema.safeParse(envelope.payload).success) {
    logger.warn(`rejected '${type}': payload failed schema validation`, 'background');
    return Promise.resolve({ ok: false, error: 'Invalid message payload.' });
  }

  return handler(envelope.payload)
    .then((data): BackgroundResponse => ({ ok: true, data }))
    .catch((err): BackgroundResponse => {
      logger.error(`handler '${type}' threw: ${String(err)}`, 'background');
      const code = (err as { code?: unknown })?.code;
      return { ok: false, error: String((err as Error)?.message ?? err), ...(typeof code === 'string' ? { code } : {}) };
    });
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'sl.license.heartbeat') {
    void onHeartbeatAlarm();
    // A sale that could not be queued (signed out, say) is retried here.
    void retryUnreportedSales();
  }
  else if (alarm.name === 'sl.telemetry.flush') void onFlushAlarm();
  else if (alarm.name === 'sl.errors.flush') void onErrorFlushAlarm();
  else if (alarm.name === LIFECYCLE_SEED_ALARM) void onLifecycleSeedAlarm();
});

function startAlarms(): void {
  ensureHeartbeatAlarm();
  ensureFlushAlarm();
  ensureErrorFlushAlarm();
  ensureLifecycleSeedAlarm();
}

installGlobalErrorHandlers();
installUpdateHandler();
installWelcomeHandler();
startAlarms();
// A cold-started service worker (MV3 kills it after ~30s idle, per rule 5)
// re-bootstraps on every wake rather than assuming any in-memory state
// survived — `runBootstrap` itself is a no-op if not authenticated or if
// the cache is still fresh (`background/license.ts`).
//
// A browser restart cleared the access token (`storage.session`) but not the
// refresh token: one refresh first (lib/auth.ts `refreshOnStartup`), so the
// bootstrap — and every tab asking `auth.status` meanwhile — sees the
// account that is still signed in.
refreshOnStartup()
  .then(() => runBootstrap())
  // Then, signed in, the account's open trades: cards bought in another
  // browser are followed here too (background/lifecycle.ts). A no-op when
  // signed out, or when this browser session read them in the last 15 min.
  .then(() => void seedOpenTrades())
  .catch((err) => logger.warn(`startup bootstrap failed: ${String(err)}`, 'background'));
