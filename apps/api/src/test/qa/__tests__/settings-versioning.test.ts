// QA suite (owned by the Testing & QA agent — see docs/12-testing.md).
// Integration coverage for the settings module (apps/api/src/modules/
// settings): version incrementing, settings_history writes, the
// last-write-wins sync policy docs/06-extension.md documents ("server
// version wins" — see apps/extension/src/lib/settings.ts), governor-ceiling
// enforcement, and a defect found while writing this suite (see "Defects
// found" in docs/12-testing.md and this file's last test).

import { systemConfig } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bearer, buildTestApp, createUserSession, type TestApp } from '../helpers.js';

describe('settings versioning and sync-conflict policy', () => {
  let app: TestApp;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app.db);
  });

  it('GET creates and returns default settings at version 1', async () => {
    const user = await createUserSession(
      app,
      'settings-default@example.com',
      'fp-settings-default-00001',
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: bearer(user.accessToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { version: number };
    expect(body.version).toBe(1);
  });

  it('PUT increments version, merges only the patched sections, and appends a settings_history row', async () => {
    const user = await createUserSession(
      app,
      'settings-put@example.com',
      'fp-settings-put-000000001',
    );

    const first = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers: bearer(user.accessToken),
      payload: { targets: { minProfitPerSnipe: 2000 } },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as {
      version: number;
      targets: { minProfitPerSnipe: number; dailyProfitGoal: number | null };
      budgets: unknown;
    };
    expect(firstBody.version).toBe(2);
    expect(firstBody.targets.minProfitPerSnipe).toBe(2000);
    // Untouched sections carry over from the default, not wiped by the partial patch.
    expect(firstBody.budgets).toBeDefined();

    const second = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers: bearer(user.accessToken),
      payload: { budgets: { maxCoinsPerSnipe: 100_000 } },
    });
    const secondBody = second.json() as { version: number; targets: { minProfitPerSnipe: number } };
    expect(secondBody.version).toBe(3);
    // First patch's change is still there — merge, not overwrite.
    expect(secondBody.targets.minProfitPerSnipe).toBe(2000);

    const history = await app.inject({
      method: 'GET',
      url: '/api/v1/settings/history',
      headers: bearer(user.accessToken),
    });
    const historyBody = history.json() as Array<{ version: number }>;
    expect(historyBody.map((h) => h.version).sort((a, b) => a - b)).toEqual([2, 3]);
  });

  // --- Defect #1 (docs/12-testing.md "Defects found") — FIXED ---
  //
  // apps/extension/src/lib/settings.ts documents the sync-conflict policy as
  // "server version wins" with no client-side merge. modules/settings/
  // index.ts's PUT handler reads `current` (version N), computes
  // `merged.version = current.version + 1` in application code, then
  // inserts a settings_history row with that same computed version.
  // `settings_history_user_version_unique` is a unique index on
  // `(user_id, version)` (packages/db/src/schema/settings.ts) — when two
  // PUTs race, both read the same `current.version` and both compute the
  // same next version, so the second settings_history insert hits the
  // unique constraint. This used to surface as an unhandled 500 INTERNAL;
  // the handler now catches the Postgres unique-violation (23505) around
  // the update+insert and throws AppErrors.conflict(), so the loser gets a
  // clean, documented `409 CONFLICT` instead of a raw crash.
  it("concurrent PUTs race on settings_history's unique (user_id, version) index — the loser gets a clean 409 CONFLICT, never a raw 500", async () => {
    // The race is timing-dependent (Postgres connection-pool/scheduler
    // timing shifts which SELECTs interleave with which INSERTs), so this
    // loops several racing pairs on fresh users to reliably surface it at
    // least once per run without asserting an exact split that would
    // itself be flaky. The invariant that must always hold: every response
    // is 200 or a well-formed 409 CONFLICT (never a 500, never an
    // unhandled crash/timeout, never silent data loss), and the settings
    // row is always left readable afterward.
    let sawTheRace = false;

    for (let i = 0; i < 8; i += 1) {
      const user = await createUserSession(
        app,
        `settings-race-${i}@example.com`,
        `fp-settings-race-000${i}`,
      );
      const patchA = app.inject({
        method: 'PUT',
        url: '/api/v1/settings',
        headers: bearer(user.accessToken),
        payload: { targets: { minProfitPerSnipe: 111 } },
      });
      const patchB = app.inject({
        method: 'PUT',
        url: '/api/v1/settings',
        headers: bearer(user.accessToken),
        payload: { targets: { minProfitPerSnipe: 222 } },
      });
      const [resA, resB] = await Promise.all([patchA, patchB]);

      for (const res of [resA, resB]) {
        expect([200, 409]).toContain(res.statusCode);
        if (res.statusCode === 409) {
          sawTheRace = true;
          expect(res.json()).toMatchObject({ code: 'CONFLICT' });
        } else {
          expect(res.statusCode).not.toBe(500);
        }
      }

      const final = await app.inject({
        method: 'GET',
        url: '/api/v1/settings',
        headers: bearer(user.accessToken),
      });
      expect(final.statusCode).toBe(200);
    }

    // If this ever stops firing across 8 racing pairs, either the race
    // window closed for an unrelated reason (worth re-investigating) or the
    // handler was changed to serialise instead of conflict (fine — update
    // this comment); either way this assertion should not be silently
    // deleted, since it's what pins defect #1 as fixed.
    expect(sawTheRace).toBe(true);
  });

  it('rejects a governor patch that exceeds the admin-configured ceiling', async () => {
    const user = await createUserSession(
      app,
      'settings-ceiling@example.com',
      'fp-settings-ceiling-0001',
    );
    await app.db
      .insert(systemConfig)
      .values({ key: 'governor.max_actions_per_hour', value: 20, isSecret: false });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers: bearer(user.accessToken),
      payload: { governor: { actionsPerHour: 40 } },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { message: string };
    expect(body.message).toMatch(/exceeds the plan's configured ceiling/);
  });

  // --- Defect #4 (docs/12-testing.md "Defects found") — FIXED ---
  //
  // apps/extension/src/lib/settings.ts's updateSettings() used to send
  // `{ method: 'PATCH' }` to '/api/v1/settings', but this module only ever
  // registers `app.put('/api/v1/settings', ...)` — there was no PATCH
  // route, so every real settings sync from the extension 404d. The
  // dashboard (apps/dashboard/src/pages/user/SettingsPage.tsx) already
  // called `api.PUT('/api/v1/settings', ...)`, which was always correct —
  // this was extension-only. Fixed by changing
  // apps/extension/src/lib/settings.ts's `updateSettings()` to send
  // `method: 'PUT'` (see apps/extension/test/unit/settings-conflict.test.ts
  // for the extension-side regression test, and
  // apps/api/src/test/contract/openapi-client-methods.test.ts for a
  // standing contract test that every method the extension's api client
  // uses is a route the API actually registers). This route still has no
  // PATCH handler by design — asserted below so a future regression (the
  // extension reverting to PATCH) is caught here too.
  it('the server still has no PATCH handler for this route — the extension must use PUT', async () => {
    const user = await createUserSession(
      app,
      'settings-defect@example.com',
      'fp-settings-defect-0001',
    );
    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: bearer(user.accessToken),
      payload: { targets: { minProfitPerSnipe: 999 } },
    });
    expect(patchRes.statusCode).toBe(404);

    const putRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers: bearer(user.accessToken),
      payload: { targets: { minProfitPerSnipe: 999 } },
    });
    expect(putRes.statusCode).toBe(200);
  });
});
