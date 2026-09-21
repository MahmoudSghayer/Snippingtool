/*
 * popup/main.ts — status, login/2FA form, plan/license summary, telemetry
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

import { send } from '../lib/bg-client.js';

import type { RiskSnapshot } from '../engine/governor.js';
import type { BootstrapResponse, LoginResponse, RegisterResponse, UserSettings } from '@sl/shared';
// Type-only: engine/governor.ts is automation-surface code, but a `type`
// import is fully erased at compile time (no runtime code, nothing for a
// bundler to pull in) — see extBackgroundGovernorSnapshotPushPayloadSchema's
// own comment in packages/shared/src/ext-messages.ts for why the *runtime*
// shape is duplicated there instead of imported the same way.

const coins = (n: number): string => Math.round(n).toLocaleString('en-US');

const app = document.getElementById('app') as HTMLDivElement;

function h(html: string): void {
  app.innerHTML = html;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

async function renderLoggedOut(error?: string): Promise<void> {
  h(`
    <h1><span class="dot"></span> Sniper's Ledger</h1>
    ${error ? `<div class="error">${esc(error)}</div>` : ''}
    <input id="email" type="email" placeholder="Email" autocomplete="username" />
    <input id="password" type="password" placeholder="Password" autocomplete="current-password" />
    <button id="login">Sign in</button>
    <p style="text-align:center;margin-top:10px;">
      <button class="link" id="register-link">Create an account</button>
    </p>
  `);
  document.getElementById('login')?.addEventListener('click', onLoginSubmit);
  document.getElementById('register-link')?.addEventListener('click', () => void renderRegister());
}

async function renderRegister(error?: string): Promise<void> {
  h(`
    <h1><span class="dot"></span> Sniper's Ledger</h1>
    ${error ? `<div class="error">${esc(error)}</div>` : ''}
    <input id="email" type="email" placeholder="Email" autocomplete="username" />
    <input id="password" type="password" placeholder="Password (12+ chars)" autocomplete="new-password" />
    <button id="register">Create account</button>
    <p style="text-align:center;margin-top:10px;">
      <button class="link" id="back-link">Back to sign in</button>
    </p>
  `);
  document.getElementById('register')?.addEventListener('click', onRegisterSubmit);
  document.getElementById('back-link')?.addEventListener('click', () => void renderLoggedOut());
}

/** Defect #3 fix (docs/12-testing.md "Defects found"): `POST /auth/register`
 * never returns tokens — the account needs email verification before login
 * works (docs/03-api.md §"auth"). Registering used to fall straight into
 * `renderLoggedIn()`, which called `license.bootstrap` with no access token
 * and silently broke. This renders an explicit "check your email" state
 * instead, with a resend action, and a way back to the (now-usable, once
 * verified) sign-in form. */
function renderCheckEmail(email: string, notice?: string): void {
  h(`
    <h1><span class="dot warn"></span> Verify your email</h1>
    <p style="color:var(--muted)">We sent a verification link to <strong>${esc(email)}</strong>. Open it, then sign in below.</p>
    ${notice ? `<div class="hint">${esc(notice)}</div>` : ''}
    <button class="secondary" id="resend">Resend verification email</button>
    <p style="text-align:center;margin-top:10px;">
      <button class="link" id="to-login">Back to sign in</button>
    </p>
  `);
  document.getElementById('resend')?.addEventListener('click', async () => {
    const btn = document.getElementById('resend') as HTMLButtonElement;
    btn.disabled = true;
    try {
      await send('auth.resendVerification', { email });
      renderCheckEmail(email, 'Verification email sent.');
    } catch (err) {
      renderCheckEmail(email, err instanceof Error ? err.message : 'Could not resend — try again shortly.');
    }
  });
  document.getElementById('to-login')?.addEventListener('click', () => void renderLoggedOut());
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

function renderMfa(mfaTicket: string): void {
  h(`
    <h1><span class="dot warn"></span> Verify it's you</h1>
    <p style="color:var(--muted)">Enter the 6-digit code from your authenticator app.</p>
    <input id="code" inputmode="numeric" placeholder="123456" />
    <button id="verify">Verify</button>
  `);
  document.getElementById('verify')?.addEventListener('click', async () => {
    const code = (document.getElementById('code') as HTMLInputElement).value.trim();
    try {
      await send<LoginResponse>('auth.mfa', { mfaTicket, code });
      await renderLoggedIn();
    } catch (err) {
      renderMfa(mfaTicket);
      const el = document.createElement('div');
      el.className = 'error';
      el.textContent = err instanceof Error ? err.message : 'Verification failed';
      app.prepend(el);
    }
  });
}

async function onLoginSubmit(): Promise<void> {
  const email = (document.getElementById('email') as HTMLInputElement).value.trim();
  const password = (document.getElementById('password') as HTMLInputElement).value;
  try {
    const result = await send<LoginResponse>('auth.login', { email, password });
    if (result?.status === 'mfa_required') renderMfa(result.mfaTicket);
    else await renderLoggedIn();
  } catch (err) {
    await renderLoggedOut(err instanceof Error ? err.message : 'Sign-in failed');
  }
}

async function onRegisterSubmit(): Promise<void> {
  const email = (document.getElementById('email') as HTMLInputElement).value.trim();
  const password = (document.getElementById('password') as HTMLInputElement).value;
  try {
    await send<RegisterResponse>('auth.register', { email, password });
    // No tokens are issued at register time — render the verify-email
    // state instead of assuming a session exists (defect #3).
    renderCheckEmail(email);
  } catch (err) {
    await renderRegister(err instanceof Error ? err.message : 'Registration failed');
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
    <h1><span class="dot ${killSwitch ? 'risk' : 'live'}"></span> Sniper's Ledger</h1>
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

  document.getElementById('telemetry-toggle')?.addEventListener('click', async () => {
    await send('settings.set', { telemetryOptOut: !optedOut });
    await renderLoggedIn();
  });
  document.getElementById('options-link')?.addEventListener('click', () => browser.runtime.openOptionsPage());
  document.getElementById('logout')?.addEventListener('click', async () => {
    await send('auth.logout', { allDevices: false });
    await renderLoggedOut();
  });
}

async function boot(): Promise<void> {
  const status = await send<{ authenticated: boolean }>('auth.status');
  if (status?.authenticated) await renderLoggedIn();
  else await renderLoggedOut();
}

void boot();
