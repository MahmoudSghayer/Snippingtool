// recordExtensionInstall: one row per install, an upgrade rewrites it in
// place, and an unchanged install reporting again within
// INSTALL_TOUCH_INTERVAL_MS is not written at all.

import { extensionInstalls, users } from '@sl/db';
import { closeTestDb, createTestDb, resetDatabase } from '@sl/db/test-utils';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { INSTALL_TOUCH_INTERVAL_MS, recordExtensionInstall } from '../extension-installs.js';
import { newId } from '../ids.js';

const { db, sql } = createTestDb();

async function createUser(email: string): Promise<string> {
  const id = newId();
  await db.insert(users).values({ id, email, passwordHash: 'x', emailVerifiedAt: new Date() });
  return id;
}

async function installRow(installId: string) {
  const rows = await db.query.extensionInstalls.findMany({
    where: eq(extensionInstalls.installId, installId),
  });
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

describe('lib/extension-installs', () => {
  beforeEach(async () => {
    await resetDatabase(db);
  });

  afterAll(async () => {
    await closeTestDb(sql);
  });

  it('inserts a new install, then upgrades the same row in place', async () => {
    const userId = await createUser('installs@example.com');
    const installId = newId();
    const t0 = new Date('2026-10-18T07:00:00Z');

    await recordExtensionInstall(db, {
      installId,
      userId,
      version: '0.1.0.202610100000',
      browser: 'chrome',
      now: t0,
    });
    const first = await installRow(installId);
    expect(first).toMatchObject({
      userId,
      version: '0.1.0.202610100000',
      browser: 'chrome',
      uninstalledAt: null,
    });
    expect(first.firstSeen.toISOString()).toBe(t0.toISOString());

    // An upgrade a minute later is written straight away, despite the
    // throttle, and keeps first_seen.
    const t1 = new Date(t0.getTime() + 60_000);
    await recordExtensionInstall(db, {
      installId,
      userId,
      version: '0.1.0.202610180706',
      browser: null,
      now: t1,
    });
    const upgraded = await installRow(installId);
    expect(upgraded.version).toBe('0.1.0.202610180706');
    expect(upgraded.browser).toBe('chrome'); // unknown browser leaves it as it was
    expect(upgraded.firstSeen.toISOString()).toBe(t0.toISOString());
    expect(upgraded.lastSeen.toISOString()).toBe(t1.toISOString());
    expect(await db.$count(extensionInstalls)).toBe(1);
  });

  it('does not write an unchanged install again within the touch interval, then does after it', async () => {
    const userId = await createUser('throttle@example.com');
    const installId = newId();
    const t0 = new Date('2026-10-18T07:00:00Z');
    const report = { installId, userId, version: '0.1.0.1', browser: 'edge' };

    await recordExtensionInstall(db, { ...report, now: t0 });
    const inserted = await installRow(installId);

    // Two minutes later (the bot's report cadence): no write — row_version
    // (bumped by a trigger on every UPDATE) and last_seen are unchanged.
    await recordExtensionInstall(db, { ...report, now: new Date(t0.getTime() + 2 * 60_000) });
    const throttled = await installRow(installId);
    expect(throttled.rowVersion).toBe(inserted.rowVersion);
    expect(throttled.lastSeen.toISOString()).toBe(t0.toISOString());

    // Past the interval: last_seen moves.
    const later = new Date(t0.getTime() + INSTALL_TOUCH_INTERVAL_MS + 1_000);
    await recordExtensionInstall(db, { ...report, now: later });
    const touched = await installRow(installId);
    expect(touched.rowVersion).toBeGreaterThan(inserted.rowVersion);
    expect(touched.lastSeen.toISOString()).toBe(later.toISOString());
  });

  it('an install marked uninstalled that reports in again is live again', async () => {
    const userId = await createUser('reinstall@example.com');
    const installId = newId();
    const t0 = new Date('2026-10-18T07:00:00Z');
    await recordExtensionInstall(db, { installId, userId, version: '0.1.0.1', now: t0 });
    await db
      .update(extensionInstalls)
      .set({ uninstalledAt: t0 })
      .where(eq(extensionInstalls.installId, installId));

    await recordExtensionInstall(db, {
      installId,
      userId,
      version: '0.1.0.1',
      now: new Date(t0.getTime() + 60_000),
    });
    expect((await installRow(installId)).uninstalledAt).toBeNull();
  });
});
