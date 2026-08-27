import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearPendingCheckout,
  clearPendingCheckoutForSession,
  checkoutReturnFromUrl,
  checkoutVerificationMessage,
  consumeCheckoutReturn,
  consumePendingCheckout,
  readPendingCheckout,
  rememberPendingCheckout,
} from './checkoutStatus';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

describe('pending checkout state', () => {
  it('is scoped to the auth session and consumed once', () => {
    const storage = new MemoryStorage();
    const pending = { sessionId: 'cs_live_pending_a', packId: 'starter', credits: 20 };
    rememberPendingCheckout(pending, 'user-a', storage, 1_000);

    expect(consumePendingCheckout('user-b', storage, 1_001)).toBeNull();
    expect(consumePendingCheckout('user-a', storage, 1_001)).toEqual(pending);
    expect(consumePendingCheckout('user-a', storage, 1_001)).toBeNull();
  });

  it('can be read without consuming during Strict Mode effect replay', () => {
    const storage = new MemoryStorage();
    const pending = { sessionId: 'cs_live_pending_a', packId: 'starter', credits: 20 };
    rememberPendingCheckout(pending, 'user-a', storage, 1_000);

    expect(readPendingCheckout('user-a', storage, 1_001)).toEqual(pending);
    expect(readPendingCheckout('user-a', storage, 1_002)).toEqual(pending);
  });

  it('clears only the current session pending checkout', () => {
    const storage = new MemoryStorage();
    const pending = { sessionId: 'cs_live_pending_a', packId: 'starter', credits: 20 };
    rememberPendingCheckout(pending, 'user-a', storage, 1_000);
    rememberPendingCheckout(pending, 'user-b', storage, 1_000);
    clearPendingCheckout('user-a', storage);

    expect(consumePendingCheckout('user-a', storage, 1_001)).toBeNull();
    expect(consumePendingCheckout('user-b', storage, 1_001)).toEqual(pending);
  });

  it('does not clear a newer pending session when an older tab returns', () => {
    const storage = new MemoryStorage();
    const pending = { sessionId: 'cs_live_newer', packId: 'starter', credits: 20 };
    rememberPendingCheckout(pending, 'user-a', storage, 1_000);

    clearPendingCheckoutForSession('user-a', 'cs_live_older', storage, 1_001);
    expect(readPendingCheckout('user-a', storage, 1_001)).toEqual(pending);

    clearPendingCheckoutForSession('user-a', 'cs_live_newer', storage, 1_001);
    expect(readPendingCheckout('user-a', storage, 1_001)).toBeNull();
  });
});

describe('checkout return verification helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves the exact Stripe session across Strict Mode replay', () => {
    const storage = new MemoryStorage();
    const browser = {
      location: { href: 'https://insertplayer.ai/menu?checkout=success&session_id=cs_live_exact_123' },
      history: {
        state: null,
        replaceState: (_state: unknown, _title: string, nextUrl: string) => {
          browser.location.href = new URL(nextUrl, browser.location.href).toString();
        },
      },
      sessionStorage: storage,
      setTimeout: vi.fn(() => 1),
    };
    vi.stubGlobal('window', browser);

    expect(consumeCheckoutReturn('user-a')).toEqual({
      status: 'success',
      sessionId: 'cs_live_exact_123',
    });
    expect(browser.location.href).toBe('https://insertplayer.ai/menu');
    expect(consumeCheckoutReturn('user-a')).toEqual({
      status: 'success',
      sessionId: 'cs_live_exact_123',
    });
  });

  it('can inspect a signed-out return without consuming its exact session', () => {
    expect(checkoutReturnFromUrl(
      'https://insertplayer.ai/menu?checkout=success&session_id=cs_live_sign_in_first',
    )).toEqual({ status: 'success', sessionId: 'cs_live_sign_in_first' });
  });

  it('never promotes a high balance into a completed checkout', () => {
    expect(checkoutVerificationMessage({
      sessionId: 'cs_live_pending',
      state: 'pending',
      processorStatus: 'open',
      packId: 'starter',
      credits: 11,
      creditsBalance: 10_000,
      updatedAt: '2026-08-28T00:00:00.000Z',
    })).toContain('balance alone does not confirm it');
  });

  it('reports completion only from the exact backend session state', () => {
    expect(checkoutVerificationMessage({
      sessionId: 'cs_live_complete',
      state: 'complete',
      processorStatus: 'paid',
      packId: 'starter',
      credits: 11,
      creditsBalance: 16,
      updatedAt: '2026-08-28T00:00:00.000Z',
    })).toBe('16 credits ready · Stripe session confirmed for 11 credits.');
  });
});
