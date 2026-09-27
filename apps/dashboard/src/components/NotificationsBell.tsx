import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  IconButton,
  cn,
  formatRelativeTime,
} from '@sl/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { api, apiErrorMessage } from '@/api/client.js';

const NOTIFICATIONS_KEY = ['notifications'] as const;

/** Topbar bell fed by `GET /notifications` (polled on open) and kept fresh
 * in near-real-time by the WS `notification.new` handler invalidating this
 * same query key (src/hooks/useWsGateway.ts). Each notification is a menu
 * item, so the list is reachable with the arrow keys; choosing an unread
 * one marks it read, and "Mark all as read" clears the lot. */
export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: NOTIFICATIONS_KEY,
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/notifications', {
        params: { query: { limit: 10 } },
      });
      if (error) throw error;
      return data;
    },
  });

  const refresh = () => void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
  const markRead = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await api.POST('/api/v1/notifications/{id}/read', {
        params: { path: { id } },
      });
      if (error) throw error;
    },
    onSuccess: refresh,
    onError: (error) =>
      toast.error("Couldn't mark the notification read", { description: apiErrorMessage(error) }),
  });
  const markAllRead = useMutation({
    mutationFn: async () => {
      const { error } = await api.POST('/api/v1/notifications/read-all');
      if (error) throw error;
    },
    onSuccess: refresh,
    onError: (error) =>
      toast.error("Couldn't mark notifications read", { description: apiErrorMessage(error) }),
  });

  const unread = data?.items.filter((n) => !n.readAt).length ?? 0;
  // The badge is decoration (aria-hidden); the count goes in the name, so a
  // screen reader hears "Notifications, 2 unread".
  const label = unread > 0 ? `Notifications, ${unread} unread` : 'Notifications';

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      {/* The `relative` positioning wrapper stays *outside* the trigger so
          Radix's `asChild` merges its aria-haspopup/aria-expanded/
          aria-controls straight onto the real `<button>` (IconButton) —
          those attributes aren't valid on a plain `<div>`'s implicit
          "generic" role (axe `aria-allowed-attr`, caught by this pass's
          new accessibility e2e). The unread badge is a sibling, not a
          trigger child, so it never affects the trigger's accessible
          name/role either. */}
      <div className="relative">
        <DropdownMenuTrigger asChild>
          <IconButton icon={<Bell className="size-4" />} label={label} />
        </DropdownMenuTrigger>
        {unread > 0 && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -right-0.5 -top-0.5 flex size-4 items-center justify-center rounded-full bg-risk text-[10px] font-semibold text-ground"
          >
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </div>
      <DropdownMenuContent align="end" className="w-80 max-w-[calc(100vw-2rem)]">
        <DropdownMenuLabel>Notifications</DropdownMenuLabel>
        {unread > 0 && (
          <DropdownMenuItem
            className="min-h-11 text-xs text-gold sm:min-h-0"
            // Stay open so the trader sees the list clear.
            onSelect={(e) => {
              e.preventDefault();
              markAllRead.mutate();
            }}
          >
            Mark all as read
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        {!data?.items.length ? (
          <EmptyState title="No notifications yet" className="py-6" />
        ) : (
          <div className="flex max-h-80 flex-col gap-1 overflow-y-auto">
            {data.items.map((n) => (
              <DropdownMenuItem
                key={n.id}
                className={cn('flex-col items-start gap-0 py-2', !n.readAt && 'bg-surface-2/60')}
                onSelect={(e) => {
                  e.preventDefault();
                  if (!n.readAt) markRead.mutate(n.id);
                }}
              >
                <span className="flex w-full items-center gap-2 text-sm font-medium text-ink">
                  {!n.readAt && (
                    <span className="size-1.5 shrink-0 rounded-full bg-gold" aria-hidden="true" />
                  )}
                  {n.title}
                  {!n.readAt && <span className="sr-only"> (unread)</span>}
                </span>
                {n.body && <span className="mt-0.5 text-xs text-ink-2">{n.body}</span>}
                <span className="mt-1 text-[11px] text-ink-2">
                  {formatRelativeTime(n.createdAt)}
                </span>
              </DropdownMenuItem>
            ))}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
