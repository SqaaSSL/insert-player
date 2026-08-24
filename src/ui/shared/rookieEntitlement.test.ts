import { describe, expect, it } from 'vitest';
import type { BillingProfile } from '../../services/Billing.ts';
import { includedRookieStatus, initialCreationTier } from './rookieEntitlement.ts';

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
});

describe('initialCreationTier', () => {
  it('keeps Contender as the normal signed-in recommendation', () => {
    expect(initialCreationTier(null, false)).toBe('contender');
  });

  it('honors the Rookie entry point from Arcade', () => {
    expect(initialCreationTier('rookie', false)).toBe('rookie');
    expect(initialCreationTier('rookie', true)).toBe('rookie');
  });

  it('does not unlock paid tiers through the URL while signed out', () => {
    expect(initialCreationTier('contender', true)).toBe('rookie');
    expect(initialCreationTier('champion', true)).toBe('rookie');
  });
});
