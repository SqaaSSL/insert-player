import { describe, expect, it } from 'vitest';
import {
  requireReviewedProductionWorkerPin,
  validateOptionalReviewedProductionWorkerPin,
} from './reviewedDeploymentPin';
import type { Env } from './types';

describe('reviewed production Worker pin', () => {
  const sha = 'a'.repeat(40);
  const env = {
    ENVIRONMENT: 'production',
    WORKER_VERSION_METADATA: { id: 'version-id', tag: `prod-${sha}-2` },
  } as unknown as Env;

  it('accepts only the exact deployed full SHA in production', async () => {
    expect(requireReviewedProductionWorkerPin(new Request('https://api.insertplayer.ai', {
      headers: { 'X-Insert-Player-Expected-Worker-Sha': sha },
    }), env)).toBeNull();

    const missing = requireReviewedProductionWorkerPin(
      new Request('https://api.insertplayer.ai'), env,
    );
    expect(missing?.status).toBe(428);

    const stale = requireReviewedProductionWorkerPin(new Request('https://api.insertplayer.ai', {
      headers: { 'X-Insert-Player-Expected-Worker-Sha': 'b'.repeat(40) },
    }), env);
    expect(stale?.status).toBe(409);
    expect(await stale?.json()).toMatchObject({ code: 'reviewed_worker_version_mismatch' });
  });

  it('does not alter sandbox or local flows', () => {
    expect(requireReviewedProductionWorkerPin(
      new Request('https://sandbox.insertplayer.ai'),
      { ...env, ENVIRONMENT: 'sandbox' } as Env,
    )).toBeNull();
  });

  it('preserves browser review routes without a pin but validates every supplied pin', () => {
    expect(validateOptionalReviewedProductionWorkerPin(
      new Request('https://api.insertplayer.ai'), env,
    )).toBeNull();
    expect(validateOptionalReviewedProductionWorkerPin(new Request('https://api.insertplayer.ai', {
      headers: { 'X-Insert-Player-Expected-Worker-Sha': sha },
    }), env)).toBeNull();
    expect(validateOptionalReviewedProductionWorkerPin(new Request('https://api.insertplayer.ai', {
      headers: { 'X-Insert-Player-Expected-Worker-Sha': 'b'.repeat(40) },
    }), env)?.status).toBe(409);
  });
});
