import { afterEach, describe, expect, it, vi } from 'vitest';
import { rememberAuraOnboarding, shouldGuideAuraBattle } from './auraOnboarding.ts';
const solo = { gameMode: 'aura' as const, vsAI: true };
afterEach(() => vi.unstubAllGlobals());
describe('first Aura battle preference', () => {
  it('remembers completion without account or server storage', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) } });
    expect(shouldGuideAuraBattle(solo)).toBe(true);
    rememberAuraOnboarding();
    expect(shouldGuideAuraBattle(solo)).toBe(false);
  });
  it('keeps play available if device storage is blocked', () => {
    vi.stubGlobal('window', { get localStorage() { throw new Error('blocked'); } });
    expect(shouldGuideAuraBattle(solo)).toBe(true);
    expect(() => rememberAuraOnboarding()).not.toThrow();
    expect(shouldGuideAuraBattle({ ...solo, cpuVsCpu: true })).toBe(false);
    expect(shouldGuideAuraBattle({ ...solo, vsAI: false })).toBe(false);
  });
});
