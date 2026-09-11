import { afterEach, describe, expect, it, vi } from 'vitest';
import { battleWatchPageResponse } from './battle-watch-page.mjs';
const id = 'a'.repeat(32);
const battle = { id, published: true, summary: { game: 'aura', winner: 'p1', p1Name: 'Alex <3 & "friends"', p2Name: 'Rival' } };
function context(suffix = '', method = 'GET') {
  return { request: new Request(`https://insertplayer.ai/battles/${id}${suffix}`, { method, headers: { Authorization: 'Bearer private', Cookie: 'private' } }), env: { ASSETS: { fetch: vi.fn(async () => new Response('<html><head><title>Old</title><meta property="og:image" content="old"></head><body><div id="app"></div><script src="/app.js"></script></body></html>', { headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'self'", ETag: 'old' } })) } } };
}
afterEach(() => vi.unstubAllGlobals());
describe('branded battle Pages entry points', () => {
  it.each(['', '/finisher'])('serves a current app and escaped branded metadata at %s without copying credentials', async suffix => {
    const fetcher = vi.fn(async () => Response.json({ battle: { ...battle, shareUrl: 'https://evil.example', ogImageUrl: 'https://evil.example' } })); vi.stubGlobal('fetch', fetcher);
    const response = await battleWatchPageResponse(context(`${suffix}?private=secret`)); const html = await response.text();
    expect(response.status).toBe(200); expect(html.match(/property="og:image"/g)).toHaveLength(1);
    expect(html).toContain('Alex &lt;3 &amp; &quot;friends&quot; wins');
    expect(html).toContain(`/share/battles/${id}/og.png`); expect(html).toContain(`<meta property="og:url" content="https://insertplayer.ai/battles/${id}${suffix}">`);
    expect(html).not.toContain('evil.example'); expect(html).not.toContain('private='); expect(html).not.toContain('og:video');
    expect(fetcher.mock.calls[0][1].headers).toEqual({ Accept: 'application/json' }); expect(fetcher.mock.calls[0][1].redirect).toBe('manual');
    expect(response.headers.get('Cache-Control')).toBe('no-store'); expect(response.headers.get('ETag')).toBeNull(); expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'self'");
  });
  it('keeps private battle names and media out of metadata while leaving the sign-in shell usable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ battle: { ...battle, published: false } })));
    const response = await battleWatchPageResponse(context()); const html = await response.text();
    expect(response.status).toBe(200); expect(html).toContain('id="app"'); expect(html).not.toContain('Alex'); expect(html).not.toContain(`/share/battles/${id}/og.png`);
  });
  it('preserves a retryable shell for provider/API outages and empty HEAD responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
    const response = await battleWatchPageResponse(context('', 'HEAD'));
    expect(response.status).toBe(503); expect(response.headers.get('Retry-After')).toBe('10'); expect(await response.text()).toBe('');
  });
});
