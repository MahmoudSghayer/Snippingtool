// QA suite (owned by the Testing & QA agent — see docs/12-testing.md).
//
// docs/02-database.md documents an ON DELETE behaviour for every foreign
// key (CASCADE / RESTRICT / SET NULL), each with a stated rationale (pure
// child telemetry cascades; financial/entitlement records RESTRICT; a ban's
// user_id SET NULLs so it survives account deletion; etc). This introspects
// pg_constraint directly (the actual enforced behaviour, not what a comment
// claims) for a representative set spanning every ON DELETE kind and every
// table section, plus asserts audit_logs deliberately carries no FK at all
// on actor_id/entity_id (§6.9 — "the audit trail must outlive the rows it
// describes"). Read-only introspection; safe against the shared
// TEST_DATABASE_URL alongside any other suite.

import { afterAll, describe, expect, it } from 'vitest';

import { closeTestDb, createTestDb } from '../../src/test-utils';

type OnDelete = 'CASCADE' | 'RESTRICT' | 'SET NULL' | 'NO ACTION';

const CONFDELTYPE_TO_LABEL: Record<string, OnDelete> = {
  c: 'CASCADE',
  r: 'RESTRICT',
  n: 'SET NULL',
  a: 'NO ACTION',
};

interface ExpectedFk {
  table: string;
  column: string;
  onDelete: OnDelete;
  doc: string;
}

// A representative sample spanning every §6 section and every ON DELETE
// kind actually used — not the full FK graph (schema.test.ts / individual
// module tests already exercise the app-level consequences of several of
// these), but enough that a migration silently loosening/tightening one of
// these documented guarantees fails here.
const EXPECTED: ExpectedFk[] = [
  // §6.1
  {
    table: 'admin_users',
    column: 'user_id',
    onDelete: 'RESTRICT',
    doc: "can't hard-delete a user who's still an admin",
  },
  {
    table: 'admin_actions',
    column: 'admin_user_id',
    onDelete: 'RESTRICT',
    doc: 'admin activity log must outlive a removed admin_users row',
  },
  // §6.2
  { table: 'devices', column: 'user_id', onDelete: 'CASCADE', doc: 'pure child of users' },
  {
    table: 'devices',
    column: 'license_id',
    onDelete: 'SET NULL',
    doc: 'optional pointer to the currently-validating license',
  },
  { table: 'sessions', column: 'user_id', onDelete: 'CASCADE', doc: 'pure child of users' },
  {
    table: 'sessions',
    column: 'device_id',
    onDelete: 'SET NULL',
    doc: 'device removal must not cascade-delete sessions',
  },
  {
    table: 'email_verifications',
    column: 'user_id',
    onDelete: 'CASCADE',
    doc: 'ephemeral token, pure child of users',
  },
  // §6.3
  {
    table: 'subscriptions',
    column: 'user_id',
    onDelete: 'RESTRICT',
    doc: 'entitlement record never silently orphaned',
  },
  {
    table: 'subscriptions',
    column: 'plan_id',
    onDelete: 'RESTRICT',
    doc: 'entitlement record never silently orphaned',
  },
  {
    table: 'subscriptions',
    column: 'granted_by_admin_id',
    onDelete: 'SET NULL',
    doc: 'optional actor',
  },
  {
    table: 'licenses',
    column: 'subscription_id',
    onDelete: 'RESTRICT',
    doc: 'financial/entitlement record',
  },
  {
    table: 'licenses',
    column: 'user_id',
    onDelete: 'RESTRICT',
    doc: 'financial/entitlement record',
  },
  // §6.4
  {
    table: 'coupon_redemptions',
    column: 'coupon_id',
    onDelete: 'RESTRICT',
    doc: 'financial record: RESTRICT on coupon_id/user_id',
  },
  {
    table: 'coupon_redemptions',
    column: 'user_id',
    onDelete: 'RESTRICT',
    doc: 'financial record: RESTRICT on coupon_id/user_id',
  },
  {
    table: 'coupon_redemptions',
    column: 'subscription_id',
    onDelete: 'SET NULL',
    doc: 'redemption event itself must be retained',
  },
  { table: 'payments', column: 'user_id', onDelete: 'RESTRICT', doc: 'financial record' },
  { table: 'payments', column: 'subscription_id', onDelete: 'RESTRICT', doc: 'financial record' },
  {
    table: 'payments',
    column: 'coupon_id',
    onDelete: 'SET NULL',
    doc: 'payment amount already reflects the discount',
  },
  {
    table: 'payment_history',
    column: 'payment_id',
    onDelete: 'CASCADE',
    doc: 'pure child of payments',
  },
  // §6.5 — telemetry cascades (supports GDPR erasure)
  {
    table: 'user_activity',
    column: 'user_id',
    onDelete: 'CASCADE',
    doc: 'pure child of users, supports GDPR erasure',
  },
  {
    table: 'user_activity',
    column: 'device_id',
    onDelete: 'SET NULL',
    doc: 'device removal must not cascade-delete activity',
  },
  {
    table: 'search_activity',
    column: 'user_id',
    onDelete: 'CASCADE',
    doc: 'pure child of users, supports GDPR erasure',
  },
  {
    table: 'sniping_activity',
    column: 'user_id',
    onDelete: 'CASCADE',
    doc: 'pure child of users, supports GDPR erasure',
  },
  {
    table: 'risk_budget_events',
    column: 'user_id',
    onDelete: 'CASCADE',
    doc: 'pure child telemetry',
  },
  {
    table: 'risk_budget_events',
    column: 'device_id',
    onDelete: 'SET NULL',
    doc: 'optional pointer',
  },
  {
    table: 'risk_budget_events',
    column: 'session_id',
    onDelete: 'SET NULL',
    doc: 'optional pointer',
  },
  // §6.6
  { table: 'trades', column: 'user_id', onDelete: 'RESTRICT', doc: 'financial record' },
  { table: 'profits', column: 'user_id', onDelete: 'RESTRICT', doc: 'financial record' },
  { table: 'saved_filters', column: 'user_id', onDelete: 'CASCADE', doc: 'pure child of users' },
  {
    table: 'filter_stats',
    column: 'filter_id',
    onDelete: 'CASCADE',
    doc: 'pure child of saved_filters',
  },
  // §6.7
  { table: 'user_settings', column: 'user_id', onDelete: 'CASCADE', doc: 'one row per user' },
  { table: 'settings_history', column: 'user_id', onDelete: 'CASCADE', doc: 'pure child of users' },
  { table: 'settings_history', column: 'changed_by', onDelete: 'SET NULL', doc: 'optional actor' },
  { table: 'notifications', column: 'user_id', onDelete: 'CASCADE', doc: 'pure child of users' },
  // §6.8 — a ban must survive the account it targets
  {
    table: 'bans',
    column: 'user_id',
    onDelete: 'SET NULL',
    doc: 'an IP/device/hwid ban must survive account deletion',
  },
  { table: 'bans', column: 'issued_by', onDelete: 'SET NULL', doc: 'optional actor' },
  {
    table: 'flags',
    column: 'user_id',
    onDelete: 'RESTRICT',
    doc: 'a flag is evidence, must not be silently lost',
  },
  { table: 'flags', column: 'reviewed_by', onDelete: 'SET NULL', doc: 'optional actor' },
  // §6.10
  {
    table: 'ip_activity',
    column: 'user_id',
    onDelete: 'SET NULL',
    doc: 'rolling counter survives account deletion',
  },
  {
    table: 'extension_installs',
    column: 'user_id',
    onDelete: 'SET NULL',
    doc: 'nullable — pre-login installs',
  },
];

describe('FK ON DELETE behaviours per docs/02-database.md §6', () => {
  const { sql, db } = createTestDb();

  afterAll(async () => {
    await closeTestDb(sql);
  });

  it.each(EXPECTED)(
    '$table.$column ON DELETE $onDelete ($doc)',
    async ({ table, column, onDelete }) => {
      // table/column always come from this file's own EXPECTED literal above
      // (never request input) — validated before sql.raw() per the project
      // lint preset (packages/config/eslint-preset.js), which forbids
      // interpolating a value into a Drizzle-style `sql` tagged template at
      // all, even a would-be-parameterised one.
      if (!/^[a-z_]+$/.test(table) || !/^[a-z_]+$/.test(column)) {
        throw new Error(
          `refusing to interpolate an unexpected identifier into SQL: ${table}.${column}`,
        );
      }
      const rows = (await sql.unsafe(`
      SELECT con.confdeltype, confrel.relname AS confrelid_name
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_class confrel ON confrel.oid = con.confrelid
      JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY(con.conkey)
      WHERE con.contype = 'f'
        AND rel.relname = '${table}'
        AND att.attname = '${column}'
    `)) as unknown as Array<{ confdeltype: string; confrelid_name: string }>;
      expect(
        rows.length,
        `expected exactly one FK on ${table}.${column}, found ${rows.length}`,
      ).toBe(1);
      expect(CONFDELTYPE_TO_LABEL[rows[0]!.confdeltype]).toBe(onDelete);
    },
  );

  it('audit_logs.actor_id and .entity_id carry no FK at all (polymorphic, outlives the rows they describe)', async () => {
    const rows = await sql<{ attname: string }[]>`
      SELECT att.attname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY(con.conkey)
      WHERE con.contype = 'f'
        AND rel.relname = 'audit_logs'
        AND att.attname IN ('actor_id', 'entity_id')
    `;
    expect(rows).toEqual([]);
  });

  void db;
});
