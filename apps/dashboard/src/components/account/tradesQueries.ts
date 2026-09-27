// Queries for the trades section on /account. Kept out of queries.ts (the
// other sections' shared file). Every key starts with `trades`, so
// recording a sale can refresh the list, the totals and today's net at once.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/api/client.js';
import { useAuthStore } from '@/stores/auth.js';

import { todayIn } from './timezone.js';

import type { TradeStatus } from '@sl/shared';

export const TRADES_PAGE_SIZE = 25;

/** The trades section's filters, as the API's `tradeFilterQuerySchema`
 * takes them (`tz` is passed alongside). */
export interface TradeFilters {
  status?: TradeStatus;
  /** Inclusive purchase days, `YYYY-MM-DD`, in the chosen zone. */
  from?: string;
  to?: string;
}

/** The filter as query params, leaving out what isn't set. */
export function filterQuery(filters: TradeFilters, tz: string) {
  return {
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.from ? { from: filters.from } : {}),
    ...(filters.to ? { to: filters.to } : {}),
    tz,
  };
}

export function useTradesPage(
  filters: TradeFilters,
  tz: string,
  order: 'asc' | 'desc',
  cursor: string | undefined,
) {
  return useQuery({
    queryKey: ['trades', 'list', filters, tz, order, cursor ?? null],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/trades', {
        params: {
          query: {
            limit: TRADES_PAGE_SIZE,
            ...filterQuery(filters, tz),
            order,
            ...(cursor ? { cursor } : {}),
          },
        },
      });
      if (error) throw error;
      return data;
    },
    // Keep the current page on screen while the next one loads.
    placeholderData: (previous) => previous,
  });
}

export function useTradeTotals(filters: TradeFilters, tz: string) {
  return useQuery({
    queryKey: ['trades', 'totals', filters, tz],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/trades/totals', {
        params: { query: filterQuery(filters, tz) },
      });
      if (error) throw error;
      return data;
    },
  });
}

/** Net profit for today in `tz`, bucketed by the API in that zone. */
export function useTodayNet(tz: string) {
  const day = todayIn(tz);
  return useQuery({
    queryKey: ['trades', 'today', tz, day],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/analytics/me/profits', {
        params: { query: { from: day, to: day, granularity: 'lifetime', tz } },
      });
      if (error) throw error;
      return data.items[0]?.netProfit ?? 0;
    },
  });
}

/** `POST /trades/:id/close`. The API computes the tax and net itself. */
export function useRecordSale() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, sellPrice }: { id: string; sellPrice: number }) => {
      const { data, error } = await api.POST('/api/v1/trades/{id}/close', {
        params: { path: { id } },
        body: { sellPrice },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['trades'] }),
  });
}

/** Saves the trader's time zone on their account (`PATCH /users/me`). */
export function useSaveTimeZone() {
  const setSession = useAuthStore((s) => s.setSession);
  return useMutation({
    mutationFn: async (timezone: string) => {
      const { data, error } = await api.PATCH('/api/v1/users/me', { body: { timezone } });
      if (error) throw error;
      return data;
    },
    onSuccess: (user) => setSession(user),
  });
}
