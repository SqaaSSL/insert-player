import { describe, expect, it, vi } from 'vitest';
import { authorizeGenerationPurchase } from './billing';
import { requestFighterUpgrade, tiersResponse } from './fighters';
import { CURRENT_LEGAL_VERSION } from './legal';
import { generationCreditCost, isOfferedQualityTier, maxTier, TIER_DEFINITIONS } from './tiers';
import type { AuthContext, Env, PublicAuthContext } from './types';

const legal = {
  legalVersion: CURRENT_LEGAL_VERSION,
  ageConfirmed: true,
  termsAccepted: true,
  photoRightsConfirmed: true,
  aiProcessingConfirmed: true,
  immediatePerformanceConfirmed: true,
  withdrawalLossAcknowledged: true,
};

const auth = {
  userId: 'tier-owner', rateLimitKey: 'user:tier-owner', claims: {}, user: { id: 'tier-owner' },
} as unknown as PublicAuthContext;

describe('two offered qualities with stable legacy generation contracts', () => {
  it('advertises Rookie and the existing refined workflow as Champion at their existing prices', async () => {
    expect(await tiersResponse().json()).toEqual({ tiers: [
      { id: 'rookie', label: 'Rookie', creditCost: 2, animationRetryCreditCost: 1 },
      { id: 'contender', label: 'Champion', creditCost: 11, animationRetryCreditCost: 2 },
    ] });
    expect(isOfferedQualityTier('champion')).toBe(false);
    expect(TIER_DEFINITIONS.contender).toMatchObject({ pipeline: 'sheet_refined', model: 'flash' });
  });

  it('keeps legacy ranks and maintenance costs for old assets and paid work', () => {
    expect(maxTier('champion', 'contender')).toBe('champion');
    expect(generationCreditCost('champion', 'fighter_retry_animation')).toBe(4);
    expect(generationCreditCost('champion', 'fighter_retry_source')).toBe(1);
    expect(TIER_DEFINITIONS.champion.model).toBe('pro');
  });

  it.each([
    { operation: 'fighter_generation' },
    { operation: 'fighter_generation', quoteOnly: true },
    { operation: 'fighter_generation', creationFlow: 'video' },
    { operation: 'fighter_upgrade' },
    { operation: 'fighter_upgrade', expansion: true, quoteOnly: true },
  ])('rejects a stale client request before any billing or provider side effect: %j', async (options) => {
    const prepare = vi.fn(() => { throw new Error('Retired offers must not touch billing state'); });
    const env = { DB: { prepare } } as unknown as Env;
    const response = await authorizeGenerationPurchase(new Request('https://api.insertplayer.ai/api/billing/generation', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'champion', legal, ...options }),
    }), env, auth);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'generation_tier_retired' });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('defaults the upgrade quote to the current Champion and refuses the retired upsell', async () => {
    const env = { DB: { prepare: () => ({ bind: () => ({ first: async () => ({
      id: 'fighter', owner_user_id: auth.userId, name: 'Fighter', quality_tier: 'rookie',
      photo_hash: 'photo', public_flag: 0, created_at: '', updated_at: '',
    }) }) }) } } as unknown as Env;
    const request = (body: unknown) => new Request('https://api.insertplayer.ai/api/fighters/fighter/upgrade', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const current = await requestFighterUpgrade(request({}), env, auth as AuthContext, 'fighter');
    expect(await current.json()).toMatchObject({ upgrade: { toTier: 'contender', cost: 11 } });
    const retired = await requestFighterUpgrade(request({ toTier: 'champion' }), env, auth as AuthContext, 'fighter');
    expect(retired.status).toBe(409);
    expect(await retired.json()).toMatchObject({ code: 'generation_tier_retired' });
  });
});
