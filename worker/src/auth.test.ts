import { describe, expect, it } from 'vitest';
import { anonymousRateLimitKey } from './auth';
import type { Env } from './types';

describe('anonymous identifier protection', () => {
  it('produces a stable HMAC key without retaining the source IP', async () => {
    const env = {
      ENVIRONMENT: 'production',
      ANONYMIZATION_SECRET: 'test-secret-that-is-not-used-in-production',
    } as Env;
    const request = new Request('https://api.insertplayer.ai/health', {
      headers: { 'CF-Connecting-IP': '203.0.113.42' },
    });

    const first = await anonymousRateLimitKey(request, env);
    const second = await anonymousRateLimitKey(request, env);

    expect(first).toBe(second);
    expect(first).toMatch(/^anon:[a-f0-9]{64}$/);
    expect(first).not.toContain('203.0.113.42');
  });

  it('fails closed in production when the HMAC secret is absent', async () => {
    const env = { ENVIRONMENT: 'production' } as Env;
    await expect(anonymousRateLimitKey(
      new Request('https://api.insertplayer.ai/health'),
      env,
    )).rejects.toThrow('ANONYMIZATION_SECRET is required');
  });
});
