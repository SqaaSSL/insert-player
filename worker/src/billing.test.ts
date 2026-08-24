import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCreditCheckoutSession,
  creditsForStripeAdjustment,
  stripeEventAuditPayload,
} from './billing';
import { CURRENT_LEGAL_VERSION } from './legal';
import type { AuthContext, Env } from './types';

class FakeD1Statement {
  private bindings: unknown[] = [];

  constructor(private readonly sql: string) {}

  bind(...bindings: unknown[]): this {
    this.bindings = bindings;
    return this;
  }

  first<T>(): Promise<T | null> {
    if (this.sql.includes('SELECT stripe_customer_id FROM users')) {
      return Promise.resolve({ stripe_customer_id: storedStripeCustomerId } as T);
    }
    return Promise.resolve(null);
  }

  run(): Promise<D1Result> {
    if (this.sql.includes('UPDATE users') && this.sql.includes('stripe_customer_id')) {
      storedStripeCustomerId ??= String(this.bindings[0]);
    }
    return Promise.resolve({ success: true, meta: {} } as D1Result);
  }
}

let storedStripeCustomerId: string | null = null;

const env = {
  DB: {
    prepare: (sql: string) => new FakeD1Statement(sql),
    batch: (statements: D1PreparedStatement[]) => Promise.resolve(
      statements.map(() => ({ success: true, meta: {} } as D1Result)),
    ),
  } as unknown as D1Database,
  ENVIRONMENT: 'production',
  CORS_ORIGIN: 'https://insertplayer.ai',
  PUBLIC_APP_NAME: 'Insert Player',
  STRIPE_SECRET_KEY: 'sk_live_insert_player',
  STRIPE_WEBHOOK_SECRET: 'whsec_insert_player',
  STRIPE_ACCOUNT_ID: 'acct_insertplayer',
  STRIPE_PRICE_STARTER: 'price_starter',
  STRIPE_PRICE_VERSUS: 'price_versus',
  STRIPE_PRICE_ARCADE: 'price_arcade',
} as Env;

const auth = {
  userId: 'user_insert_player',
  claims: {},
  user: { id: 'user_insert_player' },
} as unknown as AuthContext;

const checkoutLegal = {
  legalVersion: CURRENT_LEGAL_VERSION,
  ageConfirmed: true,
  termsAccepted: true,
  refundPolicyAcknowledged: true,
  immediateDeliveryConfirmed: true,
  withdrawalLossAcknowledged: true,
} as const;

afterEach(() => {
  storedStripeCustomerId = null;
  vi.unstubAllGlobals();
});

describe('Stripe checkout hardening', () => {
  it('retries a transient Checkout failure with the same idempotency key', async () => {
    const checkoutHeaders: Headers[] = [];
    const checkoutForms: URLSearchParams[] = [];
    let checkoutAttempts = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      expect(init?.signal).toBeInstanceOf(AbortSignal);

      if (url.endsWith('/v1/account')) {
        return Response.json({
          id: 'acct_insertplayer',
          details_submitted: true,
          charges_enabled: true,
          business_profile: {
            name: 'Insert Player',
            url: 'https://insertplayer.ai',
            support_url: 'https://insertplayer.ai/refunds',
          },
        });
      }
      if (url.includes('/v1/prices/price_starter')) {
        return Response.json({
          id: 'price_starter',
          active: true,
          currency: 'eur',
          unit_amount: 1499,
          tax_behavior: 'inclusive',
          product: {
            tax_code: 'txcd_10201000',
            metadata: { insert_player_pack_id: 'starter' },
          },
        });
      }
      if (url.endsWith('/v1/customers')) {
        const headers = new Headers(init?.headers);
        expect(headers.get('Idempotency-Key')).toMatch(/^insert-player-customer-[a-f0-9]{64}$/);
        return Response.json({ id: 'cus_insertplayer' });
      }
      if (url.endsWith('/v1/checkout/sessions')) {
        checkoutAttempts += 1;
        checkoutHeaders.push(new Headers(init?.headers));
        checkoutForms.push(new URLSearchParams(String(init?.body ?? '')));
        if (checkoutAttempts === 1) {
          return Response.json({ error: { message: 'temporary' } }, { status: 503 });
        }
        return Response.json({ id: 'cs_live_insert_player', url: 'https://checkout.stripe.com/test' });
      }
      throw new Error(`Unexpected Stripe URL: ${url}`);
    }));

    const response = await createCreditCheckoutSession(new Request(
      'https://api.insertplayer.ai/api/billing/checkout',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://insertplayer.ai',
        },
        body: JSON.stringify({ packId: 'starter', legal: checkoutLegal }),
      },
    ), env, auth);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sessionId: 'cs_live_insert_player' });
    expect(checkoutAttempts).toBe(2);
    const idempotencyKeys = checkoutHeaders.map((headers) => headers.get('Idempotency-Key'));
    expect(idempotencyKeys[0]).toMatch(/^insert-player-checkout-/);
    expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);
    expect(checkoutForms[0].get('automatic_tax[enabled]')).toBe('true');
    expect(checkoutForms[0].get('consent_collection[terms_of_service]')).toBe('none');
    expect(checkoutForms[0].get('metadata[legal_version]')).toBe(CURRENT_LEGAL_VERSION);
    expect(checkoutForms[0].get('metadata[withdrawal_loss_acknowledged]')).toBe('true');
    expect(checkoutForms[0].get('payment_intent_data[metadata][session_token]'))
      .toBe(checkoutForms[0].get('metadata[session_token]'));
    expect(checkoutForms[0].get('payment_intent_data[metadata][stripe_account_id]')).toBe('acct_insertplayer');
    expect(checkoutForms[0].get('payment_intent_data[metadata][legal_version]')).toBe(CURRENT_LEGAL_VERSION);
    expect(checkoutForms[0].get('customer')).toBe('cus_insertplayer');
    expect(checkoutForms[0].get('customer_update[address]')).toBe('auto');
  });

  it('maps partial and full payment adjustments to bounded whole credits', () => {
    expect(creditsForStripeAdjustment(11, 0, 1499)).toBe(0);
    expect(creditsForStripeAdjustment(11, 1, 1499)).toBe(1);
    expect(creditsForStripeAdjustment(11, 750, 1499)).toBe(6);
    expect(creditsForStripeAdjustment(11, 1499, 1499)).toBe(11);
    expect(creditsForStripeAdjustment(11, 2000, 1499)).toBe(11);
  });

  it('rejects checkout before contacting Stripe when consent is missing', async () => {
    const stripeFetch = vi.fn();
    vi.stubGlobal('fetch', stripeFetch);

    const response = await createCreditCheckoutSession(new Request(
      'https://api.insertplayer.ai/api/billing/checkout',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packId: 'starter' }),
      },
    ), env, auth);

    expect(response.status).toBe(428);
    expect(await response.json()).toEqual({ error: 'Current checkout consent is required' });
    expect(stripeFetch).not.toHaveBeenCalled();
  });

  it('returns an actionable 503 before creating Stripe state when the business profile is incomplete', async () => {
    const stripeFetch = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toMatch(/\/v1\/account$/);
      return Response.json({ id: 'acct_insertplayer', business_profile: {} });
    });
    vi.stubGlobal('fetch', stripeFetch);

    const response = await createCreditCheckoutSession(new Request(
      'https://api.insertplayer.ai/api/billing/checkout',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packId: 'starter', legal: checkoutLegal }),
      },
    ), env, auth);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'Credit checkout is temporarily unavailable while billing setup is being completed.',
    });
    expect(stripeFetch).toHaveBeenCalledTimes(1);
  });

  it('validates the Stripe business profile against the configured public brand', async () => {
    const stripeFetch = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toMatch(/\/v1\/account$/);
      return Response.json({
        id: 'acct_insertplayer',
        details_submitted: true,
        charges_enabled: true,
        business_profile: {
          name: 'Insert Player',
          url: 'https://insertplayer.ai',
          support_url: 'https://insertplayer.ai/support',
        },
      });
    });
    vi.stubGlobal('fetch', stripeFetch);

    const response = await createCreditCheckoutSession(new Request(
      'https://api.insertplayer.ai/api/billing/checkout',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packId: 'starter', legal: checkoutLegal }),
      },
    ), { ...env, PUBLIC_APP_NAME: 'A Different Arcade' }, auth);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'Credit checkout is temporarily unavailable while billing setup is being completed.',
    });
    expect(stripeFetch).toHaveBeenCalledTimes(1);
  });

  it('creates Checkout without duplicating the app-level legal consent in Stripe', async () => {
    storedStripeCustomerId = 'cus_insertplayer';
    const checkoutForms: URLSearchParams[] = [];
    const stripeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/account')) {
        return Response.json({
          id: 'acct_insertplayer',
          details_submitted: true,
          charges_enabled: true,
          business_profile: {
            name: 'Insert Player',
            url: 'https://insertplayer.ai',
            support_phone: '+34 900 000 000',
          },
        });
      }
      if (url.includes('/v1/prices/price_starter')) {
        return Response.json({
          id: 'price_starter',
          active: true,
          currency: 'eur',
          unit_amount: 1499,
          tax_behavior: 'inclusive',
          product: {
            tax_code: 'txcd_10201000',
            metadata: { insert_player_pack_id: 'starter' },
          },
        });
      }
      if (url.endsWith('/v1/checkout/sessions')) {
        checkoutForms.push(new URLSearchParams(String(init?.body ?? '')));
        return Response.json({
          id: 'cs_live_app_consent',
          url: 'https://checkout.stripe.com/test',
        });
      }
      throw new Error(`Unexpected Stripe URL: ${url}`);
    });
    vi.stubGlobal('fetch', stripeFetch);

    const response = await createCreditCheckoutSession(new Request(
      'https://api.insertplayer.ai/api/billing/checkout',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packId: 'starter', legal: checkoutLegal }),
      },
    ), env, auth);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sessionId: 'cs_live_app_consent' });
    expect(checkoutForms[0]?.get('consent_collection[terms_of_service]')).toBe('none');
    expect(stripeFetch).toHaveBeenCalledTimes(3);
  });

  it('reduces webhook data to a non-PII audit summary', () => {
    const payload = stripeEventAuditPayload({
      id: 'evt_insert_player',
      livemode: true,
      data: {
        object: {
          id: 'cs_live_insert_player',
          object: 'checkout.session',
          payment_status: 'paid',
          customer_details: {
            email: 'player@example.com',
            name: 'Private Player',
            address: { line1: 'Private address' },
          },
        },
      },
    }, 'acct_insertplayer', 'credited');

    expect(JSON.parse(payload)).toEqual({
      accountId: 'acct_insertplayer',
      livemode: true,
      objectId: 'cs_live_insert_player',
      objectType: 'checkout.session',
      paymentStatus: 'paid',
      creditStatus: 'credited',
    });
    expect(payload).not.toContain('player@example.com');
    expect(payload).not.toContain('Private Player');
    expect(payload).not.toContain('Private address');
  });
});
