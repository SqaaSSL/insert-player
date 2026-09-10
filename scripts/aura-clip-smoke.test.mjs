import { describe, expect, it, vi } from 'vitest';
import { assertAuraClipSmokeEnvironment, runHostedAuraClipSmoke } from './aura-clip-smoke.mjs';

const api = 'https://api.insertplayer.ai';
const app = 'https://insertplayer.ai';
const id = 'a'.repeat(32);
const uploadToken = 'u'.repeat(32);
const deleteToken = 'd'.repeat(32);
const token = 'chosen-challenge';
const media = { video: Buffer.from(Array.from({ length: 80 }, (_, i) => i)), poster: Buffer.from([255, 216, 255, 224, 0, 0, 255, 217]), contentType: 'video/webm' };
const clip = { id, challengeToken: token, videoUrl: `${api}/api/aura/clips/${id}/video`, downloadUrl: `${api}/api/aura/clips/${id}/video?download=1`,
  posterUrl: `${api}/api/aura/clips/${id}/poster`, shareUrl: `${app}/watch/${id}`, ogImageUrl: `${api}/challenges/aura/${token}/og.png?v=aura-versus-v2`,
  byteLength: 80, contentType: media.contentType, expiresAt: '2099-01-01T00:00:00Z' };
function fixture({ brokenPage = false, foreignUpload = false } = {}) {
  let ready = false;
  let revoked = false;
  const request = vi.fn(async (target, init = {}) => {
    const url = new URL(target);
    if (url.pathname === '/api/aura/clips' && init.method === 'POST') return Response.json({ id, uploadToken, deleteToken, uploadUrl: foreignUpload ? 'https://evil.test/upload' : clip.videoUrl }, { status: 201 });
    if (url.pathname === `/api/aura/clips/${id}` && init.method === 'DELETE') { revoked = true; return new Response(null, { status: 204 }); }
    if (revoked) return new Response('Unavailable', { status: 404 });
    if (url.pathname.endsWith('/video') && init.method === 'PUT') { ready = true; return Response.json({ clip }, { status: 201 }); }
    if (url.pathname === `/api/aura/clips/${id}`) return ready ? Response.json(clip, { headers: { 'Cache-Control': 'no-store' } }) : new Response(null, { status: 404 });
    if (url.pathname.startsWith('/watch/')) return new Response(`<title>Insert Player QA</title><meta property="og:url" content="${clip.shareUrl}"><meta property="og:image" content="${clip.ogImageUrl}">${brokenPage ? '<meta property="og:image" content="wrong">' : ''}<script type="module" src="/assets/index-current.js"></script>`, { headers: { 'Cache-Control': 'no-store' } });
    if (url.pathname.endsWith('/og.png')) {
      const png = Buffer.alloc(32); png.writeUInt32BE(1200, 16); png.writeUInt32BE(630, 20);
      return new Response(png, { headers: { 'Content-Type': 'image/png' } });
    }
    if (url.pathname.endsWith('/poster')) return new Response(media.poster, { headers: { 'Content-Type': 'image/jpeg' } });
    if (init.headers?.Range) return new Response(media.video.subarray(0, 64), { status: 206, headers: { 'Content-Range': 'bytes 0-63/80' } });
    if (url.searchParams.has('download')) return new Response(media.video, { headers: { 'Content-Disposition': `attachment; filename="Insert-Player-Aura-${id}.webm"` } });
    throw new Error('Unexpected test request');
  });
  return { request, options: { request, authHeaders: extra => ({ ...extra, Authorization: 'Bearer QA_SESSION' }), baseUrl: api, frontendOrigin: app, challengeToken: token, media } };
}

describe('bounded hosted Aura release smoke', () => {
  it('allows production publication only from Actions main with exact commit provenance', () => {
    const good = { target: 'production', githubActions: 'true', githubRef: 'refs/heads/main', githubSha: 'f'.repeat(40) };
    expect(assertAuraClipSmokeEnvironment(good)).toBe(good.githubSha);
    for (const changed of [{ githubActions: 'false' }, { githubRef: 'refs/heads/codex/test' }, { githubSha: 'short' }]) {
      expect(() => assertAuraClipSmokeEnvironment({ ...good, ...changed })).toThrow('GitHub Actions from main');
    }
    expect(assertAuraClipSmokeEnvironment({ target: 'sandbox' })).toBeNull();
  });
  it('checks original bytes and root metadata, then revokes all public resources', async () => {
    const { request, options } = fixture();
    await runHostedAuraClipSmoke(options);
    const init = request.mock.calls.find(([, init]) => init.method === 'POST')[1];
    expect(JSON.parse(init.body)).toEqual({ challengeToken: token, contentType: 'video/webm', byteLength: 80, posterBase64: media.poster.toString('base64') });
    const upload = request.mock.calls.find(([, init]) => init.method === 'PUT')[1];
    expect(upload.body).toBe(media.video);
    expect(upload.headers.Authorization).toBe(`Bearer ${uploadToken}`);
    const removal = request.mock.calls.find(([, init]) => init.method === 'DELETE');
    expect(removal[0]).toBe(`${api}/api/aura/clips/${id}`);
    expect(JSON.parse(removal[1].body)).toEqual({ deleteToken });
    expect(request.mock.calls.at(-1)[0]).toBe(clip.shareUrl);
    for (const [, init] of request.mock.calls.filter(([, init]) => !init.method)) expect(init.headers?.Authorization).toBeUndefined();
  });
  it('still revokes after the deployed Pages metadata fails validation', async () => {
    const { request, options } = fixture({ brokenPage: true });
    await expect(runHostedAuraClipSmoke(options)).rejects.toThrow('duplicate battle OG');
    expect(request.mock.calls.some(([, init]) => init.method === 'DELETE')).toBe(true);
    expect(request.mock.calls.at(-1)[0]).toBe(clip.shareUrl);
  });
  it('never sends a capability to a foreign upload URL and removes the pending reservation', async () => {
    const { request, options } = fixture({ foreignUpload: true });
    await expect(runHostedAuraClipSmoke(options)).rejects.toThrow('configured API');
    expect(request.mock.calls.some(([url]) => url.includes('evil.test'))).toBe(false);
    expect(request.mock.calls.some(([, init]) => init.method === 'DELETE')).toBe(true);
  });
});
