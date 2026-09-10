import { describe, expect, it } from 'vitest';
import type { BillingProfile } from '../../services/Billing.ts';
import { expectedCreationCredits, includedRookieStatus, initialCreationTier } from './rookieEntitlement.ts';

const profile = (freeRookieGenerationsUsed: number): BillingProfile => ({
  creditsBalance: 0,
  freeRookieGenerationsUsed,
  planTier: 'free',
});

describe('includedRookieStatus', () => {
  it('includes the anonymous Turnstile-protected Rookie', () => {
    expect(includedRookieStatus('signed-out', null)).toBe('included');
  });

  it('includes the local development Rookie', () => {
    expect(includedRookieStatus('local', null)).toBe('included');
  });

  it('uses the authenticated free-generation counter', () => {
    expect(includedRookieStatus('signed-in', profile(0))).toBe('included');
    expect(includedRookieStatus('signed-in', profile(1))).toBe('credits');
    expect(includedRookieStatus('signed-in', profile(3))).toBe('credits');
  });

  it('does not promise an entitlement before the account is known', () => {
    expect(includedRookieStatus('loading', null)).toBe('checking');
    expect(includedRookieStatus('signed-in', null)).toBe('checking');
  });

  it('requires an account for Aura rather than promising the anonymous combat Rookie', () => {
    expect(includedRookieStatus('signed-out', null, 'aura')).toBe('account-required');
    expect(includedRookieStatus('local', null, 'aura')).toBe('account-required');
    expect(includedRookieStatus('loading', null, 'aura')).toBe('checking');
    expect(includedRookieStatus('signed-in', profile(0), 'aura')).toBe('included');
    expect(includedRookieStatus('signed-in', profile(1), 'aura')).toBe('credits');
  });
});

describe('initialCreationTier', () => {
  it('keeps Contender as the normal signed-in recommendation', () => {
    expect(initialCreationTier(null, false)).toBe('contender');
  });

  it('honors the Rookie entry point from Arcade', () => {
    expect(initialCreationTier('rookie', false)).toBe('rookie');
    expect(initialCreationTier('rookie', true)).toBe('rookie');
  });

  it('defaults an Aura entry to Rookie while preserving explicit quality choices', () => {
    expect(initialCreationTier(null, false, 'aura')).toBe('rookie');
    expect(initialCreationTier('champion', false, 'aura')).toBe('champion');
  });

  it('does not unlock paid tiers through the URL while signed out', () => {
    expect(initialCreationTier('contender', true)).toBe('rookie');
    expect(initialCreationTier('champion', true)).toBe('rookie');
  });
});

describe('expectedCreationCredits', () => {
  it('binds the shown Aura price to zero for the included Rookie and two after it is used', () => {
    expect(expectedCreationCredits('rookie', 'aura', 'signed-in', profile(0))).toBe(0);
    expect(expectedCreationCredits('rookie', 'aura', 'signed-in', profile(1))).toBe(2);
    expect(expectedCreationCredits('contender', 'aura', 'signed-in', profile(0))).toBe(6);
  });
  it('cannot authorize an unknown account entitlement or malformed counter', () => {
    expect(expectedCreationCredits('rookie', 'aura', 'signed-out', null)).toBeNull();
    expect(expectedCreationCredits('rookie', 'aura', 'signed-in', null)).toBeNull();
    expect(expectedCreationCredits('rookie', 'aura', 'signed-in', profile(Number.NaN))).toBeNull();
    expect(expectedCreationCredits('rookie', 'aura', 'signed-in', profile(-1))).toBeNull();
  });
});
