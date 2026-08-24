import { describe, expect, it } from 'vitest';
import {
  configuredGeminiTransport,
  geminiEstimatedCostCents,
  geminiTransportStatus,
  meterkeyBaseUrl,
} from './geminiTransport';
import type { Env } from './types';

describe('Gemini transport policy', () => {
  it('requires an explicit transport in deployed environments', () => {
    expect(configuredGeminiTransport({ ENVIRONMENT: 'production' } as Env)).toBeNull();
    expect(geminiTransportStatus({ ENVIRONMENT: 'production' } as Env)).toMatchObject({
      configured: false,
      transport: null,
    });
  });

  it('accepts only a bare HTTPS Meterkey origin', () => {
    expect(meterkeyBaseUrl('https://meter.hilo.cx')?.origin).toBe('https://meter.hilo.cx');
    expect(meterkeyBaseUrl('http://meter.hilo.cx')).toBeNull();
    expect(meterkeyBaseUrl('https://user:pass@meter.hilo.cx')).toBeNull();
    expect(meterkeyBaseUrl('https://meter.hilo.cx/path')).toBeNull();
    expect(meterkeyBaseUrl('https://meter.hilo.cx?key=bad')).toBeNull();
    expect(meterkeyBaseUrl('https://attacker.example')).toBeNull();
  });

  it('reserves the Meterkey ceiling in whole cents without changing direct estimates', () => {
    const meterkey = { ENVIRONMENT: 'production', GEMINI_TRANSPORT: 'meterkey' } as Env;
    const direct = { ENVIRONMENT: 'sandbox', GEMINI_TRANSPORT: 'google-direct' } as Env;
    expect(geminiEstimatedCostCents(meterkey, 'gemini-3.1-flash-image')).toBe(9);
    expect(geminiEstimatedCostCents(meterkey, 'gemini-3-pro-image')).toBe(17);
    expect(geminiEstimatedCostCents(direct, 'gemini-3.1-flash-image')).toBe(8);
    expect(geminiEstimatedCostCents(direct, 'gemini-3-pro-image')).toBe(15);
  });
});
