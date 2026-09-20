#!/usr/bin/env tsx
// Idempotent seed data: plans, feature toggles, system config (safety-governor
// defaults), a super admin (from SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD), and —
// outside production — a dev user. Safe to run repeatedly: every entity is
// looked up by its natural key first and updated in place rather than
// re-inserted (upsert), so `pnpm seed` twice leaves the same rows behind.

import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { createDb, getDatabaseUrl } from './index.js';
import { adminUsers, featureToggles, plans, systemConfig, users } from './schema/index.js';

const ARGON2_OPTS = { type: argon2.argon2id } as const;

async function upsertPlan(
  db: ReturnType<typeof createDb>['db'],
  plan: {
    code: string;
    name: string;
    description: string;
    priceCents: number;
    interval: 'day' | 'week' | 'month' | 'year' | 'one_time';
    isLifetime: boolean;
    deviceLimit: number;
    features: Record<string, unknown>;
    sortOrder: number;
  },
) {
  const existing = await db.query.plans.findFirst({ where: eq(plans.code, plan.code) });
  if (existing) {
    await db
      .update(plans)
      .set({
        name: plan.name,
        description: plan.description,
        priceCents: plan.priceCents,
        interval: plan.interval,
        isLifetime: plan.isLifetime,
        deviceLimit: plan.deviceLimit,
        features: plan.features,
        sortOrder: plan.sortOrder,
        isActive: true,
      })
      .where(eq(plans.id, existing.id));
    console.log(`  plan ${plan.code}: updated`);
  } else {
    await db.insert(plans).values(plan);
    console.log(`  plan ${plan.code}: created`);
  }
}

async function upsertFeatureToggle(
  db: ReturnType<typeof createDb>['db'],
  toggle: { key: string; enabled: boolean; description: string; rolloutPercent?: number },
) {
  const existing = await db.query.featureToggles.findFirst({ where: eq(featureToggles.key, toggle.key) });
  if (existing) {
    console.log(`  feature_toggle ${toggle.key}: already present, leaving enabled=${existing.enabled} (admin-controlled)`);
    return;
  }
  await db.insert(featureToggles).values({
    key: toggle.key,
    enabled: toggle.enabled,
    rolloutPercent: toggle.rolloutPercent ?? 100,
    description: toggle.description,
  });
  console.log(`  feature_toggle ${toggle.key}: created (enabled=${toggle.enabled})`);
}

async function upsertSystemConfig(
  db: ReturnType<typeof createDb>['db'],
  config: { key: string; value: unknown; description: string; isSecret?: boolean },
) {
  const existing = await db.query.systemConfig.findFirst({ where: eq(systemConfig.key, config.key) });
  if (existing) {
    console.log(`  system_config ${config.key}: already present, leaving value as-is (admin-controlled)`);
    return;
  }
  await db.insert(systemConfig).values({
    key: config.key,
    value: config.value,
    description: config.description,
    isSecret: config.isSecret ?? false,
  });
  console.log(`  system_config ${config.key}: created`);
}

async function upsertUser(
  db: ReturnType<typeof createDb>['db'],
  user: { email: string; password: string; role: 'user' | 'admin' },
) {
  const passwordHash = await argon2.hash(user.password, ARGON2_OPTS);
  const existing = await db.query.users.findFirst({ where: eq(users.email, user.email) });
  if (existing) {
    await db
      .update(users)
      .set({ passwordHash, role: user.role, emailVerifiedAt: existing.emailVerifiedAt ?? new Date() })
      .where(eq(users.id, existing.id));
    console.log(`  user ${user.email}: updated`);
    return existing.id;
  }
  const [row] = await db
    .insert(users)
    .values({ email: user.email, passwordHash, role: user.role, emailVerifiedAt: new Date() })
    .returning({ id: users.id });
  console.log(`  user ${user.email}: created`);
  return row!.id;
}

/**
 * Runs the full idempotent seed against the given connection string (defaults
 * to DATABASE_URL). Exported so both the CLI entry point below and the
 * vitest suite (test/seed.test.ts, which seeds the test database and checks
 * re-running is a no-op) can call it directly without spawning a subprocess.
 */
export async function seed(connectionString: string = getDatabaseUrl()) {
  const { db, sql } = createDb(connectionString);

  try {
    console.log('Seeding plans...');
    await upsertPlan(db, {
      code: 'trial',
      name: 'Trial',
      description: '7-day trial, 1 device, full feature access to evaluate the app.',
      priceCents: 0,
      interval: 'month',
      isLifetime: false,
      deviceLimit: 1,
      features: { ranker: true, assist: true, automation: false },
      sortOrder: 0,
    });
    await upsertPlan(db, {
      code: 'basic',
      name: 'Basic',
      description: 'Single-device access to the recorder and assist tools.',
      priceCents: 499,
      interval: 'month',
      isLifetime: false,
      deviceLimit: 1,
      features: { ranker: true, assist: true, automation: false },
      sortOrder: 1,
    });
    await upsertPlan(db, {
      code: 'pro',
      name: 'Pro',
      description: 'Two devices, full assist toolset.',
      priceCents: 999,
      interval: 'month',
      isLifetime: false,
      deviceLimit: 2,
      features: { ranker: true, assist: true, automation: false },
      sortOrder: 2,
    });
    await upsertPlan(db, {
      code: 'ultimate',
      name: 'Ultimate',
      description: 'Three devices and every feature, including gated automation.',
      priceCents: 1999,
      interval: 'month',
      isLifetime: false,
      deviceLimit: 3,
      features: { ranker: true, assist: true, automation: true },
      sortOrder: 3,
    });
    await upsertPlan(db, {
      code: 'lifetime',
      name: 'Lifetime (Founders)',
      description: 'One-time purchase, lifetime access, three devices, every feature.',
      priceCents: 9999,
      interval: 'one_time',
      isLifetime: true,
      deviceLimit: 3,
      features: { ranker: true, assist: true, automation: true },
      sortOrder: 4,
    });

    console.log('Seeding feature toggles...');
    await upsertFeatureToggle(db, {
      key: 'automation.enabled',
      enabled: false,
      description: 'Master switch for the M3 autobuyer (ledger-auto build). Off by default; automation ships gated behind this and the safety governor.',
    });
    await upsertFeatureToggle(db, {
      key: 'kill_switch',
      enabled: false,
      description: 'Server-pushed emergency stop. When true, every extension instance halts sniping/automation on next heartbeat.',
    });
    await upsertFeatureToggle(db, {
      key: 'telemetry.enabled',
      enabled: true,
      description: 'Master switch for extension telemetry upload (account-agnostic product data only; user-visible opt-out in Settings overrides this per-user).',
    });
    await upsertFeatureToggle(db, {
      key: 'trial.enabled',
      enabled: true,
      description: 'Whether new signups may start a trial subscription.',
    });
    await upsertFeatureToggle(db, {
      key: 'hibp_check',
      enabled: false,
      description: 'Check new passwords against the HaveIBeenPwned k-anonymity range API during registration/reset.',
    });

    console.log('Seeding system config (safety-governor defaults, device limits, heartbeat)...');
    await upsertSystemConfig(db, {
      key: 'governor.max_actions_per_hour',
      value: 90,
      description: 'Default safety-governor ceiling on total in-page actions per hour, before a hard stop.',
    });
    await upsertSystemConfig(db, {
      key: 'governor.max_session_minutes',
      value: 120,
      description: 'Default safety-governor ceiling on continuous session length in minutes.',
    });
    await upsertSystemConfig(db, {
      key: 'governor.max_buy_search_ratio',
      value: 0.35,
      description: 'Default safety-governor ceiling on the ratio of buy attempts to searches (a human-plausible shape).',
    });
    await upsertSystemConfig(db, {
      key: 'governor.max_coin_flow_per_hour',
      value: 200000,
      description: 'Default safety-governor ceiling on total coins moved (spent + earned) per hour.',
    });
    await upsertSystemConfig(db, {
      key: 'device_limits',
      value: { trial: 1, basic: 1, pro: 2, ultimate: 3, lifetime: 3 },
      description: 'Fallback device-limit-per-plan-code map, mirrors plans.device_limit; used when a plan lookup is unavailable.',
    });
    await upsertSystemConfig(db, {
      key: 'offline_grace_hours',
      value: 24,
      description: 'How long a license stays valid on a device without contacting the server (cached signed entitlement blob).',
    });
    await upsertSystemConfig(db, {
      key: 'heartbeat_minutes',
      value: 10,
      description: 'Extension heartbeat interval in minutes (license re-validation, kill-switch/feature-toggle sync).',
    });

    console.log('Seeding super admin...');
    const adminEmail = process.env.SEED_ADMIN_EMAIL;
    const adminPassword = process.env.SEED_ADMIN_PASSWORD;
    if (!adminEmail || !adminPassword) {
      console.warn('  SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD not set — skipping super admin seed. Set both in .env to seed one.');
    } else {
      const adminUserId = await upsertUser(db, { email: adminEmail, password: adminPassword, role: 'admin' });
      const existingAdmin = await db.query.adminUsers.findFirst({ where: eq(adminUsers.userId, adminUserId) });
      if (existingAdmin) {
        await db.update(adminUsers).set({ adminRole: 'super_admin' }).where(eq(adminUsers.id, existingAdmin.id));
        console.log(`  admin_users for ${adminEmail}: updated`);
      } else {
        await db.insert(adminUsers).values({ userId: adminUserId, adminRole: 'super_admin', permissions: {} });
        console.log(`  admin_users for ${adminEmail}: created`);
      }
    }

    if (process.env.NODE_ENV !== 'production') {
      console.log('Seeding dev user (NODE_ENV != production)...');
      await upsertUser(db, { email: 'dev@sniperledger.local', password: 'dev-password-123', role: 'user' });
    }

    console.log('Seed complete.');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  await seed();
}
