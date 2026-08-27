import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./ApiClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ApiClient')>();
  return { ...actual, apiFetch: vi.fn() };
});

import { apiFetch } from './ApiClient.ts';
import { loadBillingProfile, loadCreditPacks } from './Billing.ts';

describe('billing load states', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.insertplayer.test');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('distinguishes an unavailable pack endpoint from a valid empty catalog', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(Response.json({ error: 'Temporarily unavailable' }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ packs: [] }));

    await expect(loadCreditPacks()).resolves.toMatchObject({
      status: 'unavailable',
      packs: [],
    });
    await expect(loadCreditPacks()).resolves.toEqual({ status: 'ready', packs: [] });
  });

  it('distinguishes signed out from a failed credit-balance request', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(Response.json({ user: null }))
      .mockRejectedValueOnce(new Error('network offline'));

    await expect(loadBillingProfile()).resolves.toEqual({
      status: 'signed-out',
      profile: null,
    });
    await expect(loadBillingProfile()).resolves.toMatchObject({
      status: 'unavailable',
      profile: null,
      message: 'network offline',
    });
  });

  it('returns the verified balance only after a successful profile response', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(Response.json({
      user: {
        creditsBalance: 42,
        freeRookieGenerationsUsed: 1,
        planTier: 'pro',
      },
    }));

    await expect(loadBillingProfile()).resolves.toEqual({
      status: 'ready',
      profile: {
        creditsBalance: 42,
        freeRookieGenerationsUsed: 1,
        planTier: 'pro',
      },
    });
  });
});
