// Matches migrations/0004_admin.sql, 0019_moderation.sql.

import { isNull, relations } from 'drizzle-orm';
import { index, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import {
  adminRoleEnum,
  banTypeEnum,
  createdAt,
  deletedAt,
  flagKindEnum,
  flagSeverityEnum,
  flagStatusEnum,
  idPk,
  rowVersion,
  timestamptz,
  updatedAt,
} from './common';
import { users } from './users';

export const adminUsers = pgTable(
  'admin_users',
  {
    id: idPk(),
    userId: uuid('user_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'restrict' }),

    adminRole: adminRoleEnum('admin_role').notNull(),
    permissions: jsonb('permissions').notNull().default({}).$type<Record<string, boolean>>(),

    deletedAt: deletedAt(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    rowVersion: rowVersion(),
  },
  (t) => [index('admin_users_admin_role_idx').on(t.adminRole).where(isNull(t.deletedAt))],
);

export const adminUsersRelations = relations(adminUsers, ({ one, many }) => ({
  user: one(users, { fields: [adminUsers.userId], references: [users.id] }),
  actions: many(adminActions),
}));

// ---------------------------------------------------------------------------

export const adminActions = pgTable(
  'admin_actions',
  {
    id: idPk(),
    adminUserId: uuid('admin_user_id')
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'restrict' }),

    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id'),
    reason: text('reason'),
    metadata: jsonb('metadata').notNull().default({}).$type<Record<string, unknown>>(),

    occurredAt: timestamptz('occurred_at').notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    index('admin_actions_admin_user_id_idx').on(t.adminUserId, t.occurredAt),
    index('admin_actions_target_idx').on(t.targetType, t.targetId),
    index('admin_actions_action_idx').on(t.action),
    index('admin_actions_occurred_at_idx').on(t.occurredAt),
  ],
);

export const adminActionsRelations = relations(adminActions, ({ one }) => ({
  adminUser: one(adminUsers, { fields: [adminActions.adminUserId], references: [adminUsers.id] }),
}));

// ---------------------------------------------------------------------------

export const bans = pgTable(
  'bans',
  {
    id: idPk(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),

    type: banTypeEnum('type').notNull(),
    value: text('value').notNull(),
    reason: text('reason').notNull(),

    issuedBy: uuid('issued_by').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: timestamptz('expires_at'),
    liftedAt: timestamptz('lifted_at'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    rowVersion: rowVersion(),
  },
  (t) => [
    index('bans_user_id_idx').on(t.userId).where(isNull(t.liftedAt)),
    index('bans_type_value_idx').on(t.type, t.value).where(isNull(t.liftedAt)),
    index('bans_expires_at_idx').on(t.expiresAt).where(isNull(t.liftedAt)),
  ],
);

export const bansRelations = relations(bans, ({ one }) => ({
  user: one(users, { fields: [bans.userId], references: [users.id] }),
}));

// ---------------------------------------------------------------------------

export const flags = pgTable(
  'flags',
  {
    id: idPk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    kind: flagKindEnum('kind').notNull(),
    severity: flagSeverityEnum('severity').notNull().default('medium'),
    evidence: jsonb('evidence').notNull().default({}).$type<Record<string, unknown>>(),

    status: flagStatusEnum('status').notNull().default('open'),
    reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
    reviewedAt: timestamptz('reviewed_at'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    rowVersion: rowVersion(),
  },
  (t) => [
    index('flags_user_id_idx').on(t.userId),
    index('flags_status_idx').on(t.status),
    index('flags_kind_idx').on(t.kind),
    index('flags_severity_idx').on(t.severity),
  ],
);

export const flagsRelations = relations(flags, ({ one }) => ({
  user: one(users, { fields: [flags.userId], references: [users.id] }),
}));
