// EA's content calendar (docs/14-ml-suggestions.md Phase C).
//
// FUT prices are overwhelmingly supply-driven by content releases, and EA
// announces those in advance — so this list is the single most predictive
// thing on the page, even though it contains no prediction at all.
//
// The design problem here is honesty about dates. EA's promo posts do not
// state machine-readable start/end times (checked against real articles, not
// assumed), so almost every event knows only when EA *published*, not when
// the content lands. Rendering a publication date in the same visual slot a
// scheduled start would occupy asserts something nobody established, so
// `dateConfidence` is surfaced rather than smoothed over: `announced` reads
// as "announced", and only a `stated` window is shown as a window.

import { Badge, Card, CardContent, EmptyState, formatDate } from '@sl/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { api } from '@/api/client.js';

type EventKind = 'content' | 'season' | 'pitch_notes' | 'ratings_refresh' | 'other';
type DateConfidence = 'announced' | 'stated' | 'inferred';

interface MarketEventRow {
  id: string;
  kind: EventKind;
  title: string;
  slug: string;
  sourceUrl: string | null;
  announcedAt: string;
  startsAt: string | null;
  endsAt: string | null;
  dateConfidence: DateConfidence;
  fcTitle: string | null;
  summary: string | null;
}

interface EventsResponse {
  events: MarketEventRow[];
  lastCollectedAt: string | null;
}

const KIND_LABEL: Record<EventKind, string> = {
  content: 'Content',
  season: 'Season',
  pitch_notes: 'Pitch Notes',
  ratings_refresh: 'Ratings',
  other: 'Other',
};

// Pitch Notes get the accent tone because they are the one kind that reprices
// a whole cohort at once: a playstyle nerf hits every card carrying it.
const KIND_TONE: Record<EventKind, 'neutral' | 'accent' | 'positive' | 'warning'> = {
  content: 'neutral',
  season: 'positive',
  pitch_notes: 'accent',
  ratings_refresh: 'warning',
  other: 'neutral',
};

const FILTERS: { value: EventKind | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'content', label: 'Content' },
  { value: 'pitch_notes', label: 'Pitch Notes' },
  { value: 'season', label: 'Seasons' },
];

/** What we actually know about an event's timing, in words rather than a
 * date that would imply more precision than we have. */
function timingLabel(event: MarketEventRow): string {
  if (event.dateConfidence !== 'announced' && event.startsAt) {
    const start = formatDate(event.startsAt);
    return event.endsAt ? `Runs ${start} – ${formatDate(event.endsAt)}` : `Starts ${start}`;
  }
  return `Announced ${formatDate(event.announcedAt)}`;
}

export function EventsTimeline() {
  const [kind, setKind] = useState<EventKind | 'all'>('all');

  const eventsQuery = useQuery({
    queryKey: ['market', 'events', kind],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/market/events', {
        params: { query: kind === 'all' ? {} : { kind } },
      });
      if (error) throw error;
      return data as unknown as EventsResponse;
    },
  });

  const events = eventsQuery.data?.events ?? [];
  const lastCollectedAt = eventsQuery.data?.lastCollectedAt ?? null;

  return (
    <Card>
      <CardContent className="pt-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-medium">EA announcements</h3>
          <div className="flex flex-wrap gap-1">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => setKind(f.value)}
                aria-pressed={kind === f.value}
                className={
                  kind === f.value
                    ? 'rounded-md border border-(--sl-accent) px-2 py-1 text-xs text-(--sl-accent)'
                    : 'rounded-md border border-(--sl-border) px-2 py-1 text-xs text-(--sl-fg-muted) hover:text-(--sl-fg)'
                }
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {eventsQuery.isLoading && <p className="text-sm text-(--sl-fg-muted)">Loading…</p>}

        {eventsQuery.isError && (
          <EmptyState
            title="Couldn't load the calendar"
            description="The events request failed."
            action={
              <button
                type="button"
                className="text-sm underline"
                onClick={() => void eventsQuery.refetch()}
              >
                Retry
              </button>
            }
          />
        )}

        {!eventsQuery.isLoading && !eventsQuery.isError && events.length === 0 && (
          <EmptyState
            title="No announcements yet"
            // An empty calendar and a collector that has never run look
            // identical from here, and only one of them is a problem — so the
            // API returns which, and this says so.
            description={
              lastCollectedAt
                ? `Nothing matching this filter. Last collected ${formatDate(lastCollectedAt)}.`
                : 'The EA collector has not completed a run yet, so nothing has been gathered.'
            }
          />
        )}

        {events.length > 0 && (
          <ol className="space-y-3">
            {events.map((event) => (
              <li
                key={event.id}
                className="flex flex-col gap-1 border-l-2 border-(--sl-border) pl-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={KIND_TONE[event.kind]}>{KIND_LABEL[event.kind]}</Badge>
                  <span className="text-sm font-medium">
                    {event.sourceUrl ? (
                      <a
                        href={event.sourceUrl}
                        target="_blank"
                        // noopener/noreferrer: these URLs come from a scraped
                        // source, so the new tab gets no handle on this one.
                        rel="noopener noreferrer"
                        className="underline decoration-dotted underline-offset-2"
                      >
                        {event.title}
                      </a>
                    ) : (
                      event.title
                    )}
                  </span>
                  {event.fcTitle && (
                    <span className="text-xs text-(--sl-fg-muted) uppercase">{event.fcTitle}</span>
                  )}
                </div>
                <span className="text-xs text-(--sl-fg-muted)">{timingLabel(event)}</span>
                {event.summary && <p className="text-xs text-(--sl-fg-muted)">{event.summary}</p>}
              </li>
            ))}
          </ol>
        )}

        <p className="mt-4 text-xs text-(--sl-fg-muted)">
          Dates are when EA published the announcement, not when the content goes live — EA’s posts
          rarely state a start time, and showing one we inferred would look more certain than it is.
        </p>
      </CardContent>
    </Card>
  );
}
