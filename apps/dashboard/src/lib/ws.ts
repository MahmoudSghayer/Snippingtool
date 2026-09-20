// WebSocket client: ticket handshake, reconnect with backoff, and dispatch
// of every @sl/shared WsEvent to the right store/query-cache effect
// (docs/07-dashboard.md "Auth/CSRF/WS handling"; docs/03-api.md §`ws`).
import { wsEventSchema } from '@sl/shared';

import { api, API_BASE_URL } from '@/api/client.js';

import type { WsEvent } from '@sl/shared';

export type WsEventHandler = (event: WsEvent) => void;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

function wsUpgradeUrl(ticket: string): string {
  // API_BASE_URL is `${origin}/api/v1` (or `/api/v1` for the dev proxy /
  // same-origin case) — the WS upgrade itself is unprefixed (docs/03-api.md
  // §ws), so strip `/api/v1` and swap the http(s) scheme for ws(s).
  const base = API_BASE_URL.replace(/\/api\/v1$/, '');
  const absoluteBase = base.startsWith('http') ? base : `${window.location.origin}${base}`;
  const wsBase = absoluteBase.replace(/^http/, 'ws');
  return `${wsBase}/ws?ticket=${encodeURIComponent(ticket)}`;
}

export class WsConnection {
  private socket: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  private closedByCaller = false;

  constructor(private readonly onEvent: WsEventHandler) {}

  async connect(): Promise<void> {
    this.closedByCaller = false;
    try {
      const { data, error } = await api.POST('/ws/ticket', {});
      if (error || !data) {
        this.scheduleReconnect();
        return;
      }
      const url = wsUpgradeUrl(data.ticket);
      const socket = new WebSocket(url);
      this.socket = socket;

      socket.addEventListener('open', () => {
        this.reconnectAttempt = 0;
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
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  close(): void {
    this.closedByCaller = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.socket?.close();
    this.socket = null;
  }
}
