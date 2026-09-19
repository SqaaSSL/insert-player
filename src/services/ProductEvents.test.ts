import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { productChannelFromSearch, sanitizeProductEvent } from './ProductEventContract.ts';

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('VITE_API_BASE_URL', '');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('privacy-preserving playtest events', () => {
  it('allowlists useful metrics and drops private or unexpected properties', async () => {
    const { readProductEvents, trackProductEvent } = await import('./ProductEvents.ts');
    const storage = new Map<string, string>();
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    trackProductEvent('game_started', { game: 'aura', source: 'trial', photoHash: 'private', name: 'Private Person', token: 'secret' } as never);
    expect(readProductEvents()[0].properties).toEqual({ game: 'aura', source: 'trial', channel: 'direct' });
    expect(JSON.stringify(readProductEvents())).not.toMatch(/private|secret/i);
    for (let i = 0; i < 220; i++) trackProductEvent('game_completed');
    expect(readProductEvents()).toHaveLength(200);
  });

  it('sends only allowlisted data without cookies, credentials, referrer or persistent identity', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.insertplayer.ai/');
    vi.stubGlobal('window', { location: { search: '?utm_source=ig&utm_campaign=alice@example.com&token=secret' } });
    vi.stubGlobal('navigator', { doNotTrack: '0' });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('blocked storage'); } });
    const fetch = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetch);
    const { trackProductEvent } = await import('./ProductEvents.ts');
    trackProductEvent('creation_completed', { tier: 'rookie', durationMs: 25_001, email: 'alice@example.com' } as never);
    expect(fetch).toHaveBeenCalledWith('https://api.insertplayer.ai/api/product-events', expect.objectContaining({
      credentials: 'omit', referrerPolicy: 'no-referrer', keepalive: true,
    }));
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      name: 'creation_completed', properties: { tier: 'rookie', durationMs: 25_001, channel: 'instagram' },
    });
    expect(JSON.stringify(fetch.mock.calls)).not.toMatch(/alice|secret|Authorization|at"/);
    await Promise.resolve();
  });

  it.each([{ doNotTrack: '1' }, { globalPrivacyControl: true }])('honors privacy signals %j', async (navigator) => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.insertplayer.ai');
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', navigator);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { trackProductEvent } = await import('./ProductEvents.ts');
    trackProductEvent('platform_visited');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('bounds page delivery, ignores invalid events and never queues retries', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.insertplayer.ai');
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', {});
    const fetch = vi.fn().mockResolvedValue({ status: 429 });
    vi.stubGlobal('fetch', fetch);
    const { trackProductEvent } = await import('./ProductEvents.ts');
    trackProductEvent('private@example.com' as never);
    for (let i = 0; i < 110; i++) trackProductEvent('game_started');
    expect(fetch).toHaveBeenCalledTimes(100);
  });

  it('uses finite campaign and metric vocabularies', () => {
    expect(productChannelFromSearch('?utm_source=whatsapp')).toBe('whatsapp');
    expect(productChannelFromSearch('?utm_source=private@example.com')).toBe('other');
    expect(productChannelFromSearch('')).toBe('direct');
    expect(sanitizeProductEvent({ name: 'purchase_completed' })).toBeNull();
    expect(sanitizeProductEvent({ name: 'game_completed', at: 'secret', properties: {
      source: 'https://private.example', channel: 'alice', game: 'unknown',
      durationMs: 1e10, credits: -20, accountId: 'secret',
    } })).toEqual({ name: 'game_completed', properties: { durationMs: 86_400_000, credits: 0 } });
  });
});
