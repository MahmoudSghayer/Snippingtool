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
  backgroundMessageEnvelopeSchema,
  extBackgroundBotSettingsSetPayloadSchema,
  extBackgroundCardNamesPayloadSchema,
  extBackgroundEngineStateSetPayloadSchema,
  extBackgroundFiltersSavePayloadSchema,
  extBackgroundGovernorSnapshotPushPayloadSchema,
  extBackgroundLicenseHeartbeatPayloadSchema,
  extBackgroundLoginPayloadSchema,
  extBackgroundLogoutPayloadSchema,
  extBackgroundRecordPayloadSchema,
  extBackgroundRegisterPayloadSchema,
  extBackgroundResendVerificationPayloadSchema,
  extBackgroundSummaryPayloadSchema,
  extBackgroundTelemetryEnqueuePayloadSchema,
  mfaVerifyRequestSchema,
  updateUserSettingsRequestSchema,
} from '@sl/shared';
import browser from 'webextension-polyfill';

import { logger } from '../lib/logger.js';
import { margin, maxSnipePrice, summarise } from '../model/prices.js';
import * as db from '../store/db.js';

import { handleAuthLogin, handleAuthLogout, handleAuthMfaVerify, handleAuthRegister, handleAuthResendVerification, handleAuthStatus } from './auth.js';
import { handleBotSettingsGet, handleBotSettingsSet, handleCardNames } from './bot.js';
import { installGlobalErrorHandlers, handleErrorsReport, ensureErrorFlushAlarm, onErrorFlushAlarm } from './errors.js';
import { handleEngineStateGet, handleEngineStateSet, handleGovernorSnapshotGet, handleGovernorSnapshotPush } from './governor.js';
import { handleKillSwitchGet } from './kill-switch.js';
import { ensureHeartbeatAlarm, handleLicenseBootstrap, handleLicenseHeartbeat, onHeartbeatAlarm, runBootstrap } from './license.js';
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

  'governor.snapshotPush': (payload) => handleGovernorSnapshotPush(payload as never),
  'governor.snapshotGet': () => handleGovernorSnapshotGet(),

  'engine.stateSet': (payload) => handleEngineStateSet(payload as never),
  'engine.stateGet': () => handleEngineStateGet(),

  async 'engine.state'() {
    return { ok: true };
  },

  'bot.settingsGet': () => handleBotSettingsGet(),
  'bot.settingsSet': (payload) => handleBotSettingsSet(payload as never),
  'cards.names': (payload) => handleCardNames((payload as { resourceIds: number[] }).resourceIds),
};

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
// `governor.snapshotGet`, `engine.stateGet`, `license.killSwitchGet`, `engine.state`, `counts`) has nothing to validate and is deliberately
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
  'governor.snapshotPush': extBackgroundGovernorSnapshotPushPayloadSchema,
  'engine.stateSet': extBackgroundEngineStateSetPayloadSchema,
  'bot.settingsSet': extBackgroundBotSettingsSetPayloadSchema,
  'cards.names': extBackgroundCardNamesPayloadSchema,
};

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

  const parsed = backgroundMessageEnvelopeSchema.safeParse(message);
  if (!parsed.success) return undefined;
  const envelope = parsed.data;
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
      return { ok: false, error: String((err as Error)?.message ?? err) };
    });
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'sl.license.heartbeat') void onHeartbeatAlarm();
  else if (alarm.name === 'sl.telemetry.flush') void onFlushAlarm();
  else if (alarm.name === 'sl.errors.flush') void onErrorFlushAlarm();
});

function startAlarms(): void {
  ensureHeartbeatAlarm();
  ensureFlushAlarm();
  ensureErrorFlushAlarm();
}

installGlobalErrorHandlers();
installUpdateHandler();
installWelcomeHandler();
startAlarms();
// A cold-started service worker (MV3 kills it after ~30s idle, per rule 5)
// re-bootstraps on every wake rather than assuming any in-memory state
// survived — `runBootstrap` itself is a no-op if not authenticated or if
// the cache is still fresh (`background/license.ts`).
runBootstrap().catch((err) => logger.warn(`startup bootstrap failed: ${String(err)}`, 'background'));
