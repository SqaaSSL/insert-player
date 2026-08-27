import { describe, expect, it } from 'vitest';
import {
  GeminiRequestError,
  RequestStartPacer,
  geminiErrorFromResponse,
  isApprovedGeminiImageModel,
  parseRetryAfterMs,
  retryGeminiRequest,
} from './GeminiRequestPolicy';

describe('Gemini request policy', () => {
  it('parses Retry-After seconds and dates', () => {
    expect(parseRetryAfterMs('2.5', 0)).toBe(2_500);
    expect(parseRetryAfterMs('Thu, 01 Jan 1970 00:00:05 GMT', 1_000)).toBe(4_000);
    expect(parseRetryAfterMs('invalid', 0)).toBeNull();
  });

  it('honors Google RetryInfo and identifies spend-based limits', () => {
    const error = geminiErrorFromResponse(
      'gemini-3-pro-image',
      new Response(null, { status: 429 }),
      JSON.stringify({
        error: {
          status: 'RESOURCE_EXHAUSTED',
          message: 'Your spending rate exceeded the spend-based rate limit.',
          details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12.25s' }],
        },
      }),
      0,
    );

    expect(error.retryable).toBe(true);
    expect(error.spendRateLimited).toBe(true);
    expect(error.retryAfterMs).toBe(12_250);
  });

  it('recognizes the structured per-model daily quota and preserves its reset delay', () => {
    const error = geminiErrorFromResponse(
      'gemini-3-pro-image',
      new Response(null, { status: 429 }),
      JSON.stringify({
        error: {
          status: 'RESOURCE_EXHAUSTED',
          message: 'You exceeded your current quota.',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
              violations: [{
                quotaMetric: 'generativelanguage.googleapis.com/generate_requests_per_model_per_day',
                quotaId: 'GenerateRequestsPerDayPerProjectPerModel',
              }],
            },
            { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '85783s' },
          ],
        },
      }),
      0,
    );

    expect(error).toMatchObject({
      model: 'gemini-3-pro-image',
      retryable: false,
      dailyQuotaExhausted: true,
      retryAfterMs: 85_783_000,
    });
  });

  it.each(['daily_cap_exceeded', 'monthly_cap_exceeded'])(
    'does not retry a Meterkey %s cap rejection',
    (code) => {
      const error = geminiErrorFromResponse(
        'gemini-3-pro-image',
        new Response(null, { status: 429, headers: { 'Retry-After': '3600' } }),
        JSON.stringify({ error: { code, message: 'request rejected before provider dispatch' } }),
        0,
      );

      expect(error).toMatchObject({ code, retryable: false, retryAfterMs: 3_600_000 });
    },
  );

  it.each([
    ['unknown', 'provider_request_outcome_unknown'],
    ['not-dispatched', 'provider_request_not_dispatched'],
  ])('does not retry a Meterkey %s upstream outcome', (outcome, code) => {
    const error = geminiErrorFromResponse(
      'gemini-3-pro-image',
      new Response(null, {
        status: 503,
        headers: { 'X-Insert-Player-Upstream-Outcome': outcome },
      }),
      JSON.stringify({ error: { code: 'service_unavailable', message: 'gateway failure' } }),
    );

    expect(error).toMatchObject({ code, retryable: false });
  });

  it('allows only the two production Gemini image models', () => {
    expect(isApprovedGeminiImageModel('gemini-3-pro-image')).toBe(true);
    expect(isApprovedGeminiImageModel('gemini-3.1-flash-image')).toBe(true);
    expect(isApprovedGeminiImageModel('gemini-2.5-flash-image')).toBe(false);
    expect(isApprovedGeminiImageModel('flux-2-pro')).toBe(false);
  });

  it('backs off transient errors and succeeds', async () => {
    const delays: number[] = [];
    let calls = 0;
    const result = await retryGeminiRequest(async () => {
      calls += 1;
      if (calls < 3) {
        throw new GeminiRequestError({ message: 'busy', status: 503, retryable: true });
      }
      return 'ok';
    }, {
      baseDelayMs: 100,
      random: () => 0.5,
      sleep: async (delayMs) => { delays.push(delayMs); },
    });

    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(delays).toEqual([100, 200]);
  });

  it('caps an excessive upstream Retry-After at the normal retry ceiling', async () => {
    const delays: number[] = [];
    let calls = 0;
    const result = await retryGeminiRequest(async () => {
      calls += 1;
      if (calls === 1) {
        throw new GeminiRequestError({
          message: 'busy for too long',
          status: 429,
          retryable: true,
          retryAfterMs: 24 * 60 * 60 * 1_000,
        });
      }
      return 'ok';
    }, {
      maxAttempts: 2,
      baseDelayMs: 100,
      maxDelayMs: 60_000,
      random: () => 0.5,
      sleep: async (delayMs) => { delays.push(delayMs); },
    });

    expect(result).toBe('ok');
    expect(calls).toBe(2);
    expect(delays).toEqual([60_000]);
  });

  it('uses the longer spend cooldown and stops at the attempt limit', async () => {
    const delays: number[] = [];
    let calls = 0;
    await expect(retryGeminiRequest(async () => {
      calls += 1;
      throw new GeminiRequestError({
        message: 'spend limit',
        status: 429,
        retryable: true,
        spendRateLimited: true,
      });
    }, {
      maxAttempts: 3,
      spendBaseDelayMs: 1_000,
      spendMaxDelayMs: 10_000,
      random: () => 0.5,
      sleep: async (delayMs) => { delays.push(delayMs); },
    })).rejects.toThrow('spend limit');

    expect(calls).toBe(3);
    expect(delays).toEqual([1_000, 2_000]);
  });

  it('serializes starts for the same pacing key', async () => {
    let now = 0;
    const delays: number[] = [];
    const pacer = new RequestStartPacer(async (delayMs) => {
      delays.push(delayMs);
      now += delayMs;
    }, () => now);

    await Promise.all([
      pacer.wait('pro', 10),
      pacer.wait('pro', 10),
      pacer.wait('pro', 10),
    ]);

    expect(delays).toEqual([10, 10]);
    expect(now).toBe(20);
  });
});
