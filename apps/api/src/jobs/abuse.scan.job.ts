// Hourly abuse-detection sweep (docs/05-subscriptions.md §6): device-
// registration velocity, one license seen from too many distinct networks,
// and multi-account-by-fingerprint. Chargebacks are handled synchronously
// by the Stripe webhook (`charge.dispute.created`, `modules/payments/
// webhooks.ts`), not re-scanned here. Every finding writes a `flags` row
// and, once its severity crosses `abuse.auto_suspend_severity_threshold`,
// suspends the affected user's live subscription the same way an admin
// suspend does — `actor_type = 'system'` in the resulting `audit_logs` row.

import { devices, licenses, systemConfig, type Database } from '@sl/db';
import { and, eq, gte, isNull } from 'drizzle-orm';

import { recordAudit } from '../lib/audit.js';
import { toAuditSnapshot } from '../modules/admin-subscriptions/admin-action-log.js';
import { createFlag, type FlagRow } from '../modules/flags/service.js';
import { getLiveSubscriptionForUser, suspend } from '../modules/subscriptions/service.js';

import { defineJob } from './types.js';

import type { Redis } from 'ioredis';

const DAY_MS = 24 * 60 * 60 * 1000;

async function getConfigNumber(db: Database, key: string, fallback: number): Promise<number> {
  const row = await db.query.systemConfig.findFirst({ where: eq(systemConfig.key, key) });
  return typeof row?.value === 'number' ? row.value : fallback;
}

async function getConfigSeverity(
  db: Database,
  key: string,
  fallback: FlagRow['severity'],
): Promise<FlagRow['severity']> {
  const row = await db.query.systemConfig.findFirst({ where: eq(systemConfig.key, key) });
  const severities: readonly FlagRow['severity'][] = ['low', 'medium', 'high', 'critical'];
  return typeof row?.value === 'string' && (severities as readonly string[]).includes(row.value)
    ? (row.value as FlagRow['severity'])
    : fallback;
}

const SEVERITY_ORDER: readonly FlagRow['severity'][] = ['low', 'medium', 'high', 'critical'];

function severityFromRatio(count: number, threshold: number): FlagRow['severity'] {
  const ratio = threshold > 0 ? count / threshold : count;
  if (ratio >= 3) return 'critical';
  if (ratio >= 2) return 'high';
  return 'medium'; // reaching this function at all means the threshold was already crossed
}

async function maybeAutoSuspend(
  db: Database,
  redis: Redis,
  userId: string,
  severity: FlagRow['severity'],
  autoSuspendThreshold: FlagRow['severity'],
): Promise<void> {
  if (SEVERITY_ORDER.indexOf(severity) < SEVERITY_ORDER.indexOf(autoSuspendThreshold)) return;

  const sub = await getLiveSubscriptionForUser(db, userId);
  if (!sub || sub.status === 'suspended') return;

  const { before, after } = await suspend(db, redis, sub.id);
  await recordAudit({
    db,
    actor: { type: 'system', id: null },
    action: 'subscription.suspend',
    entityType: 'subscription',
    entityId: sub.id,
    before: toAuditSnapshot(before),
    after: toAuditSnapshot(after),
    requestId: null,
  });
}

/** Detector 1: more than N distinct devices first-seen from the same IP in
 * a rolling 24h window — flags every account involved. */
async function scanDeviceVelocity(
  db: Database,
  redis: Redis,
  threshold: number,
  autoSuspendSeverity: FlagRow['severity'],
): Promise<number> {
  const since = new Date(Date.now() - DAY_MS);
  const recent = await db.query.devices.findMany({ where: gte(devices.firstSeenAt, since) });

  const byIp = new Map<string, typeof recent>();
  for (const device of recent) {
    if (!device.lastIp) continue;
    const group = byIp.get(device.lastIp) ?? [];
    group.push(device);
    byIp.set(device.lastIp, group);
  }

  let flagged = 0;
  for (const [ip, group] of byIp) {
    if (group.length <= threshold) continue;
    const severity = severityFromRatio(group.length, threshold);
    const userIds = [...new Set(group.map((d) => d.userId))];
    for (const userId of userIds) {
      await createFlag(db, {
        userId,
        kind: 'velocity',
        severity,
        evidence: {
          detector: 'velocity.device_registration',
          ip,
          count: group.length,
          threshold,
          windowStart: since.toISOString(),
          windowEnd: new Date().toISOString(),
          matchedIds: group.map((d) => d.id),
        },
      });
      flagged += 1;
      await maybeAutoSuspend(db, redis, userId, severity, autoSuspendSeverity);
    }
  }
  return flagged;
}

/** Detector 2: more than N distinct user accounts have ever registered a
 * device with the same fingerprint hash — unbounded lookback (a shared
 * fingerprint is evidence regardless of when each account first used it). */
async function scanMultiAccountByFingerprint(
  db: Database,
  redis: Redis,
  threshold: number,
  autoSuspendSeverity: FlagRow['severity'],
): Promise<number> {
  const allDevices = await db.query.devices.findMany({ where: isNull(devices.deletedAt) });

  const byFingerprint = new Map<string, Set<string>>();
  for (const device of allDevices) {
    const set = byFingerprint.get(device.fingerprintHash) ?? new Set<string>();
    set.add(device.userId);
    byFingerprint.set(device.fingerprintHash, set);
  }

  let flagged = 0;
  for (const [fingerprintHash, userIds] of byFingerprint) {
    if (userIds.size <= threshold) continue;
    const severity = severityFromRatio(userIds.size, threshold);
    for (const userId of userIds) {
      await createFlag(db, {
        userId,
        kind: 'multi_account',
        severity,
        evidence: {
          detector: 'multi_account.fingerprint',
          fingerprintHash,
          accountCount: userIds.size,
          threshold,
          matchedIds: [...userIds],
        },
      });
      flagged += 1;
      await maybeAutoSuspend(db, redis, userId, severity, autoSuspendSeverity);
    }
  }
  return flagged;
}

/** Detector 3: one active license validated from more than N distinct IPs
 * in 24h — the design calls for distinct ASNs (`ip_activity.asn`), but no
 * component in this system currently enriches that column with a real ASN
 * lookup (out of this agent's scope — see docs/05-subscriptions.md §6),
 * so distinct IP addresses are used as the nearest available proxy. */
async function scanLicenseNetworkSpread(
  db: Database,
  redis: Redis,
  threshold: number,
  autoSuspendSeverity: FlagRow['severity'],
): Promise<number> {
  const since = new Date(Date.now() - DAY_MS);
  const activeLicenses = await db.query.licenses.findMany({
    where: and(eq(licenses.status, 'active'), isNull(licenses.deletedAt)),
  });

  let flagged = 0;
  for (const license of activeLicenses) {
    const recentDevices = await db.query.devices.findMany({
      where: and(eq(devices.licenseId, license.id), gte(devices.lastSeenAt, since)),
    });
    const ips = new Set(
      recentDevices.map((d) => d.lastIp).filter((ip): ip is string => Boolean(ip)),
    );
    if (ips.size <= threshold) continue;

    const severity = severityFromRatio(ips.size, threshold);
    await createFlag(db, {
      userId: license.userId,
      kind: 'multi_account',
      severity,
      evidence: {
        detector: 'multi_account.license_network_spread',
        licenseId: license.id,
        ipCount: ips.size,
        threshold,
        matchedIds: [...ips],
        note: 'ASN enrichment unavailable; distinct IP count used as a proxy for distinct ASNs.',
      },
    });
    flagged += 1;
    await maybeAutoSuspend(db, redis, license.userId, severity, autoSuspendSeverity);
  }
  return flagged;
}

export default defineJob({
  name: 'abuse.scan',
  schedule: '0 * * * *', // hourly
  async processor(_job, { db, redis, log }) {
    const [
      maxDevicesPerIpPerDay,
      maxAccountsPerFingerprint,
      maxIpsPerLicense,
      autoSuspendSeverity,
    ] = await Promise.all([
      getConfigNumber(db, 'abuse.max_devices_per_ip_per_day', 5),
      getConfigNumber(db, 'abuse.max_accounts_per_fingerprint', 3),
      getConfigNumber(db, 'abuse.max_ips_per_license_24h', 3),
      getConfigSeverity(db, 'abuse.auto_suspend_severity_threshold', 'high'),
    ]);

    const velocityFlags = await scanDeviceVelocity(
      db,
      redis,
      maxDevicesPerIpPerDay,
      autoSuspendSeverity,
    );
    const fingerprintFlags = await scanMultiAccountByFingerprint(
      db,
      redis,
      maxAccountsPerFingerprint,
      autoSuspendSeverity,
    );
    const networkSpreadFlags = await scanLicenseNetworkSpread(
      db,
      redis,
      maxIpsPerLicense,
      autoSuspendSeverity,
    );

    log.info(
      {
        velocityFlags,
        fingerprintFlags,
        networkSpreadFlags,
        totalFlags: velocityFlags + fingerprintFlags + networkSpreadFlags,
      },
      'abuse.scan completed',
    );
  },
});
