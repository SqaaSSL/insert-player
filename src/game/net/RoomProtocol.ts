/**
 * Client-side mirror of the Worker room protocol (`worker/src/matchRoomProtocol.ts`).
 * Kept in sync by hand; the shapes are tiny and the Worker validates its side.
 */

export type RoomSeat = 'host' | 'guest';

export type RoomServerMessage =
  | { type: 'welcome'; roomCode: string; seat: RoomSeat; peerConnected: boolean }
  | { type: 'peer'; event: 'joined' | 'left'; seat: RoomSeat }
  | { type: 'signal'; from: RoomSeat; payload: SignalPayload }
  | { type: 'relay'; from: RoomSeat; data: string }
  | { type: 'pong'; t: number; serverTime: number }
  | { type: 'error'; code: 'invalid_message' | 'peer_missing' | 'room_closed' | 'too_large' };

export type RoomClientMessage =
  | { type: 'signal'; payload: SignalPayload }
  | { type: 'relay'; data: string }
  | { type: 'ping'; t: number };

export type SignalPayload =
  | { kind: 'offer'; sdp: string }
  | { kind: 'answer'; sdp: string }
  | { kind: 'ice'; candidate: RTCIceCandidateInit | null }
  | { kind: 'restart' };

export function otherSeat(seat: RoomSeat): RoomSeat {
  return seat === 'host' ? 'guest' : 'host';
}

export function parseRoomServerMessage(raw: unknown): RoomServerMessage | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const message = parsed as Record<string, unknown>;
  const seatOk = (value: unknown): value is RoomSeat => value === 'host' || value === 'guest';
  switch (message.type) {
    case 'welcome':
      return typeof message.roomCode === 'string' && seatOk(message.seat)
        ? { type: 'welcome', roomCode: message.roomCode, seat: message.seat, peerConnected: message.peerConnected === true }
        : null;
    case 'peer':
      return seatOk(message.seat) && (message.event === 'joined' || message.event === 'left')
        ? { type: 'peer', event: message.event, seat: message.seat }
        : null;
    case 'signal':
      return seatOk(message.from) && isSignalPayload(message.payload)
        ? { type: 'signal', from: message.from, payload: message.payload }
        : null;
    case 'relay':
      return seatOk(message.from) && typeof message.data === 'string'
        ? { type: 'relay', from: message.from, data: message.data }
        : null;
    case 'pong':
      return typeof message.t === 'number' && typeof message.serverTime === 'number'
        ? { type: 'pong', t: message.t, serverTime: message.serverTime }
        : null;
    case 'error':
      return message.code === 'invalid_message' || message.code === 'peer_missing' || message.code === 'room_closed' || message.code === 'too_large'
        ? { type: 'error', code: message.code }
        : null;
    default:
      return null;
  }
}

function isSignalPayload(value: unknown): value is SignalPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Record<string, unknown>;
  switch (payload.kind) {
    case 'offer':
    case 'answer':
      return typeof payload.sdp === 'string';
    case 'ice':
      return payload.candidate === null || (typeof payload.candidate === 'object' && payload.candidate !== null);
    case 'restart':
      return true;
    default:
      return false;
  }
}

// Relay payload framing: one character says what rides in the string.
const RELAY_INPUT_PREFIX = 'i';
const RELAY_CONTROL_PREFIX = 'c';

export type RelayFrame =
  | { kind: 'input'; bytes: Uint8Array }
  | { kind: 'control'; payload: unknown };

export function encodeRelayInput(bytes: Uint8Array): string {
  return RELAY_INPUT_PREFIX + bytesToBase64(bytes);
}

export function encodeRelayControl(payload: unknown): string {
  return RELAY_CONTROL_PREFIX + JSON.stringify(payload);
}

export function decodeRelayFrame(data: string): RelayFrame | null {
  if (!data) return null;
  const prefix = data[0];
  const body = data.slice(1);
  if (prefix === RELAY_INPUT_PREFIX) {
    const bytes = base64ToBytes(body);
    return bytes ? { kind: 'input', bytes } : null;
  }
  if (prefix === RELAY_CONTROL_PREFIX) {
    try {
      return { kind: 'control', payload: JSON.parse(body) };
    } catch {
      return null;
    }
  }
  return null;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

/** `https://api.example` → `wss://api.example/api/versus/rooms/CODE/ws?ticket=…` */
export function roomSocketUrl(apiBase: string, roomCode: string, ticket: string): string {
  const url = new URL(`/api/versus/rooms/${encodeURIComponent(roomCode)}/ws`, apiBase);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.searchParams.set('ticket', ticket);
  return url.toString();
}
