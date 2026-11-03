// Gallery usage analytics for the admin dashboard (/admin/gallery): per-user
// totals across the three Gallery tables — completed Sets and the Gallery
// Tokens they gave (user_gallery_completions), cards put through the club
// (user_gallery_owned), and the live list's coin spend/budget (user_gallery).
// Pure, parameterised Drizzle queries: no mutation, no side-effects. The
// Gallery is a niche mode with a small user base, so each table is aggregated
// once and the three grains are merged per user in memory, rather than one
// wide join that would fan the different grains out against each other.

import {
  userGallery,
  userGalleryCompletions,
  userGalleryOwned,
  users,
  type Database,
} from '@sl/db';
import {
  GALLERY_GRADES,
  type GalleryCompletionsQuery,
  type GalleryCompletionsResponse,
  type GalleryGrade,
  type GalleryUsageResponse,
  type GalleryUsageRow,
} from '@sl/shared';
import { and, count, desc, eq, inArray, isNull, max, min, sql, sum } from 'drizzle-orm';

const GALLERY_GRADE_SET: ReadonlySet<string> = new Set(GALLERY_GRADES);

/** A timestamp aggregate (min/max of a timestamptz column, or null) rendered
 * as an ISO string. postgres-js hands these back as `Date`; guard a string
 * too so the function never assumes the driver's shape. */
function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

interface GalleryAcc {
  setsCompleted: number;
  tokensEarned: number;
  coinsSpent: number;
  coinsBudget: number;
  cardsCollected: number;
  firstCardAt: string | null;
  firstCompletedAt: string | null;
  lastCompletedAt: string | null;
}

function zeroAcc(): GalleryAcc {
  return {
    setsCompleted: 0,
    tokensEarned: 0,
    coinsSpent: 0,
    coinsBudget: 0,
    cardsCollected: 0,
    firstCardAt: null,
    firstCompletedAt: null,
    lastCompletedAt: null,
  };
}

/** Per-user Gallery totals plus the platform-wide tallies the tab's KPI tiles
 * show. One user appears for any Gallery activity: a standing completion, a
 * clubbed card, or a saved list. Rows for soft-deleted (or otherwise missing)
 * users are dropped. */
export async function getGalleryUsage(db: Database): Promise<GalleryUsageResponse> {
  // Completed Sets that still stand, the Gallery Tokens they gave, and the
  // first/last completion, per user.
  const completionRows = await db
    .select({
      userId: userGalleryCompletions.userId,
      setsCompleted: count(),
      tokensEarned: sum(userGalleryCompletions.tokens),
      firstCompletedAt: min(userGalleryCompletions.completedAt),
      lastCompletedAt: max(userGalleryCompletions.completedAt),
    })
    .from(userGalleryCompletions)
    .where(isNull(userGalleryCompletions.undoneAt))
    .groupBy(userGalleryCompletions.userId);

  // Cards put through the club, and when the first one was, per user.
  const ownedRows = await db
    .select({
      userId: userGalleryOwned.userId,
      cardsCollected: count(),
      firstCardAt: min(userGalleryOwned.firstSeenAt),
    })
    .from(userGalleryOwned)
    .groupBy(userGalleryOwned.userId);

  // The current list's coin spend and budget, per user (one row each). Read
  // the two numeric keys out of the JSONB rather than loading the whole list
  // (it can run to hundreds of KB); both are schema-capped ints well inside
  // int4, so `::int` is in range. Constant SQL (no interpolation, no user
  // input): the column is named literally, qualified by its table.
  const stateRows = await db
    .select({
      userId: userGallery.userId,
      coinsSpent: sql<number>`coalesce((user_gallery.state ->> 'spent')::int, 0)`,
      coinsBudget: sql<number>`coalesce((user_gallery.state ->> 'budget')::int, 0)`,
    })
    .from(userGallery);

  const byUser = new Map<string, GalleryAcc>();
  const ensure = (userId: string): GalleryAcc => {
    let acc = byUser.get(userId);
    if (!acc) {
      acc = zeroAcc();
      byUser.set(userId, acc);
    }
    return acc;
  };

  for (const r of completionRows) {
    const acc = ensure(r.userId);
    acc.setsCompleted = Number(r.setsCompleted ?? 0);
    acc.tokensEarned = Number(r.tokensEarned ?? 0);
    acc.firstCompletedAt = toIso(r.firstCompletedAt);
    acc.lastCompletedAt = toIso(r.lastCompletedAt);
  }
  for (const r of ownedRows) {
    const acc = ensure(r.userId);
    acc.cardsCollected = Number(r.cardsCollected ?? 0);
    acc.firstCardAt = toIso(r.firstCardAt);
  }
  for (const r of stateRows) {
    const acc = ensure(r.userId);
    acc.coinsSpent = Number(r.coinsSpent ?? 0);
    acc.coinsBudget = Number(r.coinsBudget ?? 0);
  }

  const totals = { users: 0, setsCompleted: 0, tokensEarned: 0, coinsSpent: 0, cardsCollected: 0 };
  if (byUser.size === 0) return { items: [], totals };

  // Names for the rows; a user that is gone (soft-deleted) or missing is
  // dropped from both the list and the totals.
  const liveUsers = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(and(inArray(users.id, [...byUser.keys()]), isNull(users.deletedAt)));
  const emailById = new Map(liveUsers.map((u) => [u.id, u.email]));

  const items: GalleryUsageRow[] = [];
  for (const [userId, acc] of byUser) {
    const email = emailById.get(userId);
    if (email === undefined) continue;
    items.push({ userId, email, ...acc });
    totals.users += 1;
    totals.setsCompleted += acc.setsCompleted;
    totals.tokensEarned += acc.tokensEarned;
    totals.coinsSpent += acc.coinsSpent;
    totals.cardsCollected += acc.cardsCollected;
  }

  // Most Sets first, then most tokens, then email for a stable, deterministic
  // order.
  items.sort(
    (a, b) =>
      b.setsCompleted - a.setsCompleted ||
      b.tokensEarned - a.tokensEarned ||
      a.email.localeCompare(b.email),
  );

  return { items, totals };
}

/** One user's completed-Set log (the Gallery "log" the admin row expands to),
 * newest first. Mirrors the trader-facing
 * `GET /api/v1/extension/gallery/completions`, but for any user id and behind
 * the admin `analytics.read` gate. Undone Sets are hidden unless
 * `undone === 'include'`. */
export async function getGalleryUserCompletions(
  db: Database,
  userId: string,
  opts: GalleryCompletionsQuery,
): Promise<GalleryCompletionsResponse> {
  const rows = await db
    .select({
      setId: userGalleryCompletions.setId,
      setName: userGalleryCompletions.setName,
      grade: userGalleryCompletions.grade,
      tokens: userGalleryCompletions.tokens,
      completedAt: userGalleryCompletions.completedAt,
      undoneAt: userGalleryCompletions.undoneAt,
    })
    .from(userGalleryCompletions)
    .where(
      and(
        eq(userGalleryCompletions.userId, userId),
        opts.undone === 'include' ? undefined : isNull(userGalleryCompletions.undoneAt),
      ),
    )
    .orderBy(desc(userGalleryCompletions.completedAt), desc(userGalleryCompletions.createdAt))
    .limit(opts.limit);
  return {
    items: rows.map((r) => ({
      setId: r.setId,
      name: r.setName,
      grade: r.grade !== null && GALLERY_GRADE_SET.has(r.grade) ? (r.grade as GalleryGrade) : null,
      tokens: r.tokens,
      completedAt: r.completedAt.toISOString(),
      undoneAt: r.undoneAt?.toISOString() ?? null,
    })),
  };
}
