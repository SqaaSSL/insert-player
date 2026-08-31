import { describe, expect, it, vi } from 'vitest';

vi.mock('./versusInviteOg', () => ({
  renderVersusInviteOg: vi.fn(),
}));

import type { Env } from './types';
import {
  createVersusInvitationRecord,
  normalizeVersusInviteToken,
  versusInvitationOgBlobKey,
  versusInvitationOgImage,
  versusInvitationSharePage,
  versusInvitationShareUrl,
  versusInviterSlug,
} from './versusInvites';
import { renderVersusInviteOg } from './versusInviteOg';
import { VERSUS_INVITE_TEMPLATE_VERSION } from './versusInviteOgTemplate';

describe('versus invitation protocol', () => {
  it('accepts only the fixed-length base64url token shape', () => {
    const token = 'AbCdEfGhIjKlMnOpQrStUvWxYz_23456';
    expect(normalizeVersusInviteToken(token)).toBe(token);
    expect(normalizeVersusInviteToken('ABC234')).toBeNull();
    expect(normalizeVersusInviteToken(`${token}!`)).toBeNull();
  });

  it('builds canonical public URLs and versioned R2 keys', () => {
    const token = 'AbCdEfGhIjKlMnOpQrStUvWxYz_23456';
    expect(versusInvitationShareUrl(
      new Request('https://api.insertplayer.ai/api/versus/rooms/ABC234/invitations?debug=1'),
      token,
      'Francisco Novella',
    )).toBe(`https://api.insertplayer.ai/v/francisco-novella/${token}`);
    expect(versusInviterSlug(' Rosalía & Co. ')).toBe('rosalia-co');
    expect(versusInvitationOgBlobKey('a'.repeat(64))).toBe(
      `public/versus-invitations/${'a'.repeat(64)}/${VERSUS_INVITE_TEMPLATE_VERSION}.png`,
    );
  });

  it('persists the token hash rather than the bearer token', async () => {
    let values: unknown[] = [];
    const db = {
      prepare: () => ({
        bind: (...bound: unknown[]) => ({
          first: async () => {
            values = bound;
            return {
              token_hash: bound[0],
              room_code: bound[1],
              host_user_id: bound[2],
              fighter_id: bound[3],
              fighter_name: bound[4],
              fighter_quality_tier: bound[5],
              fighter_source_kind: bound[6],
              fighter_source_blob_key: bound[7],
              template_version: bound[8],
              expires_at: bound[9],
              created_at: '2026-08-30T12:00:00.000Z',
            };
          },
        }),
      }),
    };
    const created = await createVersusInvitationRecord({ DB: db } as unknown as Env, {
      roomCode: 'ABC234',
      hostUserId: 'user-host',
      hostDisplayName: 'Francisco',
      fighterId: 'fighter-1',
      fighterName: 'Rosalía',
      fighterQualityTier: 'champion',
      fighterSourceKind: 'side',
      fighterSourceBlobKey: 'users/user-host/fighters/fighter-1/side.png',
    }, Date.UTC(2026, 7, 30, 12, 0, 0));

    expect(created.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(values[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(values[0]).not.toBe(created.token);
    expect(values[9]).toBe('2026-08-30T12:30:00.000Z');
    expect(created.record.host_display_name).toBe('Francisco');
  });

  it('serves crawler metadata without exposing the room code', async () => {
    const token = 'AbCdEfGhIjKlMnOpQrStUvWxYz_23456';
    const record = {
      token_hash: 'a'.repeat(64),
      room_code: 'ABC234',
      host_user_id: 'host-user',
      host_display_name: 'Francisco Novella',
      fighter_id: 'fighter-1',
      fighter_name: 'Rosa <3',
      fighter_quality_tier: 'champion',
      fighter_source_kind: 'side',
      fighter_source_blob_key: 'users/host/fighter.png',
      template_version: VERSUS_INVITE_TEMPLATE_VERSION,
      created_at: '2026-08-30T12:00:00.000Z',
      expires_at: '2026-08-30T12:30:00.000Z',
    };
    const env = {
      CORS_ORIGIN: 'https://insertplayer.ai,https://www.insertplayer.ai',
      PUBLIC_APP_NAME: 'Insert Player',
      PUBLIC_SOCIAL_CARD_PATH: '/assets/social-card.png',
      DB: {
        prepare: () => ({ bind: () => ({ first: async () => record }) }),
      },
    } as unknown as Env;
    const response = await versusInvitationSharePage(
      new Request(`https://api.insertplayer.ai/v/${token}`),
      env,
      token,
    );
    const markup = await response.text();
    expect(response.status).toBe(200);
    expect(markup).toContain(`https://api.insertplayer.ai/v/francisco-novella/${token}/og.png?v=${VERSUS_INVITE_TEMPLATE_VERSION}`);
    expect(markup).toContain(`https://insertplayer.ai/versus/online?invite=${token}`);
    expect(markup).toContain('from=Francisco+Novella');
    expect(markup).toContain('Francisco Novella challenges you');
    expect(markup).toContain('bringing Rosa &lt;3');
    expect(markup).not.toContain('ABC234');
    expect(markup).not.toContain('host-user');
  });

  it('upgrades an active invitation to the current OG template before rendering', async () => {
    const token = 'AbCdEfGhIjKlMnOpQrStUvWxYz_23456';
    const record = {
      token_hash: 'a'.repeat(64),
      room_code: 'ABC234',
      host_user_id: 'host-user',
      host_display_name: 'Francisco',
      fighter_id: 'fighter-1',
      fighter_name: 'Rosalía',
      fighter_quality_tier: 'champion',
      fighter_source_kind: 'side',
      fighter_source_blob_key: 'users/host/fighter.png',
      template_version: 'fight-intro-v1',
      created_at: '2026-08-30T12:00:00.000Z',
      expires_at: '2026-08-30T12:30:00.000Z',
    };
    let upgradedValues: unknown[] = [];
    const pending: Promise<unknown>[] = [];
    const r2Get = vi.fn(async (key: string) => (
      key === record.fighter_source_blob_key
        ? { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }
        : null
    ));
    const r2Put = vi.fn(async () => undefined);
    const r2Delete = vi.fn(async () => undefined);
    const env = {
      DB: {
        prepare: (query: string) => ({
          bind: (...values: unknown[]) => ({
            first: async () => record,
            run: async () => {
              if (query.includes('UPDATE versus_invitations')) upgradedValues = values;
              return { success: true };
            },
          }),
        }),
      },
      SPRITES: { get: r2Get, put: r2Put, delete: r2Delete },
    } as unknown as Env;
    const context = {
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    } as unknown as ExecutionContext;
    vi.mocked(renderVersusInviteOg).mockResolvedValue(new Uint8Array([137, 80, 78, 71]).buffer);

    const response = await versusInvitationOgImage(env, token, context);
    await Promise.all(pending);

    const currentCacheKey = versusInvitationOgBlobKey(record.token_hash, VERSUS_INVITE_TEMPLATE_VERSION);
    expect(response.status).toBe(200);
    expect(upgradedValues).toEqual([VERSUS_INVITE_TEMPLATE_VERSION, record.token_hash]);
    expect(r2Delete).toHaveBeenCalledWith(versusInvitationOgBlobKey(record.token_hash, 'fight-intro-v1'));
    expect(r2Get).toHaveBeenNthCalledWith(1, currentCacheKey);
    expect(r2Get).toHaveBeenNthCalledWith(2, record.fighter_source_blob_key);
    expect(r2Put).toHaveBeenCalledWith(currentCacheKey, expect.any(ArrayBuffer), expect.objectContaining({
      customMetadata: { templateVersion: VERSUS_INVITE_TEMPLATE_VERSION },
    }));
    expect(renderVersusInviteOg).toHaveBeenCalledWith(expect.objectContaining({
      inviterName: 'Francisco',
      fighterName: 'Rosalía',
    }));
  });
});
