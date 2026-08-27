import { describe, expect, it } from 'vitest';
import { GeminiRequestError } from '../../src/services/GeminiRequestPolicy.ts';
import { processorErrorResponse } from './providerErrorResponse';

describe('processorErrorResponse', () => {
  it.each([
    ['provider_request_not_dispatched', 429],
    ['provider_request_outcome_unknown', 503],
    ['daily_cap_exceeded', 429],
    ['monthly_cap_exceeded', 429],
  ])('preserves the non-retryable Meterkey code %s', (code, status) => {
    expect(processorErrorResponse(new GeminiRequestError({
      message: `Gemini request failed: ${code}`,
      model: 'gemini-3-pro-image',
      status,
      code,
      dailyQuotaExhausted: true,
    }))).toEqual({
      status,
      body: {
        error: `Gemini request failed: ${code}`,
        code,
        provider: 'gemini',
        model: 'gemini-3-pro-image',
      },
    });
  });

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
