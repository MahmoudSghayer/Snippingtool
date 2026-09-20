// Matches migrations/0015_settings.sql, 0016_notifications.sql.

import { isNull, relations } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { createdAt, idPk, notificationChannelEnum, rowVersion, timestamptz, updatedAt } from './common.js';
import { users } from './users.js';

export const userSettings = pgTable(
  'user_settings',
  {
    id: idPk(),
    userId: uuid('user_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'cascade' }),

    settings: jsonb('settings').notNull().default({}).$type<Record<string, unknown>>(),
    version: integer('version').notNull().default(1),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    rowVersion: rowVersion(),
  },
);

export const userSettingsRelations = relations(userSettings, ({ one }) => ({
  user: one(users, { fields: [userSettings.userId], references: [users.id] }),
}));

// ---------------------------------------------------------------------------

export const settingsHistory = pgTable(
  'settings_history',
  {
    id: idPk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    settings: jsonb('settings').notNull().$type<Record<string, unknown>>(),
    version: integer('version').notNull(),
    changedBy: uuid('changed_by').references(() => users.id, { onDelete: 'set null' }),

    createdAt: createdAt(),
  },
  (t) => [
    index('settings_history_user_id_idx').on(t.userId, t.createdAt),
    uniqueIndex('settings_history_user_version_unique').on(t.userId, t.version),
  ],
);

export const settingsHistoryRelations = relations(settingsHistory, ({ one }) => ({
  user: one(users, { fields: [settingsHistory.userId], references: [users.id] }),
}));

// ---------------------------------------------------------------------------

export const notifications = pgTable(
  'notifications',
  {
    id: idPk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    data: jsonb('data').notNull().default({}).$type<Record<string, unknown>>(),

    readAt: timestamptz('read_at'),
    deliveredVia: notificationChannelEnum('delivered_via').notNull().default('in_app'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    rowVersion: rowVersion(),
  },
  (t) => [
    index('notifications_user_id_idx').on(t.userId, t.createdAt),
    index('notifications_unread_idx').on(t.userId).where(isNull(t.readAt)),
    index('notifications_type_idx').on(t.type),
  ],
);

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, { fields: [notifications.userId], references: [users.id] }),
}));
