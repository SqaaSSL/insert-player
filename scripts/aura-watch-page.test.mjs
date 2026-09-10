import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuraChallenge, createAuraChallengeRoutine, encodeAuraChallenge } from '../src/game/aura/AuraChallenge.ts';
import { auraWatchApiOrigin, auraWatchPageResponse } from './aura-watch-page.mjs';

const id = '1234567890abcdef'.repeat(2);
const token = encodeAuraChallenge(createAuraChallenge(createAuraChallengeRoutine(42, 'viral', 'neon-arena-155', 'aura-plaza-v3'), 'Alex <3 & "friends"', 12500, 1));
const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const fixture = () => ({ id, challengeToken: token, expiresAt: new Date(Date.now() + 86400000).toISOString() });
function context(path = `/watch/${id}`, method = 'GET') {
  return {
    request: new Request(`https://insertplayer.ai${path}`, { method, headers: { Authorization: 'Bearer PRIVATE', Cookie: 'PRIVATE=1' } }),
    env: { ASSETS: { fetch: vi.fn(async () => new Response(index, { headers: {
      'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'self'; media-src https://api.insertplayer.ai",
      'Content-Length': String(index.length), ETag: 'homepage', 'Cache-Control': 'public, max-age=300',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    } })) } },
  };
}
afterEach(() => { vi.unstubAllGlobals(); });

describe('Aura battle Pages route', () => {
  it('serves the current app with one escaped Fight-style social preview and no MP4 share redirect', async () => {
    const api = vi.fn(async () => Response.json({ ...fixture(), shareUrl: 'https://evil.example', ogImageUrl: 'https://evil.example' }));
    vi.stubGlobal('fetch', api);
    const ctx = context(`/watch/${id}?photo=private&redirect=https://evil.example`);
    const response = await auraWatchPageResponse(ctx);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html.match(/property="og:image"/g)).toHaveLength(1);
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html).toContain('Alex &lt;3 &amp; &quot;friends&quot; · 12,500 AURA · Insert Player');
    expect(html).toContain(`/challenges/aura/${token}/og.png?v=aura-versus-v2`);
    expect(html).toContain(`<meta property="og:url" content="https://insertplayer.ai/watch/${id}">`);
    expect(html).toContain('<script type="module" src="/src/main.tsx"></script>');
    expect(html).not.toContain('social-card-v8');
    expect(html).not.toContain('evil.example');
    expect(html).not.toContain('photo=');
    expect(html).not.toContain('location.replace');
    expect(html).not.toContain('og:video');
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('ETag')).toBeNull();
    expect(response.headers.get('Content-Length')).toBeNull();
    expect(response.headers.get('X-Robots-Tag')).toContain('noindex');
    const [target, options] = api.mock.calls[0];
    expect(target).toBe(`https://api.insertplayer.ai/api/aura/clips/${id}`);
    expect(options.headers).toEqual({ Accept: 'application/json' });
    expect(options.redirect).toBe('error');
    const assetRequest = ctx.env.ASSETS.fetch.mock.calls[0][0];
    expect(assetRequest.url).toBe('https://insertplayer.ai/');
    expect(assetRequest.headers.has('Authorization')).toBe(false);
    expect(assetRequest.headers.has('Cookie')).toBe(false);
  });
  it.each([404, 410])('preserves the watch UI but removes score and image after expiry/revocation (%i)', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status })));
    const response = await auraWatchPageResponse(context());
    const html = await response.text();
    expect(response.status).toBe(404);
    expect(html).toContain('Aura battle unavailable');
    expect(html).toContain('id="app"');
    expect(html).not.toContain('og:image');
    expect(html).not.toContain('12,500');
  });
  it.each([
    () => ({ ...fixture(), id: 'bad' }),
    () => ({ ...fixture(), expiresAt: '2000-01-01' }),
    () => ({ ...fixture(), challengeToken: 'invalid' }),
  ])('rejects malformed backend metadata without breaking the retry shell', async (payload) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(payload())));
    const response = await auraWatchPageResponse(context());
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('10');
    expect(await response.text()).not.toContain('og:image');
  });
  it('keeps HEAD metadata headers and an empty body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture())));
    const response = await auraWatchPageResponse(context(`/watch/${id}`, 'HEAD'));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });
  it('does not fetch data for malformed IDs or unsupported methods', async () => {
    const api = vi.fn(); vi.stubGlobal('fetch', api);
    expect((await auraWatchPageResponse(context('/watch/bad'))).status).toBe(404);
    expect((await auraWatchPageResponse(context(`/watch/${id}`, 'POST'))).status).toBe(405);
    expect(api).not.toHaveBeenCalled();
  });
  it('keeps sandbox previews on the sandbox API without accepting arbitrary API hosts', () => {
    for (const host of ['insert-player-sandbox.pages.dev', 'f00ba4.insert-player-sandbox.pages.dev']) {
      expect(auraWatchApiOrigin(host)).toBe('https://insert-player-api-sandbox.shellbot.workers.dev');
    }
    for (const host of ['insertplayer.ai', 'www.insertplayer.ai', 'evilinsert-player-sandbox.pages.dev']) {
      expect(auraWatchApiOrigin(host)).toBe('https://api.insertplayer.ai');
    }
  });
});
