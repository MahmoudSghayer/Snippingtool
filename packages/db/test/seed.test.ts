import 'dotenv/config';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, closeTestDb, getTestDatabaseUrl, resetDatabase } from '../src/test-utils';
import { adminUsers, featureToggles, plans, systemConfig, users } from '../src/schema/index';
import { seed } from '../src/seed';

describe('seed is idempotent', () => {
  const { db, sql } = createTestDb();

  beforeEach(async () => {
    await resetDatabase(db);
    process.env.SEED_ADMIN_EMAIL = 'seed-admin@example.com';
    process.env.SEED_ADMIN_PASSWORD = 'seed-admin-password-123';
    process.env.NODE_ENV = 'test';
  });

  afterAll(async () => {
    await closeTestDb(sql);
  });

  it('running seed twice does not duplicate plans, feature toggles, system config, or the super admin', async () => {
    await seed(getTestDatabaseUrl());
    await seed(getTestDatabaseUrl());

    const planRows = await db.select().from(plans);
    const planCodes = planRows.map((p) => p.code);
    expect(new Set(planCodes).size).toBe(planCodes.length); // no duplicate codes
    expect(planCodes).toEqual(expect.arrayContaining(['trial', 'basic', 'pro', 'ultimate', 'lifetime']));
    expect(planRows.length).toBe(5);

    const toggleRows = await db.select().from(featureToggles);
    const toggleKeys = toggleRows.map((t) => t.key);
    expect(new Set(toggleKeys).size).toBe(toggleKeys.length);
    expect(toggleKeys).toEqual(
      expect.arrayContaining(['automation.enabled', 'kill_switch', 'telemetry.enabled', 'trial.enabled', 'hibp_check']),
    );

    const configRows = await db.select().from(systemConfig);
    const configKeys = configRows.map((c) => c.key);
    expect(new Set(configKeys).size).toBe(configKeys.length);
    expect(configKeys).toEqual(
      expect.arrayContaining([
        'governor.max_actions_per_hour',
        'governor.max_session_minutes',
        'governor.max_buy_search_ratio',
        'governor.max_coin_flow_per_hour',
        'device_limits',
        'offline_grace_hours',
        'heartbeat_minutes',
      ]),
    );

    const allUsers = await db.select().from(users);
    const admin = allUsers.filter((u) => u.email === 'seed-admin@example.com');
    expect(admin).toHaveLength(1);

    const adminProfiles = await db.select().from(adminUsers);
    expect(adminProfiles).toHaveLength(1);
    expect(adminProfiles[0]!.adminRole).toBe('super_admin');
  });

  it('seeds correct trial/basic/pro/ultimate/lifetime prices', async () => {
    await seed(getTestDatabaseUrl());
    const planRows = await db.select().from(plans);
    const byCode = Object.fromEntries(planRows.map((p) => [p.code, p]));

    expect(byCode.trial?.priceCents).toBe(0);
    expect(byCode.basic?.priceCents).toBe(499);
    expect(byCode.pro?.priceCents).toBe(999);
    expect(byCode.ultimate?.priceCents).toBe(1999);
    expect(byCode.lifetime?.priceCents).toBe(9999);
    expect(byCode.lifetime?.isLifetime).toBe(true);
  });
});
