/*
 * popup/app.ts — status, login/2FA form, plan/license summary, telemetry
 * toggle, quick links. Vanilla TS (no framework — the popup is small enough
 * that a dependency would cost more than it saves, see
 * docs/06-extension.md).
 *
 * The *live* risk budget meter (docs/10-design-system.md §15's former
 * "Known gap", docs/12-testing.md "Defects found"): the governor itself
 * still only ever runs inside the content script attached to the active EA
 * tab, so this file never recomputes or reconstructs the numbers — it asks
 * `background/governor.ts` for whatever `content/index.ts` most recently
 * pushed it (`governor.snapshotGet`, a real message handler, addressing
 * what this comment used to call out as file-ownership-boundary future
 * work) and renders the exact segmented gauge `ui/panel.ts` does
 * (`riskGaugeHtml`/`meterHtml` below mirror its `meterClass`/`setMeter`).
 * If no EA tab has reported a snapshot recently, this shows an honest
 * "no live EA tab" message instead of a fabricated number (see
 * `renderLoggedIn`'s "Risk budget" card).
 */
import browser from 'webextension-polyfill';

import { BackgroundError, send } from '../lib/bg-client.js';
import { onTrusted } from '../ui/trusted-events.js';

import type { RiskSnapshot } from '../engine/governor.js';
import type { BootstrapResponse, LoginResponse, UserSettings } from '@sl/shared';
// Type-only: engine/governor.ts is automation-surface code, but a `type`
// import is fully erased at compile time (no runtime code, nothing for a
// bundler to pull in) — see extBackgroundGovernorSnapshotPushPayloadSchema's
// own comment in packages/shared/src/ext-messages.ts for why the *runtime*
// shape is duplicated there instead of imported the same way.

const coins = (n: number): string => Math.round(n).toLocaleString('en-US');

let app: HTMLElement;

const DASHBOARD_ORIGIN = (import.meta.env.VITE_DASHBOARD_ORIGIN ?? '').replace(/\/$/, '');

/** False on a web page (the userscript's drawer on ea.com): the browser's
 * password manager would offer that site's saved login — the user's EA
 * password — for these fields. The extension popup has its own origin, where
 * autofill of the Nova Trade login is exactly what the user wants. */
let allowAutofill = true;

/** Looks up an element inside whatever root the page was mounted into:
 * `#app` in the extension's popup/options page, or a shadow root on the EA
 * page in the userscript build (`src/userscript/launcher.ts`). */
function byId(id: string): HTMLElement | null {
  return app.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
}

/** A user-action listener on `#id`, if it exists, that ignores script-made
 * events (ui/trusted-events.ts): in the userscript this page shares EA's
 * document with page scripts. */
function onTrustedById<K extends keyof HTMLElementEventMap>(
  id: string,
  type: K,
  handler: (event: HTMLElementEventMap[K]) => void,
): void {
  const el = byId(id);
  if (el) onTrusted(el, type, handler);
}

function h(html: string): void {
  app.innerHTML = html;
}

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

/** What went wrong with a sign-in step, in words that say what to do next.
 * Keyed on the API's error codes (`@sl/shared` ERROR_CODES); anything else
 * falls back to the server's own message. */
function authErrorMessage(err: unknown, fallback: string): string {
  const code = err instanceof BackgroundError ? err.code : undefined;
  const message = err instanceof Error && err.message ? err.message : '';
  switch (code) {
    case 'AUTH_INVALID_CREDENTIALS':
      return "Wrong email or password. Use your Nova Trade password (the one for the dashboard), not your EA password. After 5 wrong tries the account locks for 15 minutes.";
    case 'AUTH_ACCOUNT_LOCKED':
      return 'Your account is locked after too many wrong passwords. Wait 15 minutes, or reset your password on the dashboard.';
    case 'RATE_LIMITED':
      return 'Too many sign-in attempts. Wait 15 minutes, then try again.';
    case 'AUTH_EMAIL_NOT_VERIFIED':
      return 'Verify your email first: open the link we emailed you, then sign in.';
    case 'AUTH_MFA_INVALID':
      return "That code didn't work. Enter the current 6-digit code from your authenticator app.";
    case 'AUTH_TOKEN_INVALID':
    case 'AUTH_TOKEN_EXPIRED':
      return 'Your sign-in expired. Enter your password again.';
    case 'DEVICE_LIMIT_REACHED':
      return 'Your plan’s device limit is reached. Remove a device on the dashboard (Settings → Devices), then sign in.';
    case 'AUTH_SESSION_REVOKED':
      return 'This session was signed out. Sign in again.';
  }
  if (/network error|timed out|aborted|failed to fetch/i.test(message)) {
    return "Can't reach the Nova Trade server. Check your connection and try again.";
  }
  return message || fallback;
}

async function renderLoggedOut(error?: string, email = ''): Promise<void> {
  const [emailAc, passwordAc] = allowAutofill
    ? ['username', 'current-password']
    : ['off', 'new-password'];
  h(`
    <h1><span class="dot"></span> Nova Trade</h1>
    ${error ? `<div class="error" role="alert">${esc(error)}</div>` : ''}
    <form id="login-form" novalidate>
      <input id="email" type="email" placeholder="Email" aria-label="Email" autocomplete="${emailAc}" value="${esc(email)}" />
      <input id="password" type="password" placeholder="Nova Trade password" aria-label="Password" autocomplete="${passwordAc}" />
      <button id="login" type="submit">Sign in</button>
    </form>
    ${allowAutofill || error ? '' : '<p class="hint">Use your Nova Trade (dashboard) password, not your EA password.</p>'}
    <p style="text-align:center;margin-top:10px;">
      <button class="link" id="register-link">Create an account</button>
    </p>
  `);
  onTrustedById('login-form', 'submit', (e) => {
    e.preventDefault();
    void onLoginSubmit();
  });
  onTrustedById('register-link', 'click', () => void openDashboardRegister());
  (byId(email ? 'password' : 'email') as HTMLInputElement | null)?.focus();
}

/** Accounts are created on the website, not in the popup: registering
 * requires accepting the Terms of Service and Refund Policy, and the website
 * is where those are shown and accepted (`/register`). After verifying their
 * email, the user signs in here as usual. */
async function openDashboardRegister(): Promise<void> {
  if (!DASHBOARD_ORIGIN) {
    await renderLoggedOut('Create your account on the website, then sign in here.');
    return;
  }
  await browser.tabs.create({ url: `${DASHBOARD_ORIGIN}/register` });
  // The toolbar popup closes itself; the userscript's drawer lives on the EA
  // page, and closing that window would close EA.
  if (import.meta.env.VITE_BUILD_TARGET !== 'userscript') window.close();
}

/** Mirrors `ui/panel.ts`'s `meterClass`/`setMeter` exactly (same 80%/100%
 * bands, same clamping) so the popup's gauge and the in-page panel's read
 * identically for the same snapshot. */
function meterHtml(value: number, limit: number): string {
  const ratio = limit > 0 ? Math.min(1.2, value / limit) : 0;
  const cls = ratio >= 1 ? 'meter over' : ratio >= 0.8 ? 'meter high' : 'meter';
  const widthPct = Math.min(100, ratio * 100);
  return `<div class="${cls}"><i style="width:${widthPct}%"></i></div>`;
}

/** The real segmented risk gauge, fed by the live governor snapshot the
 * content script pushes to background (defect fix: docs/10-design-system.md
 * §15 "Known gap" — the popup previously always showed the static
 * "tracked live on the EA page" text, never real numbers). `snapshot` is
 * `null` when no EA tab has reported one recently (none open, or the cache
 * went stale) — the honest fallback for that case, never a fabricated or
 * reconstructed number. */
function riskGaugeHtml(snapshot: RiskSnapshot | null, killSwitch: boolean): string {
  if (killSwitch) {
    return `<div class="row"><span class="k">Risk budget</span><span class="v">Halted</span></div>`;
  }
  if (!snapshot) {
    return `
      <div class="row"><span class="k">Risk budget</span><span class="v">No live EA tab</span></div>
      <p class="hint" style="margin:6px 0 0;">Open the EA Web App in a tab while sniping to see actions/hour, buy:search ratio
        and coin flow live here — the panel on that page shows the same numbers.</p>
    `;
  }
  return `
    <div class="row"><span class="k">Actions this hour</span><span class="v">${snapshot.actionsLastHour} / ${snapshot.actionsPerHourLimit}</span></div>
    ${meterHtml(snapshot.actionsLastHour, snapshot.actionsPerHourLimit)}
    <div class="row" style="margin-top:8px;"><span class="k">Buy / search ratio</span><span class="v">${snapshot.buyToSearchRatio.toFixed(2)} / ${snapshot.buyToSearchRatioLimit.toFixed(2)}</span></div>
    ${meterHtml(snapshot.buyToSearchRatio, snapshot.buyToSearchRatioLimit)}
    <div class="row" style="margin-top:8px;"><span class="k">Coin flow / hour</span><span class="v">${coins(snapshot.coinFlowLastHour)} / ${coins(snapshot.coinFlowLimit)}</span></div>
    ${meterHtml(snapshot.coinFlowLastHour, snapshot.coinFlowLimit)}
    ${snapshot.inCooldown ? '<div class="hint" style="margin:6px 0 0;color:var(--sl-warning);">Cooldown active — actions paused briefly.</div>' : ''}
  `;
}

function renderMfa(mfaTicket: string, error?: string, email = ''): void {
  h(`
    <h1><span class="dot warn"></span> Verify it's you</h1>
    ${error ? `<div class="error" role="alert">${esc(error)}</div>` : ''}
    <p style="color:var(--muted)">Enter the 6-digit code from your authenticator app.</p>
    <form id="mfa-form" novalidate>
      <input id="code" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" aria-label="Authentication code" />
      <button id="verify" type="submit">Verify</button>
    </form>
  `);
  (byId('code') as HTMLInputElement | null)?.focus();
  onTrustedById('mfa-form', 'submit', async (e) => {
    e.preventDefault();
    const code = (byId('code') as HTMLInputElement).value.trim();
    if (!code) return renderMfa(mfaTicket, 'Enter the 6-digit code.', email);
    const button = byId('verify') as HTMLButtonElement;
    button.disabled = true;
    button.textContent = 'Verifying…';
    try {
      await send<LoginResponse>('auth.mfa', { mfaTicket, code });
      await renderLoggedIn();
    } catch (err) {
      const message = authErrorMessage(err, 'Verification failed');
      const code = err instanceof BackgroundError ? err.code : undefined;
      // A used or expired ticket cannot be retried: back to the password step.
      if (
        code === 'AUTH_TOKEN_INVALID' ||
        code === 'AUTH_TOKEN_EXPIRED' ||
        code === 'DEVICE_LIMIT_REACHED'
      ) {
        await renderLoggedOut(message, email);
      } else {
        renderMfa(mfaTicket, message, email);
      }
    }
  });
}

async function onLoginSubmit(): Promise<void> {
  const email = (byId('email') as HTMLInputElement).value.trim();
  const password = (byId('password') as HTMLInputElement).value;
  if (!email || !password) {
    await renderLoggedOut('Enter your email and password.', email);
    return;
  }
  const button = byId('login') as HTMLButtonElement;
  button.disabled = true;
  button.textContent = 'Signing in…';
  try {
    const result = await send<LoginResponse>('auth.login', { email, password });
    if (result == null)
      await renderLoggedOut(
        "Couldn't reach the extension's background — reload the page and try again.",
        email,
      );
    else if (result.status === 'mfa_required') renderMfa(result.mfaTicket, undefined, email);
    else await renderLoggedIn();
  } catch (err) {
    await renderLoggedOut(authErrorMessage(err, 'Sign-in failed'), email);
  }
}

async function renderLoggedIn(): Promise<void> {
  const [bootstrap, settings, counts, riskSnapshot] = await Promise.all([
    send<BootstrapResponse>('license.bootstrap'),
    send<UserSettings>('settings.get'),
    send<{ auctions: number; playersLast24h: number }>('counts'),
    send<RiskSnapshot | null>('governor.snapshotGet'),
  ]);

  const planName = bootstrap?.subscription?.plan.name ?? 'No active plan';
  const killSwitch = bootstrap?.killSwitchActive ?? false;
  const optedOut = settings?.telemetryOptOut ?? false;

  h(`
    <h1><span class="dot ${killSwitch ? 'risk' : 'live'}"></span> Nova Trade</h1>
    <div class="card">
      <div class="row"><span class="k">Plan</span><span class="v">${esc(planName)}</span></div>
      <div class="row"><span class="k">Auctions recorded</span><span class="v">${(counts?.auctions ?? 0).toLocaleString('en-US')}</span></div>
      <div class="row"><span class="k">Players seen today</span><span class="v">${(counts?.playersLast24h ?? 0).toLocaleString('en-US')}</span></div>
      ${killSwitch ? '<div class="error">Kill switch active — all actions are blocked.</div>' : ''}
    </div>
    <div class="card">
      <h4 style="margin:0 0 4px;font-size:13px;color:var(--sl-fg-muted);">Risk budget</h4>
      ${riskGaugeHtml(riskSnapshot ?? null, killSwitch)}
    </div>
    <div class="card toggle-row">
      <span>Telemetry</span>
      <button class="secondary" id="telemetry-toggle">${optedOut ? 'Opted out' : 'Sending'}</button>
    </div>
    <button class="secondary" id="options-link">Open settings</button>
    <button class="secondary" id="logout" style="margin-top:8px;">Sign out</button>
  `);

  onTrustedById('telemetry-toggle', 'click', async () => {
    await send('settings.set', { telemetryOptOut: !optedOut });
    await renderLoggedIn();
  });
  onTrustedById('options-link', 'click', () => browser.runtime.openOptionsPage());
  onTrustedById('logout', 'click', async () => {
    await send('auth.logout', { allDevices: false });
    await renderLoggedOut();
  });
}

async function boot(): Promise<void> {
  const status = await send<{ authenticated: boolean }>('auth.status');
  if (status?.authenticated) await renderLoggedIn();
  else await renderLoggedOut();
}

export function mountPopup(root: HTMLElement, opts: { allowAutofill?: boolean } = {}): void {
  app = root;
  allowAutofill = opts.allowAutofill ?? true;
  void boot();
}
