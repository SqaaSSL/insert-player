import { Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { getOrganizationMembershipList, getClerkUser } = vi.hoisted(() => ({
  getOrganizationMembershipList: vi.fn(),
  getClerkUser: vi.fn(),
}));
vi.mock('@clerk/backend', () => ({
  createClerkClient: () => ({
    organizations: { getOrganizationMembershipList },
    users: { getUser: getClerkUser },
  }),
}));
import {
  getCrewStageAsset,
  getCrewStageStatus,
  uploadCrewStage,
} from './crewStages';
import type { AuthContext, Env } from './types';

const USER_ID = '11111111111111111111111111111111';
const ORGANIZATION_ID = 'org_stage_crew';
const runtimes: Miniflare[] = [];

const SCHEMA = `
  CREATE TABLE users (id TEXT PRIMARY KEY, clerk_user_id TEXT, display_name TEXT NOT NULL);
  CREATE TABLE crew_referrals (
    id TEXT PRIMARY KEY,
    clerk_organization_id TEXT NOT NULL,
    inviter_user_id TEXT NOT NULL,
    invitee_user_id TEXT,
    status TEXT NOT NULL
  );
  CREATE TABLE generation_charges (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    reason TEXT NOT NULL,
    status TEXT NOT NULL
  );
  CREATE TABLE crew_stages (
    clerk_organization_id TEXT PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    generation_charge_id TEXT UNIQUE REFERENCES generation_charges(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'reserved',
    label TEXT NOT NULL DEFAULT 'CREW STAGE',
    kind TEXT,
    blob_key TEXT,
    content_hash TEXT,
    source_json TEXT,
    reservation_expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

async function bindings(): Promise<{ mf: Miniflare; db: D1Database; env: Env; bucket: R2Bucket }> {
  const mf = new Miniflare({
    workers: [{ config: {
      type: 'worker',
      name: `crew-stages-${runtimes.length}`,
      compatibilityDate: '2026-08-24',
      manifest: { mainModule: 'index.js', modules: { 'index.js': {
        type: 'esm',
        contents: 'export default { fetch() { return new Response("ok"); } };',
      } } },
      env: {
        DB: { type: 'd1', id: `crew-stages-${runtimes.length}` },
        SPRITES: { type: 'r2', name: `crew-stages-${runtimes.length}` },
      },
    } }],
  });
  runtimes.push(mf);
  const db = await mf.getD1Database('DB');
  const bucket = await mf.getR2Bucket('SPRITES') as unknown as R2Bucket;
  await db.batch(SCHEMA.split(';').map((sql) => sql.trim()).filter(Boolean).map((sql) => db.prepare(sql)));
  await db.prepare('INSERT INTO users (id, clerk_user_id, display_name) VALUES (?, ?, ?)')
    .bind(USER_ID, 'clerk_admin', 'Stage Admin').run();
  return { mf, db, bucket, env: { DB: db, SPRITES: bucket, CLERK_SECRET_KEY: 'sk_test_stage' } as unknown as Env };
}

async function acceptedFriend(db: D1Database, organizationId = ORGANIZATION_ID): Promise<void> {
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO users (id, clerk_user_id, display_name)
      VALUES ('friend', 'clerk_friend', 'Player Two')`),
    db.prepare(`INSERT INTO crew_referrals (id, clerk_organization_id, inviter_user_id, invitee_user_id, status)
      VALUES (?, ?, ?, 'friend', 'accepted')`).bind(`referral-${organizationId}`, organizationId, USER_ID),
  ]);
}

beforeEach(() => {
  vi.resetAllMocks();
  getOrganizationMembershipList.mockResolvedValue({ data: [{ id: 'membership_friend' }] });
  getClerkUser.mockResolvedValue({ externalAccounts: [{
    provider: 'oauth_google', providerUserId: 'google_friend', verification: { status: 'verified' },
  }] });
});

function auth(role = 'org:admin', organizationId = ORGANIZATION_ID): AuthContext {
  return {
    userId: USER_ID,
    claims: {},
    activeOrganizationId: organizationId,
    activeOrganizationRole: role,
    user: { id: USER_ID, display_name: 'Stage Admin' },
  } as AuthContext;
}

function stagePng(): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  new DataView(bytes.buffer).setUint32(16, 1024);
  new DataView(bytes.buffer).setUint32(20, 576);
  return bytes;
}

function uploadRequest(
  kind: 'photo' | 'photo-direct',
  purchaseId?: string,
  source?: Record<string, unknown>,
): Request {
  const form = new FormData();
  form.set('label', 'THE OLD PARK');
  form.set('kind', kind);
  if (purchaseId) form.set('purchaseId', purchaseId);
  if (source) form.set('source', JSON.stringify(source));
  form.set('file', new File([stagePng()], 'stage.png', { type: 'image/png' }));
  return new Request('https://api.insertplayer.ai/api/crew/stage', { method: 'POST', body: form });
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

describe('one shared stage per Crew', () => {
  it('lets one admin lock it once and lets only active Crew members read the private asset', async () => {
    const { db, env } = await bindings();
    await acceptedFriend(db);
    expect((await getCrewStageStatus(new Request('https://api.insertplayer.ai/api/crew/stage'), env, auth())).status)
      .toBe(200);
    expect((await uploadCrewStage(uploadRequest('photo-direct'), env, auth('org:member'))).status).toBe(403);

    const source = {
      provider: 'google-street-view',
      panoId: 'park-pano_42',
      latitude: 38.5411,
      longitude: -0.1225,
      heading: 90,
      pitch: 2,
      fov: 70,
      locationLabel: 'The Old Park',
      capturedAt: 1_789_508_800_000,
    };
    const created = await uploadCrewStage(uploadRequest('photo-direct', undefined, source), env, auth());
    expect(created.status).toBe(201);
    const payload = await created.json() as {
      stage: { id: string; label: string; assetUrl: string; source: unknown };
    };
    expect(payload.stage).toMatchObject({ label: 'THE OLD PARK', source });
    expect(await db.prepare('SELECT COUNT(*) AS count FROM crew_stages').first()).toEqual({ count: 1 });
    expect((await uploadCrewStage(uploadRequest('photo-direct'), env, auth())).status).toBe(409);

    const sameCrewAsset = await getCrewStageAsset(env, auth('org:member'), payload.stage.id);
    expect(sameCrewAsset.status).toBe(200);
    expect(sameCrewAsset.headers.get('Content-Type')).toBe('image/png');
    expect(new Uint8Array(await sameCrewAsset.arrayBuffer())).toEqual(stagePng());
    expect((await getCrewStageAsset(env, auth('org:admin', 'org_other_crew'), payload.stage.id)).status)
      .toBe(404);
  });

  it('serializes concurrent direct claims so two admins cannot lock two included stages', async () => {
    const { db, env } = await bindings();
    await acceptedFriend(db);
    const responses = await Promise.all([
      uploadCrewStage(uploadRequest('photo-direct'), env, auth()),
      uploadCrewStage(uploadRequest('photo-direct'), env, auth()),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(await db.prepare(`
      SELECT COUNT(*) AS count FROM crew_stages WHERE clerk_organization_id = ?
    `).bind(ORGANIZATION_ID).first()).toEqual({ count: 1 });
  });

  it('accepts a forged stage only from the committed included Crew charge', async () => {
    const { db, env } = await bindings();
    const stageId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const purchaseId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    await db.batch([
      db.prepare(`
        INSERT INTO generation_charges (id, user_id, reason, status)
        VALUES (?, ?, 'crew_stage_included', 'committed')
      `).bind(purchaseId, USER_ID),
      db.prepare(`
        INSERT INTO crew_stages (
          clerk_organization_id, id, created_by_user_id, generation_charge_id,
          status, reservation_expires_at
        ) VALUES (?, ?, ?, ?, 'reserved', datetime('now', '+12 hours'))
      `).bind(ORGANIZATION_ID, stageId, USER_ID, purchaseId),
    ]);

    expect((await uploadCrewStage(uploadRequest('photo'), env, auth())).status).toBe(409);
    const created = await uploadCrewStage(uploadRequest('photo', purchaseId), env, auth());
    expect(created.status).toBe(201);
    expect(await db.prepare(`
      SELECT status, kind, generation_charge_id FROM crew_stages WHERE clerk_organization_id = ?
    `).bind(ORGANIZATION_ID).first()).toEqual({
      status: 'ready',
      kind: 'photo',
      generation_charge_id: purchaseId,
    });
  });

  it('blocks both the creation quote and direct upload until a verified friend really joins', async () => {
    const { db, env, bucket } = await bindings();
    const request = new Request('https://api.insertplayer.ai/api/crew/stage');
    expect(await (await getCrewStageStatus(request, env, auth())).json()).toMatchObject({
      canCreate: false, eligibilityReason: 'crew_stage_friend_required',
    });
    const empty = await uploadCrewStage(uploadRequest('photo-direct'), env, auth());
    expect(empty.status).toBe(409);
    expect(await empty.json()).toMatchObject({ code: 'crew_stage_friend_required' });
    await acceptedFriend(db);
    getOrganizationMembershipList.mockResolvedValue({ data: [] });
    expect((await uploadCrewStage(uploadRequest('photo-direct'), env, auth())).status).toBe(409);
    getOrganizationMembershipList.mockResolvedValue({ data: [{ id: 'membership_friend' }] });
    getClerkUser.mockResolvedValue({ externalAccounts: [{
      provider: 'oauth_google', providerUserId: 'google_friend', verification: { status: 'unverified' },
    }] });
    expect((await uploadCrewStage(uploadRequest('photo-direct'), env, auth())).status).toBe(409);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM crew_stages').first()).toEqual({ count: 0 });
    expect((await bucket.list()).objects).toHaveLength(0);
  });

  it.each(['pending', 'revoked', 'rejected', 'expired'])('does not unlock a stage for a %s invitation', async (status) => {
    const { db, env } = await bindings();
    await acceptedFriend(db);
    await db.prepare('UPDATE crew_referrals SET status = ?').bind(status).run();
    const response = await uploadCrewStage(uploadRequest('photo-direct'), env, auth());
    expect(response.status).toBe(409);
    expect(getOrganizationMembershipList).not.toHaveBeenCalled();
  });

  it('does not count self-invites or an accepted invitation to another Crew', async () => {
    const { db, env } = await bindings();
    await acceptedFriend(db, 'org_other_crew');
    await db.prepare(`INSERT INTO crew_referrals
      (id, clerk_organization_id, inviter_user_id, invitee_user_id, status)
      VALUES ('self', ?, ?, ?, 'accepted')`).bind(ORGANIZATION_ID, USER_ID, USER_ID).run();
    expect((await uploadCrewStage(uploadRequest('photo-direct'), env, auth())).status).toBe(409);
    expect(getOrganizationMembershipList).not.toHaveBeenCalled();
  });

  it('fails closed during identity verification outages without using the included slot', async () => {
    const { db, env } = await bindings();
    await acceptedFriend(db);
    getOrganizationMembershipList.mockRejectedValue(new Error('Clerk unavailable'));
    const response = await uploadCrewStage(uploadRequest('photo-direct'), env, auth());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'crew_stage_verification_unavailable' });
    const status = await getCrewStageStatus(new Request('https://api.insertplayer.ai/api/crew/stage'), env, auth());
    expect(await status.json()).toMatchObject({ canCreate: false, eligibilityReason: 'crew_stage_verification_unavailable' });
    expect(await db.prepare('SELECT COUNT(*) AS count FROM crew_stages').first()).toEqual({ count: 0 });
  });

  it('bounds checks of historical accepted accounts and reports an incomplete verification honestly', async () => {
    const { db, env } = await bindings();
    await db.batch(Array.from({ length: 13 }, (_, index) => [
      db.prepare('INSERT INTO users (id, clerk_user_id, display_name) VALUES (?, ?, ?)')
        .bind(`old_friend_${index}`, `clerk_old_${index}`, 'Old Member'),
      db.prepare(`INSERT INTO crew_referrals (id, clerk_organization_id, inviter_user_id, invitee_user_id, status)
        VALUES (?, ?, ?, ?, 'accepted')`).bind(`old_referral_${index}`, ORGANIZATION_ID, USER_ID, `old_friend_${index}`),
    ]).flat());
    getOrganizationMembershipList.mockResolvedValue({ data: [] });
    const status = await getCrewStageStatus(new Request('https://api.insertplayer.ai/api/crew/stage'), env, auth());
    expect(await status.json()).toMatchObject({ canCreate: false, eligibilityReason: 'crew_stage_verification_unavailable' });
    expect(getOrganizationMembershipList).toHaveBeenCalledTimes(12);
    expect(getClerkUser).not.toHaveBeenCalled();
  });

  it('lets another Crew admin use the same Crew benefit without requiring a personal invite', async () => {
    const { db, env } = await bindings();
    await acceptedFriend(db);
    await db.prepare(`INSERT INTO users (id, clerk_user_id, display_name)
      VALUES ('other_admin', 'clerk_other_admin', 'Other admin')`).run();
    const otherAdmin = { ...auth(), userId: 'other_admin', user: { ...auth().user, id: 'other_admin' } };
    expect((await uploadCrewStage(uploadRequest('photo-direct'), env, otherAdmin)).status).toBe(201);
  });

  it('preserves the winning asset when two retries upload the same authorized forge concurrently', async () => {
    const { db, env, bucket } = await bindings();
    const stageId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const purchaseId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    await db.batch([
      db.prepare(`INSERT INTO generation_charges (id, user_id, reason, status)
        VALUES (?, ?, 'crew_stage_included', 'committed')`).bind(purchaseId, USER_ID),
      db.prepare(`INSERT INTO crew_stages (clerk_organization_id, id, created_by_user_id, generation_charge_id, status)
        VALUES (?, ?, ?, ?, 'reserved')`).bind(ORGANIZATION_ID, stageId, USER_ID, purchaseId),
    ]);
    const responses = await Promise.all([
      uploadCrewStage(uploadRequest('photo', purchaseId), env, auth()),
      uploadCrewStage(uploadRequest('photo', purchaseId), env, auth()),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const asset = await getCrewStageAsset(env, auth('org:member'), stageId);
    expect(asset.status).toBe(200);
    expect(new Uint8Array(await asset.arrayBuffer())).toEqual(stagePng());
    expect((await bucket.list()).objects).toHaveLength(1);
  });
});
