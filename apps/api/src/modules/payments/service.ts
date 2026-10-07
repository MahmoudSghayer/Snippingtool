// Payment history. Rows in `payments` are written when an admin approves a
// PayPal payment claim (modules/payment-claims), with provider = 'manual'.

import { payments, type Database } from '@sl/db';
import { and, desc, eq, lt } from 'drizzle-orm';

import { decodeCursor, paginate } from '../../lib/pagination.js';

export type PaymentRow = typeof payments.$inferSelect;

export interface PaymentHistoryPage {
  items: PaymentRow[];
  nextCursor: string | null;
}

export async function listPaymentHistory(
  db: Database,
  userId: string,
  limit: number,
  cursor?: string,
): Promise<PaymentHistoryPage> {
  const decoded = decodeCursor(cursor);
  const rows = await db.query.payments.findMany({
    where: decoded
      ? and(eq(payments.userId, userId), lt(payments.createdAt, new Date(decoded.v)))
      : eq(payments.userId, userId),
    orderBy: [desc(payments.createdAt)],
    limit: limit + 1,
  });
  return paginate(rows, limit, (row) => row.createdAt.toISOString());
}
