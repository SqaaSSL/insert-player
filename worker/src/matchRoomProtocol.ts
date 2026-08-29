import type { Env } from './types';

/**
 * Online versus room protocol — the pure part. The Durable Object in
 * `matchRoom.ts` and the Worker routes in `matchRoomRoutes.ts` only add
 * transport; everything that can be unit-tested lives here.
 *
 * A room has two seats. The Worker authenticates players with Clerk, asks the
 * room DO for a seat, and mints a short-lived HMAC ticket that the browser
 * presents on the WebSocket upgrade. Over the socket the room relays WebRTC
 * signalling between the seats and, if P2P never comes up, the input frames
 * themselves (`relay`).
 */

export type RoomSeat = 'host' | 'guest';

export const ROOM_CODE_LENGTH = 6;
/** Unambiguous: no 0/O, 1/I/L. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_TICKET_TTL_SECONDS = 10 * 60;
/** A room that has seen no socket activity for this long is destroyed. */
export const ROOM_IDLE_TTL_MS = 30 * 60 * 1000;
export const MAX_ROOM_MESSAGE_BYTES = 16 * 1024;
export const MAX_SIGNAL_PAYLOAD_BYTES = 8 * 1024;
export const MAX_RELAY_PAYLOAD_BYTES = 2 * 1024;

const TICKET_VERSION = 1;

export interface RoomTicket {
  v: number;
  purpose: 'room';
  roomCode: string;
  seat: RoomSeat;
  userId: string;
  exp: number;
}

export interface RoomRecord {
  code: string;
  hostUserId: string;
  guestUserId: string | null;
  createdAt: number;
  lastActivityAt: number;
  /** Cloud fighter ids each seat declared for the next match (owned or active Arcade). */
  hostFighterId?: string | null;
  guestFighterId?: string | null;
  /** Increments per started match; makes result reports idempotent. */
  matchSerial?: number;
}

// ----------------------------------------------------------------- codes

export function generateRoomCode(random: (max: number) => number = randomIndex): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[random(ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

function randomIndex(max: number): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0] % max;
}

export function normalizeRoomCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== ROOM_CODE_LENGTH) return null;
  for (const character of code) {
    if (!ROOM_CODE_ALPHABET.includes(character)) return null;
  }
  return code;
}

// ---------------------------------------------------------------- tickets

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function ticketSecret(env: Pick<Env, 'GENERATION_JOB_SIGNING_SECRET' | 'ENVIRONMENT'>): string {
  const secret = env.GENERATION_JOB_SIGNING_SECRET?.trim();
  if (secret) return `${secret}:versus-room`;
  if (env.ENVIRONMENT === 'development') return 'insert-player-local-versus-rooms-only';
  throw new Error('GENERATION_JOB_SIGNING_SECRET is required');
}

async function ticketKey(env: Pick<Env, 'GENERATION_JOB_SIGNING_SECRET' | 'ENVIRONMENT'>): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(ticketSecret(env)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function mintRoomTicket(
  env: Pick<Env, 'GENERATION_JOB_SIGNING_SECRET' | 'ENVIRONMENT'>,
  params: { roomCode: string; seat: RoomSeat; userId: string },
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<string> {
  const payload: RoomTicket = {
    v: TICKET_VERSION,
    purpose: 'room',
    roomCode: params.roomCode,
    seat: params.seat,
    userId: params.userId,
    exp: nowSeconds + ROOM_TICKET_TTL_SECONDS,
  };
  const encoded = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', await ticketKey(env), new TextEncoder().encode(encoded)),
  );
  return `${encoded}.${base64UrlEncode(signature)}`;
}

export async function verifyRoomTicket(
  env: Pick<Env, 'GENERATION_JOB_SIGNING_SECRET' | 'ENVIRONMENT'>,
  ticket: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<RoomTicket | null> {
  const [encoded, signature] = ticket.split('.');
  if (!encoded || !signature) return null;
  const signatureBytes = base64UrlDecode(signature);
  if (!signatureBytes) return null;
  const valid = await crypto.subtle.verify(
    'HMAC',
    await ticketKey(env),
    signatureBytes,
    new TextEncoder().encode(encoded),
  );
  if (!valid) return null;
  const bytes = base64UrlDecode(encoded);
  if (!bytes) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as Partial<RoomTicket>;
    if (
      payload.v !== TICKET_VERSION ||
      payload.purpose !== 'room' ||
      normalizeRoomCode(payload.roomCode) !== payload.roomCode ||
      (payload.seat !== 'host' && payload.seat !== 'guest') ||
      typeof payload.userId !== 'string' || !payload.userId ||
      typeof payload.exp !== 'number' || !Number.isInteger(payload.exp) ||
      payload.exp <= nowSeconds
    ) {
      return null;
    }
    return payload as RoomTicket;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------- messages

/** Browser → room. */
export type ClientRoomMessage =
  | { type: 'signal'; payload: unknown }
  | { type: 'relay'; data: string }
  | { type: 'ping'; t: number };

/** Room → browser. */
export type ServerRoomMessage =
  | {
      type: 'welcome';
      roomCode: string;
      seat: RoomSeat;
      peerConnected: boolean;
    }
  | { type: 'peer'; event: 'joined' | 'left'; seat: RoomSeat }
  | { type: 'signal'; from: RoomSeat; payload: unknown }
  | { type: 'relay'; from: RoomSeat; data: string }
  | { type: 'pong'; t: number; serverTime: number }
  | { type: 'error'; code: 'invalid_message' | 'peer_missing' | 'room_closed' | 'too_large' };

export function otherSeat(seat: RoomSeat): RoomSeat {
  return seat === 'host' ? 'guest' : 'host';
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export type ParsedClientMessage =
  | { ok: true; message: ClientRoomMessage }
  | { ok: false; code: 'invalid_message' | 'too_large' };

export function parseClientMessage(raw: unknown): ParsedClientMessage {
  if (typeof raw !== 'string') return { ok: false, code: 'invalid_message' };
  if (byteLength(raw) > MAX_ROOM_MESSAGE_BYTES) return { ok: false, code: 'too_large' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: 'invalid_message' };
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, code: 'invalid_message' };
  const message = parsed as Record<string, unknown>;
  switch (message.type) {
    case 'signal': {
      if (message.payload === undefined) return { ok: false, code: 'invalid_message' };
      if (byteLength(JSON.stringify(message.payload)) > MAX_SIGNAL_PAYLOAD_BYTES) {
        return { ok: false, code: 'too_large' };
      }
      return { ok: true, message: { type: 'signal', payload: message.payload } };
    }
    case 'relay': {
      if (typeof message.data !== 'string') return { ok: false, code: 'invalid_message' };
      if (byteLength(message.data) > MAX_RELAY_PAYLOAD_BYTES) return { ok: false, code: 'too_large' };
      return { ok: true, message: { type: 'relay', data: message.data } };
    }
    case 'ping': {
      if (typeof message.t !== 'number' || !Number.isFinite(message.t)) {
        return { ok: false, code: 'invalid_message' };
      }
      return { ok: true, message: { type: 'ping', t: message.t } };
    }
    default:
      return { ok: false, code: 'invalid_message' };
  }
}

// -------------------------------------------------------------- seating

export type JoinResult =
  | { ok: true; seat: RoomSeat; record: RoomRecord }
  | { ok: false; reason: 'not_found' | 'full' };

/**
 * Seat assignment rules: the creator is host; the first other user is guest;
 * either may re-join their own seat (reconnect); a third user is refused.
 */
export function assignSeat(record: RoomRecord | null, userId: string, now: number): JoinResult {
  if (!record) return { ok: false, reason: 'not_found' };
  if (record.hostUserId === userId) {
    return { ok: true, seat: 'host', record: { ...record, lastActivityAt: now } };
  }
  if (record.guestUserId === userId) {
    return { ok: true, seat: 'guest', record: { ...record, lastActivityAt: now } };
  }
  if (record.guestUserId) return { ok: false, reason: 'full' };
  return {
    ok: true,
    seat: 'guest',
    record: { ...record, guestUserId: userId, lastActivityAt: now },
  };
}

export function isRoomExpired(record: RoomRecord, now: number): boolean {
  return now - record.lastActivityAt > ROOM_IDLE_TTL_MS;
}
