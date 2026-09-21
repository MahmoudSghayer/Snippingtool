/*
 * options/main.ts — saved filters editor, budgets/governor thresholds
 * (clamped to `GOVERNOR_ABSOLUTE_LIMITS`), devices list, telemetry opt-out +
 * "What it sends", logs export, account/license info. Vanilla TS, same
 * reasoning as `popup/main.ts`.
 */
import {
  budgetsSchema,
  governorSettingsSchema,
  GOVERNOR_ABSOLUTE_LIMITS,
  targetsSchema,
  type BootstrapResponse,
  type DeviceDto,
  type SavedFilter,
  type UserSettings,
} from '@sl/shared';

import { send } from '../lib/bg-client.js';

/** Structural, not `import type { ZodTypeAny } from 'zod'` — `zod` is a
 * transitive dependency (via `@sl/shared`), not one this package declares
 * directly, and this is exactly the shape `safeParse` needs for the inline
 * validation below. */
interface FieldSchema {
  safeParse: (value: unknown) => { success: boolean; error?: { issues: { message: string }[] } };
}

const app = document.getElementById('app') as HTMLDivElement;

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function toast(message: string, tone: 'success' | 'error' = 'success'): void {
  const el = document.createElement('div');
  el.className = tone === 'error' ? 'toast error' : 'toast';
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

/** Inline validation (PHASE 10: "options sections + inline validation") —
 * reuses the exact zod schema `apps/api`'s settings module (and
 * `background/settings.ts`'s `handleSettingsSet`) validates the same field
 * against, via `@sl/shared`, rather than re-deriving bounds by hand and
 * risking the two drifting apart. Reads the input's current value, runs it
 * through `fieldSchema`, and paints the result onto the input
 * (`aria-invalid`) and its paired `<p class="field-error">` (found by
 * `${inputId}-error`, wired via `aria-describedby` in the markup below) —
 * returns whether the field is currently valid so callers can gate the
 * section's Save button on every field in it passing. `parse` turns the
 * input's string value into the number/null the schema actually expects
 * (empty string -> `null` for the nullable budget fields, a bare number
 * otherwise) before validating, so "empty" and "not a number" get their own
 * distinct messages instead of both collapsing into zod's generic one. */
function validateField(inputId: string, fieldSchema: FieldSchema, parse: (raw: string) => unknown): boolean {
  const input = document.getElementById(inputId) as HTMLInputElement | null;
  const errorEl = document.getElementById(`${inputId}-error`);
  if (!input) return true;
  const raw = input.value.trim();
  const result = fieldSchema.safeParse(parse(raw));
  if (result.success) {
    input.removeAttribute('aria-invalid');
    if (errorEl) errorEl.textContent = '';
    return true;
  }
  input.setAttribute('aria-invalid', 'true');
  if (errorEl) errorEl.textContent = result.error?.issues[0]?.message ?? 'Invalid value';
  return false;
}

const parseRequiredNumber = (raw: string): unknown => (raw === '' ? NaN : Number(raw));
const parseNullableNumber = (raw: string): unknown => (raw === '' ? null : Number(raw));

/** Wires live (`input` event) validation onto a section's fields and its
 * Save button, so the button disables the instant any field in the section
 * fails — before the click even happens, not just as a submit-time reject. */
function wireSectionValidation(saveButtonId: string, fields: { id: string; schema: FieldSchema; parse: (raw: string) => unknown }[]): void {
  const button = document.getElementById(saveButtonId) as HTMLButtonElement | null;
  function revalidateAll(): boolean {
    // `.every` without short-circuit-skipping any field, so every field's
    // own error message paints even if an earlier one already failed —
    // `reduce` would work too, but `.map(...).every(Boolean)` reads clearer
    // for "run every one, then require them all".
    const results = fields.map((f) => validateField(f.id, f.schema, f.parse));
    const allValid = results.every(Boolean);
    if (button) button.disabled = !allValid;
    return allValid;
  }
  for (const f of fields) {
    document.getElementById(f.id)?.addEventListener('input', revalidateAll);
  }
  revalidateAll();
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
      <label for="minProfit">Minimum profit per snipe (coins)</label>
      <input id="minProfit" type="number" min="0" value="${s.targets.minProfitPerSnipe}" aria-describedby="minProfit-error" />
      <p class="field-error" id="minProfit-error"></p>
      <label for="maxCoinsPerSnipe">Max coins per snipe</label>
      <input id="maxCoinsPerSnipe" type="number" min="0" value="${s.budgets.maxCoinsPerSnipe}" aria-describedby="maxCoinsPerSnipe-error" />
      <p class="field-error" id="maxCoinsPerSnipe-error"></p>
      <label for="sessionCoinBudget">Session coin budget (blank = no cap)</label>
      <input id="sessionCoinBudget" type="number" min="0" value="${s.budgets.sessionCoinBudget ?? ''}" aria-describedby="sessionCoinBudget-error" />
      <p class="field-error" id="sessionCoinBudget-error"></p>
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

  // Live inline validation, wired once per render — each section's Save
  // button disables itself the moment any field in it fails, and the click
  // handlers below re-check anyway (belt-and-braces against a
  // programmatic click or a race with the `input` listener) before ever
  // calling `send`.
  wireSectionValidation('save-targets', [{ id: 'minProfit', schema: targetsSchema.shape.minProfitPerSnipe as FieldSchema, parse: parseRequiredNumber }]);
  wireSectionValidation('save-targets', [
    { id: 'maxCoinsPerSnipe', schema: budgetsSchema.shape.maxCoinsPerSnipe as FieldSchema, parse: parseRequiredNumber },
    { id: 'sessionCoinBudget', schema: budgetsSchema.shape.sessionCoinBudget as FieldSchema, parse: parseNullableNumber },
  ]);
  wireSectionValidation('save-governor', [
    { id: 'actionsPerHour', schema: governorSettingsSchema.shape.actionsPerHour as FieldSchema, parse: parseRequiredNumber },
    { id: 'sessionLengthMinutes', schema: governorSettingsSchema.shape.sessionLengthMinutes as FieldSchema, parse: parseRequiredNumber },
    { id: 'buyToSearchRatio', schema: governorSettingsSchema.shape.buyToSearchRatio as FieldSchema, parse: parseRequiredNumber },
    { id: 'cooldownSeconds', schema: governorSettingsSchema.shape.cooldownSeconds as FieldSchema, parse: parseRequiredNumber },
    { id: 'maxCoinFlowPerHour', schema: governorSettingsSchema.shape.maxCoinFlowPerHour as FieldSchema, parse: parseRequiredNumber },
  ]);

  document.getElementById('save-targets')?.addEventListener('click', async () => {
    const minProfitValid = validateField('minProfit', targetsSchema.shape.minProfitPerSnipe as FieldSchema, parseRequiredNumber);
    const maxCoinsValid = validateField('maxCoinsPerSnipe', budgetsSchema.shape.maxCoinsPerSnipe as FieldSchema, parseRequiredNumber);
    const sessionBudgetValid = validateField('sessionCoinBudget', budgetsSchema.shape.sessionCoinBudget as FieldSchema, parseNullableNumber);
    if (!minProfitValid || !maxCoinsValid || !sessionBudgetValid) {
      toast('Fix the highlighted fields before saving.', 'error');
      return;
    }
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
      toast(err instanceof Error ? err.message : 'Save failed', 'error');
    }
  });

  document.getElementById('save-governor')?.addEventListener('click', async () => {
    const read = (id: string) => Number((document.getElementById(id) as HTMLInputElement).value);
    const fields: [string, FieldSchema][] = [
      ['actionsPerHour', governorSettingsSchema.shape.actionsPerHour as FieldSchema],
      ['sessionLengthMinutes', governorSettingsSchema.shape.sessionLengthMinutes as FieldSchema],
      ['buyToSearchRatio', governorSettingsSchema.shape.buyToSearchRatio as FieldSchema],
      ['cooldownSeconds', governorSettingsSchema.shape.cooldownSeconds as FieldSchema],
      ['maxCoinFlowPerHour', governorSettingsSchema.shape.maxCoinFlowPerHour as FieldSchema],
    ];
    const allValid = fields.map(([id, schema]) => validateField(id, schema, parseRequiredNumber)).every(Boolean);
    if (!allValid) {
      toast('Fix the highlighted fields before saving.', 'error');
      return;
    }
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
      toast(err instanceof Error ? err.message : 'Save failed', 'error');
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
    <label for="${id}">${label} (<span class="bounds">${bounds.min}–${bounds.max}</span>)</label>
    <input id="${id}" type="number" min="${bounds.min}" max="${bounds.max}" step="${step}" value="${value}" aria-describedby="${id}-error" />
    <p class="field-error" id="${id}-error"></p>
  `;
}

async function hashFilter(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

void render();
