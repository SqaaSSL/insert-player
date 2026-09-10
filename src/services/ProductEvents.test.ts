import { afterEach, describe, expect, it, vi } from 'vitest';
import { readProductEvents, trackProductEvent } from './ProductEvents.ts';

afterEach(() => vi.unstubAllGlobals());
describe('device-only playtest events', () => {
  it('allowlists useful metrics and drops private or unexpected properties', () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    trackProductEvent('game_started', { game: 'aura', source: 'trial', photoHash: 'private', name: 'Private Person', token: 'secret' } as never);
    expect(readProductEvents()[0].properties).toEqual({ game: 'aura', source: 'trial' });
    expect(JSON.stringify(readProductEvents())).not.toMatch(/private|secret/i);
    for (let i = 0; i < 220; i++) trackProductEvent('game_completed');
    expect(readProductEvents()).toHaveLength(200);
  });
});
