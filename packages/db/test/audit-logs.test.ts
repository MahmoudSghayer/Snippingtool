import 'dotenv/config';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { auditLogs } from '../src/schema/index';
import { createTestDb, closeTestDb, resetDatabase } from '../src/test-utils';

describe('audit_logs is append-only', () => {
  const { db, sql } = createTestDb();

  beforeEach(async () => {
    await resetDatabase(db);
  });

  afterAll(async () => {
    await closeTestDb(sql);
  });

  it('accepts INSERT', async () => {
    const [row] = await db
      .insert(auditLogs)
      .values({ actorType: 'system', action: 'test.insert', entityType: 'user' })
      .returning();
    expect(row).toBeDefined();
  });

  it('rejects UPDATE via both the trigger and the revoked privilege', async () => {
    await db.insert(auditLogs).values({ actorType: 'system', action: 'test.update-target', entityType: 'user' });

    await expect(
      sql`UPDATE audit_logs SET action = 'hacked' WHERE action = 'test.update-target'`,
    ).rejects.toThrow(/append-only|permission denied/i);
  });

  it('rejects DELETE via both the trigger and the revoked privilege', async () => {
    await db.insert(auditLogs).values({ actorType: 'system', action: 'test.delete-target', entityType: 'user' });

    await expect(sql`DELETE FROM audit_logs WHERE action = 'test.delete-target'`).rejects.toThrow(
      /append-only|permission denied/i,
    );
  });

  it('app_rw role has UPDATE/DELETE revoked at the grant level', async () => {
    const rows = await sql<{ privilege_type: string }[]>`
      SELECT privilege_type
      FROM information_schema.role_table_grants
      WHERE table_name = 'audit_logs' AND grantee = 'app_rw'
    `;
    const privileges = new Set(rows.map((r) => r.privilege_type));
    expect(privileges.has('SELECT')).toBe(true);
    expect(privileges.has('INSERT')).toBe(true);
    expect(privileges.has('UPDATE')).toBe(false);
    expect(privileges.has('DELETE')).toBe(false);
  });
});
