import { describe, expect, it } from 'vitest';
import {
  MAX_RELAY_PAYLOAD_BYTES,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_IDLE_TTL_MS,
  ROOM_TICKET_TTL_SECONDS,
  assignSeat,
  generateRoomCode,
  isRoomExpired,
  mintRoomTicket,
  normalizeRoomCode,
  otherSeat,
  parseClientMessage,
  verifyRoomTicket,
  type RoomRecord,
} from './matchRoomProtocol';

const env = { GENERATION_JOB_SIGNING_SECRET: 'test-secret', ENVIRONMENT: 'test' };

describe('room codes', () => {
  it('generates codes from the unambiguous alphabet', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateRoomCode();
      expect(code).toHaveLength(ROOM_CODE_LENGTH);
      for (const character of code) expect(ROOM_CODE_ALPHABET).toContain(character);
      expect(normalizeRoomCode(code)).toBe(code);
    }
    expect(ROOM_CODE_ALPHABET).not.toMatch(/[0O1IL]/);
  });

  it('normalizes user input and rejects junk', () => {
    expect(normalizeRoomCode(' ab-c d23 ')).toBe('ABCD23');
    expect(normalizeRoomCode('abcd2')).toBeNull();
    expect(normalizeRoomCode('ABCD10')).toBeNull(); // 1 and 0 are not in the alphabet
    expect(normalizeRoomCode(42)).toBeNull();
    expect(normalizeRoomCode('ABCDEFG')).toBeNull();
  });
});

describe('room tickets', () => {
  it('round-trips and binds room, seat, and user', async () => {
    const ticket = await mintRoomTicket(env, { roomCode: 'ABCDEF', seat: 'guest', userId: 'user_1' }, 1_000);
    const payload = await verifyRoomTicket(env, ticket, 1_001);
    expect(payload).toMatchObject({ roomCode: 'ABCDEF', seat: 'guest', userId: 'user_1', purpose: 'room' });
    expect(payload?.exp).toBe(1_000 + ROOM_TICKET_TTL_SECONDS);
  });

  it('rejects expired, tampered, or foreign-secret tickets', async () => {
    const ticket = await mintRoomTicket(env, { roomCode: 'ABCDEF', seat: 'host', userId: 'user_1' }, 1_000);
    expect(await verifyRoomTicket(env, ticket, 1_000 + ROOM_TICKET_TTL_SECONDS)).toBeNull();
    const [encoded, signature] = ticket.split('.');
    expect(await verifyRoomTicket(env, `${encoded}x.${signature}`, 1_001)).toBeNull();
    expect(await verifyRoomTicket(env, `${encoded}.${signature.slice(0, -2)}AA`, 1_001)).toBeNull();
    expect(await verifyRoomTicket({ ...env, GENERATION_JOB_SIGNING_SECRET: 'other' }, ticket, 1_001)).toBeNull();
    expect(await verifyRoomTicket(env, 'garbage', 1_001)).toBeNull();
  });

  it('requires a signing secret outside development', async () => {
    await expect(
      mintRoomTicket({ ENVIRONMENT: 'production' }, { roomCode: 'ABCDEF', seat: 'host', userId: 'u' }),
    ).rejects.toThrow(/GENERATION_JOB_SIGNING_SECRET/);
    const dev = await mintRoomTicket({ ENVIRONMENT: 'development' }, { roomCode: 'ABCDEF', seat: 'host', userId: 'u' });
    expect(await verifyRoomTicket({ ENVIRONMENT: 'development' }, dev)).not.toBeNull();
  });
});

describe('client messages', () => {
  it('accepts the three message kinds', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'ping', t: 12.5 }))).toEqual({ ok: true, message: { type: 'ping', t: 12.5 } });
    expect(parseClientMessage(JSON.stringify({ type: 'signal', payload: { sdp: 'x' } }))).toEqual({
      ok: true,
      message: { type: 'signal', payload: { sdp: 'x' } },
    });
    expect(parseClientMessage(JSON.stringify({ type: 'relay', data: 'AAAA' }))).toEqual({
      ok: true,
      message: { type: 'relay', data: 'AAAA' },
    });
  });

  it('rejects malformed and oversized messages', () => {
    expect(parseClientMessage('not json')).toEqual({ ok: false, code: 'invalid_message' });
    expect(parseClientMessage(new ArrayBuffer(4) as never)).toEqual({ ok: false, code: 'invalid_message' });
    expect(parseClientMessage(JSON.stringify({ type: 'nope' }))).toEqual({ ok: false, code: 'invalid_message' });
    expect(parseClientMessage(JSON.stringify({ type: 'ping', t: 'now' }))).toEqual({ ok: false, code: 'invalid_message' });
    expect(parseClientMessage(JSON.stringify({ type: 'relay', data: 1 }))).toEqual({ ok: false, code: 'invalid_message' });
    expect(parseClientMessage(JSON.stringify({ type: 'relay', data: 'x'.repeat(MAX_RELAY_PAYLOAD_BYTES + 1) }))).toEqual({
      ok: false,
      code: 'too_large',
    });
    expect(parseClientMessage(JSON.stringify({ type: 'signal', payload: 'x'.repeat(9_000) }))).toEqual({
      ok: false,
      code: 'too_large',
    });
  });
});

describe('seating', () => {
  const record: RoomRecord = {
    code: 'ABCDEF',
    hostUserId: 'host',
    guestUserId: null,
    createdAt: 0,
    lastActivityAt: 0,
  };

  it('seats host, then one guest, and lets both reconnect', () => {
    expect(assignSeat(null, 'anyone', 10)).toEqual({ ok: false, reason: 'not_found' });
    const host = assignSeat(record, 'host', 10);
    expect(host).toMatchObject({ ok: true, seat: 'host' });

    const guest = assignSeat(record, 'guest', 20);
    expect(guest).toMatchObject({ ok: true, seat: 'guest' });
    const withGuest = (guest as { record: RoomRecord }).record;
    expect(withGuest.guestUserId).toBe('guest');
    expect(withGuest.lastActivityAt).toBe(20);

    expect(assignSeat(withGuest, 'guest', 30)).toMatchObject({ ok: true, seat: 'guest' });
    expect(assignSeat(withGuest, 'host', 30)).toMatchObject({ ok: true, seat: 'host' });
    expect(assignSeat(withGuest, 'third', 30)).toEqual({ ok: false, reason: 'full' });
  });

  it('expires idle rooms', () => {
    expect(isRoomExpired(record, ROOM_IDLE_TTL_MS)).toBe(false);
    expect(isRoomExpired(record, ROOM_IDLE_TTL_MS + 1)).toBe(true);
    expect(otherSeat('host')).toBe('guest');
    expect(otherSeat('guest')).toBe('host');
  });
});
