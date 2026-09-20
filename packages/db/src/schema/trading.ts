// Matches migrations/0012_trading.sql, 0013_filters.sql.

import { isNull, relations } from 'drizzle-orm';
import { bigint, boolean, date, index, integer, jsonb, numeric, pgTable, smallint, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, deletedAt, idPk, rowVersion, timestamptz, tradeStatusEnum, updatedAt } from './common.js';
import { users } from './users.js';

export const trades = pgTable(
  'trades',
  {
    id: idPk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    tradeId: text('trade_id').notNull(),
    resourceId: text('resource_id').notNull(),
    assetId: text('asset_id'),
    rating: smallint('rating'),

    buyPrice: integer('buy_price'),
    sellPrice: integer('sell_price'),
    eaTax: integer('ea_tax'),
    netProfit: integer('net_profit'),

    status: tradeStatusEnum('status').notNull().default('bought'),
    boughtAt: timestamptz('bought_at'),
    soldAt: timestamptz('sold_at'),

    deletedAt: deletedAt(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    rowVersion: rowVersion(),
  },
  (t) => [
    uniqueIndex('trades_user_id_trade_id_unique_live').on(t.userId, t.tradeId).where(isNull(t.deletedAt)),
    index('trades_user_id_idx').on(t.userId).where(isNull(t.deletedAt)),
    index('trades_resource_id_idx').on(t.resourceId).where(isNull(t.deletedAt)),
    index('trades_status_idx').on(t.status).where(isNull(t.deletedAt)),
    index('trades_sold_at_idx').on(t.userId, t.soldAt).where(isNull(t.deletedAt)),
  ],
);

export const tradesRelations = relations(trades, ({ one }) => ({
  user: one(users, { fields: [trades.userId], references: [users.id] }),
}));

// ---------------------------------------------------------------------------

export const profits = pgTable(
  'profits',
  {
    id: idPk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    day: date('day', { mode: 'string' }).notNull(),
    coinsSpent: bigint('coins_spent', { mode: 'number' }).notNull().default(0),
    coinsEarned: bigint('coins_earned', { mode: 'number' }).notNull().default(0),
    netProfit: bigint('net_profit', { mode: 'number' }).notNull().default(0),
    snipes: integer('snipes').notNull().default(0),
    successes: integer('successes').notNull().default(0),
    tradesClosed: integer('trades_closed').notNull().default(0),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    rowVersion: rowVersion(),
  },
  (t) => [
    uniqueIndex('profits_user_id_day_unique').on(t.userId, t.day),
    index('profits_day_idx').on(t.day),
    index('profits_user_id_idx').on(t.userId, t.day),
  ],
);

export const profitsRelations = relations(profits, ({ one }) => ({
  user: one(users, { fields: [profits.userId], references: [users.id] }),
}));

// ---------------------------------------------------------------------------

export const savedFilters = pgTable(
  'saved_filters',
  {
    id: idPk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    filter: jsonb('filter').notNull().$type<Record<string, unknown>>(),
    filterHash: text('filter_hash').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: smallint('sort_order').notNull().default(0),

    deletedAt: deletedAt(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    rowVersion: rowVersion(),
  },
  (t) => [
    uniqueIndex('saved_filters_user_filter_hash_unique_live').on(t.userId, t.filterHash).where(isNull(t.deletedAt)),
    index('saved_filters_user_id_idx').on(t.userId, t.sortOrder).where(isNull(t.deletedAt)),
  ],
);

export const savedFiltersRelations = relations(savedFilters, ({ one, many }) => ({
  user: one(users, { fields: [savedFilters.userId], references: [users.id] }),
  stats: many(filterStats),
}));

// ---------------------------------------------------------------------------

export const filterStats = pgTable(
  'filter_stats',
  {
    id: idPk(),
    filterId: uuid('filter_id')
      .notNull()
      .references(() => savedFilters.id, { onDelete: 'cascade' }),

    windowStart: timestamptz('window_start').notNull(),
    searches: integer('searches').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    successes: integer('successes').notNull().default(0),
    coinsSpent: bigint('coins_spent', { mode: 'number' }).notNull().default(0),
    coinsEarned: bigint('coins_earned', { mode: 'number' }).notNull().default(0),
    coinsPerHour: numeric('coins_per_hour', { precision: 14, scale: 2 }).notNull().default('0'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    rowVersion: rowVersion(),
  },
  (t) => [
    uniqueIndex('filter_stats_filter_window_unique').on(t.filterId, t.windowStart),
    index('filter_stats_filter_id_idx').on(t.filterId, t.windowStart),
    index('filter_stats_coins_per_hour_idx').on(t.coinsPerHour),
  ],
);

export const filterStatsRelations = relations(filterStats, ({ one }) => ({
  filter: one(savedFilters, { fields: [filterStats.filterId], references: [savedFilters.id] }),
}));
