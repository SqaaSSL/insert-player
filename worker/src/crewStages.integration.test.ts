import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';
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
  CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT NOT NULL);
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
  await db.prepare('INSERT INTO users (id, display_name) VALUES (?, ?)').bind(USER_ID, 'Stage Admin').run();
  return { mf, db, bucket, env: { DB: db, SPRITES: bucket } as unknown as Env };
}

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
});
