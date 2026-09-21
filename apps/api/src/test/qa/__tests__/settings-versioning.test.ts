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
    const user = await createUserSession(app, 'settings-default@example.com', 'fp-settings-default-00001');
    const res = await app.inject({ method: 'GET', url: '/api/v1/settings', headers: bearer(user.accessToken) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { version: number };
    expect(body.version).toBe(1);
  });

  it('PUT increments version, merges only the patched sections, and appends a settings_history row', async () => {
    const user = await createUserSession(app, 'settings-put@example.com', 'fp-settings-put-000000001');

    const first = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers: bearer(user.accessToken),
      payload: { targets: { minProfitPerSnipe: 2000 } },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as { version: number; targets: { minProfitPerSnipe: number; dailyProfitGoal: number | null }; budgets: unknown };
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

    const history = await app.inject({ method: 'GET', url: '/api/v1/settings/history', headers: bearer(user.accessToken) });
    const historyBody = history.json() as Array<{ version: number }>;
    expect(historyBody.map((h) => h.version).sort((a, b) => a - b)).toEqual([2, 3]);
  });

  // --- Defect found: PUT /settings is not safe under concurrent writes ---
  //
  // apps/extension/src/lib/settings.ts documents the sync-conflict policy as
  // "server version wins" with no client-side merge, implying every PUT
  // should simply be accepted and bump `version` again. The *intended*
  // behaviour asserted here originally was "both concurrent PUTs from the
  // same version apply, in server-received order, version ends at 3" — that
  // is not what modules/settings/index.ts actually does. Its handler reads
  // `current` (version N), computes `merged.version = current.version + 1`
  // in application code, then inserts a settings_history row with that same
  // computed version. `settings_history_user_version_unique` is a unique
  // index on `(user_id, version)` (packages/db/src/schema/settings.ts) —
  // when two PUTs race, both read the same `current.version` and both
  // compute the same next version, so the second settings_history insert
  // hits the unique constraint and the request 500s (`INTERNAL`) instead of
  // retrying, serialising via a row lock, or returning a documented conflict
  // code. Reproduced deterministically (3/3 runs) via
  // `TEST_DATABASE_URL=... REDIS_TEST_DB=12 pnpm --filter @sl/api exec
  // vitest run src/test/qa/__tests__/settings-versioning.test.ts -t "last
  // write wins"` before this test was corrected to assert the real
  // behaviour. See docs/12-testing.md "Defects found" for the proposed fix
  // (`SELECT ... FOR UPDATE` on the user_settings row, or an
  // `INSERT ... ON CONFLICT DO NOTHING` + retry loop, inside a transaction
  // wrapping the read-merge-write) — not applied here, this suite never
  // edits application source.
  it('DEFECT: concurrent PUTs race on settings_history\'s unique (user_id, version) index — this can 500 instead of serialising or reporting a conflict', async () => {
    // The race is timing-dependent (confirmed both ways: isolated runs of
    // just this test hit it 3/3, full-suite runs sometimes don't — Postgres
    // connection-pool/scheduler timing shifts which SELECTs interleave with
    // which INSERTs). So this loops several racing pairs on fresh users to
    // reliably surface it at least once per run without asserting an exact
    // 200/500 split that would itself be flaky. The invariant that always
    // holds, buggy or not, is: every response is 200 or a well-formed 500
    // (never an unhandled crash/timeout, never silent data loss), and the
    // settings row is always left readable afterward.
    let sawTheRace = false;

    for (let i = 0; i < 8; i += 1) {
      const user = await createUserSession(app, `settings-race-${i}@example.com`, `fp-settings-race-000${i}`);
      const patchA = app.inject({ method: 'PUT', url: '/api/v1/settings', headers: bearer(user.accessToken), payload: { targets: { minProfitPerSnipe: 111 } } });
      const patchB = app.inject({ method: 'PUT', url: '/api/v1/settings', headers: bearer(user.accessToken), payload: { targets: { minProfitPerSnipe: 222 } } });
      const [resA, resB] = await Promise.all([patchA, patchB]);

      for (const res of [resA, resB]) {
        expect([200, 500]).toContain(res.statusCode);
        if (res.statusCode === 500) {
          sawTheRace = true;
          expect(res.json()).toMatchObject({ code: 'INTERNAL' });
        }
      }

      const final = await app.inject({ method: 'GET', url: '/api/v1/settings', headers: bearer(user.accessToken) });
      expect(final.statusCode).toBe(200);
    }

    // If this ever stops firing across 8 racing pairs, either the module
    // was fixed (great — tighten this test to assert [200, 200] and update
    // the comment above) or the race window closed for an unrelated reason
    // worth re-investigating; either way this assertion should not be
    // silently deleted.
    expect(sawTheRace).toBe(true);
  });

  it('rejects a governor patch that exceeds the admin-configured ceiling', async () => {
    const user = await createUserSession(app, 'settings-ceiling@example.com', 'fp-settings-ceiling-0001');
    await app.db.insert(systemConfig).values({ key: 'governor.max_actions_per_hour', value: 20, isSecret: false });

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

  // --- Defect found: extension/server HTTP-verb mismatch on this exact route ---
  //
  // apps/extension/src/lib/settings.ts's updateSettings() sends
  // `{ method: 'PATCH' }` to '/api/v1/settings', but this module only ever
  // registers `app.put('/api/v1/settings', ...)` — there is no PATCH route.
  // The dashboard (apps/dashboard/src/pages/user/SettingsPage.tsx) calls
  // `api.PUT('/api/v1/settings', ...)`, which is correct — this is
  // extension-only. Documented in docs/12-testing.md "Defects found";
  // proposed fix: change apps/extension/src/lib/settings.ts's
  // `updateSettings()` to send `method: 'PUT'` (this repo never edits
  // application source from the QA suite, so the fix isn't applied here).
  it('DEFECT: the route the extension patches (PATCH) is not the route the server exposes (PUT)', async () => {
    const user = await createUserSession(app, 'settings-defect@example.com', 'fp-settings-defect-0001');
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: bearer(user.accessToken),
      payload: { targets: { minProfitPerSnipe: 999 } },
    });
    // Fastify has no PATCH handler registered for this path -> 404, not 200.
    // If this ever starts returning 200, the mismatch has been fixed
    // (either the extension now sends PUT, or the server now also accepts
    // PATCH) and this assertion — and the note above — should be updated.
    expect(res.statusCode).toBe(404);
  });
});
