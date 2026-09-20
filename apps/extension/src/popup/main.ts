/*
 * popup/main.ts — status, login/2FA form, current card, risk meter, quick
 * toggles. Vanilla TS (no framework — the popup is small enough that a
 * dependency would cost more than it saves, see docs/06-extension.md).
 */
import type { BootstrapResponse, LoginResponse, UserSettings } from '@sl/shared';
import browser from 'webextension-polyfill';

import { send } from '../lib/bg-client.js';

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
    await send<LoginResponse>('auth.register', { email, password });
    await renderLoggedIn();
  } catch (err) {
    await renderRegister(err instanceof Error ? err.message : 'Registration failed');
  }
}

async function renderLoggedIn(): Promise<void> {
  const [bootstrap, settings, counts] = await Promise.all([
    send<BootstrapResponse>('license.bootstrap'),
    send<UserSettings>('settings.get'),
    send<{ auctions: number; playersLast24h: number }>('counts'),
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
