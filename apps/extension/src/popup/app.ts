/*
 * popup/app.ts — the Nova Trade account view: sign in (with 2FA), then the
 * plan, the usage-data switch and a Sign out button. The tool itself opens from the "Nova AI" item
 * in the EA web app's left menu. Vanilla TS (no framework — the popup is
 * small enough that a dependency would cost more than it saves, see
 * docs/06-extension.md).
 */
import browser from 'webextension-polyfill';

import { BackgroundError, send } from '../lib/bg-client.js';
import { onTrusted } from '../ui/trusted-events.js';

import type { BootstrapResponse, LoginResponse, SubscriptionStatus, UserSettings } from '@sl/shared';

let app: HTMLElement;

const DASHBOARD_ORIGIN = (import.meta.env.VITE_DASHBOARD_ORIGIN ?? '').replace(/\/$/, '');
// The listable (`ledger`) build carries no automation code at all — the
// bundle must not even name the feature (test/unit/ledger-build-adapter.ts
// greps dist/ledger for "Nova AI"), so every mention of it here is gated.
const AUTOMATION_ENABLED = import.meta.env.VITE_AUTOMATION === '1';

/** False on a web page (the userscript's drawer on ea.com): the browser's
 * password manager would offer that site's saved login — the user's EA
 * password — for these fields. The extension popup has its own origin, where
 * autofill of the Nova Trade login is exactly what the user wants. */
let allowAutofill = true;

/** Looks up an element inside whatever root the page was mounted into:
 * `#app` in the extension's popup, or a shadow root on the EA
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

const STATUS_LABEL: Record<SubscriptionStatus, string> = {
  trialing: 'Free trial',
  active: 'Active',
  past_due: 'Payment due',
  canceled: 'Cancelled',
  suspended: 'Suspended',
  expired: 'Expired',
  lifetime: 'Lifetime',
};

/** Opens a page of the website in a new tab (and closes the toolbar popup). */
async function openDashboard(path: string): Promise<void> {
  if (!DASHBOARD_ORIGIN) return;
  await browser.tabs.create({ url: `${DASHBOARD_ORIGIN}${path}` });
  if (import.meta.env.VITE_BUILD_TARGET !== 'userscript') window.close();
}

async function renderLoggedIn(): Promise<void> {
  const [bootstrap, settings] = await Promise.all([
    send<BootstrapResponse>('license.bootstrap'),
    send<UserSettings>('settings.get'),
  ]);
  const sharing = !(settings?.telemetryOptOut ?? false);
  const sub = bootstrap?.subscription ?? null;
  const killSwitch = bootstrap?.killSwitchActive ?? false;
  const usable = sub != null && ['trialing', 'active', 'lifetime'].includes(sub.status);

  h(`
    <h1><span class="dot ${killSwitch ? 'risk' : usable ? 'live' : 'warn'}"></span> Nova Trade</h1>
    <div class="card">
      ${bootstrap?.email ? `<div class="row"><span class="k">Email</span><span class="v">${esc(bootstrap.email)}</span></div>` : ''}
      <div class="row"><span class="k">Plan</span><span class="v">${esc(sub?.plan.name ?? 'No plan')}</span></div>
      ${sub ? `<div class="row"><span class="k">Status</span><span class="v">${esc(STATUS_LABEL[sub.status])}</span></div>` : ''}
      ${
        usable || !DASHBOARD_ORIGIN
          ? ''
          : `<button class="link" id="plan-link">${sub ? 'Renew on the website' : 'Get a pass on the website'}</button>`
      }
      ${killSwitch && AUTOMATION_ENABLED ? '<div class="error">Nova AI is paused by Nova Trade. All actions are blocked.</div>' : ''}
    </div>
    <div class="card switch-row">
      <div>
        <div id="share-label">Share usage data</div>
        <p class="hint" id="share-help">Anonymous usage stats that help improve Nova Trade. No personal data.</p>
      </div>
      <button type="button" class="switch" id="share-usage" role="switch" aria-checked="${sharing}"
        aria-labelledby="share-label" aria-describedby="share-help"></button>
    </div>
    ${AUTOMATION_ENABLED ? '<p class="hint">Open Nova AI from the left menu in the EA web app.</p>' : ''}
    <button class="secondary" id="logout">Sign out</button>
  `);

  onTrustedById('share-usage', 'click', async () => {
    await send('settings.set', { telemetryOptOut: sharing });
    await renderLoggedIn();
  });
  onTrustedById('plan-link', 'click', () => void openDashboard('/account'));
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
