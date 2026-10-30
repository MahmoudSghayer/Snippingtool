// "Gallery" on /account: Nova AI's Gallery mode as saved on the account —
// the Sets in progress with every card they still need, and the Sets
// completed lately, newest first — so a session started on one browser can
// be picked up on another, and each completed Set finished in the game
// (Gallery, the Set, Autocomplete, then Confirm Changes).
//
// The list comes from `GET /extension/gallery` (what the extension saves,
// at most every 2 s while the bot runs); the completed log from
// `GET /extension/gallery/completions` (user_gallery_completions, kept after
// the list is cleared), with the list's own `completed` as the fallback
// while an API without that route serves the account.
import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  Skeleton,
  formatCoins,
  formatDateTime,
  formatRelativeTime,
  type BadgeTone,
} from '@sl/ui';
import { useQuery } from '@tanstack/react-query';
import { Images, Trophy } from 'lucide-react';

import { api } from '@/api/client.js';

import type {
  GalleryCard,
  GalleryCompletion,
  GalleryGrade,
  GallerySet,
  GalleryState,
} from '@sl/shared';

/** The account's list, as the extension last saved it. */
export function useGalleryList() {
  return useQuery({
    queryKey: ['gallery'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/extension/gallery');
      if (error) throw error;
      return { state: data.state as GalleryState | null, updatedAt: data.updatedAt };
    },
  });
}

/** The account's completed-Sets log, newest first. */
export function useGalleryCompletions() {
  return useQuery({
    queryKey: ['gallery', 'completions'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/extension/gallery/completions', {
        params: { query: { limit: 100 } },
      });
      if (error) throw error;
      return data.items as GalleryCompletion[];
    },
    retry: false,
  });
}

/** A card counts for a Set once it has been through the club. */
const COLLECTED = new Set<GalleryCard['status']>(['owned', 'club', 'listed']);

type Reason = 'buy' | 'collecting' | 'skipped' | 'sbc';

const REASON_LABEL: Record<Reason, string> = {
  buy: 'Still to buy',
  collecting: 'Bought, on the way to your club',
  skipped: 'Skipped: nobody lists it (retry it, or collect it in the game)',
  sbc: 'SBC / Objective: collect it in the game',
};
const REASON_ORDER: Reason[] = ['buy', 'collecting', 'skipped', 'sbc'];

function reasonOf(card: GalleryCard): Reason {
  if (card.status === 'sbc') return 'sbc';
  if (card.status === 'skipped') return 'skipped';
  if (card.status === 'bought') return 'collecting';
  return 'buy';
}

const GRADE_TONE: Record<GalleryGrade, BadgeTone> = {
  S: 'positive',
  A: 'accent',
  B: 'accent',
  C: 'neutral',
  D: 'neutral',
};

interface SetProgress {
  set: GallerySet;
  total: number;
  done: number;
  needed: { reason: Reason; cards: GalleryCard[] }[];
}

/** Each Set on the list that is not completed: how far it is, and the
 * cards it still needs, grouped by why. */
export function setsInProgress(state: GalleryState): SetProgress[] {
  const completed = new Set(state.completed ?? []);
  return (state.sets ?? [])
    .filter((set) => !completed.has(set.id))
    .map((set) => {
      const mine = state.cards.filter((c) => c.setIds?.includes(set.id));
      const groups = new Map<Reason, GalleryCard[]>();
      for (const card of mine) {
        if (COLLECTED.has(card.status)) continue;
        const reason = reasonOf(card);
        groups.set(reason, [...(groups.get(reason) ?? []), card]);
      }
      return {
        set,
        total: mine.length,
        done: mine.filter((c) => COLLECTED.has(c.status)).length,
        needed: REASON_ORDER.filter((r) => groups.has(r)).map((reason) => ({
          reason,
          cards: groups.get(reason)!,
        })),
      };
    });
}

/** The list's own record of completed Sets as log entries, newest first:
 * what shows while the account's log cannot be read. */
export function completionsFromState(state: GalleryState): GalleryCompletion[] {
  const at = (id: number) => state.completedAt?.[String(id)] ?? 0;
  return [...(state.completed ?? [])]
    .sort((a, b) => at(b) - at(a))
    .map((id) => {
      const set = state.sets?.find((s) => s.id === id);
      return {
        setId: id,
        name: set?.name ?? `Set #${id}`,
        grade: state.completedGrade?.[String(id)] ?? set?.grade ?? null,
        tokens: set?.tokens ?? null,
        completedAt: new Date(at(id) || 0).toISOString(),
        undoneAt: null,
      };
    });
}

function cardLine(card: GalleryCard): string {
  const price =
    card.market != null
      ? `market ${formatCoins(card.market)}`
      : card.guide != null
        ? `fut.gg ${formatCoins(card.guide)}`
        : null;
  return [card.version, price, card.note].filter((x): x is string => !!x).join(' · ');
}

function Loading() {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 pt-5">
        <Skeleton className="h-4 w-56" />
        <Skeleton className="h-4 w-80" />
        <Skeleton className="h-4 w-64" />
      </CardContent>
    </Card>
  );
}

function Failed({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <Card>
      <CardContent className="pt-5">
        <EmptyState
          title={`Couldn't load ${what}`}
          description="Nova Trade could not be reached, or refused the request. Try again in a moment."
          action={
            <Button size="sm" variant="outline" onClick={onRetry}>
              Try again
            </Button>
          }
        />
      </CardContent>
    </Card>
  );
}

export function GallerySection() {
  const listQuery = useGalleryList();
  const logQuery = useGalleryCompletions();

  if (listQuery.isLoading) return <Loading />;
  if (listQuery.isError)
    return <Failed what="your Gallery list" onRetry={() => void listQuery.refetch()} />;

  const state = listQuery.data?.state ?? null;
  const savedAt = listQuery.data?.updatedAt ?? null;
  const inProgress = state ? setsInProgress(state) : [];
  const completions = logQuery.data ?? (state ? completionsFromState(state) : []);

  return (
    <>
      <Card>
        <CardContent className="pt-5">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-base font-semibold text-ink">Sets in progress</h3>
            <p className="text-xs text-ink-2">
              {savedAt
                ? `Saved from your browser ${formatRelativeTime(savedAt)} (${formatDateTime(savedAt)})`
                : 'Nothing saved from your browser yet'}
            </p>
          </div>
          {!state ? (
            <EmptyState
              icon={<Images className="size-5" aria-hidden="true" />}
              title="No Gallery list on your account yet"
              description="Open Nova AI in the EA FC web app while signed in: the Gallery list you build there, and every card it buys, is saved here as it goes, so another browser can pick it up where you stopped."
            />
          ) : inProgress.length === 0 ? (
            <EmptyState
              icon={<Images className="size-5" aria-hidden="true" />}
              title="No Set in progress"
              description="Every fut.gg Set on your list is completed. Add Sets from the Nova AI page to keep going."
            />
          ) : (
            <ul className="flex flex-col gap-5">
              {inProgress.map(({ set, total, done, needed }) => (
                <li key={set.id} className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-ink">{set.name}</span>
                    <Badge tone={GRADE_TONE[set.grade]}>grade {set.grade}</Badge>
                    <span className="text-sm text-ink-2">
                      {done} of {total} collected · {set.tokens} tokens
                    </span>
                  </div>
                  {needed.length === 0 ? (
                    <p className="text-sm text-ink-2">
                      Every card is collected: the extension marks it completed on its next save.
                    </p>
                  ) : (
                    needed.map(({ reason, cards }) => (
                      <div key={reason}>
                        <p className="text-xs font-medium uppercase tracking-[0.08em] text-ink-2">
                          {REASON_LABEL[reason]} · {cards.length}
                        </p>
                        <ul className="mt-1 flex flex-col gap-1">
                          {cards.map((card) => (
                            <li key={card.key} className="text-sm text-ink">
                              <span className="font-mono text-xs text-gold">{card.rating}</span>{' '}
                              {card.name}
                              {cardLine(card) && (
                                <span className="text-ink-2"> · {cardLine(card)}</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-5">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-base font-semibold text-ink">Completed Sets</h3>
            <p className="text-xs text-ink-2">
              Finish each one in the game: Gallery, the Set, Autocomplete, then Confirm Changes.
            </p>
          </div>
          {logQuery.isError && state && (
            <p className="mb-3 text-xs text-ink-2">
              The account's log could not be read; this is what your list itself marks completed.
            </p>
          )}
          {completions.length === 0 ? (
            <EmptyState
              icon={<Trophy className="size-5" aria-hidden="true" />}
              title="No Set completed yet"
              description="A Set is marked completed once every card of its lineup has been through your club. It shows here, on every browser."
            />
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {completions.map((c) => (
                <li
                  key={`${c.setId}-${c.completedAt}`}
                  className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                >
                  <span className="flex items-center gap-2">
                    <span className="text-ink">{c.name}</span>
                    {c.grade && <Badge tone={GRADE_TONE[c.grade]}>grade {c.grade}</Badge>}
                    {c.tokens != null && <span className="text-ink-2">{c.tokens} tokens</span>}
                  </span>
                  <span className="text-ink-2">
                    {new Date(c.completedAt).getTime() > 0
                      ? formatDateTime(c.completedAt)
                      : 'before dates were kept'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}
