import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDetachedApiRequestContext } from './ApiClient.ts';
import { verifyCreditCheckoutSession } from './Billing.ts';

const context = createDetachedApiRequestContext({
  apiBaseUrl: 'https://api.insertplayer.ai',
  authorizationToken: 'checkout-token',
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('exact checkout verification client', () => {
  it('requests the exact session with auth and accepts the matching response', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(
        'https://api.insertplayer.ai/api/billing/checkout-status?session_id=cs_live_exact_123',
      );
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer checkout-token');
      return Response.json({
        checkout: {
          sessionId: 'cs_live_exact_123',
          state: 'complete',
          processorStatus: 'paid',
          packId: 'starter',
          credits: 11,
          creditsBalance: 18,
          updatedAt: '2026-08-28T00:00:00.000Z',
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(verifyCreditCheckoutSession('cs_live_exact_123', context)).resolves.toEqual({
      checkout: {
        sessionId: 'cs_live_exact_123',
        state: 'complete',
        processorStatus: 'paid',
        packId: 'starter',
        credits: 11,
        creditsBalance: 18,
        updatedAt: '2026-08-28T00:00:00.000Z',
      },
    });
  });

  it('rejects a successful response for a different Stripe session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      checkout: {
        sessionId: 'cs_live_someone_else',
        state: 'complete',
        processorStatus: 'paid',
        packId: 'starter',
        credits: 11,
        creditsBalance: 1_000,
        updatedAt: '2026-08-28T00:00:00.000Z',
      },
    })));

    await expect(verifyCreditCheckoutSession('cs_live_expected', context)).resolves.toEqual({
      error: 'Checkout verification returned an invalid session.',
      retryable: true,
    });
  });
});
