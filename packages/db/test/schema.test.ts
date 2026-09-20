import 'dotenv/config';
import { afterAll, describe, expect, it } from 'vitest';

import { createTestDb, closeTestDb } from '../src/test-utils';

const EXPECTED_TABLES = [
  'users',
  'admin_users',
  'admin_actions',
  'plans',
  'subscriptions',
  'licenses',
  'devices',
  'sessions',
  'email_verifications',
  'password_resets',
  'totp_recovery_codes',
  'user_activity',
  'search_activity',
  'sniping_activity',
  'trades',
  'profits',
  'saved_filters',
  'filter_stats',
  'risk_budget_events',
  'user_settings',
  'settings_history',
  'notifications',
  'payments',
  'payment_history',
  'stripe_webhook_events',
  'coupons',
  'coupon_redemptions',
  'bans',
  'flags',
  'audit_logs',
  'feature_toggles',
  'system_config',
  'ip_activity',
  'extension_installs',
  'analytics_daily',
];

const EXPECTED_VIEWS = ['v_active_subscriptions', 'v_mrr', 'v_arr', 'v_user_lifetime_profit', 'v_daily_profit'];
const EXPECTED_MATVIEWS = ['mv_kpi_daily'];

const PARTITIONED_TABLES = ['user_activity', 'search_activity', 'sniping_activity', 'audit_logs'];

describe('schema: every expected table/view/partition exists', () => {
  const { sql, db } = createTestDb();

  afterAll(async () => {
    await closeTestDb(sql);
  });

  it('has every expected application table', async () => {
    const rows = await sql<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    `;
    const names = new Set(rows.map((r) => r.tablename));
    for (const table of EXPECTED_TABLES) {
      expect(names.has(table), `missing table: ${table}`).toBe(true);
    }
  });

  it('has every expected view', async () => {
    const rows = await sql<{ viewname: string }[]>`
      SELECT viewname FROM pg_views WHERE schemaname = 'public'
    `;
    const names = new Set(rows.map((r) => r.viewname));
    for (const view of EXPECTED_VIEWS) {
      expect(names.has(view), `missing view: ${view}`).toBe(true);
    }
  });

  it('has every expected materialized view', async () => {
    const rows = await sql<{ matviewname: string }[]>`
      SELECT matviewname FROM pg_matviews WHERE schemaname = 'public'
    `;
    const names = new Set(rows.map((r) => r.matviewname));
    for (const mv of EXPECTED_MATVIEWS) {
      expect(names.has(mv), `missing materialized view: ${mv}`).toBe(true);
    }
  });

  it('has at least 13 monthly partitions plus a default partition for each partitioned table', async () => {
    for (const table of PARTITIONED_TABLES) {
      // sql.unsafe: a constant query string with a bound ($1) parameter —
      // not string interpolation into the query text — since `table` needs
      // to be cast to ::regclass, which the tagged-template form can't
      // parameterize as a plain identifier or literal cleanly.
      const rows = await sql.unsafe<{ inhrelid: string }[]>(
        `SELECT inhrelid::regclass::text AS inhrelid FROM pg_inherits WHERE inhparent = $1::regclass`,
        [table],
      );
      const names = rows.map((r) => r.inhrelid);
      expect(names.some((n) => n === `${table}_default`), `${table} missing default partition`).toBe(true);
      const monthly = names.filter((n) => new RegExp(`^${table}_y\\d{4}m\\d{2}$`).test(n));
      expect(monthly.length, `${table} should have >= 13 monthly partitions`).toBeGreaterThanOrEqual(13);
    }
  });

  it('records applied migrations in schema_migrations', async () => {
    const rows = await sql<{ count: string }[]>`SELECT count(*)::text FROM schema_migrations`;
    expect(Number(rows[0]!.count)).toBeGreaterThanOrEqual(24);
  });

  it('exposes the query-builder relational API (sanity check on db.query)', () => {
    expect(db.query.users).toBeDefined();
    expect(db.query.plans).toBeDefined();
  });
});
