import {
  apiFetch,
  apiUrl,
  captureApiRequestContext,
  createDetachedApiRequestContext,
  type ApiRequestContext,
} from './ApiClient.ts';
import { roomSocketUrl, type RoomSeat } from '../game/net/RoomProtocol.ts';
import type { CloudFighter } from './CloudFighters.ts';

export interface VersusRoomSeatInfo {
  roomCode: string;
  seat: RoomSeat;
  ticket: string;
  ticketExpiresInSeconds: number;
  peerConnected: boolean;
  socketUrl: string;
}

export interface VersusIceServers {
  iceServers: RTCIceServer[];
  turn: 'configured' | 'not_configured' | 'unavailable';
}

export interface VersusInvitationInfo {
  url: string;
  expiresAt: string;
  inviter: {
    displayName: string;
  };
  fighter: {
    id: string;
    name: string;
    qualityTier: 'rookie' | 'contender' | 'champion';
  };
}

export class VersusRoomError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'VersusRoomError';
    this.status = status;
  }
}

async function readError(response: Response, fallback: string): Promise<VersusRoomError> {
  let message = fallback;
  try {
    const body = await response.json() as { error?: string };
    if (body?.error) message = body.error;
  } catch {
    // keep fallback
  }
  return new VersusRoomError(response.status, message);
}

function socketUrlFor(roomCode: string, ticket: string, context: ApiRequestContext): string {
  const base = apiUrl('/', context);
  const absoluteBase = /^https?:\/\//i.test(base)
    ? base
    : new URL(base, window.location.href).toString();
  return roomSocketUrl(absoluteBase, roomCode, ticket);
}

export function versusRoomRequestContext(
  seat: Pick<VersusRoomSeatInfo, 'ticket'>,
  context: ApiRequestContext = captureApiRequestContext(),
): ApiRequestContext {
  const configuredBase = apiUrl('/', context);
  const apiBaseUrl = /^https?:\/\//i.test(configuredBase)
    ? configuredBase
    : new URL(configuredBase, window.location.href).toString();
  return createDetachedApiRequestContext({
    apiBaseUrl,
    authorizationToken: seat.ticket,
    authorizationScheme: 'Room',
  });
}

export async function createVersusRoom(
  context: ApiRequestContext = captureApiRequestContext(),
): Promise<VersusRoomSeatInfo> {
  const response = await apiFetch('/api/versus/rooms', { method: 'POST' }, context);
  if (!response.ok) throw await readError(response, 'Could not create room');
  const body = await response.json() as Omit<VersusRoomSeatInfo, 'socketUrl' | 'peerConnected'>;
  return {
    ...body,
    peerConnected: false,
    socketUrl: socketUrlFor(body.roomCode, body.ticket, context),
  };
}

export async function joinVersusRoom(
  roomCode: string,
  context: ApiRequestContext = captureApiRequestContext(),
): Promise<VersusRoomSeatInfo> {
  const response = await apiFetch(
    `/api/versus/rooms/${encodeURIComponent(roomCode)}/join`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    context,
  );
  if (!response.ok) throw await readError(response, 'Could not join room');
  const body = await response.json() as Omit<VersusRoomSeatInfo, 'socketUrl'>;
  return {
    ...body,
    socketUrl: socketUrlFor(body.roomCode, body.ticket, context),
  };
}

export async function createVersusInvitation(
  roomCode: string,
  fighterId: string,
  context: ApiRequestContext = captureApiRequestContext(),
): Promise<VersusInvitationInfo> {
  const response = await apiFetch(
    `/api/versus/rooms/${encodeURIComponent(roomCode)}/invitations`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fighterId }),
    },
    context,
  );
  if (!response.ok) throw await readError(response, 'Could not create invitation link');
  const body = await response.json() as { invitation: VersusInvitationInfo };
  return body.invitation;
}

export async function joinVersusInvitation(
  token: string,
  guestId: string | null = null,
  context: ApiRequestContext = captureApiRequestContext(),
): Promise<VersusRoomSeatInfo> {
  const response = await apiFetch(
    `/api/versus/invitations/${encodeURIComponent(token)}/join`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(guestId ? { guestId } : {}),
    },
    context,
  );
  if (!response.ok) throw await readError(response, 'Could not join invitation');
  const body = await response.json() as Omit<VersusRoomSeatInfo, 'socketUrl'>;
  return {
    ...body,
    socketUrl: socketUrlFor(body.roomCode, body.ticket, context),
  };
}

const FALLBACK_ICE: VersusIceServers = {
  iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }],
  turn: 'unavailable',
};

export async function fetchVersusIceServers(
  context: ApiRequestContext = captureApiRequestContext(),
): Promise<VersusIceServers> {
  try {
    const response = await apiFetch('/api/versus/ice-servers', { method: 'GET' }, context);
    if (!response.ok) return FALLBACK_ICE;
    const body = await response.json() as Partial<VersusIceServers>;
    if (!Array.isArray(body.iceServers) || body.iceServers.length === 0) return FALLBACK_ICE;
    return {
      iceServers: body.iceServers,
      turn: body.turn ?? 'unavailable',
    };
  } catch {
    return FALLBACK_ICE;
  }
}

/** Tell the room which fighter you bring (owned or active Arcade); null clears it. */
export async function declareVersusFighter(
  roomCode: string,
  fighterId: string | null,
  context: ApiRequestContext = captureApiRequestContext(),
): Promise<void> {
  const response = await apiFetch(
    `/api/versus/rooms/${encodeURIComponent(roomCode)}/fighter`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fighterId }) },
    context,
  );
  if (!response.ok) throw await readError(response, 'Could not declare fighter');
}

/** The opponent's declared fighter as a downloadable manifest (room-scoped asset URLs). */
export async function fetchVersusOpponentFighter(
  roomCode: string,
  context: ApiRequestContext = captureApiRequestContext(),
): Promise<CloudFighter | null> {
  const response = await apiFetch(
    `/api/versus/rooms/${encodeURIComponent(roomCode)}/opponent-fighter`,
    { method: 'GET' },
    context,
  );
  if (!response.ok) throw await readError(response, 'Could not load opponent fighter');
  const body = await response.json() as { fighter: CloudFighter | null };
  return body.fighter ?? null;
}

/** Host only: allocate the next match serial for result reporting. */
export async function allocateVersusMatch(
  roomCode: string,
  context: ApiRequestContext = captureApiRequestContext(),
): Promise<number> {
  const response = await apiFetch(
    `/api/versus/rooms/${encodeURIComponent(roomCode)}/match`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    context,
  );
  if (!response.ok) throw await readError(response, 'Could not start match');
  const body = await response.json() as { matchSerial: number };
  return body.matchSerial;
}

/** Local cache identity for a fighter fetched through a room. */
export function versusFighterPhotoHash(fighterId: string): string {
  return `versus:${fighterId}`;
}
