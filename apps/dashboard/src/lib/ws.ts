// WebSocket client: ticket handshake, reconnect with backoff, and dispatch
// of every @sl/shared WsEvent to the right store/query-cache effect
// (docs/07-dashboard.md "Auth/CSRF/WS handling"; docs/03-api.md §`ws`).
import { wsEventSchema } from '@sl/shared';

import { api, API_BASE_URL } from '@/api/client.js';

import type { WsEvent } from '@sl/shared';

export type WsEventHandler = (event: WsEvent) => void;
export type WsStatus = 'connecting' | 'open' | 'closed';
export type WsStatusHandler = (status: WsStatus) => void;
export type WsReconnectHandler = () => void;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/** The API's own origin for the WebSocket upgrade. Vercel's rewrite proxy
 * (vercel.json) makes ordinary HTTP calls same-origin so cookies work in
 * browsers that block third-party cookies, but Vercel cannot proxy a
 * WebSocket upgrade — this connection always goes straight to the API, over
 * a ticket (issued by an already-authenticated same-origin call), never a
 * cookie, so going cross-site here needs no CSRF/cookie story of its own.
 * Falls back to API_BASE_URL for local dev, where the two already coincide. */
const WS_ORIGIN = import.meta.env.VITE_WS_ORIGIN?.replace(/\/$/, '') || API_BASE_URL;

function wsUpgradeUrl(ticket: string): string {
  // WS_ORIGIN is the bare origin (or '' for the dev proxy / same-origin
  // case) — the WS upgrade itself is unprefixed (docs/03-api.md §ws), so no
  // `/api/v1` stripping is needed here, just the http(s) -> ws(s) swap.
  const absoluteBase = WS_ORIGIN.startsWith('http')
    ? WS_ORIGIN
    : `${window.location.origin}${WS_ORIGIN}`;
  const wsBase = absoluteBase.replace(/^http/, 'ws');
  return `${wsBase}/ws?ticket=${encodeURIComponent(ticket)}`;
}

export class WsConnection {
  private socket: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByCaller = false;
  // Set once the socket has completed its first successful `open`, so a
  // later `open` (i.e. after a drop + backoff, not the initial connect) can
  // be told apart and trigger a cache reconciliation — see `onReconnect`.
  private hasConnectedOnce = false;

  constructor(
    private readonly onEvent: WsEventHandler,
    private readonly onStatus?: WsStatusHandler,
    // Called when the socket reopens after a *reconnect* (not the first
    // connect). While the socket was down, WS-pushed events (notifications,
    // subscription/toggle changes, ...) were missed, so the cache they'd
    // normally keep fresh can be stale — the caller should invalidate it.
    private readonly onReconnect?: WsReconnectHandler,
  ) {}

  async connect(): Promise<void> {
    this.closedByCaller = false;
    this.onStatus?.('connecting');
    try {
      const { data, error } = await api.POST('/api/v1/ws/ticket', {});
      if (error || !data) {
        this.scheduleReconnect();
        return;
      }
      const url = wsUpgradeUrl(data.ticket);
      const socket = new WebSocket(url);
      this.socket = socket;

      socket.addEventListener('open', () => {
        this.reconnectAttempt = 0;
        const isReconnect = this.hasConnectedOnce;
        this.hasConnectedOnce = true;
        this.onStatus?.('open');
        if (isReconnect) this.onReconnect?.();
      });
      socket.addEventListener('message', (event) => {
        try {
          const parsed = wsEventSchema.safeParse(JSON.parse(event.data as string));
          if (parsed.success) this.onEvent(parsed.data);
        } catch {
          // Malformed frame — ignore rather than crash the connection.
        }
      });
      socket.addEventListener('close', () => {
        this.socket = null;
        this.onStatus?.('closed');
        if (!this.closedByCaller) this.scheduleReconnect();
      });
      socket.addEventListener('error', () => {
        socket.close();
      });
    } catch {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closedByCaller) return;
    this.onStatus?.('closed');
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  close(): void {
    this.closedByCaller = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = null;
    this.onStatus?.('closed');
  }
}
