// Queries shared by the /account sections. Keys match the ones the WS
// gateway invalidates (`['subscription']` on `subscription.changed`).
import { useQuery } from '@tanstack/react-query';

import { api } from '@/api/client.js';

export function useMySubscription() {
  return useQuery({
    queryKey: ['subscription'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/subscriptions/me');
      if (error) throw error;
      return data;
    },
  });
}

export function usePlans() {
  return useQuery({
    queryKey: ['plans'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/plans');
      if (error) throw error;
      return data;
    },
  });
}

/** Devices signed in to this account (the "Devices" section and the
 * getting-started checklist share this cache entry). */
export function useDevices() {
  return useQuery({
    queryKey: ['devices'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/devices');
      if (error) throw error;
      return data;
    },
  });
}

/** The caller's saved search filters. `enabled: false` when the plan has no
 * `assist.filter_rotation`, so the request isn't sent only to get a 403. */
export function useSavedFilters({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['filters'],
    enabled,
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/filters');
      if (error) throw error;
      return data;
    },
  });
}

/** Whether the caller has recorded at least one trade. Reads the smallest
 * page of the trades list, so it never pulls more than one row. `enabled:
 * false` when the plan has no `ledger.recorder`. */
export function useHasTrades({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['trades', 'has-any'],
    enabled,
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/trades', { params: { query: { limit: 1 } } });
      if (error) throw error;
      return data.items.length > 0;
    },
  });
}
