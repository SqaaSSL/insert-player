import { describe, expect, it } from 'vitest';
import {
  clearPendingVersusInvite,
  getOrCreateVersusGuestId,
  normalizeVersusInviteToken,
  normalizeVersusRoomCode,
  PENDING_VERSUS_INVITE_TTL_MS,
  readPendingVersusInvite,
  sanitizeVersusRoomCodeInput,
  storePendingVersusInvite,
  versusInviterNameFromSearch,
  versusInvitedFighterNameFromSearch,
  versusInviteTokenFromSearch,
} from './versusInvite.ts';

const INVITE_TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz_23456';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe('online versus invitation links', () => {
  it('normalizes complete room codes and rejects malformed ones', () => {
    expect(normalizeVersusRoomCode(' abc234 ')).toBe('ABC234');
    expect(normalizeVersusRoomCode('ABC23')).toBeNull();
    expect(normalizeVersusRoomCode('ABC-234')).toBeNull();
    expect(normalizeVersusRoomCode('ABC230')).toBeNull();
    expect(normalizeVersusRoomCode('ABC23O')).toBeNull();
  });

  it('sanitizes pasted room codes for the manual join field', () => {
    expect(sanitizeVersusRoomCodeInput('ab-c 2345')).toBe('ABC234');
  });

  it('accepts only the opaque 32-character invitation token', () => {
    expect(normalizeVersusInviteToken(` ${INVITE_TOKEN} `)).toBe(INVITE_TOKEN);
    expect(normalizeVersusInviteToken('ABC234')).toBeNull();
    expect(normalizeVersusInviteToken(`${INVITE_TOKEN}!`)).toBeNull();
    expect(versusInviteTokenFromSearch(`?invite=${INVITE_TOKEN}`)).toBe(INVITE_TOKEN);
    expect(versusInviteTokenFromSearch('?room=ABC234')).toBeNull();
    expect(versusInviterNameFromSearch('?from=Francisco+Novella')).toBe('Francisco Novella');
    expect(versusInvitedFighterNameFromSearch('?fighter=Launch+Test')).toBe('Launch Test');
    expect(versusInviterNameFromSearch('?from=%00%20')).toBeNull();
  });

  it('keeps one opaque guest identity per invitation so the same browser can reconnect', () => {
    const storage = memoryStorage();
    const first = getOrCreateVersusGuestId(INVITE_TOKEN, storage, 10_000, () => 'a'.repeat(32));
    const second = getOrCreateVersusGuestId(INVITE_TOKEN, storage, 10_001, () => 'b'.repeat(32));
    expect(first).toBe('a'.repeat(32));
    expect(second).toBe(first);
  });

  it('rotates the guest identity after the invitation window', () => {
    const storage = memoryStorage();
    getOrCreateVersusGuestId(INVITE_TOKEN, storage, 10_000, () => 'a'.repeat(32));
    expect(getOrCreateVersusGuestId(
      INVITE_TOKEN,
      storage,
      10_000 + PENDING_VERSUS_INVITE_TTL_MS,
      () => 'b'.repeat(32),
    )).toBe('b'.repeat(32));
  });

  it('keeps reconnect identities independent when the browser opens two invitations', () => {
    const storage = memoryStorage();
    const otherToken = 'ZyXwVuTsRqPoNmLkJiHgFeDcBa_65432';
    const first = getOrCreateVersusGuestId(INVITE_TOKEN, storage, 10_000, () => 'a'.repeat(32));
    const other = getOrCreateVersusGuestId(otherToken, storage, 10_001, () => 'b'.repeat(32));
    expect(getOrCreateVersusGuestId(INVITE_TOKEN, storage, 10_002, () => 'c'.repeat(32))).toBe(first);
    expect(getOrCreateVersusGuestId(otherToken, storage, 10_002, () => 'c'.repeat(32))).toBe(other);
  });

  it('persists a pending invite until the room idle window expires', () => {
    const storage = memoryStorage();
    const now = 10_000;
    expect(storePendingVersusInvite(INVITE_TOKEN, 'Francisco', storage, now)).toBe(true);
    expect(readPendingVersusInvite(storage, now + 1)).toEqual({
      token: INVITE_TOKEN,
      inviterName: 'Francisco',
      expiresAt: now + PENDING_VERSUS_INVITE_TTL_MS,
    });
    expect(readPendingVersusInvite(storage, now + PENDING_VERSUS_INVITE_TTL_MS)).toBeNull();
  });

  it('clears a recovered invite after it has been consumed', () => {
    const storage = memoryStorage();
    storePendingVersusInvite(INVITE_TOKEN, null, storage, 10_000);
    clearPendingVersusInvite(storage);
    expect(readPendingVersusInvite(storage, 10_001)).toBeNull();
  });
});
