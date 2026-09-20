import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, EmptyState, IconButton , formatRelativeTime } from '@sl/ui';
import { useQuery } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { useState } from 'react';


import { api } from '@/api/client.js';

/** Topbar bell fed by `GET /notifications` (polled on open) and kept fresh
 * in near-real-time by the WS `notification.new` handler invalidating this
 * same query key (src/hooks/useWsGateway.ts). */
export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/notifications', { params: { query: { limit: 10 } } });
      if (error) throw error;
      return data;
    },
  });

  const unread = data?.items.filter((n) => !n.readAt).length ?? 0;

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
          <IconButton icon={<Bell className="size-4" />} label="Notifications" />
        </DropdownMenuTrigger>
        {unread > 0 && (
          <span className="pointer-events-none absolute -right-0.5 -top-0.5 flex size-4 items-center justify-center rounded-full bg-risk text-[10px] font-semibold text-ground">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </div>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>Notifications</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {!data?.items.length ? (
          <EmptyState title="No notifications yet" className="py-6" />
        ) : (
          <div className="flex max-h-80 flex-col gap-1 overflow-y-auto">
            {data.items.map((n) => (
              <div key={n.id} className="rounded-sm px-2.5 py-2 hover:bg-surface-2">
                <p className="text-sm font-medium text-ink">{n.title}</p>
                <p className="mt-0.5 text-xs text-ink-2">{n.body}</p>
                <p className="mt-1 text-[11px] text-ink-2">{formatRelativeTime(n.createdAt)}</p>
              </div>
            ))}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
