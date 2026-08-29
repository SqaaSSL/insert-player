import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PeerTransport,
  type DataChannelLike,
  type PeerConnectionLike,
  type WebSocketLike,
} from './PeerTransport.ts';
import {
  decodeRelayFrame,
  encodeRelayControl,
  encodeRelayInput,
  parseRoomServerMessage,
  roomSocketUrl,
  type RoomSeat,
  type RoomServerMessage,
} from './RoomProtocol.ts';

/**
 * In-memory stand-in for the MatchRoom Durable Object: two sockets, relays
 * `signal` and `relay` to the other seat, answers `ping`.
 */
class FakeRoom {
  readonly sockets = new Map<RoomSeat, FakeSocket>();

  connect(seat: RoomSeat): FakeSocket {
    const socket = new FakeSocket(this, seat);
    this.sockets.set(seat, socket);
    queueMicrotask(() => {
      socket.readyState = 1;
      socket.onopen?.({});
      const peer = this.sockets.get(seat === 'host' ? 'guest' : 'host');
      socket.deliver({ type: 'welcome', roomCode: 'ABCDEF', seat, peerConnected: Boolean(peer && peer.readyState === 1) });
      peer?.deliver({ type: 'peer', event: 'joined', seat });
    });
    return socket;
  }

  relay(from: RoomSeat, raw: string): void {
    const message = JSON.parse(raw) as { type: string; payload?: unknown; data?: string; t?: number };
    const peer = this.sockets.get(from === 'host' ? 'guest' : 'host');
    if (message.type === 'ping') {
      this.sockets.get(from)?.deliver({ type: 'pong', t: message.t ?? 0, serverTime: 0 });
      return;
    }
    if (!peer || peer.readyState !== 1) {
      this.sockets.get(from)?.deliver({ type: 'error', code: 'peer_missing' });
      return;
    }
    if (message.type === 'signal') peer.deliver({ type: 'signal', from, payload: message.payload as never });
    if (message.type === 'relay') peer.deliver({ type: 'relay', from, data: message.data ?? '' });
  }

  disconnect(seat: RoomSeat): void {
    const socket = this.sockets.get(seat);
    if (!socket) return;
    this.sockets.delete(seat);
    socket.readyState = 3;
    socket.onclose?.({ code: 1000, reason: '' });
    this.sockets.get(seat === 'host' ? 'guest' : 'host')?.deliver({ type: 'peer', event: 'left', seat });
  }
}

class FakeSocket implements WebSocketLike {
  readyState = 0;
  onopen: WebSocketLike['onopen'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  onclose: WebSocketLike['onclose'] = null;
  onerror: WebSocketLike['onerror'] = null;
  sent: string[] = [];

  constructor(private readonly room: FakeRoom, readonly seat: RoomSeat) {}

  send(data: string): void {
    this.sent.push(data);
    queueMicrotask(() => this.room.relay(this.seat, data));
  }

  close(): void {
    this.room.disconnect(this.seat);
  }

  deliver(message: RoomServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

/** Two fake peer connections that "connect" once both descriptions exist. */
class FakeRtcWorld {
  private pcs: FakePeerConnection[] = [];

  constructor(private readonly mode: 'connect' | 'never') {}

  create(): FakePeerConnection {
    const pc = new FakePeerConnection(this);
    this.pcs.push(pc);
    return pc;
  }

  maybeConnect(): void {
    if (this.mode !== 'connect') return;
    const [a, b] = this.pcs.filter((pc) => !pc.closed).slice(-2);
    if (!a || !b || !a.localSet || !a.remoteSet || !b.localSet || !b.remoteSet) return;
    if (a.connectionState === 'connected') return;
    a.linkWith(b);
  }
}

class FakeChannel implements DataChannelLike {
  readyState = 'connecting';
  binaryType?: string;
  peer: FakeChannel | null = null;
  onopen: DataChannelLike['onopen'] = null;
  onclose: DataChannelLike['onclose'] = null;
  onmessage: DataChannelLike['onmessage'] = null;

  constructor(readonly label: string) {}

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== 'open' || !this.peer) throw new Error('channel not open');
    const peer = this.peer;
    const payload = typeof data === 'string'
      ? data
      : data instanceof ArrayBuffer
        ? data.slice(0)
        : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    queueMicrotask(() => peer.onmessage?.({ data: payload }));
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.onclose?.({});
    const peer = this.peer;
    this.peer = null;
    peer?.close();
  }
}

class FakePeerConnection implements PeerConnectionLike {
  connectionState = 'new';
  localSet = false;
  remoteSet = false;
  closed = false;
  channels: FakeChannel[] = [];
  onicecandidate: PeerConnectionLike['onicecandidate'] = null;
  ondatachannel: PeerConnectionLike['ondatachannel'] = null;
  onconnectionstatechange: PeerConnectionLike['onconnectionstatechange'] = null;

  constructor(private readonly world: FakeRtcWorld) {}

  createDataChannel(label: string): DataChannelLike {
    const channel = new FakeChannel(label);
    this.channels.push(channel);
    return channel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'offer-sdp' };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'answer-sdp' };
  }

  async setLocalDescription(): Promise<void> {
    this.localSet = true;
    queueMicrotask(() => this.onicecandidate?.({ candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 1 typ host' } }));
    queueMicrotask(() => this.onicecandidate?.({ candidate: null }));
    this.world.maybeConnect();
  }

  async setRemoteDescription(): Promise<void> {
    this.remoteSet = true;
    this.world.maybeConnect();
  }

  async addIceCandidate(): Promise<void> {}

  close(): void {
    this.closed = true;
    this.connectionState = 'closed';
    for (const channel of this.channels) channel.close();
  }

  linkWith(other: FakePeerConnection): void {
    // The offerer created the channels; mirror them onto the answerer.
    const offerer = this.channels.length > 0 ? this : other;
    const answerer = offerer === this ? other : this;
    for (const channel of offerer.channels) {
      const mirror = new FakeChannel(channel.label);
      answerer.channels.push(mirror);
      channel.peer = mirror;
      mirror.peer = channel;
      answerer.ondatachannel?.({ channel: mirror });
      channel.readyState = 'open';
      mirror.readyState = 'open';
      channel.onopen?.({});
      mirror.onopen?.({});
    }
    this.connectionState = 'connected';
    other.connectionState = 'connected';
    this.onconnectionstatechange?.({});
    other.onconnectionstatechange?.({});
  }
}

async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function makeTransport(room: FakeRoom, world: FakeRtcWorld | null, seat: RoomSeat, extra: Partial<ConstructorParameters<typeof PeerTransport>[0]> = {}) {
  return new PeerTransport({
    socketUrl: `wss://room/${seat}`,
    seat,
    roomCode: 'ABCDEF',
    iceServers: [],
    p2pTimeoutMs: 500,
    pingIntervalMs: 100,
    createSocket: () => room.connect(seat),
    createPeerConnection: world ? () => world.create() : () => null,
    ...extra,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('room protocol codecs', () => {
  it('builds the socket URL from the API base', () => {
    expect(roomSocketUrl('https://api.insertplayer.ai', 'ABCDEF', 'tok.en'))
      .toBe('wss://api.insertplayer.ai/api/versus/rooms/ABCDEF/ws?ticket=tok.en');
    expect(roomSocketUrl('http://localhost:8787/', 'ABCDEF', 't'))
      .toBe('ws://localhost:8787/api/versus/rooms/ABCDEF/ws?ticket=t');
  });

  it('frames input and control relay payloads', () => {
    const bytes = new Uint8Array([1, 2, 250, 255]);
    expect(decodeRelayFrame(encodeRelayInput(bytes))).toEqual({ kind: 'input', bytes });
    expect(decodeRelayFrame(encodeRelayControl({ hello: 1 }))).toEqual({ kind: 'control', payload: { hello: 1 } });
    expect(decodeRelayFrame('')).toBeNull();
    expect(decodeRelayFrame('x??')).toBeNull();
  });

  it('parses server messages defensively', () => {
    expect(parseRoomServerMessage(JSON.stringify({ type: 'welcome', roomCode: 'A', seat: 'host', peerConnected: true })))
      .toEqual({ type: 'welcome', roomCode: 'A', seat: 'host', peerConnected: true });
    expect(parseRoomServerMessage(JSON.stringify({ type: 'signal', from: 'guest', payload: { kind: 'bogus' } }))).toBeNull();
    expect(parseRoomServerMessage('{')).toBeNull();
    expect(parseRoomServerMessage(5)).toBeNull();
  });
});

describe('PeerTransport', () => {
  it('negotiates P2P through the room and exchanges inputs and control both ways', async () => {
    const room = new FakeRoom();
    const world = new FakeRtcWorld('connect');
    const host = makeTransport(room, world, 'host');
    const guest = makeTransport(room, world, 'guest');
    const hostGot: Uint8Array[] = [];
    const guestGot: unknown[] = [];
    host.onInput((bytes) => hostGot.push(bytes));
    guest.onControl((payload) => guestGot.push(payload));

    host.connect();
    await flush();
    expect(host.getState().phase).toBe('waiting_peer');

    guest.connect();
    await flush(30);

    expect(host.getState().path).toBe('p2p');
    expect(guest.getState().path).toBe('p2p');
    expect(host.getState().phase).toBe('connected');
    expect(host.getState().p2pAvailable).toBe(true);

    expect(guest.sendInput(new Uint8Array([7, 7]))).toBe(true);
    expect(host.sendControl({ start: true })).toBe(true);
    await flush();
    expect(hostGot).toEqual([new Uint8Array([7, 7])]);
    expect(guestGot).toEqual([{ start: true }]);

    // Nothing rode the relay once P2P was up.
    const relayed = room.sockets.get('guest')!.sent.filter((raw) => raw.includes('"relay"'));
    expect(relayed).toHaveLength(0);

    host.close();
    guest.close();
  });

  it('falls back to the room relay when P2P never connects, and measures RTT there', async () => {
    const room = new FakeRoom();
    const world = new FakeRtcWorld('never');
    let clock = 0;
    const now = () => clock;
    const host = makeTransport(room, world, 'host', { now });
    const guest = makeTransport(room, world, 'guest', { now });
    const guestGot: Uint8Array[] = [];
    guest.onInput((bytes) => guestGot.push(bytes));

    host.connect();
    guest.connect();
    await flush(20);
    expect(host.getState().phase).toBe('negotiating');
    expect(host.getState().path).toBe('relay');

    vi.advanceTimersByTime(600);
    await flush();
    expect(host.getState().phase).toBe('connected');
    expect(host.getState().path).toBe('relay');
    expect(host.getState().p2pAvailable).toBe(false);

    expect(host.sendInput(new Uint8Array([1, 2, 3]))).toBe(true);
    await flush();
    expect(guestGot).toEqual([new Uint8Array([1, 2, 3])]);

    // Ping rides the relay: host ping → guest pong → host RTT. Earlier pings
    // measured 0 ms (frozen clock); this one takes 42 ms and is smoothed in.
    clock = 1_000;
    vi.advanceTimersByTime(100);
    clock = 1_042;
    await flush(10);
    expect(host.getState().rttMs).toBeGreaterThan(0);
    expect(host.getState().rttMs).toBeLessThanOrEqual(42);

    host.close();
    guest.close();
  });

  it('works with no WebRTC at all (relay is the connection)', async () => {
    const room = new FakeRoom();
    const host = makeTransport(room, null, 'host');
    const guest = makeTransport(room, null, 'guest');
    host.connect();
    guest.connect();
    await flush(10);
    expect(host.getState()).toMatchObject({ phase: 'connected', path: 'relay', peerPresent: true });
    expect(guest.getState()).toMatchObject({ phase: 'connected', path: 'relay', peerPresent: true });
    host.close();
    guest.close();
  });

  it('notices the peer leaving and renegotiates when they come back', async () => {
    const room = new FakeRoom();
    const world = new FakeRtcWorld('connect');
    const host = makeTransport(room, world, 'host');
    let guest = makeTransport(room, world, 'guest');
    host.connect();
    guest.connect();
    await flush(30);
    expect(host.getState().path).toBe('p2p');

    guest.close();
    await flush();
    expect(host.getState()).toMatchObject({ phase: 'waiting_peer', path: 'none', peerPresent: false });
    expect(host.sendInput(new Uint8Array([1]))).toBe(false);

    guest = makeTransport(room, world, 'guest');
    guest.connect();
    await flush(30);
    expect(host.getState().path).toBe('p2p');
    expect(guest.getState().path).toBe('p2p');
    host.close();
    guest.close();
  });
});
