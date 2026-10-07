// Global setup: truncate the audit log once per run and print the resolved
// target. On the local stack (QA_RESET_DB=1) it also resets the admin's TOTP
// enrolment and clears stale device/session rows so every run re-exercises
// the real TOTP-bootstrap flow deterministically. It never touches a remote
// database — prod runs leave QA_RESET_DB unset.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import postgres from 'postgres';

import { initAuditLog } from './audit.ts';
import { target } from './targets.ts';

export default async function globalSetup(): Promise<void> {
  initAuditLog();
  // eslint-disable-next-line no-console
  console.log(`\n[QA] target=${target.name} web=${target.web} api=${target.api}\n`);

  if (process.env.QA_RESET_DB === '1' && process.env.DATABASE_URL && target.name === 'local') {
    // Drop any stale enrolment secret so first admin login re-enrols cleanly.
    try {
      fs.unlinkSync(path.join(os.tmpdir(), 'nova-qa-admin-totp.txt'));
    } catch {
      /* none to remove */
    }
    const db = postgres(process.env.DATABASE_URL, { max: 1 });
    try {
      const email = target.admin?.email ?? 'qa-admin@novatrade.local';
      const rows = await db`
        update users set totp_secret_enc = null, totp_enabled_at = null
        where email = ${email} returning id`;
      if (rows[0]) {
        const id = rows[0].id;
        await db`delete from totp_recovery_codes where user_id = ${id}`;
        await db`delete from devices where user_id = ${id}`;
        await db`delete from sessions where user_id = ${id}`;
      }
      // Clear the QA customer accounts' devices/sessions too, so the trial
      // device limit (1) doesn't 409 logins that use a fresh fingerprint.
      const userEmails = [target.user1?.email, target.user2?.email].filter(Boolean) as string[];
      for (const ue of userEmails) {
        const u = await db`select id from users where email = ${ue}`;
        if (u[0]) {
          await db`delete from devices where user_id = ${u[0].id}`;
          await db`delete from sessions where user_id = ${u[0].id}`;
        }
      }
    } finally {
      await db.end({ timeout: 5 });
    }
  }
}
