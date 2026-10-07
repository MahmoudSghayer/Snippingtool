// F5: the ledger's aggregate totals and CSV export must be gated by the same
// plan feature (`ledger.recorder`) that GET /trades and POST /trades/batch
// enforce. Previously they only required authentication, so a plan without
// the feature was blocked from listing trades yet could still read totals and
// export every trade as CSV.
import { resetDatabase } from '@sl/db/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bearer, buildTestApp, createUserSession, type TestApp } from './helpers.js';

describe('F5 — trade totals/export are feature-gated', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await buildTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDatabase(app.db);
  });

  it('a user without ledger.recorder is denied totals, export.csv AND /trades alike', async () => {
    // createUserSession grants no plan, so the user falls back to the trial
    // features, which do not include ledger.recorder.
    const user = await createUserSession(app, 'no-ledger@example.com', 'fp-no-ledger-00000001');
    const auth = bearer(user.accessToken);

    const list = await app.inject({ method: 'GET', url: '/api/v1/trades', headers: auth });
    const totals = await app.inject({ method: 'GET', url: '/api/v1/trades/totals', headers: auth });
    const csv = await app.inject({ method: 'GET', url: '/api/v1/trades/export.csv', headers: auth });

    expect(list.statusCode, 'GET /trades gated (baseline)').toBe(403);
    expect(totals.statusCode, 'GET /trades/totals must be gated like /trades').toBe(403);
    expect(csv.statusCode, 'GET /trades/export.csv must be gated like /trades').toBe(403);
  });
});
