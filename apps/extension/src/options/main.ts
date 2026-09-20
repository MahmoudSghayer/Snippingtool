/*
 * options/main.ts — saved filters editor, budgets/governor thresholds
 * (clamped to `GOVERNOR_ABSOLUTE_LIMITS`), devices list, telemetry opt-out +
 * "What it sends", logs export, account/license info. Vanilla TS, same
 * reasoning as `popup/main.ts`.
 */
import {
  GOVERNOR_ABSOLUTE_LIMITS,
  type BootstrapResponse,
  type DeviceDto,
  type SavedFilter,
  type UserSettings,
} from '@sl/shared';

import { send } from '../lib/bg-client.js';

const app = document.getElementById('app') as HTMLDivElement;

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function toast(message: string): void {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

const WHAT_IT_SENDS = [
  'Login/logout, search metadata (a hash of the filter + result count — never the listings), filter changes, settings changes, errors and periodic heartbeats.',
  'Snipe attempt outcomes: resource/trade id, target and listed price, outcome, latency — never anything beyond what the app’s own UI already showed you.',
  'Trades and profit/loss, computed entirely on this device by the price model.',
  'Saved-filter performance stats (realised coins/hour) so the ranker survives a reinstall.',
  'Risk-budget events — what the safety governor allowed or blocked, and why.',
  'Extension version, install id and error reports (message + stack, never your input).',
  'Raw market listings NEVER leave this browser — they stay in this extension’s own IndexedDB. Turning telemetry off still allows the license heartbeat (install id + version + a device fingerprint hash only, no product data).',
];

async function render(): Promise<void> {
  const [settings, filters, devices, bootstrap] = await Promise.all([
    send<UserSettings>('settings.get'),
    send<SavedFilter[]>('filters.list'),
    send<DeviceDto[]>('devices.list'),
    send<BootstrapResponse>('license.bootstrap'),
  ]);

  const s: UserSettings =
    settings ?? {
      version: 0,
      targets: { minProfitPerSnipe: 1000, dailyProfitGoal: null },
      budgets: { maxCoinsPerSnipe: 200_000, sessionCoinBudget: null },
      governor: { actionsPerHour: 30, sessionLengthMinutes: 90, buyToSearchRatio: 0.35, cooldownSeconds: 20, maxCoinFlowPerHour: 300_000 },
      telemetryOptOut: false,
      notifications: { email: true, push: false, killSwitch: true, subscriptionChanges: true, weeklyDigest: false },
    };
  const filterList = filters ?? [];

  app.innerHTML = `
    <h1>Sniper's Ledger — Settings</h1>
    <p class="sub">Everything here applies immediately; budgets and governor thresholds are clamped to the bounds your plan allows.</p>

    <section id="account">
      <h2>Account &amp; license</h2>
      ${
        bootstrap
          ? `<table>
              <tr><td>Plan</td><td>${esc(bootstrap.subscription?.plan.name ?? '—')}</td></tr>
              <tr><td>License</td><td>${esc(bootstrap.license?.keyPrefix ?? '—')} (${esc(bootstrap.license?.status ?? '—')})</td></tr>
              <tr><td>Devices allowed</td><td>${bootstrap.license?.maxDevices ?? '—'}</td></tr>
              <tr><td>Kill switch</td><td>${bootstrap.killSwitchActive ? 'ACTIVE — all actions blocked' : 'inactive'}</td></tr>
            </table>`
          : `<p class="hint">Sign in from the toolbar popup to see your plan and license.</p>`
      }
    </section>

    <section id="targets">
      <h2>Targets &amp; budgets</h2>
      <label>Minimum profit per snipe (coins)</label>
      <input id="minProfit" type="number" min="0" value="${s.targets.minProfitPerSnipe}" />
      <label>Max coins per snipe</label>
      <input id="maxCoinsPerSnipe" type="number" min="0" value="${s.budgets.maxCoinsPerSnipe}" />
      <label>Session coin budget (blank = no cap)</label>
      <input id="sessionCoinBudget" type="number" min="0" value="${s.budgets.sessionCoinBudget ?? ''}" />
      <button id="save-targets">Save</button>
    </section>

    <section id="governor">
      <h2>Governor thresholds</h2>
      <p class="hint">These are the safety budget's own limits — you can tighten them, never loosen them past your plan's ceiling.</p>
      ${governorField('actionsPerHour', 'Actions per hour', s.governor.actionsPerHour)}
      ${governorField('sessionLengthMinutes', 'Session length (minutes)', s.governor.sessionLengthMinutes)}
      ${governorField('buyToSearchRatio', 'Buy / search ratio', s.governor.buyToSearchRatio, 0.01)}
      ${governorField('cooldownSeconds', 'Cooldown after a hard stop (seconds)', s.governor.cooldownSeconds)}
      ${governorField('maxCoinFlowPerHour', 'Max coin flow per hour', s.governor.maxCoinFlowPerHour)}
      <button id="save-governor">Save</button>
    </section>

    <section id="filters">
      <h2>Saved filters</h2>
      <table>
        <thead><tr><th>Name</th><th>Min rating</th><th>Max price</th><th>Active</th><th></th></tr></thead>
        <tbody>
          ${filterList
            .map(
              (f, i) => `<tr>
                <td>${esc(f.name)}</td>
                <td>${f.filter.minRating ?? '—'}</td>
                <td>${f.filter.maxPrice ?? '—'}</td>
                <td>${f.isActive ? 'yes' : 'no'}</td>
                <td><button class="secondary" data-remove="${i}">Remove</button></td>
              </tr>`,
            )
            .join('')}
        </tbody>
      </table>
      <label>New filter name</label>
      <input id="new-filter-name" placeholder="e.g. 83-84 rated fodder" />
      <label>Min rating</label>
      <input id="new-filter-min-rating" type="number" min="0" max="99" />
      <label>Max price</label>
      <input id="new-filter-max-price" type="number" min="0" />
      <button id="add-filter">Add filter</button>
    </section>

    <section id="devices">
      <h2>Devices</h2>
      <table>
        <thead><tr><th>Name</th><th>Browser / OS</th><th>Last seen</th><th>Status</th></tr></thead>
        <tbody>
          ${
            (devices ?? []).length
              ? (devices ?? [])
                  .map(
                    (d) =>
                      `<tr><td>${esc(d.name ?? d.id.slice(0, 8))}${d.isCurrent ? ' (this device)' : ''}</td><td>${esc(d.browser ?? '—')} / ${esc(d.os ?? '—')}</td><td>${new Date(d.lastSeenAt).toLocaleString()}</td><td>${d.status}</td></tr>`,
                  )
                  .join('')
              : `<tr><td colspan="4" class="hint">No devices yet — sign in to register this one.</td></tr>`
          }
        </tbody>
      </table>
    </section>

    <section id="telemetry">
      <h2>Telemetry</h2>
      <label style="display:flex;align-items:center;gap:8px;">
        <input id="telemetry-optout" type="checkbox" ${s.telemetryOptOut ? 'checked' : ''} />
        Opt out of product telemetry
      </label>
      <p class="hint">The license heartbeat (install id + version + a device fingerprint hash) is not affected by this toggle.</p>
      <h2 style="margin-top:18px;">What it sends</h2>
      <ul class="sends-list">${WHAT_IT_SENDS.map((line) => `<li>${line}</li>`).join('')}</ul>
    </section>

    <section id="logs">
      <h2>Diagnostics</h2>
      <button class="secondary" id="export-logs">Export logs</button>
    </section>
  `;

  document.getElementById('save-targets')?.addEventListener('click', async () => {
    const minProfitPerSnipe = Number((document.getElementById('minProfit') as HTMLInputElement).value);
    const maxCoinsPerSnipe = Number((document.getElementById('maxCoinsPerSnipe') as HTMLInputElement).value);
    const sessionCoinBudgetRaw = (document.getElementById('sessionCoinBudget') as HTMLInputElement).value;
    try {
      await send('settings.set', {
        targets: { minProfitPerSnipe },
        budgets: { maxCoinsPerSnipe, sessionCoinBudget: sessionCoinBudgetRaw === '' ? null : Number(sessionCoinBudgetRaw) },
      });
      toast('Saved.');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Save failed');
    }
  });

  document.getElementById('save-governor')?.addEventListener('click', async () => {
    const read = (id: string) => Number((document.getElementById(id) as HTMLInputElement).value);
    try {
      await send('settings.set', {
        governor: {
          actionsPerHour: read('actionsPerHour'),
          sessionLengthMinutes: read('sessionLengthMinutes'),
          buyToSearchRatio: read('buyToSearchRatio'),
          cooldownSeconds: read('cooldownSeconds'),
          maxCoinFlowPerHour: read('maxCoinFlowPerHour'),
        },
      });
      toast('Saved.');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Save failed');
    }
  });

  document.getElementById('add-filter')?.addEventListener('click', async () => {
    const name = (document.getElementById('new-filter-name') as HTMLInputElement).value.trim();
    if (!name) return;
    const minRating = (document.getElementById('new-filter-min-rating') as HTMLInputElement).value;
    const maxPrice = (document.getElementById('new-filter-max-price') as HTMLInputElement).value;
    const filter: SavedFilter = {
      id: crypto.randomUUID(),
      name,
      filter: { minRating: minRating ? Number(minRating) : undefined, maxPrice: maxPrice ? Number(maxPrice) : undefined },
      filterHash: await hashFilter(name + minRating + maxPrice),
      isActive: true,
      sortOrder: filterList.length,
      createdAt: new Date().toISOString(),
    };
    await send('filters.save', { filters: [...filterList, filter] });
    void render();
  });

  app.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = Number(btn.dataset.remove);
      const next = filterList.filter((_, i) => i !== idx);
      await send('filters.save', { filters: next });
      void render();
    });
  });

  document.getElementById('telemetry-optout')?.addEventListener('change', async (e) => {
    await send('settings.set', { telemetryOptOut: (e.target as HTMLInputElement).checked });
    toast('Saved.');
  });

  document.getElementById('export-logs')?.addEventListener('click', async () => {
    const logs = (await send('logs.export')) ?? [];
    const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sniper-ledger-logs-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

function governorField(id: string, label: string, value: number, step = 1): string {
  const bounds = (GOVERNOR_ABSOLUTE_LIMITS as Record<string, { min: number; max: number }>)[id] ?? { min: 0, max: value };
  return `
    <label>${label} (${bounds.min}–${bounds.max})</label>
    <input id="${id}" type="number" min="${bounds.min}" max="${bounds.max}" step="${step}" value="${value}" />
  `;
}

async function hashFilter(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

void render();
