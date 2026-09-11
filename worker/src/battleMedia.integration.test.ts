import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CURRENT_LEGAL_VERSION } from './legal';
import type { SavedBattle } from '../../src/shared/BattleFinisher';
const ORIGIN = 'https://api.insertplayer.ai';
const jpeg = Buffer.from([255,216,255,192,0,17,8,2,208,5,0,3,1,17,0,2,17,0,3,17,0,0,255,217]);
const video = Uint8Array.from([0,0,0,24,102,116,121,112,105,115,111,109,...Array.from({ length: 100 }, (_, i) => i)]);
const summary = { game: 'aura', winner: 'p1', p1Name: 'Trump', p2Name: 'Lamine', stageLabel: 'Aura Plaza', durationSeconds: 40, p1Score: 12300, p2Score: 8000 };
const legal = { legalVersion: CURRENT_LEGAL_VERSION, ageConfirmed: true, termsAccepted: true, photoRightsConfirmed: true, aiProcessingConfirmed: true, immediatePerformanceConfirmed: true, withdrawalLossAcknowledged: true };
let mf: Miniflare, db: D1Database, bucket: R2Bucket;
beforeAll(async () => {
  const bundled = await build({ stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
    import { createBattle, listBattles, getBattle, getBattleMedia, uploadBattleRecording, createBattleFinisher, publishBattle, deleteBattle, failFinisher, cleanupBattleMedia } from './worker/src/battleMedia';
    import { submitFinisher, pollFinisher } from './worker/src/battleFinisherProvider';
    let scenario = 'success', posts = 0, input = null, workflowStarts = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      const value = String(url);
      if (value === 'https://queue.fal.run/minimax/h3-max-turbo/image-to-video') {
        posts++; input = JSON.parse(options.body);
        if (scenario === 'unknown') throw new Error('network_unknown');
        return Response.json({ request_id: 'req_1', status_url: 'https://queue.fal.run/minimax/h3-max-turbo/requests/req_1/status', response_url: 'https://queue.fal.run/minimax/h3-max-turbo/requests/req_1' });
      }
      if (value.endsWith('/status')) return Response.json({ status: scenario === 'pending' ? 'IN_PROGRESS' : 'COMPLETED' });
      if (value.endsWith('/requests/req_1')) return Response.json(scenario === 'failed' ? { error: 'moderation' } : { video: { url: scenario === 'ssrf' ? 'https://localhost/private' : 'https://v3.fal.media/files/finisher.mp4' } });
      if (value === 'https://v3.fal.media/files/finisher.mp4') return new Response(new Uint8Array(${JSON.stringify([...video])}), { headers: { 'Content-Type': 'video/mp4' } });
      throw new Error('Unexpected external request: ' + value);
    };
    export default { async fetch(request, bindings) {
      const path = new URL(request.url).pathname;
      const env = { ...bindings, ENVIRONMENT: 'development', CORS_ORIGIN: 'https://insertplayer.ai', FAL_API_KEY: 'test-never-external', BATTLE_FINISHER: { create: async () => { workflowStarts++; if (scenario === 'dispatch-failed') throw new Error('workflow_unavailable'); return {}; }, get: async () => ({ status: async () => ({ status: scenario === 'dispatch-failed' ? 'unknown' : 'queued' }) }) } };
      const user = request.headers.get('test-user') ?? null;
      const auth = { userId: user, user: user ? { id: user, plan_tier: 'free' } : null, claims: null, rateLimitKey: user ?? 'anon' };
      if (path === '/test/reset') { scenario = 'success'; posts = 0; input = null; workflowStarts = 0; return new Response('ok'); }
      if (path === '/test/provider') { if (request.method === 'POST') scenario = (await request.json()).scenario; return Response.json({ posts, input, workflowStarts }); }
      if (scenario === 'delete-during-still') env.SPRITES = { put: async (key, body, options) => {
        const result = await bindings.SPRITES.put(key, body, options);
        await bindings.DB.prepare("UPDATE battle_media SET status = 'revoked', owner_user_id = NULL WHERE id = ?").bind(key.split('/')[3]).run();
        await bindings.DB.prepare("DELETE FROM users WHERE id = 'owner'").run();
        return result;
      }, delete: key => bindings.SPRITES.delete(key) };
      if (path === '/test/cleanup') { await cleanupBattleMedia(env); return new Response('ok'); }
      if (path.startsWith('/test/process/')) {
        const id = path.split('/').pop();
        if (scenario === 'revoke') env.SPRITES = { get: key => bindings.SPRITES.get(key), delete: key => bindings.SPRITES.delete(key), createMultipartUpload: async (key, options) => {
          const upload = await bindings.SPRITES.createMultipartUpload(key, options);
          return { uploadPart: (n, value) => upload.uploadPart(n, value), abort: () => upload.abort(), complete: async parts => {
            const result = await upload.complete(parts);
            await bindings.DB.prepare("UPDATE battle_media SET status = 'revoked', published = 0 WHERE id = ?").bind(key.split('/')[3]).run();
            return result;
          } };
        } };
        try { await submitFinisher(env, id); const status = await pollFinisher(env, id); if (status === 'stopped') await failFinisher(env, id, 'removed'); return Response.json({ status }); }
        catch (error) { await failFinisher(env, id, error.message); return Response.json({ status: 'failed', error: error.message }); }
      }
      if (path.startsWith('/test/refund/')) { await failFinisher(env, path.split('/').pop(), 'test_failed'); return new Response('ok'); }
      if (path === '/api/battles') return request.method === 'POST' ? createBattle(request, env, auth) : listBattles(request, env, auth);
      const match = path.match(/^\\/api\\/battles\\/([^/]+)(?:\\/(still|recording|finisher|publish))?$/); if (!match) return new Response('no', { status: 404 });
      if (!match[2]) return request.method === 'DELETE' ? deleteBattle(request, env, auth, match[1]) : getBattle(request, env, auth, match[1]);
      if (request.method === 'GET' || request.method === 'HEAD') return getBattleMedia(request, env, auth, match[1], match[2]);
      if (match[2] === 'recording') return uploadBattleRecording(request, env, auth, match[1]);
      if (match[2] === 'publish') return publishBattle(request, env, auth, match[1]);
      return createBattleFinisher(request, env, auth, match[1]);
    } };` }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['node:crypto'] });
  mf = new Miniflare({ workers: [{ config: { type: 'worker', name: 'battle-media-test', compatibilityDate: '2026-08-22', compatibilityFlags: ['nodejs_compat'],
    manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: bundled.outputFiles[0].text } } },
    env: { DB: { type: 'd1', id: 'battle-media-test' }, SPRITES: { type: 'r2', name: 'battle-media-test' } } } }] });
  db = await mf.getD1Database('DB'); bucket = await mf.getR2Bucket('SPRITES') as unknown as R2Bucket;
  await db.batch([
    db.prepare('CREATE TABLE users (id TEXT PRIMARY KEY, credits_balance INTEGER NOT NULL, updated_at TEXT)'),
    db.prepare('CREATE TABLE credit_ledger (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), delta INTEGER, reason TEXT, fighter_id TEXT)'),
    db.prepare('CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at TEXT NOT NULL)'),
    db.prepare('CREATE TABLE provider_spend_months (period TEXT PRIMARY KEY, estimated_cost_cents INTEGER, provider_calls INTEGER, updated_at TEXT)'),
  ]);
  const legalSchema = readFileSync('worker/migrations/0011_legal_consent_and_checkout_tax.sql', 'utf8').split('CREATE TABLE IF NOT EXISTS legal_acceptances')[1].split('CREATE UNIQUE INDEX')[0];
  await db.prepare('CREATE TABLE IF NOT EXISTS legal_acceptances' + legalSchema.trim().replace(/;$/, '')).run();
  const schema = readFileSync('worker/migrations/0039_battle_finishers.sql', 'utf8').replace(/--[^\n]*/g, '');
  await db.batch(schema.split(';').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
});
afterAll(async () => { await mf?.dispose(); });
beforeEach(async () => {
  await db.batch(['battle_finisher_jobs','battle_media','credit_ledger','legal_acceptances','rate_limits','provider_spend_months','users'].map(table => db.prepare('DELETE FROM ' + table)));
  await db.prepare("INSERT INTO users (id, credits_balance) VALUES ('owner', 3), ('other', 3)").run();
  const objects = await bucket.list(); if (objects.objects.length) await bucket.delete(objects.objects.map(o => o.key));
  await req('/test/reset');
});
function req(path: string, options: { method?: string; user?: string | null; json?: unknown; body?: Uint8Array; type?: string } = {}): Promise<Response> {
  return mf.dispatchFetch(path.startsWith('http') ? path : ORIGIN + path, { method: options.method ?? (options.json ? 'POST' : 'GET'),
    headers: { ...(options.user === null ? {} : { 'test-user': options.user ?? 'owner' }), ...(options.json ? { 'Content-Type': 'application/json' } : options.type ? { 'Content-Type': options.type } : {}) },
    body: options.json ? JSON.stringify(options.json) : options.body }) as unknown as Promise<Response>;
}
async function create(overrides: Record<string, unknown> = {}, user = 'owner'): Promise<SavedBattle> {
  const response = await req('/api/battles', { user, json: { clientBattleId: 'battle-client-1234567890', summary, stillBase64: jpeg.toString('base64'), ...overrides } });
  expect(response.status).toBe(201); return (await response.json() as { battle: SavedBattle }).battle;
}
async function generate(battle: SavedBattle, requestId = 'request-client-1234567890'): Promise<SavedBattle> {
  const response = await req(`/api/battles/${battle.id}/finisher`, { json: { requestId, legal } });
  expect([200,202]).toContain(response.status); return (await response.json() as { battle: SavedBattle }).battle;
}
async function credits() { return (await db.prepare("SELECT credits_balance FROM users WHERE id = 'owner'").first<{ credits_balance: number }>())!.credits_balance; }

describe('durable battle media and credit-backed finishers in D1 and R2', () => {
  it('keeps snapshots private and immutable, with same-client recovery and isolated owners', async () => {
    const battle = await create(); expect(battle.isOwner).toBe(true); expect(battle.published).toBe(false);
    expect((await create()).id).toBe(battle.id); expect((await create({}, 'other')).id).not.toBe(battle.id);
    expect((await req(`/api/battles/${battle.id}`, { user: null })).status).toBe(404);
    expect((await req(battle.stillUrl, { user: 'other' })).status).toBe(404);
    expect((await req('/api/battles', { json: { clientBattleId: 'battle-client-1234567890', summary: { ...summary, p1Name: 'Changed' }, stillBase64: jpeg.toString('base64') } })).status).toBe(409);
    const listed = await (await req('/api/battles')).json() as { battles: SavedBattle[] }; expect(listed.battles).toHaveLength(1);
    expect(battle.shareUrl).toBe(`https://insertplayer.ai/battles/${battle.id}`);
  });
  it('requires authentication, bounded real frame metadata, and current legal attestation', async () => {
    expect((await req('/api/battles', { user: null, json: {} })).status).toBe(401);
    expect((await req('/api/battles', { json: { clientBattleId: 'battle-client-1234567890', summary, stillBase64: 'SGVsbG8=' } })).status).toBe(400);
    const battle = await create();
    expect((await req(`/api/battles/${battle.id}/finisher`, { json: { requestId: 'request-client-1234567890' } })).status).toBe(428);
    expect(await credits()).toBe(3);
  });
  it('stores original recordings permanently and cannot swap a published battle recording', async () => {
    const battle = await create();
    const url = `/api/battles/${battle.id}/recording`;
    expect((await req(url, { method: 'PUT', body: video, type: 'video/mp4' })).status).toBe(200);
    expect((await req(url, { method: 'PUT', body: video, type: 'video/mp4' })).status).toBe(200);
    const changed = video.slice(); changed[25] = 255;
    expect((await req(url, { method: 'PUT', body: changed, type: 'video/mp4' })).status).toBe(409);
    expect((await req(url, { user: null })).status).toBe(404);
    await req(`/api/battles/${battle.id}/publish`, { method: 'POST' });
    const publicBattle = await (await req(`/api/battles/${battle.id}`, { user: null })).json() as { battle: SavedBattle };
    expect(publicBattle.battle).toMatchObject({ published: true, isOwner: false });
    expect(new Uint8Array(await (await req(url, { user: null })).arrayBuffer())).toEqual(video);
    await req('/test/cleanup'); expect((await req(url, { user: null })).status).toBe(200);
  });
  it('atomically reserves exactly one credit across concurrent clicks and different request IDs', async () => {
    const battle = await create();
    const results = await Promise.all([generate(battle), generate(battle), generate(battle, 'another-request-1234567890')]);
    expect(new Set(results.map(b => b.finisher?.id)).size).toBe(1); expect(await credits()).toBe(2);
    expect((await db.prepare("SELECT * FROM credit_ledger WHERE delta = -1").all()).results).toHaveLength(1);
    expect((await db.prepare('SELECT * FROM battle_finisher_jobs').all()).results).toHaveLength(1);
  });
  it('rejects insufficient balance server-side without creating a provider job', async () => {
    const battle = await create(); await db.prepare("UPDATE users SET credits_balance = 0 WHERE id = 'owner'").run();
    expect((await req(`/api/battles/${battle.id}/finisher`, { json: { requestId: 'request-client-1234567890', legal } })).status).toBe(402);
    expect((await db.prepare('SELECT * FROM battle_finisher_jobs').all()).results).toHaveLength(0);
  });
  it('finishes in the cloud, charges once, copies provider video into owned R2, and preserves native audio request settings', async () => {
    const battle = await generate(await create()); const id = battle.finisher!.id;
    expect((await (await req(`/test/process/${id}`)).json())).toEqual({ status: 'ready' });
    expect((await (await req(`/test/process/${id}`)).json())).toEqual({ status: 'ready' });
    const audit = await (await req('/test/provider')).json() as { posts: number; input: Record<string, unknown> };
    expect(audit.posts).toBe(1); expect(audit.input).toMatchObject({ duration: 5, resolution: '768P', prompt_expansion_mode: 'fast', enable_safety_checker: true, sync_mode: false });
    expect(String(audit.input.image_url)).toMatch(/^data:image\/jpeg;base64,/); expect(audit.input).not.toHaveProperty('generate_audio');
    const saved = await (await req(`/api/battles/${battle.id}`)).json() as { battle: SavedBattle };
    expect(saved.battle.finisher).toMatchObject({ status: 'ready', creditRefunded: false });
    expect(saved.battle.finisher!.videoUrl).toBe(`${ORIGIN}/api/battles/${battle.id}/finisher`);
    expect(new Uint8Array(await (await req(saved.battle.finisher!.videoUrl!)).arrayBuffer())).toEqual(video);
    expect((await req(saved.battle.finisher!.videoUrl!, { user: null })).status).toBe(404);
    expect((await db.prepare('SELECT estimated_cost_cents, provider_calls FROM provider_spend_months').first())).toEqual({ estimated_cost_cents: 20, provider_calls: 1 });
    await req(`/test/refund/${id}`); expect(await credits()).toBe(2);
  });
  it.each(['failed', 'ssrf', 'unknown'])('refunds an undeliverable %s attempt once, never automatically submits a second paid request', async scenario => {
    const battle = await generate(await create()); const id = battle.finisher!.id;
    await req('/test/provider', { json: { scenario } });
    await req(`/test/process/${id}`); await req(`/test/process/${id}`); await req(`/test/refund/${id}`);
    expect(await credits()).toBe(3);
    expect((await db.prepare("SELECT * FROM credit_ledger WHERE delta = 1").all()).results).toHaveLength(1);
    expect((await (await req('/test/provider')).json() as { posts: number }).posts).toBe(1);
    const retry = await generate(battle, 'explicit-retry-1234567890'); expect(retry.finisher!.id).not.toBe(id); expect(await credits()).toBe(2);
  });
  it('rejects another account before spending and recovers the same job after request response loss', async () => {
    const battle = await create();
    expect((await req(`/api/battles/${battle.id}/finisher`, { user: 'other', json: { requestId: 'request-client-1234567890', legal } })).status).toBe(404);
    const first = await generate(battle), recovered = await generate(battle);
    expect(first.finisher!.id).toBe(recovered.finisher!.id); expect(await credits()).toBe(2);
  });
  it('revokes public links immediately, refunds unfinished jobs, and durably removes all associated assets', async () => {
    const battle = await generate(await create());
    await req(`/api/battles/${battle.id}/publish`, { method: 'POST' });
    expect((await req(battle.stillUrl, { user: null })).status).toBe(200);
    await req(`/api/battles/${battle.id}`, { method: 'DELETE' });
    expect((await req(battle.stillUrl, { user: null })).status).toBe(404); expect(await credits()).toBe(3);
    await req('/test/cleanup'); expect((await bucket.list()).objects).toHaveLength(0);
    await req(`/test/process/${battle.finisher!.id}`); expect((await bucket.list()).objects).toHaveLength(0);
  });
  it('does not resurrect a battle removed while the final provider video was being stored', async () => {
    const battle = await generate(await create()); await req('/test/provider', { json: { scenario: 'revoke' } });
    expect(await (await req(`/test/process/${battle.finisher!.id}`)).json()).toEqual({ status: 'stopped' });
    expect(await credits()).toBe(3);
    expect((await bucket.list()).objects.filter(o => o.key.includes('/finishers/'))).toHaveLength(0);
    expect((await req(`/api/battles/${battle.id}`)).status).toBe(404);
  });
  it('recovers a dispatch failure through maintenance without another reservation or a browser tab', async () => {
    await req('/test/provider', { json: { scenario: 'dispatch-failed' } });
    const battle = await generate(await create()); expect(battle.finisher?.status).toBe('queued'); expect(await credits()).toBe(2);
    await req('/test/provider', { json: { scenario: 'success' } }); await req('/test/cleanup');
    expect((await (await req('/test/provider')).json() as { workflowStarts: number }).workflowStarts).toBe(2);
    expect(await (await req(`/test/process/${battle.finisher!.id}`)).json()).toEqual({ status: 'ready' });
    expect(await credits()).toBe(2);
  });
  it('fails closed when the owner account disappears during initial snapshot upload', async () => {
    await req('/test/provider', { json: { scenario: 'delete-during-still' } });
    const response = await req('/api/battles', { json: { clientBattleId: 'battle-client-1234567890', summary, stillBase64: jpeg.toString('base64') } });
    expect(response.status).toBe(404); expect((await bucket.list()).objects).toHaveLength(0);
    expect((await db.prepare('SELECT status, owner_user_id FROM battle_media').first())).toEqual({ status: 'revoked', owner_user_id: null });
  });

});
