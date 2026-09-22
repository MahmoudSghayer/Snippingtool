import { describe, expect, it } from 'vitest';

import { decodeCursor, encodeCursor, paginate } from '../pagination.js';

describe('pagination helpers', () => {
  it('encodeCursor/decodeCursor round-trips', () => {
    const cursor = encodeCursor({ v: '2026-01-01T00:00:00.000Z', id: 'abc-123' });
    expect(decodeCursor(cursor)).toEqual({ v: '2026-01-01T00:00:00.000Z', id: 'abc-123' });
  });

  it('decodeCursor returns null for undefined, garbage, or malformed payloads', () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor('not-base64url-json')).toBeNull();
    expect(
      decodeCursor(Buffer.from(JSON.stringify({ foo: 'bar' })).toString('base64url')),
    ).toBeNull();
  });

  it('paginate returns all rows with a null cursor when under the limit', () => {
    const rows = [{ id: '1' }, { id: '2' }];
    const { items, nextCursor } = paginate(rows, 10, () => '2026-01-01');
    expect(items).toHaveLength(2);
    expect(nextCursor).toBeNull();
  });

  it('paginate truncates to the limit and returns a cursor for the last included row', () => {
    const rows = [{ id: '1' }, { id: '2' }, { id: '3' }]; // limit+1 fetched by the caller
    const { items, nextCursor } = paginate(rows, 2, (r) => `v-${r.id}`);
    expect(items).toHaveLength(2);
    expect(items.map((r) => r.id)).toEqual(['1', '2']);
    expect(nextCursor).not.toBeNull();
    expect(decodeCursor(nextCursor!)).toEqual({ v: 'v-2', id: '2' });
  });
});
