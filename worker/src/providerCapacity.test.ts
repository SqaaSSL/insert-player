import { describe, expect, it } from 'vitest';
import {
  activeGenerationCapacity,
  GEMINI_FLASH_IMAGE_MODEL,
  GEMINI_PRO_IMAGE_MODEL,
  parseProviderDailyQuotaFailure,
  parseProviderDailyQuotaSignal,
  providerDailyQuotaFailureMessage,
  requiredGeminiModelsForGeneration,
} from './providerCapacity';
import type { Env } from './types';

describe('provider capacity policy', () => {
  it('includes Pro for every canonical source flow and Flash for non-Champion animations', () => {
    expect(requiredGeminiModelsForGeneration('fighter_generation', 'rookie')).toEqual([
      GEMINI_PRO_IMAGE_MODEL,
      GEMINI_FLASH_IMAGE_MODEL,
    ]);
    expect(requiredGeminiModelsForGeneration('fighter_retry_source', 'rookie')).toEqual([
      GEMINI_PRO_IMAGE_MODEL,
    ]);
    expect(requiredGeminiModelsForGeneration('fighter_retry_animation', 'contender')).toEqual([
      GEMINI_FLASH_IMAGE_MODEL,
    ]);
    expect(requiredGeminiModelsForGeneration('fighter_upgrade', 'champion')).toEqual([
      GEMINI_PRO_IMAGE_MODEL,
    ]);
  });

  it('accepts only a structured Gemini signal with an approved model', () => {
    expect(parseProviderDailyQuotaSignal(JSON.stringify({
      code: 'provider_daily_quota_exhausted',
      provider: 'gemini',
      model: GEMINI_PRO_IMAGE_MODEL,
      retryAfterSeconds: 85_783,
    }))).toEqual({
      provider: 'gemini',
      model: GEMINI_PRO_IMAGE_MODEL,
      retryAfterSeconds: 85_783,
    });
    expect(parseProviderDailyQuotaSignal(JSON.stringify({
      code: 'provider_daily_quota_exhausted',
      provider: 'gemini',
      model: 'unapproved-model',
      retryAfterSeconds: 3600,
    }))).toBeNull();
  });

  it('round-trips the bounded Workflow failure marker', () => {
    const window = {
      provider: 'gemini',
      model: GEMINI_PRO_IMAGE_MODEL,
      reason: 'daily_quota_exhausted',
      retryAtEpoch: 1_787_529_600,
    } as const;
    expect(parseProviderDailyQuotaFailure(providerDailyQuotaFailureMessage(window))).toEqual(window);
  });

  it('keeps direct-Google and Meterkey daily-capacity windows isolated', async () => {
    const tables: string[] = [];
    const database = {
      prepare(sql: string) {
        tables.push(sql);
        return {
          bind() {
            return { async first() { return null; } };
          },
        };
      },
    };

    await activeGenerationCapacity({
      DB: database as unknown as D1Database,
      ENVIRONMENT: 'production',
      GEMINI_TRANSPORT: 'meterkey',
    } as Env, 'fighter_generation', 'champion');
    await activeGenerationCapacity({
      DB: database as unknown as D1Database,
      ENVIRONMENT: 'sandbox',
      GEMINI_TRANSPORT: 'google-direct',
    } as Env, 'fighter_generation', 'champion');

    expect(tables[0]).toContain('FROM provider_meterkey_capacity_windows');
    expect(tables[1]).toContain('FROM provider_capacity_windows');
  });
});
