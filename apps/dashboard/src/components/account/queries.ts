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
