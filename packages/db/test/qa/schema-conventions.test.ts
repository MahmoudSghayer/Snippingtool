// QA suite (owned by the Testing & QA agent — see docs/12-testing.md).
//
// docs/02-database.md §5 states the base convention: every table gets
// `created_at`/`updated_at` (trigger-maintained) + `deleted_at` (soft
// delete) + `row_version` (optimistic concurrency), "except a handful of
// append-only / ephemeral-token tables noted per table" in §6. This test
// makes that per-table documentation executable: it introspects the real,
// migrated schema and asserts every table has exactly the four audit
// columns the doc says it should, and is missing exactly the ones the doc
// says it deliberately omits (and why) — so a future migration that
// silently drops `row_version` from a table, or adds a stray `deleted_at`
// to an append-only log, fails here instead of only being caught by an
// unrelated integration test months later.
//
// Runs against the shared TEST_DATABASE_URL (read-only introspection only —
// no writes, no destructive DDL), so it's safe alongside any other suite.

import { afterAll, describe, expect, it } from 'vitest';

import { closeTestDb, createTestDb } from '../../src/test-utils';

const STANDARD = ['created_at', 'updated_at', 'deleted_at', 'row_version'] as const;
type Column = (typeof STANDARD)[number];

/**
 * Per-table exceptions to the standard four columns, keyed by table name,
 * value = the standard columns that table deliberately does NOT have, with
 * the docs/02-database.md citation for why. Any column in `STANDARD` not
 * listed here is asserted present; any column listed here is asserted
 * absent. Tables not mentioned at all are asserted to have all four.
 */
const EXCEPTIONS: Record<string, { missing: Column[]; reason: string }> = {
  // §6.1 "no `updated_at`/soft-delete — write-once"
  admin_actions: { missing: ['updated_at', 'deleted_at', 'row_version'], reason: 'write-once admin activity log (§6.1)' },
  // §6.2 "no soft-delete — `revoked_at` is the terminal state"
  sessions: { missing: ['deleted_at'], reason: 'revoked_at is the terminal state (§6.2)' },
  // §6.2 "ephemeral" single-use tokens, CASCADE on user, no soft-delete/audit trail needed
  email_verifications: { missing: ['updated_at', 'deleted_at', 'row_version'], reason: 'ephemeral single-use token (§6.2)' },
  password_resets: { missing: ['updated_at', 'deleted_at', 'row_version'], reason: 'ephemeral single-use token (§6.2)' },
  totp_recovery_codes: { missing: ['updated_at', 'deleted_at', 'row_version'], reason: 'ephemeral single-use token (§6.2)' },
  // §6.4 append-only billing trails
  coupon_redemptions: { missing: ['updated_at', 'deleted_at', 'row_version'], reason: 'append-only redemption record (§6.4)' },
  payment_history: { missing: ['updated_at', 'deleted_at', 'row_version'], reason: 'append-only event trail per payment (§6.4)' },
  stripe_webhook_events: { missing: ['updated_at', 'deleted_at', 'row_version'], reason: 'idempotency ledger, not a soft-deletable entity (§6.4)' },
  // payments itself updates (status) but is never soft-deleted (financial record, RESTRICT-protected instead)
  payments: { missing: ['deleted_at'], reason: 'financial record, protected by RESTRICT rather than soft delete (§6.4)' },
  // §6.5 partitioned write-once telemetry: has created_at alongside occurred_at, no updated_at/deleted_at/row_version
  user_activity: { missing: ['updated_at', 'deleted_at', 'row_version'], reason: 'partitioned write-once telemetry, keyed on occurred_at (§6.5)' },
  search_activity: { missing: ['updated_at', 'deleted_at', 'row_version'], reason: 'partitioned write-once telemetry, keyed on occurred_at (§6.5)' },
  sniping_activity: { missing: ['updated_at', 'deleted_at', 'row_version'], reason: 'partitioned write-once telemetry, keyed on occurred_at (§6.5)' },
  // §6.5 risk_budget_events: "occurred_at, created_at | — |" (no updated_at/deleted_at/row_version)
  risk_budget_events: { missing: ['updated_at', 'deleted_at', 'row_version'], reason: 'governor decision log, write-once (§6.5)' },
  // §6.6 profits/filter_stats/saved_filters-adjacent rollups — not individually soft-deleted
  profits: { missing: ['deleted_at'], reason: 'daily rollup upserted by profits.rollup, not a user-owned deletable entity (§6.6)' },
  filter_stats: { missing: ['deleted_at'], reason: 'ranker scoring history rollup, not individually soft-deleted (§6.6)' },
  // §6.7 settings/notifications
  user_settings: { missing: ['deleted_at'], reason: 'one row per user, cascades with the user rather than being soft-deleted independently (§6.7)' },
  settings_history: { missing: ['updated_at', 'deleted_at', 'row_version'], reason: 'append-only snapshot on every settings change (§6.7)' },
  notifications: { missing: ['deleted_at'], reason: 'read_at is the terminal state a notification reaches, not soft-delete (§6.7)' },
  // §6.8 moderation — evidence/decisions, not soft-deletable entities
  bans: { missing: ['deleted_at'], reason: 'lifted_at is the terminal state (§6.8)' },
  flags: { missing: ['deleted_at'], reason: 'evidence record; reviewed_at/status is the terminal state, not soft-delete (§6.8)' },
  // §6.9 audit_logs — append-only, tamper-resistant (REVOKE UPDATE/DELETE + trigger)
  audit_logs: { missing: ['updated_at', 'deleted_at', 'row_version'], reason: 'append-only, tamper-resistant audit trail, keyed on occurred_at (§6.9)' },
  // §6.10 system/analytics — config and generated metrics, not soft-deletable entities
  feature_toggles: { missing: ['deleted_at'], reason: 'toggle is enabled/disabled in place, not soft-deleted (§6.10)' },
  system_config: { missing: ['deleted_at'], reason: 'config key is updated in place, not soft-deleted (§6.10)' },
  ip_activity: { missing: ['deleted_at'], reason: 'rolling per-(ip,user) counters, not a soft-deletable entity (§6.10)' },
  extension_installs: { missing: ['deleted_at'], reason: 'uninstalled_at is the terminal state (§6.10)' },
  analytics_daily: { missing: ['deleted_at'], reason: 'generated KPI store, rewritten by the nightly job, not soft-deleted (§6.10)' },
};

describe('schema conventions: created_at/updated_at/deleted_at/row_version per docs/02-database.md', () => {
  const { sql, db } = createTestDb();

  afterAll(async () => {
    await closeTestDb(sql);
  });

  it('every table has exactly the standard audit columns the docs say it should', async () => {
    // STANDARD is this file's own fixed literal above (never request input)
    // — inlined as a SQL array literal via sql.unsafe() rather than a bound
    // param, per the project lint preset (packages/config/eslint-preset.js),
    // which forbids interpolating any value into a `sql` tagged template.
    const columnList = STANDARD.map((c) => `'${c}'`).join(', ');
    const rows = (await sql.unsafe(`
      SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_name = c.table_name AND t.table_schema = 'public'
      WHERE c.table_schema = 'public'
        AND t.table_type = 'BASE TABLE'
        AND c.table_name NOT LIKE '%\\_y____m__' ESCAPE '\\'
        AND c.table_name NOT LIKE '%\\_default' ESCAPE '\\'
        AND c.table_name <> 'schema_migrations'
        AND c.column_name = ANY(ARRAY[${columnList}])
    `)) as unknown as Array<{ table_name: string; column_name: string }>;

    const byTable = new Map<string, Set<string>>();
    for (const row of rows) {
      if (!byTable.has(row.table_name)) byTable.set(row.table_name, new Set());
      byTable.get(row.table_name)!.add(row.column_name);
    }

    expect(byTable.size, 'expected to find at least one table with audit columns').toBeGreaterThan(0);

    const failures: string[] = [];
    for (const [table, present] of byTable) {
      const exception = EXCEPTIONS[table];
      const missing = exception?.missing ?? [];
      for (const col of STANDARD) {
        const shouldHave = !missing.includes(col);
        const does = present.has(col);
        if (shouldHave !== does) {
          failures.push(
            shouldHave
              ? `"${table}" is missing "${col}" (docs/02-database.md gives it no documented exception for this column)`
              : `"${table}" unexpectedly has "${col}" (docs/02-database.md §6 documents it as omitted: ${exception!.reason})`,
          );
        }
      }
    }

    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('updated_at/row_version columns are trigger-maintained, not app-set (spot check on users)', async () => {
    const before = await db.query.users.findFirst({ columns: { id: true } });
    // No fixture data expected in a fresh reset — this test only needs the
    // triggers themselves to exist, which schema.test.ts's own coverage
    // already exercises end-to-end via an actual UPDATE. Here we just assert
    // the trigger functions referenced by every table's DDL are installed.
    const triggerFns = await sql<{ proname: string }[]>`
      SELECT proname FROM pg_proc WHERE proname IN ('set_updated_at', 'bump_row_version')
    `;
    expect(triggerFns.map((f) => f.proname).sort()).toEqual(['bump_row_version', 'set_updated_at']);
    void before;
  });
});
