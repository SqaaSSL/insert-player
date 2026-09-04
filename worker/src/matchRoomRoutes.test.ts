import { describe, expect, it } from 'vitest';
import type { Env } from './types';
import {
  deriveVersusGuestUserId,
  joinVersusInvitation,
  normalizeVersusGuestId,
} from './matchRoomRoutes';

const INVITE_TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz_23456';

function invitationEnv(onJoin: (body: Record<string, unknown>) => void): Env {
  const invitation = {
    token_hash: 'a'.repeat(64),
    room_code: 'ABC234',
    host_user_id: 'host-user',
    host_display_name: 'Francisco',
    fighter_id: 'fighter-1',
    fighter_name: 'Rosalía',
    fighter_quality_tier: 'champion',
    fighter_source_kind: 'side',
    fighter_source_blob_key: 'fighters/rosalia.png',
    template_version: 'test',
    created_at: '2026-08-31T20:00:00.000Z',
    expires_at: '2026-08-31T20:30:00.000Z',
  };
  const stub = {
    fetch: async (_url: string, init?: RequestInit) => {
      onJoin(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return Response.json({ seat: 'guest', peerConnected: true });
    },
  };
  return {
    ENVIRONMENT: 'development',
    GENERATION_JOB_SIGNING_SECRET: 'guest-test-secret',
    DB: {
      prepare: () => ({ bind: () => ({ first: async () => invitation }) }),
    },
    MATCH_ROOM: {
      idFromName: () => ({}) as DurableObjectId,
      get: () => stub,
    },
  } as unknown as Env;
}

describe('online versus guest identity', () => {
  it('accepts only bounded opaque browser guest ids', () => {
    expect(normalizeVersusGuestId('a'.repeat(32))).toBe('a'.repeat(32));
    expect(normalizeVersusGuestId('short')).toBeNull();
    expect(normalizeVersusGuestId(`${'a'.repeat(24)}!`)).toBeNull();
  });

  it('derives a stable room identity without storing the browser id', async () => {
    const guestId = 'guestBrowserIdentity_1234567890';
    const first = await deriveVersusGuestUserId(INVITE_TOKEN, guestId);
    const second = await deriveVersusGuestUserId(INVITE_TOKEN, guestId);
    const other = await deriveVersusGuestUserId(INVITE_TOKEN, `${guestId}x`);
    expect(first).toMatch(/^guest:[a-f0-9]{32}$/);
    expect(second).toBe(first);
    expect(other).not.toBe(first);
    expect(first).not.toContain(guestId);
  });

  it('seats an anonymous invitation recipient with a signed room ticket', async () => {
    let joinedAs = '';
    const guestId = 'guestBrowserIdentity_1234567890';
    const response = await joinVersusInvitation(
      new Request(`https://api.insertplayer.ai/api/versus/invitations/${INVITE_TOKEN}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guestId }),
      }),
      invitationEnv((body) => { joinedAs = String(body.userId ?? ''); }),
      null,
      INVITE_TOKEN,
    );
    const body = await response.json<{ seat: string; ticket: string }>();
    expect(response.status).toBe(200);
    expect(joinedAs).toBe(await deriveVersusGuestUserId(INVITE_TOKEN, guestId));
    expect(body.seat).toBe('guest');
    expect(body.ticket).toContain('.');
  });

  it('rejects an anonymous join without a valid browser guest identity', async () => {
    let joined = false;
    const response = await joinVersusInvitation(
      new Request(`https://api.insertplayer.ai/api/versus/invitations/${INVITE_TOKEN}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guestId: 'short' }),
      }),
      invitationEnv(() => { joined = true; }),
      null,
      INVITE_TOKEN,
    );
    expect(response.status).toBe(400);
    expect(joined).toBe(false);
  });
});
