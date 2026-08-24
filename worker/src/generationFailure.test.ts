import { describe, expect, it } from 'vitest';
import { generationFailureDetails } from './generationFailure';
import { GEMINI_PRO_IMAGE_MODEL, providerDailyQuotaFailureMessage } from './providerCapacity';

describe('generationFailureDetails', () => {
  it('preserves the official quality rejection code and processor diagnostic', () => {
    expect(generationFailureDetails(
      'NonRetryableError: Official roster quality gate rejected the generated asset: {"error":"Gemini official walk visual QA rejected frame 8","code":"official_quality_rejected"}',
      false,
    )).toEqual({
      errorCode: 'qa_rejected_output',
      errorMessage: 'Gemini official walk visual QA rejected frame 8',
    });
  });

  it('keeps the generic post-provider failure for unrelated errors', () => {
    expect(generationFailureDetails('upstream connection closed', false)).toEqual({
      errorCode: 'generation_failed',
      errorMessage: 'Generation stopped after external processing began; contact support if it cannot be repaired',
    });
  });

  it('preserves the daily capacity failure and reset time', () => {
    expect(generationFailureDetails(providerDailyQuotaFailureMessage({
      provider: 'gemini',
      model: GEMINI_PRO_IMAGE_MODEL,
      reason: 'daily_quota_exhausted',
      retryAtEpoch: 1_787_529_600,
    }), false)).toEqual({
      errorCode: 'provider_daily_quota_exhausted',
      errorMessage: 'Image generation is at daily capacity; try again after 2026-08-24T00:00:00.000Z',
    });
  });
});
