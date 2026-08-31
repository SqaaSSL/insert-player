import type { AuthContext, Env } from './types';
import { readJsonBody } from './requestBody';
import { readMatchFighterId } from './matchReporting';
import {
  getVersusRoomFighterSourceAsset,
  getVersusRoomFighterSpriteAsset,
  loadVersusInviteFighterSnapshot,
  loadVersusRoomFighterManifest,
} from './fighters';
import {
  createVersusInvitationRecord,
  readActiveVersusInvitation,
  versusInvitationShareUrl,
} from './versusInvites';
import {
  ROOM_TICKET_TTL_SECONDS,
  generateRoomCode,
  mintRoomTicket,
  normalizeRoomCode,
  verifyRoomTicket,
  type RoomRecord,
  type RoomSeat,
} from './matchRoomProtocol';

const MAX_JOIN_BODY_BYTES = 1024;
const ROOM_CODE_ATTEMPTS = 4;
const DEFAULT_STUN_SERVERS = ['stun:stun.cloudflare.com:3478'];
const TURN_CREDENTIAL_TTL_SECONDS = 2 * 60 * 60;
const VERSUS_GUEST_ID_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;

export interface VersusRoomParticipant {
  userId: string;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function roomStub(env: Env, code: string): DurableObjectStub {
  const namespace = env.MATCH_ROOM;
  if (!namespace) throw new Error('MATCH_ROOM binding is not configured');
  return namespace.get(namespace.idFromName(code));
}

export function onlineVersusStatus(env: Env): 'configured' | 'not_configured' {
  return env.MATCH_ROOM ? 'configured' : 'not_configured';
}

/** POST /api/versus/rooms — create a room and seat the caller as host. */
export async function createVersusRoom(env: Env, auth: AuthContext): Promise<Response> {
  if (!env.MATCH_ROOM) return json({ error: 'Online versus is not available' }, 503);
  for (let attempt = 0; attempt < ROOM_CODE_ATTEMPTS; attempt++) {
    const code = generateRoomCode();
    const response = await roomStub(env, code).fetch(`https://room/create?code=${code}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: auth.userId }),
    });
    if (response.status === 409) continue;
    if (!response.ok) return json({ error: 'Could not create room' }, 502);
    const { record } = await response.json<{ record: RoomRecord }>();
    return json({
      roomCode: record.code,
      seat: 'host' satisfies RoomSeat,
      ticket: await mintRoomTicket(env, { roomCode: record.code, seat: 'host', userId: auth.userId }),
      ticketExpiresInSeconds: ROOM_TICKET_TTL_SECONDS,
    }, 201);
  }
  return json({ error: 'Could not allocate a room code' }, 503);
}

async function joinVersusRoomAsParticipant(
  env: Env,
  participant: VersusRoomParticipant,
  rawCode: string,
): Promise<Response> {
  if (!env.MATCH_ROOM) return json({ error: 'Online versus is not available' }, 503);
  const code = normalizeRoomCode(rawCode);
  if (!code) return json({ error: 'Invalid room code' }, 400);
  const response = await roomStub(env, code).fetch('https://room/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: participant.userId, expectedSeat: 'guest' satisfies RoomSeat }),
  });
  if (response.status === 404) return json({ error: 'Room not found' }, 404);
  if (response.status === 409) {
    const conflict: { error?: string } = await response.json<{ error?: string }>().catch(() => ({}));
    return conflict.error === 'seat_conflict'
      ? json({ error: 'This player is already Player 1. Open the link on another device.' }, 409)
      : json({ error: 'Room is full' }, 409);
  }
  if (!response.ok) return json({ error: 'Could not join room' }, 502);
  const { seat, peerConnected } = await response.json<{ seat: RoomSeat; peerConnected: boolean }>();
  return json({
    roomCode: code,
    seat,
    peerConnected,
    ticket: await mintRoomTicket(env, { roomCode: code, seat, userId: participant.userId }),
    ticketExpiresInSeconds: ROOM_TICKET_TTL_SECONDS,
  });
}

/** POST /api/versus/rooms/:code/join — signed-in room-code fallback. */
export async function joinVersusRoom(
  request: Request,
  env: Env,
  auth: AuthContext,
  rawCode: string,
): Promise<Response> {
  // Body is optional today; read it so oversized bodies are still rejected.
  await readJsonBody<Record<string, unknown>>(request, MAX_JOIN_BODY_BYTES).catch(() => ({}));
  return joinVersusRoomAsParticipant(env, auth, rawCode);
}

export function normalizeVersusGuestId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const guestId = value.trim();
  return VERSUS_GUEST_ID_PATTERN.test(guestId) ? guestId : null;
}

export async function deriveVersusGuestUserId(token: string, guestId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`versus-guest:${token}:${guestId}`),
  );
  const suffix = Array.from(new Uint8Array(digest).slice(0, 16), (byte) => (
    byte.toString(16).padStart(2, '0')
  )).join('');
  return `guest:${suffix}`;
}

/**
 * GET /api/versus/rooms/:code/ws?ticket=… — WebSocket upgrade. Browsers
 * cannot set Authorization on a socket, so the ticket minted by create/join
 * is the credential; the Worker verifies it and forwards the seat to the DO
 * on internal headers.
 */
export async function connectVersusRoom(request: Request, env: Env, rawCode: string): Promise<Response> {
  if (!env.MATCH_ROOM) return json({ error: 'Online versus is not available' }, 503);
  if (request.headers.get('Upgrade') !== 'websocket') {
    return json({ error: 'Expected WebSocket upgrade' }, 426);
  }
  const code = normalizeRoomCode(rawCode);
  if (!code) return json({ error: 'Invalid room code' }, 400);
  const ticket = new URL(request.url).searchParams.get('ticket') ?? '';
  const payload = ticket ? await verifyRoomTicket(env, ticket) : null;
  if (!payload || payload.roomCode !== code) {
    return json({ error: 'Invalid or expired room ticket' }, 401);
  }
  const headers = new Headers(request.headers);
  headers.set('X-Room-Seat', payload.seat);
  headers.set('X-Room-User', payload.userId);
  return roomStub(env, code).fetch(new Request('https://room/ws', { headers }));
}

interface IceServerEntry {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/**
 * GET /api/versus/ice-servers — STUN always; short-lived TURN credentials
 * from Cloudflare Realtime when `REALTIME_TURN_KEY_ID` /
 * `REALTIME_TURN_API_TOKEN` are configured. Fails open to STUN-only so a
 * TURN outage degrades to "P2P or relay" instead of blocking play.
 */
export async function versusIceServers(env: Env): Promise<Response> {
  const stun: IceServerEntry[] = [{ urls: DEFAULT_STUN_SERVERS }];
  const keyId = env.REALTIME_TURN_KEY_ID?.trim();
  const apiToken = env.REALTIME_TURN_API_TOKEN?.trim();
  if (!keyId || !apiToken) {
    return json({ iceServers: stun, turn: 'not_configured' });
  }
  try {
    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: TURN_CREDENTIAL_TTL_SECONDS }),
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) {
      console.warn(`Realtime TURN credential request failed: ${response.status}`);
      return json({ iceServers: stun, turn: 'unavailable' });
    }
    const body = await response.json<{ iceServers?: IceServerEntry | IceServerEntry[] }>();
    const turnServers = Array.isArray(body.iceServers)
      ? body.iceServers
      : body.iceServers
        ? [body.iceServers]
        : [];
    const sanitized = turnServers
      .filter((entry) => entry && entry.urls)
      .map((entry) => ({ urls: entry.urls, username: entry.username, credential: entry.credential }));
    return json({ iceServers: [...stun, ...sanitized], turn: sanitized.length > 0 ? 'configured' : 'unavailable' });
  } catch (err) {
    console.warn('Realtime TURN credential request errored:', err instanceof Error ? err.message : err);
    return json({ iceServers: stun, turn: 'unavailable' });
  }
}

// ------------------------------------------------------ fighters per room

interface RoomRecordView {
  record: RoomRecord;
  peers: { host: boolean; guest: boolean };
}

async function readRoomRecord(env: Env, code: string): Promise<RoomRecordView | null> {
  const response = await roomStub(env, code).fetch('https://room/record', { method: 'GET' });
  if (!response.ok) return null;
  return response.json<RoomRecordView>();
}

function seatOf(record: RoomRecord, userId: string): RoomSeat | null {
  if (record.hostUserId === userId) return 'host';
  if (record.guestUserId === userId) return 'guest';
  return null;
}

function declaredFighterId(record: RoomRecord, seat: RoomSeat): string | null {
  return (seat === 'host' ? record.hostFighterId : record.guestFighterId) ?? null;
}

/** POST /api/versus/rooms/:code/invitations — host creates a character-aware share link. */
export async function createVersusInvitation(
  request: Request,
  env: Env,
  auth: AuthContext,
  rawCode: string,
): Promise<Response> {
  if (!env.MATCH_ROOM) return json({ error: 'Online versus is not available' }, 503);
  const code = normalizeRoomCode(rawCode);
  if (!code) return json({ error: 'Invalid room code' }, 400);
  const view = await readRoomRecord(env, code);
  if (!view) return json({ error: 'Room not found' }, 404);
  if (view.record.hostUserId !== auth.userId) {
    return json({ error: 'Only the host can create an invitation link' }, 403);
  }

  const body = await readJsonBody<{ fighterId?: unknown }>(request, MAX_JOIN_BODY_BYTES);
  const fighterId = await readMatchFighterId(env, auth.userId, body.fighterId);
  if (!fighterId) return json({ error: 'Fighter is not owned or an active Arcade fighter' }, 403);
  const snapshot = await loadVersusInviteFighterSnapshot(env, fighterId);
  if (!snapshot) return json({ error: 'Fighter is not playable' }, 409);
  if (!await env.SPRITES.head(snapshot.sourceBlobKey)) {
    return json({ error: 'Fighter preview is unavailable' }, 409);
  }

  const invitation = await createVersusInvitationRecord(env, {
    roomCode: code,
    hostUserId: auth.userId,
    hostDisplayName: auth.user.display_name,
    fighterId: snapshot.fighterId,
    fighterName: snapshot.fighterName,
    fighterQualityTier: snapshot.qualityTier,
    fighterSourceKind: snapshot.sourceKind,
    fighterSourceBlobKey: snapshot.sourceBlobKey,
  });
  return json({
    invitation: {
      url: versusInvitationShareUrl(request, invitation.token, invitation.record.host_display_name),
      expiresAt: invitation.record.expires_at,
      inviter: {
        displayName: invitation.record.host_display_name,
      },
      fighter: {
        id: invitation.record.fighter_id,
        name: invitation.record.fighter_name,
        qualityTier: invitation.record.fighter_quality_tier,
      },
    },
  }, 201);
}

/** POST /api/versus/invitations/:token/join — resolve an opaque invite and take a seat. */
export async function joinVersusInvitation(
  request: Request,
  env: Env,
  participant: VersusRoomParticipant | null,
  rawToken: string,
): Promise<Response> {
  const invitation = await readActiveVersusInvitation(env, rawToken);
  if (!invitation) return json({ error: 'Invitation is invalid or has expired' }, 410);
  if (participant) {
    await readJsonBody<Record<string, unknown>>(request, MAX_JOIN_BODY_BYTES).catch(() => ({}));
    return joinVersusRoomAsParticipant(env, participant, invitation.record.room_code);
  }
  const body = await readJsonBody<{ guestId?: unknown }>(request, MAX_JOIN_BODY_BYTES);
  const guestId = normalizeVersusGuestId(body.guestId);
  if (!guestId) return json({ error: 'A valid guest identity is required' }, 400);
  return joinVersusRoomAsParticipant(env, {
    userId: await deriveVersusGuestUserId(invitation.token, guestId),
  }, invitation.record.room_code);
}

/** POST /api/versus/rooms/:code/fighter { fighterId } — declare the fighter you will bring. */
export async function declareVersusFighter(
  request: Request,
  env: Env,
  auth: VersusRoomParticipant,
  rawCode: string,
): Promise<Response> {
  if (!env.MATCH_ROOM) return json({ error: 'Online versus is not available' }, 503);
  const code = normalizeRoomCode(rawCode);
  if (!code) return json({ error: 'Invalid room code' }, 400);
  const body = await readJsonBody<{ fighterId?: unknown }>(request, MAX_JOIN_BODY_BYTES);
  let fighterId: string | null = null;
  if (body.fighterId !== null && body.fighterId !== undefined) {
    fighterId = (await readMatchFighterId(env, auth.userId, body.fighterId)) ?? null;
    if (!fighterId) return json({ error: 'Fighter is not owned or an active Arcade fighter' }, 403);
  }
  const response = await roomStub(env, code).fetch('https://room/fighter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: auth.userId, fighterId }),
  });
  if (response.status === 404) return json({ error: 'Room not found' }, 404);
  if (response.status === 403) return json({ error: 'You are not seated in this room' }, 403);
  if (!response.ok) return json({ error: 'Could not declare fighter' }, 502);
  const { seat } = await response.json<{ seat: RoomSeat }>();
  return json({ roomCode: code, seat, fighterId });
}

/** GET /api/versus/rooms/:code/opponent-fighter — the manifest the other seat declared. */
export async function getVersusOpponentFighter(
  request: Request,
  env: Env,
  auth: VersusRoomParticipant,
  rawCode: string,
): Promise<Response> {
  if (!env.MATCH_ROOM) return json({ error: 'Online versus is not available' }, 503);
  const code = normalizeRoomCode(rawCode);
  if (!code) return json({ error: 'Invalid room code' }, 400);
  const view = await readRoomRecord(env, code);
  if (!view) return json({ error: 'Room not found' }, 404);
  const seat = seatOf(view.record, auth.userId);
  if (!seat) return json({ error: 'You are not seated in this room' }, 403);
  const opponentSeat: RoomSeat = seat === 'host' ? 'guest' : 'host';
  const fighterId = declaredFighterId(view.record, opponentSeat);
  if (!fighterId) return json({ fighter: null, seat: opponentSeat });
  const manifest = await loadVersusRoomFighterManifest(request, env, code, fighterId);
  if (!manifest) return json({ error: 'Opponent fighter is not playable' }, 409);
  return json({ fighter: manifest, seat: opponentSeat });
}

/**
 * GET /api/versus/rooms/:code/fighters/:id/(sprites/:spriteId|sources/:kind)/:revision
 * Serves clean assets of a fighter declared by either seat to the other seat.
 */
export async function getVersusRoomAsset(
  env: Env,
  auth: VersusRoomParticipant,
  rawCode: string,
  fighterId: string,
  kind: 'sprites' | 'sources',
  id: string,
  revision: string,
): Promise<Response> {
  if (!env.MATCH_ROOM) return json({ error: 'Online versus is not available' }, 503);
  const code = normalizeRoomCode(rawCode);
  if (!code) return json({ error: 'Invalid room code' }, 400);
  const view = await readRoomRecord(env, code);
  if (!view) return json({ error: 'Room not found' }, 404);
  const seat = seatOf(view.record, auth.userId);
  if (!seat) return json({ error: 'You are not seated in this room' }, 403);
  const declared = [declaredFighterId(view.record, 'host'), declaredFighterId(view.record, 'guest')];
  if (!declared.includes(fighterId)) return json({ error: 'Asset not found' }, 404);
  if (kind === 'sprites') return getVersusRoomFighterSpriteAsset(env, fighterId, id, revision);
  if (id !== 'side' && id !== 'upright' && id !== 'crouch') return json({ error: 'Asset not found' }, 404);
  return getVersusRoomFighterSourceAsset(env, fighterId, id, revision);
}

/** POST /api/versus/rooms/:code/match — host allocates the next match serial. */
export async function allocateVersusMatch(
  env: Env,
  auth: VersusRoomParticipant,
  rawCode: string,
): Promise<Response> {
  if (!env.MATCH_ROOM) return json({ error: 'Online versus is not available' }, 503);
  const code = normalizeRoomCode(rawCode);
  if (!code) return json({ error: 'Invalid room code' }, 400);
  const response = await roomStub(env, code).fetch('https://room/match', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: auth.userId }),
  });
  if (response.status === 404) return json({ error: 'Room not found' }, 404);
  if (response.status === 403) return json({ error: 'Only the host starts a match' }, 403);
  if (!response.ok) return json({ error: 'Could not start match' }, 502);
  const { matchSerial } = await response.json<{ matchSerial: number }>();
  return json({ roomCode: code, matchSerial });
}

export interface VersusMatchParticipants {
  matchId: string;
  hostUserId: string;
  guestUserId: string;
  hostFighterId: string | null;
  guestFighterId: string | null;
  seat: RoomSeat;
}

/** Resolve who played a reported online match; null when the caller is not seated. */
export async function resolveVersusMatchParticipants(
  env: Env,
  auth: AuthContext,
  rawCode: unknown,
  rawSerial: unknown,
): Promise<VersusMatchParticipants | null> {
  if (!env.MATCH_ROOM) return null;
  const code = normalizeRoomCode(rawCode);
  const serial = Number(rawSerial);
  if (!code || !Number.isInteger(serial) || serial < 1) return null;
  const view = await readRoomRecord(env, code);
  if (!view || !view.record.guestUserId) return null;
  const seat = seatOf(view.record, auth.userId);
  if (!seat) return null;
  if ((view.record.matchSerial ?? 0) < serial) return null;
  return {
    matchId: `versus:${code}:${serial}`,
    hostUserId: view.record.hostUserId,
    guestUserId: view.record.guestUserId,
    hostFighterId: view.record.hostFighterId ?? null,
    guestFighterId: view.record.guestFighterId ?? null,
    seat,
  };
}
