import { describe, expect, it } from 'vitest';
import {
  generationCreationFlowAvailable,
  parseRequestedGenerationCreationFlow,
} from './generationCreationFlow';
import { authorizeGenerationPurchase } from './billing';
import type { Env, PublicAuthContext } from './types';

describe('generation creation flow rollout contract', () => {
  it('keeps omitted legacy requests on the original flow', () => {
    expect(parseRequestedGenerationCreationFlow(undefined)).toBe('original');
    expect(generationCreationFlowAvailable('original')).toBe(true);
  });

  it('recognizes video after its additive Workflow lands', () => {
    expect(parseRequestedGenerationCreationFlow('video')).toBe('video');
    expect(generationCreationFlowAvailable('video')).toBe(true);
  });

  it('rejects unknown values instead of coercing them to original', () => {
    expect(parseRequestedGenerationCreationFlow('classic')).toBeNull();
  });

  it('fails closed for anonymous video authorization before reserving anything', async () => {
    const auth = { userId: null, rateLimitKey: 'test', user: null, claims: null } satisfies PublicAuthContext;
    const env = {} as Env;
    const response = await authorizeGenerationPurchase(new Request('https://api.example.test/api/billing/generation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'rookie', operation: 'fighter_generation', creationFlow: 'video' }),
    }), env, auth);

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'video_creation_requires_sign_in' });
  });
});
