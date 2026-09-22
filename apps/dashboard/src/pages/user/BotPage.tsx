// The bot's own page: the saved searches it rotates through, and which of
// them are armed.
//
// `GET /api/v1/filters` already existed here, but only as a picker feeding
// the Analytics "Filter performance" tab — the create/update/delete half of
// the module (docs/03-api.md "filters") had no dashboard caller at all, so a
// search could only ever be created from the extension's own options page.
// This page is that missing half: the companion-site surface for building a
// search, arming it, ordering the rotation and retiring it.
//
// `isActive` is the arming switch the extension's ranker reads — an inactive
// filter stays saved (and keeps its realised-return history) but is skipped
// when picking what to search next, which is what makes it a pause rather
// than a delete.

import { zodResolver } from '@hookform/resolvers/zod';
import { filterCriteriaSchema } from '@sl/shared';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DataTable,
  EmptyState,
  FormField,
  Input,
  Modal,
  PageHeader,
  Select,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  formatDate,
  type ColumnDef,
} from '@sl/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { api, apiErrorMessage } from '@/api/client.js';
import { MarketPanel } from '@/pages/user/MarketPanel.js';

type SavedFilterRow = {
  id: string;
  name: string;
  filter: Record<string, unknown>;
  filterHash: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
};

// A number input yields '' when cleared, not undefined, and every criteria
// field is optional — so normalise '' to undefined before the shared schema
// sees it, rather than letting `z.number()` reject an empty optional field.
const optionalInt = (max?: number) =>
  z.preprocess(
    (v) => (v === '' || v === null || v === undefined ? undefined : Number(v)),
    max === undefined
      ? z.number().int().min(0).optional()
      : z.number().int().min(0).max(max).optional(),
  );

const optionalText = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().min(1).max(10).optional(),
);

const QUALITIES = ['bronze', 'silver', 'gold', 'special'] as const;

const filterFormSchema = z
  .object({
    name: z.string().min(1, 'Name is required').max(80),
    resourceId: optionalInt(),
    minPrice: optionalInt(),
    maxPrice: optionalInt(),
    minRating: optionalInt(99),
    maxRating: optionalInt(99),
    position: optionalText,
    nationality: optionalInt(),
    league: optionalInt(),
    club: optionalInt(),
    quality: z.preprocess(
      (v) => (v === '' || v === 'any' || v === undefined ? undefined : v),
      z.enum(QUALITIES).optional(),
    ),
  })
  // Catches the two ranges that silently match nothing on the EA side rather
  // than erroring, which is a confusing way to find out a search is dead.
  .refine((v) => v.minPrice === undefined || v.maxPrice === undefined || v.minPrice <= v.maxPrice, {
    message: 'Min price must not exceed max price',
    path: ['minPrice'],
  })
  .refine(
    (v) => v.minRating === undefined || v.maxRating === undefined || v.minRating <= v.maxRating,
    { message: 'Min rating must not exceed max rating', path: ['minRating'] },
  );

type FilterFormValues = z.input<typeof filterFormSchema>;

const CRITERIA_KEYS = [
  'resourceId',
  'minPrice',
  'maxPrice',
  'minRating',
  'maxRating',
  'position',
  'nationality',
  'league',
  'club',
  'quality',
] as const;

const CRITERIA_LABELS: Record<(typeof CRITERIA_KEYS)[number], string> = {
  resourceId: 'Player',
  minPrice: 'Min price',
  maxPrice: 'Max price',
  minRating: 'Min rating',
  maxRating: 'Max rating',
  position: 'Position',
  nationality: 'Nation',
  league: 'League',
  club: 'Club',
  quality: 'Quality',
};

function toCriteria(values: FilterFormValues): Record<string, unknown> {
  const parsed = filterFormSchema.parse(values);
  const criteria: Record<string, unknown> = {};
  for (const key of CRITERIA_KEYS) {
    const value = parsed[key];
    if (value !== undefined) criteria[key] = value;
  }
  // Round-trips the result through the canonical schema so this page can
  // never post a shape the API would reject.
  return filterCriteriaSchema.parse(criteria);
}

function describeCriteria(filter: Record<string, unknown>): string {
  const parts = CRITERIA_KEYS.filter((k) => filter[k] !== undefined).map(
    (k) => `${CRITERIA_LABELS[k]} ${String(filter[k])}`,
  );
  return parts.length > 0 ? parts.join(' · ') : 'No criteria — matches everything';
}

function emptyForm(): FilterFormValues {
  return {
    name: '',
    resourceId: '',
    minPrice: '',
    maxPrice: '',
    minRating: '',
    maxRating: '',
    position: '',
    nationality: '',
    league: '',
    club: '',
    quality: 'any',
  } as unknown as FilterFormValues;
}

function toForm(row: SavedFilterRow): FilterFormValues {
  const f = row.filter;
  const str = (k: string) => (f[k] === undefined ? '' : String(f[k]));
  return {
    name: row.name,
    resourceId: str('resourceId'),
    minPrice: str('minPrice'),
    maxPrice: str('maxPrice'),
    minRating: str('minRating'),
    maxRating: str('maxRating'),
    position: str('position'),
    nationality: str('nationality'),
    league: str('league'),
    club: str('club'),
    quality: f.quality === undefined ? 'any' : String(f.quality),
  } as unknown as FilterFormValues;
}

export function BotPage() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<SavedFilterRow | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [deleting, setDeleting] = useState<SavedFilterRow | null>(null);

  const filtersQuery = useQuery({
    queryKey: ['filters'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/filters');
      if (error) throw error;
      return (data ?? []) as unknown as SavedFilterRow[];
    },
  });

  // `GET /filters` returns insertion order, not rotation order — the ranker
  // reads `sortOrder`, so sort here to match what the extension will do.
  const rows = [...(filtersQuery.data ?? [])].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
  );
  const activeCount = rows.filter((r) => r.isActive).length;

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['filters'] });

  const form = useForm<FilterFormValues>({
    resolver: zodResolver(filterFormSchema),
    defaultValues: emptyForm(),
  });

  const saveMutation = useMutation({
    mutationFn: async (values: FilterFormValues) => {
      const body = { name: filterFormSchema.parse(values).name, filter: toCriteria(values) };
      if (editing) {
        const { error } = await api.PATCH('/api/v1/filters/{id}', {
          params: { path: { id: editing.id } },
          body: body as never,
        });
        if (error) throw error;
      } else {
        const { error } = await api.POST('/api/v1/filters', { body: body as never });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success(editing ? 'Search updated' : 'Search created');
      setFormOpen(false);
      setEditing(null);
      form.reset(emptyForm());
      invalidate();
    },
    onError: (e) => toast.error(apiErrorMessage(e, 'Could not save the search')),
  });

  const patchMutation = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Record<string, unknown> }) => {
      const { error } = await api.PATCH('/api/v1/filters/{id}', {
        params: { path: { id } },
        body: patch as never,
      });
      if (error) throw error;
    },
    onSuccess: invalidate,
    onError: (e) => toast.error(apiErrorMessage(e, 'Could not update the search')),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await api.DELETE('/api/v1/filters/{id}', { params: { path: { id } } });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Search deleted');
      setDeleting(null);
      invalidate();
    },
    onError: (e) => toast.error(apiErrorMessage(e, 'Could not delete the search')),
  });

  // Rotation order is a plain integer the ranker sorts on, so a swap with the
  // neighbour is the whole reorder — two PATCHes, no server-side move route.
  function move(row: SavedFilterRow, direction: -1 | 1) {
    const index = rows.findIndex((r) => r.id === row.id);
    const neighbour = rows[index + direction];
    if (!neighbour) return;
    patchMutation.mutate({ id: row.id, patch: { sortOrder: neighbour.sortOrder } });
    patchMutation.mutate({ id: neighbour.id, patch: { sortOrder: row.sortOrder } });
  }

  function openCreate() {
    setEditing(null);
    form.reset(emptyForm());
    setFormOpen(true);
  }

  function openEdit(row: SavedFilterRow) {
    setEditing(row);
    form.reset(toForm(row));
    setFormOpen(true);
  }

  const columns: ColumnDef<SavedFilterRow, unknown>[] = [
    {
      id: 'name',
      header: 'Search',
      cell: (c) => (
        <div>
          <p className="font-medium">{c.row.original.name}</p>
          <p className="text-xs text-(--sl-fg-muted)">{describeCriteria(c.row.original.filter)}</p>
        </div>
      ),
    },
    {
      id: 'isActive',
      header: 'Armed',
      cell: (c) => (
        <Switch
          checked={c.row.original.isActive}
          onCheckedChange={(v) =>
            patchMutation.mutate({ id: c.row.original.id, patch: { isActive: v } })
          }
          aria-label={`Arm ${c.row.original.name}`}
        />
      ),
    },
    {
      id: 'order',
      header: 'Order',
      cell: (c) => {
        const row = c.row.original;
        const index = rows.findIndex((r) => r.id === row.id);
        return (
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="outline"
              disabled={index === 0 || patchMutation.isPending}
              onClick={() => move(row, -1)}
              aria-label={`Move ${row.name} earlier`}
            >
              ↑
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={index === rows.length - 1 || patchMutation.isPending}
              onClick={() => move(row, 1)}
              aria-label={`Move ${row.name} later`}
            >
              ↓
            </Button>
          </div>
        );
      },
    },
    { id: 'createdAt', header: 'Created', cell: (c) => formatDate(c.row.original.createdAt) },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title="Bot" description="What the bot looks for, and what the market is doing." />

      <Tabs defaultValue="searches">
        <TabsList>
          <TabsTrigger value="searches">Saved searches</TabsTrigger>
          <TabsTrigger value="market">Market</TabsTrigger>
        </TabsList>

        <TabsContent value="market">
          <MarketPanel />
        </TabsContent>

        <TabsContent value="searches" className="space-y-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>
                Saved searches{' '}
                <Badge tone={activeCount > 0 ? 'positive' : 'neutral'}>{activeCount} armed</Badge>
              </CardTitle>
              <Button size="sm" onClick={openCreate}>
                New search
              </Button>
            </CardHeader>
            <CardContent>
              {!filtersQuery.isLoading && rows.length === 0 ? (
                <EmptyState
                  title="No saved searches yet"
                  description="Create one to give the bot something to look for. Nothing is searched until at least one is armed."
                  action={<Button onClick={openCreate}>New search</Button>}
                />
              ) : (
                <DataTable
                  columns={columns}
                  data={rows}
                  isLoading={filtersQuery.isLoading}
                  isError={filtersQuery.isError}
                  onRetry={() => void filtersQuery.refetch()}
                  emptyTitle="No saved searches"
                  getRowId={(row) => row.id}
                  rowActions={(row) => (
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" onClick={() => openEdit(row)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="destructive" onClick={() => setDeleting(row)}>
                        Delete
                      </Button>
                    </div>
                  )}
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Modal
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) setEditing(null);
        }}
        size="lg"
        title={editing ? `Edit “${editing.name}”` : 'New search'}
        description="Every field except the name is optional — leave one blank to not constrain it."
        footer={
          <>
            <Button variant="outline" onClick={() => setFormOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={saveMutation.isPending}
              onClick={() => void form.handleSubmit((v) => saveMutation.mutate(v))()}
            >
              {editing ? 'Save changes' : 'Create search'}
            </Button>
          </>
        }
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void form.handleSubmit((v) => saveMutation.mutate(v))();
          }}
        >
          <FormField
            label="Name"
            htmlFor="name"
            required
            error={form.formState.errors.name?.message}
          >
            <Input
              id="name"
              placeholder="e.g. Gold defenders under 2k"
              {...form.register('name')}
            />
          </FormField>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField
              label="Min price"
              htmlFor="minPrice"
              error={form.formState.errors.minPrice?.message}
            >
              <Input id="minPrice" type="number" min={0} {...form.register('minPrice')} />
            </FormField>
            <FormField
              label="Max price"
              htmlFor="maxPrice"
              error={form.formState.errors.maxPrice?.message}
            >
              <Input id="maxPrice" type="number" min={0} {...form.register('maxPrice')} />
            </FormField>
            <FormField
              label="Min rating"
              htmlFor="minRating"
              error={form.formState.errors.minRating?.message}
            >
              <Input
                id="minRating"
                type="number"
                min={0}
                max={99}
                {...form.register('minRating')}
              />
            </FormField>
            <FormField
              label="Max rating"
              htmlFor="maxRating"
              error={form.formState.errors.maxRating?.message}
            >
              <Input
                id="maxRating"
                type="number"
                min={0}
                max={99}
                {...form.register('maxRating')}
              />
            </FormField>
            <FormField
              label="Position"
              htmlFor="position"
              hint="EA position code, e.g. CB, ST"
              error={form.formState.errors.position?.message}
            >
              <Input id="position" {...form.register('position')} />
            </FormField>
            <FormField label="Quality" htmlFor="quality">
              <Select
                value={(form.watch('quality') as string) ?? 'any'}
                onValueChange={(v) => form.setValue('quality', v as never)}
                aria-label="Quality"
                options={[
                  { value: 'any', label: 'Any' },
                  ...QUALITIES.map((q) => ({ value: q, label: q[0]!.toUpperCase() + q.slice(1) })),
                ]}
              />
            </FormField>
            <FormField
              label="Player (resource id)"
              htmlFor="resourceId"
              error={form.formState.errors.resourceId?.message}
            >
              <Input id="resourceId" type="number" min={1} {...form.register('resourceId')} />
            </FormField>
            <FormField
              label="Nation id"
              htmlFor="nationality"
              error={form.formState.errors.nationality?.message}
            >
              <Input id="nationality" type="number" min={1} {...form.register('nationality')} />
            </FormField>
            <FormField
              label="League id"
              htmlFor="league"
              error={form.formState.errors.league?.message}
            >
              <Input id="league" type="number" min={1} {...form.register('league')} />
            </FormField>
            <FormField label="Club id" htmlFor="club" error={form.formState.errors.club?.message}>
              <Input id="club" type="number" min={1} {...form.register('club')} />
            </FormField>
          </div>
        </form>
      </Modal>

      <Modal
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this search?"
        description={
          deleting
            ? `“${deleting.name}” will stop being searched. Its recorded performance history is kept.`
            : undefined
        }
        footer={
          <>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={deleteMutation.isPending}
              onClick={() => deleting && deleteMutation.mutate(deleting.id)}
            >
              Delete
            </Button>
          </>
        }
      />
    </div>
  );
}
