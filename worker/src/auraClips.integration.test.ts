import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AURA_CHALLENGE_ASSETS } from '../../src/game/aura/AuraChallengeAssets';

const ORIGIN = 'https://api.insertplayer.ai';
const token = Buffer.from(JSON.stringify({
  version: 1, rules: 'aura-1-0000000000000000', seed: 42, difficulty: 'viral',
  trackId: 'neon-arena-155', trackVersion: AURA_CHALLENGE_ASSETS['track:neon-arena-155']?.sha256,
  stageId: 'aura-plaza-v3', stageVersion: AURA_CHALLENGE_ASSETS['stage:aura-plaza-v3']?.sha256,
  chartId: '0000000000000000', name: 'Alex', score: 12500, slot: 1,
})).toString('base64url');
const mp4 = Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, ...Array.from({ length: 148 }, (_, i) => i)]);
const webm = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, ...Array.from({ length: 156 }, (_, i) => i)]);
interface Upload { id: string; uploadUrl: string; uploadToken: string; deleteToken: string; expiresAt: string }

let mf: Miniflare;
let db: D1Database;
let bucket: R2Bucket;

beforeAll(async () => {
  const bundled = await build({
    stdin: {
      contents: `import { createAuraClip, uploadAuraClip, getAuraClip, getAuraClipVideo, getAuraClipPoster, deleteAuraClip, cleanupExpiredAuraClips } from './worker/src/auraClips';
        export default { async fetch(request, bindings) {
          const env = { ...bindings, ENVIRONMENT: 'development', CORS_ORIGIN: 'https://insertplayer.ai' };
          if (request.headers.get('test-r2-fail')) env.SPRITES = { put: () => Promise.reject(new Error('R2 unavailable')), delete: key => bindings.SPRITES.delete(key) };
          if (request.headers.get('test-revoke-after-write')) env.SPRITES = {
            put: async (key, body, options) => { const object = await bindings.SPRITES.put(key, body, options); await bindings.DB.prepare("UPDATE aura_clips SET status = 'revoked' WHERE id = ?").bind(key.split('/')[1]).run(); return object; },
            delete: key => bindings.SPRITES.delete(key),
          };
          if (request.headers.get('test-cleanup-during-poster')) env.SPRITES = {
            put: async (key, body, options) => {
              await bindings.SPRITES.delete(key);
              await bindings.DB.prepare('DELETE FROM aura_clips WHERE id = ?').bind(key.split('/')[1]).run();
              return bindings.SPRITES.put(key, body, options);
            },
            delete: key => bindings.SPRITES.delete(key),
          };
          if (request.headers.get('test-delete-fail')) env.SPRITES = { delete: async () => { throw new Error('R2 unavailable'); } };
          const path = new URL(request.url).pathname;
          if (path === '/cleanup') { await cleanupExpiredAuraClips(env); return new Response(null, { status: 204 }); }
          if (path === '/api/aura/clips') {
            const signedIn = request.headers.get('test-user');
            return createAuraClip(request, env, { userId: signedIn, user: signedIn ? { plan_tier: request.headers.get('test-plan') || 'free' } : null,
              claims: null, rateLimitKey: signedIn ? 'user:' + signedIn : 'anonymous-test' });
          }
          const match = path.match(/^\\/api\\/aura\\/clips\\/([^/]+)(\\/video|\\/poster)?$/);
          if (!match) return new Response(null, { status: 404 });
          if (request.method === 'DELETE') return deleteAuraClip(request, env, match[1]);
          if (request.method === 'PUT') return uploadAuraClip(request, env, match[1]);
          if (match[2] === '/poster') return getAuraClipPoster(request, env, match[1]);
          if (match[2]) return getAuraClipVideo(request, env, match[1]);
          return getAuraClip(request, env, match[1]);
        } };`,
      resolveDir: process.cwd(), loader: 'ts',
    },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  });
  mf = new Miniflare({ workers: [{ config: {
    type: 'worker', name: 'aura-clips-test', compatibilityDate: '2026-08-22',
    manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: bundled.outputFiles[0].text } } },
    env: { DB: { type: 'd1', id: 'aura-clips-test' }, SPRITES: { type: 'r2', name: 'aura-clips-test' } },
  } }] });
  db = await mf.getD1Database('DB');
  bucket = await mf.getR2Bucket('SPRITES') as unknown as R2Bucket;
  const schema = readFileSync(resolve('worker/migrations/0038_public_aura_clips.sql'), 'utf8').replace(/--[^\n]*/g, '');
  await db.batch(schema.split(';').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
  await db.prepare('CREATE TABLE users (id TEXT PRIMARY KEY)').run();
  await db.prepare('CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at TEXT NOT NULL)').run();
});
afterAll(async () => { await mf?.dispose(); });
beforeEach(async () => {
  await db.batch([db.prepare('DELETE FROM aura_clips'), db.prepare('DELETE FROM rate_limits')]);
  const objects = await bucket.list();
  if (objects.objects.length) await bucket.delete(objects.objects.map(object => object.key));
});

async function initialize(overrides: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<Response> {
  return mf.dispatchFetch(`${ORIGIN}/api/aura/clips`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ challengeToken: token, contentType: 'video/mp4', byteLength: mp4.length, ...overrides }),
  }) as unknown as Promise<Response>;
}
async function create(overrides: Record<string, unknown> = {}): Promise<Upload> {
  const response = await initialize(overrides);
  expect(response.status).toBe(201);
  return response.json();
}
async function upload(item: Upload, body = mp4, type = 'video/mp4', bearer = item.uploadToken): Promise<Response> {
  return mf.dispatchFetch(item.uploadUrl, {
    method: 'PUT', headers: { 'Content-Type': type, Authorization: `Bearer ${bearer}` }, body,
  }) as unknown as Promise<Response>;
}
async function get(path: string, init: Parameters<Miniflare['dispatchFetch']>[1] = {}): Promise<Response> {
  return mf.dispatchFetch(path.startsWith('http') ? path : `${ORIGIN}${path}`, init) as unknown as Promise<Response>;
}

describe('public Aura clip storage in the actual Worker runtime', () => {
  it('publishes only after a complete upload and streams the exact bytes with branded URLs', async () => {
    const item = await create();
    expect((await get(`/api/aura/clips/${item.id}`)).status).toBe(404);
    const pending = await get(`/api/aura/clips/${item.id}`, { headers: { Authorization: `Bearer ${item.uploadToken}` } });
    expect(pending.status).toBe(409);
    expect(await pending.json()).toMatchObject({ code: 'clip_pending' });
    const stored = await db.prepare('SELECT * FROM aura_clips WHERE id = ?').bind(item.id).first();
    expect(stored?.upload_token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(item.uploadToken);
    expect(JSON.stringify(stored)).not.toContain(item.deleteToken);
    const response = await upload(item);
    expect(response.status).toBe(201);
    const { clip } = await response.json() as { clip: Record<string, string | number> };
    expect(clip.shareUrl).toBe(`https://insertplayer.ai/watch/${item.id}`);
    expect(clip.ogImageUrl).toContain(`/challenges/aura/${token}/og.png?v=aura-versus-v2`);
    expect(Number(new Date(clip.expiresAt)) - Date.now()).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
    expect(JSON.stringify(clip)).not.toContain('owner_user_id');
    expect(JSON.stringify(clip)).not.toContain('token_hash');
    const video = await get(String(clip.videoUrl));
    expect(video.headers.get('Cache-Control')).toBe('no-store');
    expect(video.headers.get('Content-Type')).toBe('video/mp4');
    expect(video.headers.get('Content-Length')).toBe(String(mp4.length));
    expect(new Uint8Array(await video.arrayBuffer())).toEqual(mp4);
    expect(await (await get(`/api/aura/clips/${item.id}`)).json()).toEqual(clip);
    const retried = await upload(item);
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ clip });
  });

  it('supports seek ranges, suffix ranges, HEAD and a branded download filename', async () => {
    const item = await create({ contentType: 'video/webm' });
    expect((await upload(item, webm, 'video/webm')).status).toBe(201);
    const video = await get(item.uploadUrl, { headers: { Range: 'bytes=12-23' } });
    expect(video.status).toBe(206);
    expect(video.headers.get('Content-Range')).toBe('bytes 12-23/160');
    expect(new Uint8Array(await video.arrayBuffer())).toEqual(webm.slice(12, 24));
    const suffix = await get(item.uploadUrl, { headers: { Range: 'bytes=-8' } });
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(webm.slice(-8));
    const open = await get(item.uploadUrl, { headers: { Range: 'bytes=154-' } });
    expect(new Uint8Array(await open.arrayBuffer())).toEqual(webm.slice(154));
    const head = await get(`${item.uploadUrl}?download=1`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(head.headers.get('Content-Disposition')).toBe(`attachment; filename="Insert-Player-Aura-${item.id}.webm"`);
    for (const range of ['bytes=1000-', 'bytes=2-1', 'bytes=-0', 'bytes=0-1,2-3', 'not-a-range']) {
      const response = await get(item.uploadUrl, { headers: { Range: range } });
      expect(response.status).toBe(416);
      expect(response.headers.get('Content-Range')).toBe('bytes */160');
    }
  });

  it('rejects invalid requests, forged capabilities and nonvideo bytes without publishing', async () => {
    expect((await initialize({ challengeToken: 'fake' })).status).toBe(400);
    expect((await initialize({ byteLength: 64 * 1024 * 1024 + 1 })).status).toBe(413);
    expect((await initialize({ byteLength: 0 })).status).toBe(400);
    expect((await initialize({ contentType: 'text/html' })).status).toBe(415);
    const item = await create();
    expect((await upload(item, mp4, 'video/mp4', 'x'.repeat(32))).status).toBe(404);
    expect((await upload(item, mp4, 'video/webm')).status).toBe(415);
    expect((await upload(item, mp4.slice(0, 32))).status).toBe(400);
    const invalidHeader = await create();
    expect((await upload(invalidHeader, new Uint8Array(160))).status).toBe(400);
    expect(await bucket.head(`public-aura-clips/${invalidHeader.id}/video`)).toBeNull();
    expect((await get(`/api/aura/clips/${item.id}`)).status).toBe(404);
    expect(await bucket.head(`public-aura-clips/${item.id}/video`)).toBeNull();
  });

  it('settles a failed R2 write even when storage never consumes the upload stream', async () => {
    const item = await create();
    const response = await get(item.uploadUrl, {
      method: 'PUT', headers: { 'Content-Type': 'video/mp4', Authorization: `Bearer ${item.uploadToken}`, 'test-r2-fail': 'true' }, body: mp4,
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'upload_failed' });
    expect((await get(`/api/aura/clips/${item.id}`)).status).toBe(404);
  }, 3000);

  it('exposes an optional JPEG first-frame poster only while the recording is public', async () => {
    const jpeg = Uint8Array.from([255, 216, 255, 224, 0, 0, 255, 217]);
    const item = await create({ posterBase64: Buffer.from(jpeg).toString('base64') });
    const posterUrl = `${ORIGIN}/api/aura/clips/${item.id}/poster`;
    expect((await get(posterUrl)).status).toBe(404);
    const result = await upload(item);
    expect((await result.json() as { clip: { posterUrl: string } }).clip.posterUrl).toBe(posterUrl);
    const poster = await get(posterUrl);
    expect(poster.headers.get('Content-Type')).toBe('image/jpeg');
    expect(new Uint8Array(await poster.arrayBuffer())).toEqual(jpeg);
    expect(await (await get(posterUrl, { method: 'HEAD' })).text()).toBe('');
    await get(`/api/aura/clips/${item.id}`, { method: 'DELETE', body: JSON.stringify({ deleteToken: item.deleteToken }) });
    expect((await get(posterUrl)).status).toBe(404);
    expect(await bucket.head(`public-aura-clips/${item.id}/poster.jpg`)).toBeNull();
    for (const posterBase64 of ['not base64', 'aGVsbG8=', 'A'.repeat(360000)]) {
      expect((await initialize({ posterBase64 })).status).toBe(400);
    }
  });

  it('keeps a valid recording shareable when optional poster storage fails', async () => {
    const initialized = await initialize({ posterBase64: Buffer.from([255, 216, 255, 224, 0, 0, 255, 217]).toString('base64') }, { 'test-r2-fail': 'true' });
    expect(initialized.status).toBe(201);
    const item = await initialized.json() as Upload;
    const result = await upload(item);
    expect(result.status).toBe(201);
    expect((await result.json() as { clip: { posterUrl?: string } }).clip.posterUrl).toBeUndefined();
  });

  it('removes a late poster if cleanup deleted its pending record while the put was in flight', async () => {
    const initialized = await initialize({ posterBase64: Buffer.from([255, 216, 255, 224, 0, 0, 255, 217]).toString('base64') },
      { 'test-cleanup-during-poster': 'true' });
    expect(initialized.status).toBe(404);
    expect((await bucket.list()).objects).toHaveLength(0);
    expect((await db.prepare('SELECT id FROM aura_clips').all()).results).toHaveLength(0);
  });

  it('removes a completed upload if its capability was revoked before publication', async () => {
    const item = await create();
    const result = await get(item.uploadUrl, { method: 'PUT',
      headers: { 'Content-Type': 'video/mp4', Authorization: `Bearer ${item.uploadToken}`, 'test-revoke-after-write': 'true' }, body: mp4,
    });
    expect(result.status).toBe(404);
    expect((await get(`/api/aura/clips/${item.id}`)).status).toBe(404);
    expect(await bucket.head(`public-aura-clips/${item.id}/video`)).toBeNull();
  });

  it('does not create a signed-in clip after the owner account was deleted', async () => {
    expect((await initialize({}, { 'test-user': 'user-deleted' })).status).toBe(401);
  });

  it('allows exactly one concurrent writer per capability', async () => {
    const item = await create();
    await db.prepare("UPDATE aura_clips SET status = 'uploading' WHERE id = ?").bind(item.id).run();
    const second = await upload(item);
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ code: 'clip_uploading' });
    expect((await get(`/api/aura/clips/${item.id}`)).status).toBe(404);
  });

  it('revokes links immediately and cleans expired uploaded and abandoned clips', async () => {
    const item = await create();
    await upload(item);
    const forbidden = await get(`/api/aura/clips/${item.id}`, { method: 'DELETE', body: JSON.stringify({ deleteToken: 'x'.repeat(32) }) });
    expect(forbidden.status).toBe(404);
    const revoked = await get(`/api/aura/clips/${item.id}`, { method: 'DELETE', body: JSON.stringify({ deleteToken: item.deleteToken }) });
    expect(revoked.status).toBe(204);
    expect((await get(item.uploadUrl)).status).toBe(404);
    expect((await get(`/api/aura/clips/${item.id}`)).status).toBe(404);
    expect((await upload(item)).status).toBe(404);
    const expired = await create();
    await upload(expired);
    const abandoned = await create({ posterBase64: Buffer.from([255, 216, 255, 224, 0, 0, 255, 217]).toString('base64') });
    await db.prepare("UPDATE aura_clips SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect((await get(expired.uploadUrl)).status).toBe(404);
    expect((await upload(abandoned)).status).toBe(404);
    expect((await get('/cleanup', { headers: { 'test-delete-fail': 'true' } })).status).toBe(204);
    expect((await db.prepare('SELECT id FROM aura_clips').all()).results).toHaveLength(3);
    expect((await get('/cleanup')).status).toBe(204);
    expect((await bucket.list()).objects).toHaveLength(0);
    expect((await db.prepare('SELECT id FROM aura_clips').all()).results).toHaveLength(0);
  });

  it('caps anonymous uploads at five and every signed-in tier at twenty per day', async () => {
    for (let count = 0; count < 5; count++) expect((await initialize()).status).toBe(201);
    expect((await initialize()).status).toBe(429);
    for (const plan of ['free', 'pro', 'studio', 'admin']) {
      await db.prepare('INSERT OR IGNORE INTO users (id) VALUES (?)').bind(`user-${plan}`).run();
      const headers = { 'test-user': `user-${plan}`, 'test-plan': plan };
      for (let count = 0; count < 20; count++) expect((await initialize({}, headers)).status).toBe(201);
      const denied = await initialize({}, headers);
      expect(denied.status).toBe(429);
      expect(Number(denied.headers.get('Retry-After'))).toBeGreaterThan(0);
    }
  });
});
