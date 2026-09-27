// One-click starter searches for a new customer (STARTER_FILTERS in
// @sl/shared). Each "Add" saves the filter through the normal
// POST /filters; a starter whose criteria already match a saved filter shows
// as "Added" instead.
import { STARTER_FILTERS, type FilterCriteria, type StarterFilter } from '@sl/shared';
import { Button } from '@sl/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { api, apiErrorMessage } from '@/api/client.js';
import { useSavedFilters } from '@/components/account/queries.js';

/** Key-order-independent form of a filter, for "is this the same search". */
export function criteriaKey(filter: FilterCriteria): string {
  const entries = Object.entries(filter)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

export function StarterFilters() {
  const queryClient = useQueryClient();
  const filtersQuery = useSavedFilters();
  const saved = new Set((filtersQuery.data ?? []).map((f) => criteriaKey(f.filter)));

  const addMutation = useMutation({
    mutationFn: async (starter: StarterFilter) => {
      const { error } = await api.POST('/api/v1/filters', {
        body: { name: starter.name, filter: starter.filter },
      });
      if (error) throw error;
    },
    onSuccess: (_data, starter) => {
      toast.success(`Added "${starter.name}"`);
      void queryClient.invalidateQueries({ queryKey: ['filters'] });
    },
    onError: (error) =>
      toast.error("Couldn't add the filter", { description: apiErrorMessage(error) }),
  });

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-2">
        These are starting points to learn how searches work, not recommendations. Prices change
        all the time, so edit them to suit your club and budget.
      </p>
      <ul className="flex flex-col gap-2">
        {STARTER_FILTERS.map((starter) => {
          const added = saved.has(criteriaKey(starter.filter));
          const pending = addMutation.isPending && addMutation.variables?.key === starter.key;
          return (
            <li
              key={starter.key}
              className="flex flex-col gap-2 rounded-md border border-line p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-ink">{starter.name}</span>
                <span className="text-xs text-ink-2">{starter.description}</span>
              </div>
              {added ? (
                <Button size="sm" variant="outline" disabled aria-label={`${starter.name} added`}>
                  Added
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  loading={pending}
                  disabled={filtersQuery.isLoading || addMutation.isPending}
                  aria-label={`Add ${starter.name}`}
                  onClick={() => addMutation.mutate(starter)}
                >
                  Add
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
