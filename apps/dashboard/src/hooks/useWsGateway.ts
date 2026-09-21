// Mounted once by the authenticated app shell. Owns the single WsConnection
// for the session and fans every event out to the right effect
// (docs/07-dashboard.md "WS connection via ticket with reconnect/backoff").
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';

import { WsConnection } from '@/lib/ws.js';
import { useAdminLiveStore } from '@/stores/adminLive.js';
import { useAuthStore } from '@/stores/auth.js';
import { useConnectionStore } from '@/stores/connection.js';

export function useWsGateway(): void {
  const queryClient = useQueryClient();
  const status = useAuthStore((s) => s.status);
  const isAdmin = useAuthStore((s) => s.admin !== null);
  const connectionRef = useRef<WsConnection | null>(null);

  useEffect(() => {
    if (status !== 'authenticated') {
      useConnectionStore.getState().setStatus('closed');
      return;
    }

    const connection = new WsConnection(
      (event) => {
        switch (event.type) {
          case 'session.revoked': {
            useAuthStore.getState().clearSession();
            toast.error('You were signed out', {
              description:
                event.reason === 'admin_force_logout'
                  ? 'An administrator ended this session.'
                  : 'This session is no longer valid.',
            });
            window.location.assign('/login');
            break;
          }
          case 'subscription.changed': {
            void queryClient.invalidateQueries({ queryKey: ['subscription'] });
            toast.info('Subscription updated', {
              description: `Your plan is now ${event.subscription.status}.`,
            });
            break;
          }
          case 'notification.new': {
            void queryClient.invalidateQueries({ queryKey: ['notifications'] });
            toast(event.notification.title, { description: event.notification.body });
            break;
          }
          case 'feature_toggles.changed': {
            void queryClient.invalidateQueries({ queryKey: ['admin', 'toggles'] });
            if (isAdmin)
              toast.info('Feature toggles changed', {
                description: `${event.toggles.length} toggle(s) updated.`,
              });
            break;
          }
          case 'kill_switch': {
            if (isAdmin) {
              toast.warning(event.active ? 'Kill switch activated' : 'Kill switch deactivated', {
                description: event.reason,
              });
            }
            break;
          }
          case 'admin.overview.tick': {
            useAdminLiveStore.getState().setTick(event);
            break;
          }
        }
      },
      (wsStatus) => useConnectionStore.getState().setStatus(wsStatus),
    );

    connectionRef.current = connection;
    void connection.connect();

    return () => {
      connection.close();
      connectionRef.current = null;
    };
  }, [status, isAdmin, queryClient]);
}
