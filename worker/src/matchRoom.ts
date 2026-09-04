import { DurableObject } from 'cloudflare:workers';
import type { Env } from './types';
import {
  ROOM_IDLE_TTL_MS,
  assignSeat,
  isRoomExpired,
  otherSeat,
  parseClientMessage,
  type RoomRecord,
  type RoomSeat,
  type ServerRoomMessage,
} from './matchRoomProtocol';

const RECORD_KEY = 'room';

interface SocketAttachment {
  seat: RoomSeat;
  userId: string;
}

/**
 * One online-versus room (id = room code). Internal HTTP API, only reachable
 * from the Worker which has already authenticated the caller:
 *
 *   POST /create  { userId }            → 201 record | 409 if it exists
 *   POST /join    { userId }            → 200 { seat } | 404 | 409 full
 *   GET  /ws      (Upgrade; X-Room-Seat, X-Room-User set by the Worker)
 *
 * Sockets use the hibernation API so an idle room costs nothing. The room
 * relays `signal` (WebRTC SDP/ICE) and `relay` (fallback input frames) to
 * the other seat and answers `ping` for RTT measurement.
 */
export class MatchRoom extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const now = Date.now();

    if (url.pathname === '/create' && request.method === 'POST') {
      const body = await request.json<{ userId?: string }>().catch(() => ({} as { userId?: string }));
      if (!body.userId) return json({ error: 'userId required' }, 400);
      const existing = await this.readRecord(now);
      if (existing) return json({ error: 'Room code taken' }, 409);
      const record: RoomRecord = {
        code: url.searchParams.get('code') ?? '',
        hostUserId: body.userId,
        guestUserId: null,
        createdAt: now,
        lastActivityAt: now,
      };
      await this.writeRecord(record);
      return json({ record }, 201);
    }

    if (url.pathname === '/join' && request.method === 'POST') {
      const body = await request.json<{ userId?: string; expectedSeat?: RoomSeat }>()
        .catch(() => ({} as { userId?: string; expectedSeat?: RoomSeat }));
      if (!body.userId) return json({ error: 'userId required' }, 400);
      const expectedSeat = body.expectedSeat === 'host' || body.expectedSeat === 'guest'
        ? body.expectedSeat
        : undefined;
      const result = assignSeat(await this.readRecord(now), body.userId, now, expectedSeat);
      if (!result.ok) {
        return json({ error: result.reason }, result.reason === 'not_found' ? 404 : 409);
      }
      await this.writeRecord(result.record);
      return json({ seat: result.seat, peerConnected: this.isSeatConnected(otherSeat(result.seat)) });
    }

    if (url.pathname === '/record' && request.method === 'GET') {
      const record = await this.readRecord(now);
      if (!record) return json({ error: 'not_found' }, 404);
      return json({ record, peers: { host: this.isSeatConnected('host'), guest: this.isSeatConnected('guest') } });
    }

    if (url.pathname === '/fighter' && request.method === 'POST') {
      const body = await request.json<{ userId?: string; fighterId?: string | null }>()
        .catch(() => ({} as { userId?: string; fighterId?: string | null }));
      if (!body.userId) return json({ error: 'userId required' }, 400);
      const record = await this.readRecord(now);
      if (!record) return json({ error: 'not_found' }, 404);
      const seat: RoomSeat | null = record.hostUserId === body.userId
        ? 'host'
        : record.guestUserId === body.userId ? 'guest' : null;
      if (!seat) return json({ error: 'not_seated' }, 403);
      const fighterId = typeof body.fighterId === 'string' && body.fighterId ? body.fighterId : null;
      const updated: RoomRecord = {
        ...record,
        lastActivityAt: now,
        ...(seat === 'host' ? { hostFighterId: fighterId } : { guestFighterId: fighterId }),
      };
      await this.writeRecord(updated);
      this.broadcast(otherSeat(seat), { type: 'peer', event: 'joined', seat });
      return json({ seat, record: updated });
    }

    if (url.pathname === '/match' && request.method === 'POST') {
      const body = await request.json<{ userId?: string }>().catch(() => ({} as { userId?: string }));
      const record = await this.readRecord(now);
      if (!record) return json({ error: 'not_found' }, 404);
      if (record.hostUserId !== body.userId) return json({ error: 'host_only' }, 403);
      const updated: RoomRecord = { ...record, lastActivityAt: now, matchSerial: (record.matchSerial ?? 0) + 1 };
      await this.writeRecord(updated);
      return json({ matchSerial: updated.matchSerial });
    }

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return json({ error: 'Expected WebSocket upgrade' }, 426);
      }
      const seat = request.headers.get('X-Room-Seat');
      const userId = request.headers.get('X-Room-User');
      if ((seat !== 'host' && seat !== 'guest') || !userId) {
        return json({ error: 'Missing seat' }, 400);
      }
      const record = await this.readRecord(now);
      if (!record) return json({ error: 'Room closed' }, 404);
      const expectedUser = seat === 'host' ? record.hostUserId : record.guestUserId;
      if (expectedUser !== userId) return json({ error: 'Seat not assigned to user' }, 403);

      // A reconnect replaces the previous socket for that seat.
      for (const stale of this.ctx.getWebSockets(seat)) {
        try {
          stale.close(4000, 'replaced');
        } catch {
          // already closed
        }
      }

      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.ctx.acceptWebSocket(server, [seat]);
      server.serializeAttachment({ seat, userId } satisfies SocketAttachment);
      await this.writeRecord({ ...record, lastActivityAt: now });

      const peer = otherSeat(seat);
      this.send(server, {
        type: 'welcome',
        roomCode: record.code,
        seat,
        peerConnected: this.isSeatConnected(peer),
      });
      this.broadcast(peer, { type: 'peer', event: 'joined', seat });

      return new Response(null, { status: 101, webSocket: client });
    }

    return json({ error: 'Not found' }, 404);
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (!attachment) {
      ws.close(4001, 'unknown socket');
      return;
    }
    const parsed = parseClientMessage(typeof raw === 'string' ? raw : null);
    if (!parsed.ok) {
      this.send(ws, { type: 'error', code: parsed.code });
      return;
    }
    const message = parsed.message;
    const peer = otherSeat(attachment.seat);

    switch (message.type) {
      case 'ping':
        this.send(ws, { type: 'pong', t: message.t, serverTime: Date.now() });
        return;
      case 'signal':
        if (!this.broadcast(peer, { type: 'signal', from: attachment.seat, payload: message.payload })) {
          this.send(ws, { type: 'error', code: 'peer_missing' });
        }
        break;
      case 'relay':
        if (!this.broadcast(peer, { type: 'relay', from: attachment.seat, data: message.data })) {
          this.send(ws, { type: 'error', code: 'peer_missing' });
        }
        break;
    }
    await this.touch();
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (!attachment) return;
    // Only announce when no other socket for the seat remains (a reconnect
    // closes the stale socket after the new one was accepted).
    if (!this.isSeatConnected(attachment.seat)) {
      this.broadcast(otherSeat(attachment.seat), { type: 'peer', event: 'left', seat: attachment.seat });
    }
    await this.touch();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  async alarm(): Promise<void> {
    const record = await this.ctx.storage.get<RoomRecord>(RECORD_KEY);
    if (!record) return;
    if (!isRoomExpired(record, Date.now()) || this.ctx.getWebSockets().length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + ROOM_IDLE_TTL_MS);
      return;
    }
    await this.destroy();
  }

  private async readRecord(now: number): Promise<RoomRecord | null> {
    const record = await this.ctx.storage.get<RoomRecord>(RECORD_KEY);
    if (!record) return null;
    if (isRoomExpired(record, now) && this.ctx.getWebSockets().length === 0) {
      await this.destroy();
      return null;
    }
    return record;
  }

  private async writeRecord(record: RoomRecord): Promise<void> {
    await this.ctx.storage.put(RECORD_KEY, record);
    await this.ctx.storage.setAlarm(record.lastActivityAt + ROOM_IDLE_TTL_MS);
  }

  private async touch(): Promise<void> {
    const record = await this.ctx.storage.get<RoomRecord>(RECORD_KEY);
    if (!record) return;
    await this.writeRecord({ ...record, lastActivityAt: Date.now() });
  }

  private async destroy(): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      try {
        this.send(socket, { type: 'error', code: 'room_closed' });
        socket.close(4002, 'room closed');
      } catch {
        // ignore
      }
    }
    await this.ctx.storage.deleteAll();
  }

  private isSeatConnected(seat: RoomSeat): boolean {
    return this.ctx.getWebSockets(seat).some((socket) => socket.readyState === WebSocket.OPEN);
  }

  private send(ws: WebSocket, message: ServerRoomMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // socket already gone
    }
  }

  private broadcast(seat: RoomSeat, message: ServerRoomMessage): boolean {
    let delivered = false;
    for (const socket of this.ctx.getWebSockets(seat)) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      this.send(socket, message);
      delivered = true;
    }
    return delivered;
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
