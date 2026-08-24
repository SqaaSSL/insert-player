import { describe, expect, it } from 'vitest';
import { GeminiRequestError } from '../../src/services/GeminiRequestPolicy.ts';
import { processorErrorResponse } from './providerErrorResponse';

describe('processorErrorResponse', () => {
  it('returns a structured, bounded daily-quota signal for an approved Gemini model', () => {
    expect(processorErrorResponse(new GeminiRequestError({
      message: 'quota exhausted',
      model: 'gemini-3-pro-image',
      status: 429,
      retryAfterMs: 85_783_000,
      dailyQuotaExhausted: true,
    }))).toEqual({
      status: 429,
      body: {
        error: 'Gemini daily image capacity is exhausted for this model',
        code: 'provider_daily_quota_exhausted',
        provider: 'gemini',
        model: 'gemini-3-pro-image',
        retryAfterSeconds: 85_783,
      },
    });
  });

  it('fails closed when a daily-quota error cannot prove an approved model', () => {
    expect(processorErrorResponse(new GeminiRequestError({
      message: 'quota exhausted',
      model: 'unknown-image-model',
      status: 429,
      dailyQuotaExhausted: true,
    }))).toMatchObject({
      status: 500,
      body: { code: 'provider_model_unapproved' },
    });
  });
});
