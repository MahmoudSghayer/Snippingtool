// In-process fan-out router: multiplexes one shared Redis pub/sub connection
// (`fastify.redisSub`) across however many local WebSocket connections are
// subscribed to each channel, so N connections on one API instance only cost
// one Redis SUBSCRIBE per channel. Ref-counted so the last connection
// leaving a channel issues an UNSUBSCRIBE.

import type { Redis } from 'ioredis';
import type WebSocket from 'ws';

export class WsChannelRouter {
  private readonly channelSockets = new Map<string, Set<WebSocket>>();
  private started = false;

  constructor(private readonly redisSub: Redis) {}

  private ensureListening(): void {
    if (this.started) return;
    this.started = true;
    this.redisSub.on('message', (channel: string, message: string) => {
      const sockets = this.channelSockets.get(channel);
      if (!sockets) return;
      for (const socket of sockets) {
        if (socket.readyState === socket.OPEN) socket.send(message);
      }
    });
  }

  async subscribe(channel: string, socket: WebSocket): Promise<void> {
    this.ensureListening();
    let sockets = this.channelSockets.get(channel);
    if (!sockets) {
      sockets = new Set();
      this.channelSockets.set(channel, sockets);
      await this.redisSub.subscribe(channel);
    }
    sockets.add(socket);
  }

  async unsubscribe(channel: string, socket: WebSocket): Promise<void> {
    const sockets = this.channelSockets.get(channel);
    if (!sockets) return;
    sockets.delete(socket);
    if (sockets.size === 0) {
      this.channelSockets.delete(channel);
      await this.redisSub.unsubscribe(channel);
    }
  }

  /** Removes a socket from every channel it was subscribed to (on close). */
  async unsubscribeAll(socket: WebSocket): Promise<void> {
    for (const channel of [...this.channelSockets.keys()]) {
      await this.unsubscribe(channel, socket);
    }
  }
}
