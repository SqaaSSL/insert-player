import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./ApiClient', () => ({ apiFetch: vi.fn() }));
vi.mock('../ui/legal.ts', () => ({
  storedGenerationLegalAttestation: () => ({
    legalVersion: '2026-08-23.1',
    ageConfirmed: true,
    termsAccepted: true,
    photoRightsConfirmed: true,
    aiProcessingConfirmed: true,
    immediatePerformanceConfirmed: true,
    withdrawalLossAcknowledged: true,
  }),
}));

import { apiFetch } from './ApiClient.ts';
import { authorizeStageForge } from './Billing.ts';

describe('Stage Forge billing client', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.insertplayer.test');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the dedicated paid endpoint and returns its credit receipt', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(Response.json({
      mode: 'credits',
      purchaseId: 'forge-purchase',
      creditsCharged: 1,
      creditsBalance: 8,
      providerSessionId: 'forge-session',
    }));

    await expect(authorizeStageForge()).resolves.toMatchObject({
      authorized: true,
      mode: 'credits',
      purchaseId: 'forge-purchase',
      creditsCharged: 1,
      creditsBalance: 8,
      providerSessionId: 'forge-session',
    });
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/billing/stage-forge',
      expect.objectContaining({ method: 'POST' }),
      undefined,
    );
  });

  it('surfaces the exact balance when the player is short of credits', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(Response.json({
      error: 'Not enough credits',
      requiredCredits: 1,
      creditsBalance: 0,
    }, { status: 402 }));

    await expect(authorizeStageForge()).resolves.toMatchObject({
      authorized: false,
      creditsCharged: 0,
      creditsBalance: 0,
      error: 'Not enough credits. 1 credit required. You have 0.',
    });
  });
});
