import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildArcadeSelectionSearch,
  buildCreationSearch,
  consumePostSignUpTrialIntent,
  parseCreationPurchaseIntent,
  isGeneratedPhotoHash,
  isNewAccountForOnboarding,
  isFreshPostSignUpTrialIntent,
  readCreationNavigationContext,
  readPreferredArcadePlayerPhotoHash,
  rememberPostSignUpTrialIntent,
} from './onboardingFlow.ts';

const PHOTO_HASH = 'a'.repeat(64);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('onboardingFlow', () => {
  it('round-trips the whitelisted trial creation context', () => {
    const search = buildCreationSearch({
      tier: 'rookie',
      returnTo: 'arcade',
      source: 'trial',
    });
    expect(search).toBe('tier=rookie&return=arcade&source=trial');
    expect(readCreationNavigationContext(`?${search}`)).toEqual({
      tier: 'rookie',
      returnTo: 'arcade',
      source: 'trial',
    });
  });

  it('fails closed for unknown tiers, sources, and return targets', () => {
    expect(readCreationNavigationContext(
      '?tier=god&return=https%3A%2F%2Fevil.example&source=campaign',
    )).toEqual({
      tier: null,
      returnTo: 'gallery',
      source: null,
    });
  });

  it('defaults ordinary creation to Gallery', () => {
    expect(readCreationNavigationContext('')).toEqual({
      tier: null,
      returnTo: 'gallery',
      source: null,
    });
    expect(buildCreationSearch()).toBe('');
  });

  it('accepts only canonical generated fighter hashes for Arcade selection', () => {
    expect(isGeneratedPhotoHash(PHOTO_HASH)).toBe(true);
    expect(isGeneratedPhotoHash('A'.repeat(64))).toBe(false);
    expect(isGeneratedPhotoHash('arcade:player-one:id')).toBe(false);
    expect(readPreferredArcadePlayerPhotoHash(`?player=${PHOTO_HASH}&source=creation`)).toBe(PHOTO_HASH);
    expect(readPreferredArcadePlayerPhotoHash('?player=../../bad')).toBeNull();
  });

  it('builds a stable post-creation Arcade handoff and rejects bad hashes', () => {
    expect(buildArcadeSelectionSearch(PHOTO_HASH)).toBe(`player=${PHOTO_HASH}&source=creation`);
    expect(() => buildArcadeSelectionSearch('short')).toThrow(/photo hash/i);
  });

  it('accepts only fresh, whitelisted credit-purchase intents', () => {
    const now = 1_900_000_000_000;
    expect(parseCreationPurchaseIntent({
      tier: 'champion',
      returnTo: 'arcade',
      source: 'landing',
      createdAt: now - 1_000,
    }, now)).toMatchObject({ tier: 'champion', returnTo: 'arcade', source: 'landing' });
    expect(parseCreationPurchaseIntent({
      tier: 'god',
      returnTo: 'https://evil.example',
      source: 'campaign',
      createdAt: now,
    }, now)).toBeNull();
    expect(parseCreationPurchaseIntent({
      tier: 'champion',
      returnTo: 'arcade',
      source: 'landing',
      createdAt: now - 25 * 60 * 60 * 1_000,
    }, now)).toBeNull();
  });

  it('accepts only a fresh post-sign-up trial marker', () => {
    const now = 1_900_000_000_000;
    expect(isFreshPostSignUpTrialIntent(now - 1_000, now)).toBe(true);
    expect(isFreshPostSignUpTrialIntent(now - 31 * 60 * 1_000, now)).toBe(false);
    expect(isFreshPostSignUpTrialIntent(now + 61_000, now)).toBe(false);
    expect(isFreshPostSignUpTrialIntent('1900000000000', now)).toBe(false);
  });

  it('starts automatic onboarding only for a newly-created Clerk account', () => {
    const now = 1_900_000_000_000;
    expect(isNewAccountForOnboarding(new Date(now - 1_000), now)).toBe(true);
    expect(isNewAccountForOnboarding(new Date(now - 31 * 60 * 1_000), now)).toBe(false);
    expect(isNewAccountForOnboarding(new Date(now + 61_000), now)).toBe(false);
    expect(isNewAccountForOnboarding(null, now)).toBe(false);
  });

  it('consumes the post-sign-up intent exactly once', () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    });
    vi.spyOn(Date, 'now').mockReturnValue(1_900_000_000_000);

    rememberPostSignUpTrialIntent();

    expect(consumePostSignUpTrialIntent(1_900_000_001_000)).toBe(true);
    expect(consumePostSignUpTrialIntent(1_900_000_001_000)).toBe(false);
  });
});
