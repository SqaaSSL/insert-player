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

  it('recognizes video but keeps it fail-closed until its Workflow lands', () => {
    expect(parseRequestedGenerationCreationFlow('video')).toBe('video');
    expect(generationCreationFlowAvailable('video')).toBe(false);
  });

  it('rejects unknown values instead of coercing them to original', () => {
    expect(parseRequestedGenerationCreationFlow('classic')).toBeNull();
  });

  it('fails closed at authorization until the video Workflow is deployed', async () => {
    const auth = { userId: null, rateLimitKey: 'test', user: null, claims: null } satisfies PublicAuthContext;
    const env = {} as Env;
    const response = await authorizeGenerationPurchase(new Request('https://api.example.test/api/billing/generation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'rookie', operation: 'fighter_generation', creationFlow: 'video' }),
    }), env, auth);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'generation_creation_flow_unavailable' });
  });
});
