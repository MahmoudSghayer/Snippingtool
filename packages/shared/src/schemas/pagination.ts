import { z } from 'zod';

/** Cursor-based pagination request, used by every list endpoint. `cursor` is
 * an opaque, base64url-encoded token the previous page's `nextCursor`
 * returned — never a raw offset, so results stay stable under concurrent
 * writes. */
export const paginationQuerySchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export function paginatedResponseSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().min(1).max(2048).nullable(),
  });
}
export type PaginatedResponse<T> = { items: T[]; nextCursor: string | null };
