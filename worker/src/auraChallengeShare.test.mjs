import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createAuraChallenge, createAuraChallengeRoutine, decodeAuraChallenge, encodeAuraChallenge } from '../../src/game/aura/AuraChallenge.ts';
import { decodeAuraChallengePreview } from './auraChallengePreview.ts';
import { auraChallengeShareResponse } from './auraChallengeShare.ts';
import { renderAuraChallengeOg } from './auraChallengeOg.ts';

vi.mock('./auraChallengeOg', () => ({ renderAuraChallengeOg: vi.fn() }));
const routine = createAuraChallengeRoutine(42, 'viral', 'neon-arena-155', 'aura-plaza-v3');
const challenge = createAuraChallenge(routine, 'Alex <3 & "friends"', 12_500, 1);
const token = encodeAuraChallenge(challenge);
const url = `https://api.insertplayer.ai/challenges/aura/${token}`;
const env = { CORS_ORIGIN: 'https://sandbox.insertplayer.ai,https://insertplayer.ai',
  get DB() { throw new Error('Must not access D1'); }, get SPRITES() { throw new Error('Must not access R2'); } };
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('Aura public challenge transport', () => {
  it('accepts actual game links for both public tracks and seats without changing the routine', () => {
    for (const trackId of ['neon-arena', 'neon-arena-155']) for (const slot of [0, 1]) {
      const value = createAuraChallenge(createAuraChallengeRoutine(42, 'lowkey', trackId, 'aura-plaza-v3'), 'A😎é', 1000, slot);
      expect(decodeAuraChallengePreview(encodeAuraChallenge(value))).toEqual(value);
    }
  });
  it.each([
    ['huge token', () => 'a'.repeat(2049)], ['invalid base64', () => '!'],
    ['invalid UTF8', () => '_w'], ['extra private fields', () => encode({ ...challenge, photoHash: 'private' })],
    ['URL injection', () => encode({ ...challenge, redirect: 'https://untrusted.example' })],
    ['unknown stage', () => encode({ ...challenge, stageId: 'https://untrusted.example/photo' })],
    ['wrong asset hash', () => encode({ ...challenge, trackVersion: '0'.repeat(64) })],
    ['unsafe score', () => encode({ ...challenge, score: Number.MAX_SAFE_INTEGER + 1 })],
    ['negative score', () => encode({ ...challenge, score: -1 })], ['float score', () => encode({ ...challenge, score: 0.1 })],
    ['score string', () => encode({ ...challenge, score: '12500' })], ['bad slot', () => encode({ ...challenge, slot: 2 })],
    ['bad rules', () => encode({ ...challenge, rules: 'ranked' })], ['bad chart', () => encode({ ...challenge, chartId: 'bad' })],
    ['bad seed', () => encode({ ...challenge, seed: 0 })], ['long name', () => encode({ ...challenge, name: 'a'.repeat(33) })],
    ['control name', () => encode({ ...challenge, name: 'Alex\n' })], ['bidi name', () => encode({ ...challenge, name: 'Alex\u202e' })],
    ['surrogate name', () => encode({ ...challenge, name: '\ud800' })], ['array', () => encode([])],
    ['duplicate key', () => Buffer.from(JSON.stringify(challenge).replace('"score":12500', '"score":1,"score":12500')).toString('base64url')],
  ])('fails closed for %s before rendering or storage', async (_label, invalid) => {
    expect(decodeAuraChallengePreview(invalid())).toBeNull();
    expect((await auraChallengeShareResponse(new Request(`https://api.insertplayer.ai/challenges/aura/${invalid()}/og.png`), env)).status).toBe(404);
    expect(renderAuraChallengeOg).not.toHaveBeenCalled();
  });
});

describe('Aura social HTML and PNG routes', () => {
  it('provides escaped crawler metadata, branded image and an exact same-routine frontend destination', async () => {
    const response = await auraChallengeShareResponse(new Request(`${url}?redirect=https://untrusted.example&photo=private`), env);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(html).toContain('Alex &lt;3 &amp; &quot;friends&quot; set 12,500 AURA · Insert Player');
    expect(html).toContain(`<meta property="og:image" content="${url}/og.png?v=aura-score-v1">`);
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toContain('Friendly challenge, not a ranked score.');
    const play = new URL(html.match(/<a id="play-challenge" href="([^"]+)"/)[1]);
    expect(play.origin).toBe('https://sandbox.insertplayer.ai');
    expect(play.pathname).toBe('/challenge');
    expect([...play.searchParams.keys()]).toEqual(['challenge']);
    expect(decodeAuraChallenge(play.searchParams.get('challenge'))).toEqual({ ok: true, challenge });
    expect(html).not.toContain('untrusted.example');
    expect(html).not.toContain('photo=');
    expect(renderAuraChallengeOg).not.toHaveBeenCalled();
    expect(html).not.toMatch(/http-equiv=["']refresh/i);
    expect(response.headers.get('Location')).toBeNull();
    const script = "location.replace(document.getElementById('play-challenge').href);";
    expect(html).toContain(`<script>${script}</script>`);
    const scriptHash = createHash('sha256').update(script).digest('base64');
    expect(response.headers.get('Content-Security-Policy')).toContain(`script-src 'sha256-${scriptHash}'`);
    expect(html.indexOf('property="og:image"')).toBeLessThan(html.indexOf('<script>'));
  });
  it('never uses malformed frontend config as an open redirect', async () => {
    const html = await (await auraChallengeShareResponse(new Request(url), { CORS_ORIGIN: 'https://user:password@evil.example' })).text();
    expect(html).toContain(`href="https://insertplayer.ai/challenge?challenge=${token}"`);
    expect(html).not.toContain('evil.example');
    expect(html).not.toContain('password');
  });
  it('serves PNG bytes with no data-store dependency and a canonical edge cache key', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer;
    vi.mocked(renderAuraChallengeOg).mockResolvedValue(bytes);
    const cache = { match: vi.fn().mockResolvedValue(undefined), put: vi.fn().mockResolvedValue(undefined) };
    vi.stubGlobal('caches', { default: cache });
    const context = { waitUntil: vi.fn() };
    const response = await auraChallengeShareResponse(new Request(`${url}/og.png?junk=ignored`), env, context);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(bytes));
    expect(renderAuraChallengeOg).toHaveBeenCalledExactlyOnceWith(challenge);
    expect(cache.match.mock.calls[0][0].url).toBe(`${url}/og.png?v=aura-score-v1`);
    expect(cache.put).toHaveBeenCalledOnce();
    expect(context.waitUntil).toHaveBeenCalledOnce();
  });
  it('uses cached pixels and handles HEAD without rerendering', async () => {
    vi.stubGlobal('caches', { default: { match: vi.fn().mockResolvedValue(new Response('cached')) } });
    expect(await (await auraChallengeShareResponse(new Request(`${url}/og.png`), env)).text()).toBe('cached');
    const response = await auraChallengeShareResponse(new Request(`${url}/og.png`, { method: 'HEAD' }), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(renderAuraChallengeOg).not.toHaveBeenCalled();
  });
  it('contains render failures without returning private diagnostics or caching an error as PNG', async () => {
    vi.mocked(renderAuraChallengeOg).mockRejectedValue(new Error('private renderer details'));
    const response = await auraChallengeShareResponse(new Request(`${url}/og.png`), env);
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).not.toContain('private renderer details');
  });
  it('does not accept mutations', async () => {
    expect((await auraChallengeShareResponse(new Request(url, { method: 'POST' }), env)).status).toBe(405);
  });
});
