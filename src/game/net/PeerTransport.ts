import {
  decodeRelayFrame,
  encodeRelayControl,
  encodeRelayInput,
  otherSeat,
  parseRoomServerMessage,
  type RoomClientMessage,
  type RoomSeat,
  type SignalPayload,
} from './RoomProtocol.ts';

export type TransportPath = 'none' | 'p2p' | 'relay';

export type TransportPhase =
  | 'idle'
  | 'connecting'
  | 'waiting_peer'
  | 'negotiating'
  | 'connected'
  | 'closed'
  | 'error';

export interface PeerTransportState {
  phase: TransportPhase;
  /** Which path carries traffic right now. */
  path: TransportPath;
  seat: RoomSeat;
  roomCode: string;
  peerPresent: boolean;
  /** Smoothed round-trip time to the peer over the active path. */
  rttMs: number | null;
  /** Whether the P2P data channel ever came up this session. */
  p2pAvailable: boolean;
  error: string | null;
}

export interface PeerTransportOptions {
  socketUrl: string;
  seat: RoomSeat;
  roomCode: string;
  iceServers: RTCIceServer[];
  /** Give P2P this long after negotiation starts before falling back. */
  p2pTimeoutMs?: number;
  pingIntervalMs?: number;
  /** Injectable for tests / environments without WebRTC. */
  createSocket?: (url: string) => WebSocketLike;
  createPeerConnection?: (config: RTCConfiguration) => PeerConnectionLike | null;
  now?: () => number;
}

/** The subset of WebSocket / RTCPeerConnection this class touches. */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface DataChannelLike {
  readyState: string;
  binaryType?: string;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface PeerConnectionLike {
  connectionState: string;
  createDataChannel(label: string, init?: RTCDataChannelInit): DataChannelLike;
  createOffer(): Promise<RTCSessionDescriptionInit>;
  createAnswer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate: RTCIceCandidateInit | null): Promise<void>;
  close(): void;
  onicecandidate: ((event: { candidate: RTCIceCandidate | RTCIceCandidateInit | null }) => void) | null;
  ondatachannel: ((event: { channel: DataChannelLike }) => void) | null;
  onconnectionstatechange: ((event: unknown) => void) | null;
}

const WS_OPEN = 1;
const DEFAULT_P2P_TIMEOUT_MS = 8_000;
const DEFAULT_PING_INTERVAL_MS = 1_000;
const RTT_SMOOTHING = 0.3;

type Listener<T> = (value: T) => void;

/**
 * Peer-to-peer input transport for online versus.
 *
 * Both players hold a WebSocket to the room (signalling + fallback). The host
 * offers a WebRTC connection with two data channels — `inputs` (unordered,
 * no retransmits: a late input frame is useless, the netcode re-sends) and
 * `control` (reliable, ordered) — as soon as the guest is seated. If P2P is
 * not up within `p2pTimeoutMs`, or drops later, traffic rides the room
 * relay instead, and switches back if P2P recovers. The consumer never sees
 * which path is active except through `state.path`.
 */
export class PeerTransport {
  private readonly options: Required<Pick<PeerTransportOptions, 'p2pTimeoutMs' | 'pingIntervalMs'>> & PeerTransportOptions;
  private socket: WebSocketLike | null = null;
  private pc: PeerConnectionLike | null = null;
  private inputChannel: DataChannelLike | null = null;
  private controlChannel: DataChannelLike | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private remoteDescriptionSet = false;
  private p2pTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private negotiationEpoch = 0;
  private state: PeerTransportState;
  private readonly inputListeners = new Set<Listener<Uint8Array>>();
  private readonly controlListeners = new Set<Listener<unknown>>();
  private readonly stateListeners = new Set<Listener<PeerTransportState>>();
  private closed = false;

  constructor(options: PeerTransportOptions) {
    this.options = {
      ...options,
      p2pTimeoutMs: options.p2pTimeoutMs ?? DEFAULT_P2P_TIMEOUT_MS,
      pingIntervalMs: options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS,
    };
    this.state = {
      phase: 'idle',
      path: 'none',
      seat: options.seat,
      roomCode: options.roomCode,
      peerPresent: false,
      rttMs: null,
      p2pAvailable: false,
      error: null,
    };
  }

  getState(): PeerTransportState {
    return this.state;
  }

  onInput(listener: Listener<Uint8Array>): () => void {
    this.inputListeners.add(listener);
    return () => this.inputListeners.delete(listener);
  }

  onControl(listener: Listener<unknown>): () => void {
    this.controlListeners.add(listener);
    return () => this.controlListeners.delete(listener);
  }

  onState(listener: Listener<PeerTransportState>): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  connect(): void {
    if (this.socket || this.closed) return;
    this.setState({ phase: 'connecting', error: null });
    const create = this.options.createSocket ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
    let socket: WebSocketLike;
    try {
      socket = create(this.options.socketUrl);
    } catch (err) {
      this.fail(err instanceof Error ? err.message : 'Could not open room socket');
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.startPings();
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.handleSocketMessage(event.data);
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopPings();
      this.teardownPeerConnection();
      if (!this.closed) {
        this.setState({
          phase: 'closed',
          path: 'none',
          peerPresent: false,
          error: event.code === 4002 ? 'Room closed' : event.code === 4000 ? 'Replaced by a newer connection' : this.state.error,
        });
      }
    };
    socket.onerror = () => {
      if (this.socket !== socket) return;
      if (this.state.phase === 'connecting') this.fail('Room socket error');
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopPings();
    this.teardownPeerConnection();
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close(1000, 'bye');
    } catch {
      // ignore
    }
    this.setState({ phase: 'closed', path: 'none', peerPresent: false });
  }

  /** Fire-and-forget input frame (unreliable on P2P; relayed otherwise). */
  sendInput(bytes: Uint8Array): boolean {
    if (this.state.path === 'p2p' && this.inputChannel?.readyState === 'open') {
      try {
        this.inputChannel.send(bytes);
        return true;
      } catch {
        // fall through to relay
      }
    }
    if (this.state.peerPresent) {
      return this.sendSocket({ type: 'relay', data: encodeRelayInput(bytes) });
    }
    return false;
  }

  /** Reliable control message (JSON). */
  sendControl(payload: unknown): boolean {
    if (this.state.path === 'p2p' && this.controlChannel?.readyState === 'open') {
      try {
        this.controlChannel.send(JSON.stringify(payload));
        return true;
      } catch {
        // fall through to relay
      }
    }
    if (this.state.peerPresent) {
      return this.sendSocket({ type: 'relay', data: encodeRelayControl(payload) });
    }
    return false;
  }

  // ------------------------------------------------------------ internals

  private setState(patch: Partial<PeerTransportState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.stateListeners) listener(this.state);
  }

  private fail(message: string): void {
    this.setState({ phase: 'error', path: 'none', error: message });
  }

  private sendSocket(message: RoomClientMessage): boolean {
    if (!this.socket || this.socket.readyState !== WS_OPEN) return false;
    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  private handleSocketMessage(raw: unknown): void {
    const message = parseRoomServerMessage(raw);
    if (!message) return;
    switch (message.type) {
      case 'welcome':
        this.setState({
          phase: message.peerConnected ? 'negotiating' : 'waiting_peer',
          peerPresent: message.peerConnected,
          path: message.peerConnected ? 'relay' : 'none',
        });
        if (message.peerConnected) this.beginNegotiation();
        break;
      case 'peer':
        if (message.seat === this.state.seat) return;
        if (message.event === 'joined') {
          this.setState({ phase: 'negotiating', peerPresent: true, path: 'relay', rttMs: null });
          this.beginNegotiation();
        } else {
          this.teardownPeerConnection();
          this.setState({ phase: 'waiting_peer', peerPresent: false, path: 'none', rttMs: null });
        }
        break;
      case 'signal':
        if (message.from === this.state.seat) return;
        void this.handleSignal(message.payload);
        break;
      case 'relay': {
        if (message.from === this.state.seat) return;
        const frame = decodeRelayFrame(message.data);
        if (!frame) return;
        if (frame.kind === 'input') this.emitInput(frame.bytes);
        else this.handleControl(frame.payload);
        break;
      }
      case 'pong':
        // Server pong is only a liveness signal; RTT is measured peer-to-peer.
        break;
      case 'error':
        if (message.code === 'room_closed') this.fail('Room closed');
        break;
    }
  }

  private emitInput(bytes: Uint8Array): void {
    for (const listener of this.inputListeners) listener(bytes);
  }

  private handleControl(payload: unknown): void {
    if (payload && typeof payload === 'object') {
      const control = payload as { __ping?: number; __pong?: number };
      if (typeof control.__ping === 'number') {
        this.sendControl({ __pong: control.__ping });
        return;
      }
      if (typeof control.__pong === 'number') {
        const rtt = Math.max(0, this.now() - control.__pong);
        const smoothed = this.state.rttMs === null ? rtt : this.state.rttMs + (rtt - this.state.rttMs) * RTT_SMOOTHING;
        this.setState({ rttMs: Math.round(smoothed * 10) / 10 });
        return;
      }
    }
    for (const listener of this.controlListeners) listener(payload);
  }

  private now(): number {
    return this.options.now ? this.options.now() : (typeof performance !== 'undefined' ? performance.now() : Date.now());
  }

  private startPings(): void {
    this.stopPings();
    this.pingTimer = setInterval(() => {
      if (this.state.peerPresent) this.sendControl({ __ping: this.now() });
    }, this.options.pingIntervalMs);
  }

  private stopPings(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  // ------------------------------------------------------------- WebRTC

  private beginNegotiation(): void {
    this.teardownPeerConnection();
    const epoch = ++this.negotiationEpoch;
    const create = this.options.createPeerConnection
      ?? ((config: RTCConfiguration) => (typeof RTCPeerConnection === 'undefined'
        ? null
        : (new RTCPeerConnection(config) as unknown as PeerConnectionLike)));
    let pc: PeerConnectionLike | null = null;
    try {
      pc = create({ iceServers: this.options.iceServers });
    } catch {
      pc = null;
    }
    if (!pc) {
      // No WebRTC here: the relay is the connection.
      this.setState({ phase: 'connected', path: 'relay' });
      return;
    }
    this.pc = pc;
    this.remoteDescriptionSet = false;
    this.pendingIce = [];

    pc.onicecandidate = (event) => {
      if (this.pc !== pc) return;
      const candidate = event.candidate;
      this.sendSocket({
        type: 'signal',
        payload: { kind: 'ice', candidate: candidate ? toCandidateInit(candidate) : null },
      });
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
        this.useRelay();
      }
    };
    pc.ondatachannel = (event) => {
      if (this.pc !== pc) return;
      this.adoptChannel(event.channel);
    };

    if (this.state.seat === 'host') {
      this.adoptChannel(pc.createDataChannel('inputs', { ordered: false, maxRetransmits: 0 }));
      this.adoptChannel(pc.createDataChannel('control', { ordered: true }));
      void (async () => {
        try {
          const offer = await pc.createOffer();
          if (this.pc !== pc || epoch !== this.negotiationEpoch) return;
          await pc.setLocalDescription(offer);
          this.sendSocket({ type: 'signal', payload: { kind: 'offer', sdp: offer.sdp ?? '' } });
        } catch {
          this.useRelay();
        }
      })();
    }

    this.p2pTimer = setTimeout(() => {
      this.p2pTimer = null;
      if (this.pc === pc && this.state.path !== 'p2p') this.useRelay();
    }, this.options.p2pTimeoutMs);
  }

  private adoptChannel(channel: DataChannelLike): void {
    const label = (channel as { label?: string }).label;
    const isInputs = label ? label === 'inputs' : !this.inputChannel;
    if (isInputs) {
      channel.binaryType = 'arraybuffer';
      this.inputChannel = channel;
      channel.onmessage = (event) => {
        const data = event.data;
        if (data instanceof ArrayBuffer) this.emitInput(new Uint8Array(data));
        else if (ArrayBuffer.isView(data)) this.emitInput(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      };
    } else {
      this.controlChannel = channel;
      channel.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        try {
          this.handleControl(JSON.parse(event.data));
        } catch {
          // ignore malformed control
        }
      };
    }
    channel.onopen = () => this.checkChannelsOpen();
    channel.onclose = () => {
      if (this.state.path === 'p2p') this.useRelay();
    };
    this.checkChannelsOpen();
  }

  private checkChannelsOpen(): void {
    if (this.inputChannel?.readyState === 'open' && this.controlChannel?.readyState === 'open') {
      if (this.p2pTimer) clearTimeout(this.p2pTimer);
      this.p2pTimer = null;
      this.setState({ phase: 'connected', path: 'p2p', p2pAvailable: true, rttMs: null });
    }
  }

  private useRelay(): void {
    if (this.p2pTimer) clearTimeout(this.p2pTimer);
    this.p2pTimer = null;
    if (!this.state.peerPresent) return;
    if (this.state.path !== 'relay' || this.state.phase !== 'connected') {
      this.setState({ phase: 'connected', path: 'relay', rttMs: null });
    }
  }

  private async handleSignal(payload: SignalPayload): Promise<void> {
    if (payload.kind === 'restart') {
      if (this.state.seat === 'host') this.beginNegotiation();
      return;
    }
    if (payload.kind === 'offer') {
      if (this.state.seat !== 'guest') return;
      if (!this.pc) this.beginNegotiation();
      const pc = this.pc;
      if (!pc) return;
      try {
        await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
        this.remoteDescriptionSet = true;
        await this.flushPendingIce();
        const answer = await pc.createAnswer();
        if (this.pc !== pc) return;
        await pc.setLocalDescription(answer);
        this.sendSocket({ type: 'signal', payload: { kind: 'answer', sdp: answer.sdp ?? '' } });
      } catch {
        this.useRelay();
      }
      return;
    }
    if (payload.kind === 'answer') {
      const pc = this.pc;
      if (!pc || this.state.seat !== 'host') return;
      try {
        await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
        this.remoteDescriptionSet = true;
        await this.flushPendingIce();
      } catch {
        this.useRelay();
      }
      return;
    }
    if (payload.kind === 'ice') {
      if (!payload.candidate) return;
      if (!this.pc || !this.remoteDescriptionSet) {
        this.pendingIce.push(payload.candidate);
        return;
      }
      try {
        await this.pc.addIceCandidate(payload.candidate);
      } catch {
        // stale candidate; ignore
      }
    }
  }

  private async flushPendingIce(): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    const pending = this.pendingIce;
    this.pendingIce = [];
    for (const candidate of pending) {
      try {
        await pc.addIceCandidate(candidate);
      } catch {
        // ignore
      }
    }
  }

  private teardownPeerConnection(): void {
    if (this.p2pTimer) clearTimeout(this.p2pTimer);
    this.p2pTimer = null;
    for (const channel of [this.inputChannel, this.controlChannel]) {
      if (!channel) continue;
      channel.onopen = null;
      channel.onclose = null;
      channel.onmessage = null;
      try {
        channel.close();
      } catch {
        // ignore
      }
    }
    this.inputChannel = null;
    this.controlChannel = null;
    const pc = this.pc;
    this.pc = null;
    if (pc) {
      pc.onicecandidate = null;
      pc.ondatachannel = null;
      pc.onconnectionstatechange = null;
      try {
        pc.close();
      } catch {
        // ignore
      }
    }
    this.remoteDescriptionSet = false;
    this.pendingIce = [];
    if (this.state.path === 'p2p') {
      this.setState({ path: this.state.peerPresent ? 'relay' : 'none' });
    }
  }
}

function toCandidateInit(candidate: RTCIceCandidate | RTCIceCandidateInit): RTCIceCandidateInit {
  const source = candidate as RTCIceCandidate & { toJSON?: () => RTCIceCandidateInit };
  if (typeof source.toJSON === 'function') return source.toJSON();
  return {
    candidate: source.candidate,
    sdpMid: source.sdpMid ?? undefined,
    sdpMLineIndex: source.sdpMLineIndex ?? undefined,
    usernameFragment: source.usernameFragment ?? undefined,
  };
}

export { otherSeat };
