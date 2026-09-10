import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AURA_CHALLENGE_ASSETS } from '../../src/game/aura/AuraChallengeAssets';

const id = '1234567890abcdef'.repeat(2);
const token = Buffer.from(JSON.stringify({
  version: 1, rules: 'aura-1-0000000000000000', seed: 42, difficulty: 'viral',
  trackId: 'neon-arena-155', trackVersion: AURA_CHALLENGE_ASSETS['track:neon-arena-155']?.sha256,
  stageId: 'aura-plaza-v3', stageVersion: AURA_CHALLENGE_ASSETS['stage:aura-plaza-v3']?.sha256,
  chartId: '0000000000000000', name: 'Alex', score: 12500, slot: 1,
})).toString('base64url');
let mf: Miniflare;
let upstreamStatus = 200;
let calls: { url: string; authorization: string | null; cookie: string | null }[] = [];

beforeAll(async () => {
  const bundle = await build({
    stdin: { contents: `import { auraWatchPageResponse } from './scripts/aura-watch-page.mjs';
      export default { fetch(request) { return auraWatchPageResponse({ request, env: {
        ASSETS: { fetch: async () => new Response('<html><head><title>Home</title></head><body><div id="app"></div><script src="/assets/app.js"></script></body></html>',
          {headers:{'Content-Type':'text/html','Content-Security-Policy':"default-src 'self'"}}) }
      }}); }};`, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  });
  mf = new Miniflare({ workers: [{
    config: { type: 'worker', name: 'aura-watch-runtime', compatibilityDate: '2026-08-22',
      manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: bundle.outputFiles[0].text } } } },
    dev: { outboundService: { type: 'fetcher', handler: async request => {
      calls.push({ url: request.url, authorization: request.headers.get('Authorization'), cookie: request.headers.get('Cookie') });
      return new Response(upstreamStatus === 200 ? JSON.stringify({ id, challengeToken: token, expiresAt: '2099-01-01T00:00:00Z' }) : null,
        { status: upstreamStatus, headers: { 'Content-Type': 'application/json', ...(upstreamStatus === 302 ? { Location: 'https://untrusted.example/' } : {}) } });
    } } },
  }] });
});
afterAll(async () => { await mf?.dispose(); });
beforeEach(() => { upstreamStatus = 200; calls = []; });

describe('Aura watch metadata in the production Worker runtime', () => {
  it('uses the real fetch API to render public clip metadata without forwarding credentials', async () => {
    const response = await mf.dispatchFetch(`https://insertplayer.ai/watch/${id}`, {
      headers: { Authorization: 'Bearer PRIVATE', Cookie: 'PRIVATE=1' },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Alex · 12,500 AURA');
    expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'self'");
    expect(calls).toEqual([{ url: `https://api.insertplayer.ai/api/aura/clips/${id}`, authorization: null, cookie: null }]);
  });
  it('preserves a missing clip response rather than hiding a fetch API exception', async () => {
    upstreamStatus = 404;
    const response = await mf.dispatchFetch(`https://insertplayer.ai/watch/${id}`);
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).not.toContain('og:image');
    expect(calls).toHaveLength(1);
  });
  it('fails closed on redirects without contacting their destination', async () => {
    upstreamStatus = 302;
    const response = await mf.dispatchFetch(`https://insertplayer.ai/watch/${id}`);
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('10');
    expect(await response.text()).not.toContain('og:image');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://api.insertplayer.ai/api/aura/clips/${id}`);
  });
});
