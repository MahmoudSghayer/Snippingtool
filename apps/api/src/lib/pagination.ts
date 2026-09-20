// Cursor-pagination helpers shared by every list endpoint. The cursor is an
// opaque base64url token encoding { sortValue, id } for the last row of the
// previous page — never a raw offset, so pages stay stable under concurrent
// writes. Callers order by (sortColumn DESC, id DESC) and use
// decodeCursor()'s values to build a `(sortColumn, id) < (v, id)` predicate
// (or `>` for ascending order).

export interface CursorPayload {
  /** ISO datetime or numeric string of the row's sort column. */
  v: string;
  /** The row's id, used as a tiebreaker when sortColumn values collide. */
  id: string;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): CursorPayload | null {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      decoded &&
      typeof decoded === 'object' &&
      typeof (decoded as CursorPayload).v === 'string' &&
      typeof (decoded as CursorPayload).id === 'string'
    ) {
      return decoded as CursorPayload;
    }
    return null;
  } catch {
    return null;
  }
}

/** Given up to `limit + 1` rows fetched (one extra to detect a next page),
 * returns the page of `limit` items plus the next cursor (or null). */
export function paginate<T extends { id: string }>(
  rows: T[],
  limit: number,
  sortValue: (row: T) => string,
): { items: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  const nextCursor = hasMore && last ? encodeCursor({ v: sortValue(last), id: last.id }) : null;
  return { items, nextCursor };
}
