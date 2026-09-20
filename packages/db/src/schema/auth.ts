// Matches migrations/0008_devices.sql, 0009_sessions.sql, 0010_auth_tokens.sql.

import { isNull, relations } from 'drizzle-orm';
import { index, inet, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, deletedAt, deviceStatusEnum, idPk, rowVersion, timestamptz, updatedAt } from './common.js';
import { users } from './users.js';
import { licenses } from './subscriptions.js';

export const devices = pgTable(
  'devices',
  {
    id: idPk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    licenseId: uuid('license_id').references(() => licenses.id, { onDelete: 'set null' }),

    fingerprintHash: text('fingerprint_hash').notNull(),
    name: text('name'),
    browser: text('browser'),
    os: text('os'),
    extensionVersion: text('extension_version'),

    firstSeenAt: timestamptz('first_seen_at').notNull().defaultNow(),
    lastSeenAt: timestamptz('last_seen_at').notNull().defaultNow(),
    lastIp: inet('last_ip'),

    status: deviceStatusEnum('status').notNull().default('active'),
    trustedAt: timestamptz('trusted_at'),

    deletedAt: deletedAt(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    rowVersion: rowVersion(),
  },
  (t) => [
    uniqueIndex('devices_user_fingerprint_unique_live').on(t.userId, t.fingerprintHash).where(isNull(t.deletedAt)),
    index('devices_user_id_idx').on(t.userId).where(isNull(t.deletedAt)),
    index('devices_license_id_idx').on(t.licenseId).where(isNull(t.deletedAt)),
    index('devices_status_idx').on(t.status).where(isNull(t.deletedAt)),
    index('devices_last_seen_at_idx').on(t.lastSeenAt),
  ],
);

export const devicesRelations = relations(devices, ({ one }) => ({
  user: one(users, { fields: [devices.userId], references: [users.id] }),
  license: one(licenses, { fields: [devices.licenseId], references: [licenses.id] }),
}));

// ---------------------------------------------------------------------------

export const sessions = pgTable(
  'sessions',
  {
    id: idPk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),

    refreshTokenHash: text('refresh_token_hash').notNull(),
    familyId: uuid('family_id').notNull(),

    ip: inet('ip'),
    userAgent: text('user_agent'),

    expiresAt: timestamptz('expires_at').notNull(),
    revokedAt: timestamptz('revoked_at'),
    revokedReason: text('revoked_reason'),
    lastUsedAt: timestamptz('last_used_at').notNull().defaultNow(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    rowVersion: rowVersion(),
  },
  (t) => [
    uniqueIndex('sessions_refresh_token_hash_unique').on(t.refreshTokenHash),
    index('sessions_user_id_idx').on(t.userId),
    index('sessions_device_id_idx').on(t.deviceId),
    index('sessions_family_id_idx').on(t.familyId),
    index('sessions_active_idx').on(t.userId, t.expiresAt).where(isNull(t.revokedAt)),
  ],
);

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
  device: one(devices, { fields: [sessions.deviceId], references: [devices.id] }),
}));

// ---------------------------------------------------------------------------

export const emailVerifications = pgTable(
  'email_verifications',
  {
    id: idPk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    consumedAt: timestamptz('consumed_at'),

    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('email_verifications_token_hash_unique').on(t.tokenHash),
    index('email_verifications_user_id_idx').on(t.userId).where(isNull(t.consumedAt)),
    index('email_verifications_expires_at_idx').on(t.expiresAt).where(isNull(t.consumedAt)),
  ],
);

export const passwordResets = pgTable(
  'password_resets',
  {
    id: idPk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    consumedAt: timestamptz('consumed_at'),
    requestedIp: inet('requested_ip'),

    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('password_resets_token_hash_unique').on(t.tokenHash),
    index('password_resets_user_id_idx').on(t.userId).where(isNull(t.consumedAt)),
    index('password_resets_expires_at_idx').on(t.expiresAt).where(isNull(t.consumedAt)),
  ],
);

export const totpRecoveryCodes = pgTable(
  'totp_recovery_codes',
  {
    id: idPk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    codeHash: text('code_hash').notNull(),
    usedAt: timestamptz('used_at'),

    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('totp_recovery_codes_code_hash_unique').on(t.codeHash),
    index('totp_recovery_codes_user_id_idx').on(t.userId).where(isNull(t.usedAt)),
  ],
);
