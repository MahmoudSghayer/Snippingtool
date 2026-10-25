// Matches migrations/0015_settings.sql, 0016_notifications.sql,
// 0037_user_recent_searches.sql, 0039_user_bot_settings.sql,
// 0041_user_gallery.sql.

import { isNull, relations } from 'drizzle-orm';
import { bigint, index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import {
  createdAt,
  idPk,
  notificationChannelEnum,
  rowVersion,
  timestamptz,
  updatedAt,
} from './common.js';
import { users } from './users.js';

export const userSettings = pgTable('user_settings', {
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
});

export const userSettingsRelations = relations(userSettings, ({ one }) => ({
  user: one(users, { fields: [userSettings.userId], references: [users.id] }),
}));

// ---------------------------------------------------------------------------

/** The Nova AI page's Recent searches log, replaced whole by
 * `PUT /extension/recent-searches` (items: @sl/shared `RecentSearchDto[]`). */
export const userRecentSearches = pgTable('user_recent_searches', {
  id: idPk(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),

  items: jsonb('items').notNull().default([]).$type<unknown[]>(),

  createdAt: createdAt(),
  updatedAt: updatedAt(),
  rowVersion: rowVersion(),
});

export const userRecentSearchesRelations = relations(userRecentSearches, ({ one }) => ({
  user: one(users, { fields: [userRecentSearches.userId], references: [users.id] }),
}));

// ---------------------------------------------------------------------------

/** The Nova AI bot's settings, replaced whole by `PUT /extension/bot-settings`
 * (settings: @sl/shared `BotSettings`). 0039_user_bot_settings.sql. */
export const userBotSettings = pgTable('user_bot_settings', {
  id: idPk(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),

  settings: jsonb('settings').notNull().$type<Record<string, unknown>>(),

  createdAt: createdAt(),
  updatedAt: updatedAt(),
  rowVersion: rowVersion(),
});

export const userBotSettingsRelations = relations(userBotSettings, ({ one }) => ({
  user: one(users, { fields: [userBotSettings.userId], references: [users.id] }),
}));

// ---------------------------------------------------------------------------

/** Nova AI's Gallery mode list, replaced whole by `PUT /extension/gallery`
 * (state: @sl/shared `GalleryState`). 0041_user_gallery.sql. */
export const userGallery = pgTable('user_gallery', {
  id: idPk(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),

  state: jsonb('state').notNull().$type<Record<string, unknown>>(),

  createdAt: createdAt(),
  updatedAt: updatedAt(),
  rowVersion: rowVersion(),
});

export const userGalleryRelations = relations(userGallery, ({ one }) => ({
  user: one(users, { fields: [userGallery.userId], references: [users.id] }),
}));

/** Every card id the account has put through its club in Gallery mode. A card
 * counts for FC's Gallery once it has passed through the club, so Nova lists
 * it again and sells it; this is the durable record that it stays collected,
 * after it leaves the club and on any browser the trader signs in on. Merged
 * into `owned` when a Set is planned, so a catalogued card is never bought
 * again. GET/POST `/api/v1/extension/gallery/owned`. 0042_user_gallery_owned.sql. */
export const userGalleryOwned = pgTable(
  'user_gallery_owned',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** EA's card id (resourceId). bigint: a holographic/special card's id can
     * run past a 32-bit integer. */
    resourceId: bigint('resource_id', { mode: 'number' }).notNull(),
    firstSeenAt: timestamptz('first_seen_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.resourceId] })],
);

export const userGalleryOwnedRelations = relations(userGalleryOwned, ({ one }) => ({
  user: one(users, { fields: [userGalleryOwned.userId], references: [users.id] }),
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
