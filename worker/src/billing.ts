import { generateId, hashString } from './auth';
import type { AuthContext, Env, PublicAuthContext, QualityTier } from './types';
import {
  generationCreditCost,
  normalizeGenerationBillingOperation,
  normalizeQualityTier,
  type GenerationBillingOperation,
} from './tiers';
import { createProviderSession, markProviderSessionsForCharge } from './providerSessions';
import { enforceAnonymousRookieTurnstile } from './turnstile';
import {
  CURRENT_LEGAL_VERSION,
  parseCheckoutLegalAttestation,
  parseGenerationLegalAttestation,
  prepareLegalAcceptance,
  type GenerationLegalAttestation,
} from './legal';
import {
  readJsonBody,
  readRequestText,
  RequestBodyTooLargeError,
} from './requestBody';

const FREE_ROOKIE_GENERATION_LIMIT = 1;
const GENERATION_RESERVATION_TTL_HOURS = 12;
const STRIPE_API_VERSION = '2026-02-25.clover';
const STRIPE_FETCH_TIMEOUT_MS = 15_000;
const STRIPE_FETCH_MAX_ATTEMPTS = 2;
const MAX_BILLING_JSON_BODY_BYTES = 16 * 1024;
const MAX_STRIPE_WEBHOOK_BODY_BYTES = 1024 * 1024;

interface CreditPack {
  id: string;
  label: string;
  credits: number;
  amountCents: number;
  currency: 'eur';
  priceBinding: 'STRIPE_PRICE_STARTER' | 'STRIPE_PRICE_VERSUS' | 'STRIPE_PRICE_ARCADE';
}

interface GenerationCharge {
  id: string;
  user_id: string;
  tier: QualityTier;
  credit_cost: number;
  free_quota_delta: number;
  // `refunded` is the legacy persisted name for a pre-provider release.
  status: 'reserved' | 'committed' | 'refunded';
  reason: string;
  fighter_id: string | null;
  ledger_id: string | null;
  refund_ledger_id: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface GenerationPurchaseSettlement {
  purchaseId: string;
  status: GenerationCharge['status'];
  creditsCharged: number;
  fighterId: string | null;
}

interface CheckoutCreditExpectation {
  userId: string;
  packId: string;
  credits: number;
  amountCents: number;
  currency: string;
  stripeAccountId: string;
  legalVersion: string;
  customerId: string;
  paymentIntentId: string;
}

interface CheckoutAdjustmentRow {
  id: string;
  stripe_session_id: string;
  stripe_payment_intent_id: string | null;
  user_id: string;
  pack_id: string;
  credits: number;
  amount_cents: number;
  currency: string;
  status: string;
  legal_version: string;
  stripe_customer_id: string | null;
  refunded_amount_cents: number;
  refunded_credits: number;
  disputed_amount_cents: number;
  disputed_credits: number;
  reversed_credits: number;
  dispute_event_created: number;
}

type StripeCreditStatus = 'credited' | 'duplicate' | 'reversed' | 'restored' | 'ignored' | null;

const CREDIT_PACKS: Record<string, CreditPack> = {
  starter: {
    id: 'starter',
    label: 'Starter Pack',
    credits: 11,
    amountCents: 1499,
    currency: 'eur',
    priceBinding: 'STRIPE_PRICE_STARTER',
  },
  versus: {
    id: 'versus',
    label: 'Versus Pack',
    credits: 20,
    amountCents: 2499,
    currency: 'eur',
    priceBinding: 'STRIPE_PRICE_VERSUS',
  },
  arcade: {
    id: 'arcade',
    label: 'Arcade Pack',
    credits: 47,
    amountCents: 5699,
    currency: 'eur',
    priceBinding: 'STRIPE_PRICE_ARCADE',
  },
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export function creditPacksResponse(): Response {
  return json({
    packs: Object.values(CREDIT_PACKS).map(({ priceBinding: _priceBinding, ...pack }) => pack),
  });
}

function reservationExpiresAt(): string {
  return new Date(Date.now() + GENERATION_RESERVATION_TTL_HOURS * 60 * 60 * 1000).toISOString();
}

async function getGenerationCharge(env: Env, userId: string, chargeId: string): Promise<GenerationCharge | null> {
  return env.DB.prepare(
    'SELECT * FROM generation_charges WHERE id = ? AND user_id = ?'
  ).bind(chargeId, userId).first<GenerationCharge>();
}

async function resolveOwnedFighterId(
  env: Env,
  userId: string,
  fighterId: string | null | undefined,
): Promise<string | null | Response> {
  const normalized = fighterId?.trim();
  if (!normalized) return null;

  const fighter = await env.DB.prepare(
    'SELECT id FROM fighters WHERE id = ? AND owner_user_id = ?'
  ).bind(normalized, userId).first<{ id: string }>();
  if (!fighter) return json({ error: 'Fighter does not belong to this user' }, 403);
  return fighter.id;
}

function isResponse(value: string | null | Response): value is Response {
  return value instanceof Response;
}

function providerSessionPurposeForOperation(
  operation: GenerationBillingOperation,
): 'fighter_generation' | 'fighter_retry' | 'fighter_upgrade' {
  if (operation === 'fighter_upgrade') return 'fighter_upgrade';
  if (operation === 'fighter_retry_animation' || operation === 'fighter_retry_source') {
    return 'fighter_retry';
  }
  return 'fighter_generation';
}

// `refunded` is the historical D1 enum for an unused reservation release. This
// path never asks Stripe to return money and is reachable only before provider
// processing commits the charge.
async function releaseReservedGenerationCharge(
  env: Env,
  charge: GenerationCharge,
  releaseReason = 'generation_reservation_release',
): Promise<boolean> {
  if (charge.status !== 'reserved') return false;

  const releaseLedgerId = generateId();
  const [claim] = await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO credit_ledger (id, user_id, delta, reason, fighter_id)
      SELECT ?, user_id, credit_cost, ?, fighter_id
      FROM generation_charges
      WHERE id = ? AND user_id = ? AND status = 'reserved'
      RETURNING id
    `).bind(releaseLedgerId, `${releaseReason}:${charge.id}`, charge.id, charge.user_id),
    env.DB.prepare(`
      UPDATE users
      SET credits_balance = credits_balance + COALESCE(
            (SELECT delta FROM credit_ledger WHERE id = ?),
            0
          ),
          free_rookie_generations_used = CASE
            WHEN free_rookie_generations_used >= COALESCE(
              (SELECT free_quota_delta FROM generation_charges
               WHERE id = ? AND user_id = ? AND status = 'reserved'),
              0
            ) THEN free_rookie_generations_used - COALESCE(
              (SELECT free_quota_delta FROM generation_charges
               WHERE id = ? AND user_id = ? AND status = 'reserved'),
              0
            )
              ELSE 0
          END,
          updated_at = datetime('now')
      WHERE id = ? AND EXISTS (
        SELECT 1 FROM credit_ledger WHERE id = ?
      )
    `).bind(
      releaseLedgerId,
      charge.id,
      charge.user_id,
      charge.id,
      charge.user_id,
      charge.user_id,
      releaseLedgerId,
    ),
    env.DB.prepare(`
      UPDATE generation_charges
      SET status = 'refunded',
          refund_ledger_id = ?,
          updated_at = datetime('now')
      WHERE id = ? AND user_id = ? AND status = 'reserved' AND EXISTS (
        SELECT 1 FROM credit_ledger WHERE id = ?
      )
    `).bind(releaseLedgerId, charge.id, charge.user_id, releaseLedgerId),
  ]);

  return Boolean(claim.results?.[0]);
}

async function createProviderSessionForCharge(
  env: Env,
  auth: PublicAuthContext,
  tier: QualityTier,
  operation: GenerationBillingOperation,
  chargeId: string,
  legal: GenerationLegalAttestation,
) {
  try {
    return await createProviderSession(env, auth, {
      tier,
      purpose: providerSessionPurposeForOperation(operation),
      operation,
      chargeId,
      legal,
    });
  } catch (err) {
    const userId = auth.user?.id;
    const charge = userId ? await getGenerationCharge(env, userId, chargeId) : null;
    if (charge) {
      await releaseReservedGenerationCharge(env, charge, 'provider_session_failed');
    }
    throw err;
  }
}

export async function releaseExpiredGenerationCharges(env: Env, userId: string): Promise<void> {
  const { results } = await env.DB.prepare(`
    SELECT * FROM generation_charges
    WHERE user_id = ? AND status = 'reserved' AND datetime(expires_at) <= datetime('now')
    LIMIT 20
  `).bind(userId).all<GenerationCharge>();

  for (const charge of results ?? []) {
    await releaseReservedGenerationCharge(env, charge, 'generation_reservation_expired');
  }
}

function getClientBaseUrl(request: Request, env: Env): string {
  const requestOrigin = request.headers.get('Origin')?.replace(/\/+$/, '') ?? '';
  const configured = env.CORS_ORIGIN
    ?.split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean) ?? [];
  if (requestOrigin && configured.includes(requestOrigin)) return requestOrigin;
  if (configured.length > 0) return configured[0];
  const url = new URL(request.url);
  return url.origin;
}

function appendForm(params: URLSearchParams, key: string, value: string | number | null | undefined): void {
  if (value === null || value === undefined) return;
  params.append(key, String(value));
}

function isRetryableStripeStatus(status: number): boolean {
  return status === 409 || status >= 500;
}

class StripeCheckoutConfigurationError extends Error {}

function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

async function stripeFetch(
  url: string,
  init: RequestInit = {},
  retrySafe = false,
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= STRIPE_FETCH_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(STRIPE_FETCH_TIMEOUT_MS),
      });
      if (!retrySafe || attempt === STRIPE_FETCH_MAX_ATTEMPTS || !isRetryableStripeStatus(response.status)) {
        return response;
      }
      await response.body?.cancel();
    } catch (error) {
      lastError = error;
      if (!retrySafe || attempt === STRIPE_FETCH_MAX_ATTEMPTS) throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Stripe request failed');
}

function billingConfigurationError(env: Env): string | null {
  const stripeSecret = env.STRIPE_SECRET_KEY ?? '';
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET ?? '';
  const accountId = env.STRIPE_ACCOUNT_ID ?? '';
  const priceIds = [env.STRIPE_PRICE_STARTER, env.STRIPE_PRICE_VERSUS, env.STRIPE_PRICE_ARCADE];
  if (
    !/^sk_(live|test)_/i.test(stripeSecret) || !/^whsec_/i.test(webhookSecret) ||
    !/^acct_[A-Za-z0-9]+$/.test(accountId) || priceIds.some((priceId) => !/^price_[A-Za-z0-9]+$/.test(priceId ?? ''))
  ) {
    return 'Billing is not configured';
  }
  if (env.ENVIRONMENT === 'production' && !/^sk_live_/i.test(stripeSecret)) {
    return 'Billing is not configured for production';
  }
  return null;
}

async function verifyStripeCheckoutConfiguration(env: Env, pack: CreditPack): Promise<string> {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_ACCOUNT_ID) {
    throw new Error('Stripe account pinning is not configured');
  }
  const res = await stripeFetch('https://api.stripe.com/v1/account', {
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Stripe-Version': STRIPE_API_VERSION,
    },
  }, true);
  const body = await res.json().catch(() => ({})) as {
    id?: string;
    details_submitted?: boolean;
    charges_enabled?: boolean;
    business_profile?: {
      name?: string | null;
      support_email?: string | null;
      support_phone?: string | null;
      support_url?: string | null;
      url?: string | null;
    };
  };
  if (!res.ok || body.id !== env.STRIPE_ACCOUNT_ID) {
    throw new Error('Stripe credentials do not match the configured Insert Player account');
  }
  const profile = body.business_profile;
  if (
    body.details_submitted !== true ||
    body.charges_enabled !== true ||
    !String(profile?.name ?? '').toLowerCase().includes('insert player') ||
    !isHttpsUrl(profile?.url) ||
    !(
      isHttpsUrl(profile?.support_url) ||
      String(profile?.support_email ?? '').trim() ||
      String(profile?.support_phone ?? '').trim()
    )
  ) {
    throw new StripeCheckoutConfigurationError(
      'Credit checkout is temporarily unavailable while billing setup is being completed.',
    );
  }

  const priceId = env[pack.priceBinding];
  if (!priceId) throw new Error('Stripe pack price is not configured');
  const priceRes = await stripeFetch(`https://api.stripe.com/v1/prices/${encodeURIComponent(priceId)}?expand[]=product`, {
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Stripe-Version': STRIPE_API_VERSION,
    },
  }, true);
  const price = await priceRes.json().catch(() => ({})) as {
    id?: string;
    active?: boolean;
    currency?: string;
    unit_amount?: number;
    tax_behavior?: string;
    product?: { metadata?: Record<string, string>; tax_code?: string | { id?: string } };
  };
  const productTaxCode = typeof price.product?.tax_code === 'string'
    ? price.product.tax_code
    : price.product?.tax_code?.id;
  if (
    !priceRes.ok || price.id !== priceId || price.active !== true ||
    price.currency?.toLowerCase() !== pack.currency || price.unit_amount !== pack.amountCents ||
    price.tax_behavior !== 'inclusive' || productTaxCode !== 'txcd_10201000' ||
    price.product?.metadata?.insert_player_pack_id !== pack.id
  ) {
    throw new Error(`Stripe price configuration is invalid for ${pack.id}`);
  }
  return priceId;
}

async function createStripeCheckoutSession(
  env: Env,
  params: URLSearchParams,
  sessionToken: string,
): Promise<{ id: string; url: string | null }> {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not configured');
  }

  const res = await stripeFetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': `insert-player-checkout-${sessionToken}`,
      'Stripe-Version': STRIPE_API_VERSION,
    },
    body: params,
  }, true);

  const body = await res.json().catch(() => ({})) as {
    id?: string;
    url?: string;
    error?: { message?: string };
  };
  if (!res.ok || !body.id) {
    throw new Error(body.error?.message ?? `Stripe checkout failed (${res.status})`);
  }
  return { id: body.id, url: body.url ?? null };
}

async function ensureStripeCustomer(env: Env, auth: AuthContext): Promise<string> {
  const current = await env.DB.prepare(
    'SELECT stripe_customer_id FROM users WHERE id = ?'
  ).bind(auth.userId).first<{ stripe_customer_id: string | null }>();
  if (/^cus_[A-Za-z0-9]+$/.test(current?.stripe_customer_id ?? '')) {
    return current!.stripe_customer_id!;
  }
  if (!env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not configured');

  const form = new URLSearchParams();
  appendForm(form, 'email', auth.user.email);
  appendForm(form, 'metadata[insert_player_project]', 'insert-player');
  appendForm(form, 'metadata[user_id]', auth.userId);
  const userHash = await hashString(auth.userId);
  const res = await stripeFetch('https://api.stripe.com/v1/customers', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': `insert-player-customer-${userHash}`,
      'Stripe-Version': STRIPE_API_VERSION,
    },
    body: form,
  }, true);
  const customer = await res.json().catch(() => ({})) as { id?: string; error?: { message?: string } };
  if (!res.ok || !/^cus_[A-Za-z0-9]+$/.test(customer.id ?? '')) {
    throw new Error(customer.error?.message ?? `Stripe customer creation failed (${res.status})`);
  }

  await env.DB.prepare(`
    UPDATE users
    SET stripe_customer_id = COALESCE(stripe_customer_id, ?),
        updated_at = datetime('now')
    WHERE id = ?
  `).bind(customer.id, auth.userId).run();
  const linked = await env.DB.prepare(
    'SELECT stripe_customer_id FROM users WHERE id = ?'
  ).bind(auth.userId).first<{ stripe_customer_id: string | null }>();
  if (!/^cus_[A-Za-z0-9]+$/.test(linked?.stripe_customer_id ?? '')) {
    throw new Error('Stripe customer could not be linked to the player account');
  }
  return linked!.stripe_customer_id!;
}

export async function createCreditCheckoutSession(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  const body = await readJsonBody<{ packId?: string; legal?: unknown }>(request, MAX_BILLING_JSON_BODY_BYTES);
  const pack = CREDIT_PACKS[body.packId ?? 'starter'];
  if (!pack) return json({ error: 'Unknown credit pack' }, 400);
  const legal = parseCheckoutLegalAttestation(body.legal);
  if (!legal) return json({ error: 'Current checkout consent is required' }, 428);
  const billingError = billingConfigurationError(env);
  if (billingError) return json({ error: billingError }, 503);

  const baseUrl = getClientBaseUrl(request, env);
  const sessionToken = generateId();
  const form = new URLSearchParams();
  appendForm(form, 'mode', 'payment');
  appendForm(form, 'payment_method_types[0]', 'card');
  appendForm(form, 'billing_address_collection', 'auto');
  appendForm(form, 'automatic_tax[enabled]', 'true');
  appendForm(form, 'consent_collection[terms_of_service]', 'none');
  appendForm(form, 'client_reference_id', auth.userId);
  appendForm(form, 'success_url', `${baseUrl}/menu?checkout=success&session_id={CHECKOUT_SESSION_ID}`);
  appendForm(form, 'cancel_url', `${baseUrl}/menu?checkout=cancelled`);
  const checkoutMetadata = {
    user_id: auth.userId,
    pack_id: pack.id,
    credits: String(pack.credits),
    session_token: sessionToken,
    stripe_account_id: env.STRIPE_ACCOUNT_ID,
    legal_version: legal.legalVersion,
    terms_accepted: 'true',
    immediate_delivery_confirmed: 'true',
    withdrawal_loss_acknowledged: 'true',
  };
  for (const [key, value] of Object.entries(checkoutMetadata)) {
    appendForm(form, `metadata[${key}]`, value);
    appendForm(form, `payment_intent_data[metadata][${key}]`, value);
  }
  appendForm(form, 'line_items[0][quantity]', 1);
  let stripePriceId: string;
  try {
    stripePriceId = await verifyStripeCheckoutConfiguration(env, pack);
  } catch (err) {
    if (err instanceof StripeCheckoutConfigurationError) {
      return json({ error: err.message }, 503);
    }
    throw err;
  }
  const stripeCustomerId = await ensureStripeCustomer(env, auth);
  appendForm(form, 'customer', stripeCustomerId);
  appendForm(form, 'customer_update[address]', 'auto');
  appendForm(form, 'line_items[0][price]', stripePriceId);

  const pendingStripeSessionId = `pending:${sessionToken}`;
  const checkoutStatement = env.DB.prepare(`
    INSERT INTO checkout_sessions (
      id, stripe_session_id, user_id, pack_id, credits, amount_cents, currency, status,
      legal_version, terms_accepted, immediate_delivery_confirmed, withdrawal_loss_acknowledged,
      stripe_customer_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, 1, 1, 1, ?)
  `).bind(
    sessionToken,
    pendingStripeSessionId,
    auth.userId,
    pack.id,
    pack.credits,
    pack.amountCents,
    pack.currency,
    legal.legalVersion,
    stripeCustomerId,
  );
  const checkoutAuth: PublicAuthContext = {
    userId: auth.userId,
    rateLimitKey: `user:${auth.userId}`,
    user: auth.user,
    claims: auth.claims,
  };
  const acceptanceStatement = await prepareLegalAcceptance(
    env,
    checkoutAuth,
    'credit_checkout',
    legal,
    sessionToken,
  );
  await env.DB.batch([checkoutStatement, acceptanceStatement]);

  let checkout: { id: string; url: string | null };
  try {
    checkout = await createStripeCheckoutSession(env, form, sessionToken);
  } catch (err) {
    try {
      await env.DB.prepare(`
        UPDATE checkout_sessions
        SET status = 'failed',
            updated_at = datetime('now')
        WHERE id = ? AND stripe_session_id = ? AND status = 'open'
      `).bind(sessionToken, pendingStripeSessionId).run();
    } catch (updateErr) {
      console.warn('Failed to mark checkout session as failed:', updateErr instanceof Error ? updateErr.message : updateErr);
    }
    throw err;
  }

  try {
    await env.DB.prepare(`
      UPDATE checkout_sessions
      SET stripe_session_id = ?,
          updated_at = datetime('now')
      WHERE id = ? AND stripe_session_id = ? AND status = 'open'
    `).bind(checkout.id, sessionToken, pendingStripeSessionId).run();
  } catch (err) {
    console.warn('Failed to attach Stripe checkout id to local session:', err instanceof Error ? err.message : err);
  }

  return json({ checkoutUrl: checkout.url, sessionId: checkout.id, pack });
}

export async function authorizeGenerationPurchase(
  request: Request,
  env: Env,
  auth: PublicAuthContext,
): Promise<Response> {
  const body = await readJsonBody<{
    tier?: QualityTier;
    fighterId?: string;
    operation?: GenerationBillingOperation;
    reason?: string;
    turnstileToken?: string;
    legal?: unknown;
  }>(request, MAX_BILLING_JSON_BODY_BYTES);
  const tier = normalizeQualityTier(body.tier);
  const operation = normalizeGenerationBillingOperation(body.operation, body.reason);
  const requiredCredits = generationCreditCost(tier, operation);
  const legal = parseGenerationLegalAttestation(body.legal);
  if (!legal) return json({ error: 'Current generation consent is required' }, 428);

  if (!auth.user) {
    if (tier === 'rookie' && operation === 'fighter_generation') {
      const turnstileError = await enforceAnonymousRookieTurnstile(request, env, body.turnstileToken);
      if (turnstileError) return turnstileError;
      const providerSession = await createProviderSession(env, auth, {
        tier,
        purpose: 'fighter_generation',
        legal,
      });
      return json({
        authorized: true,
        mode: 'anonymous_rookie',
        creditsCharged: 0,
        providerSessionId: providerSession.id,
        providerSessionExpiresAt: providerSession.expiresAt,
        providerCallLimit: providerSession.providerCallLimit,
        message: 'Anonymous Rookie generation allowed after human verification.',
      });
    }
    return json({
      authorized: false,
      error: 'Sign in to generate paid tiers',
      requiredCredits,
    }, 401);
  }

  await releaseExpiredGenerationCharges(env, auth.user.id);
  const user = (await env.DB.prepare(
    'SELECT * FROM users WHERE id = ?'
  ).bind(auth.user.id).first<typeof auth.user>()) ?? auth.user;
  const ownedFighterId = await resolveOwnedFighterId(env, auth.user.id, body.fighterId);
  if (isResponse(ownedFighterId)) return ownedFighterId;
  if (operation !== 'fighter_generation' && !ownedFighterId) {
    return json({ error: 'This operation requires an owned fighter' }, 400);
  }

  if (
    operation === 'fighter_generation' &&
    tier === 'rookie' &&
    user.free_rookie_generations_used < FREE_ROOKIE_GENERATION_LIMIT
  ) {
    const purchaseId = generateId();
    const ledgerId = generateId();
    const expiresAt = reservationExpiresAt();
    const reason = operation;
    const [quotaResult] = await env.DB.batch([
      env.DB.prepare(`
        UPDATE users
        SET free_rookie_generations_used = free_rookie_generations_used + 1,
            updated_at = datetime('now')
        WHERE id = ? AND free_rookie_generations_used < ?
        RETURNING free_rookie_generations_used
      `).bind(user.id, FREE_ROOKIE_GENERATION_LIMIT),
      env.DB.prepare(`
        INSERT INTO credit_ledger (id, user_id, delta, reason, fighter_id)
        SELECT ?, id, 0, ?, ?
        FROM users
        WHERE id = ? AND changes() = 1
      `).bind(ledgerId, reason, ownedFighterId, user.id),
      env.DB.prepare(`
        INSERT INTO generation_charges (
          id, user_id, tier, credit_cost, free_quota_delta, status,
          reason, fighter_id, ledger_id, expires_at
        )
        SELECT ?, user_id, ?, 0, 1, 'reserved', ?, ?, id, ?
        FROM credit_ledger
        WHERE id = ? AND user_id = ?
      `).bind(
        purchaseId,
        tier,
        reason,
        ownedFighterId,
        expiresAt,
        ledgerId,
        user.id,
      ),
    ]);
    const quota = quotaResult.results?.[0] as { free_rookie_generations_used: number } | undefined;

    if (quota) {
      const providerSession = await createProviderSessionForCharge(
        env,
        auth,
        tier,
        operation,
        purchaseId,
        legal,
      );
      return json({
        authorized: true,
        mode: 'free_rookie',
        purchaseId,
        creditsCharged: 0,
        providerSessionId: providerSession.id,
        providerSessionExpiresAt: providerSession.expiresAt,
        providerCallLimit: providerSession.providerCallLimit,
        reservationExpiresAt: expiresAt,
        freeRookieGenerationsRemaining: Math.max(0, FREE_ROOKIE_GENERATION_LIMIT - quota.free_rookie_generations_used),
      });
    }
  }

  const purchaseId = generateId();
  const ledgerId = generateId();
  const expiresAt = reservationExpiresAt();
  const reason = operation;
  const [spendResult] = await env.DB.batch([
    env.DB.prepare(`
      UPDATE users
      SET credits_balance = credits_balance - ?,
          updated_at = datetime('now')
      WHERE id = ? AND credits_balance >= ?
      RETURNING credits_balance
    `).bind(requiredCredits, user.id, requiredCredits),
    env.DB.prepare(`
      INSERT INTO credit_ledger (id, user_id, delta, reason, fighter_id)
      SELECT ?, id, ?, ?, ?
      FROM users
      WHERE id = ? AND changes() = 1
    `).bind(
      ledgerId,
      -requiredCredits,
      reason,
      ownedFighterId,
      user.id,
    ),
    env.DB.prepare(`
      INSERT INTO generation_charges (
        id, user_id, tier, credit_cost, free_quota_delta, status,
        reason, fighter_id, ledger_id, expires_at
      )
      SELECT ?, user_id, ?, ?, 0, 'reserved', ?, ?, id, ?
      FROM credit_ledger
      WHERE id = ? AND user_id = ?
    `).bind(
      purchaseId,
      tier,
      requiredCredits,
      reason,
      ownedFighterId,
      expiresAt,
      ledgerId,
      user.id,
    ),
  ]);
  const spend = spendResult.results?.[0] as { credits_balance: number } | undefined;

  if (!spend) {
    const latest = await env.DB.prepare(
      'SELECT credits_balance FROM users WHERE id = ?'
    ).bind(user.id).first<{ credits_balance: number }>();
    return json({
      authorized: false,
      error: 'Not enough credits',
      requiredCredits,
      creditsBalance: latest?.credits_balance ?? user.credits_balance,
    }, 402);
  }

  const providerSession = await createProviderSessionForCharge(
    env,
    auth,
    tier,
    operation,
    purchaseId,
    legal,
  );

  return json({
    authorized: true,
    mode: 'credits',
    purchaseId,
    creditsCharged: requiredCredits,
    creditsBalance: spend.credits_balance,
    providerSessionId: providerSession.id,
    providerSessionExpiresAt: providerSession.expiresAt,
    providerCallLimit: providerSession.providerCallLimit,
    reservationExpiresAt: expiresAt,
  });
}

export async function completeGenerationPurchase(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  const body = await readJsonBody<{
    purchaseId?: string;
    success?: boolean;
    fighterId?: string | null;
  }>(request, MAX_BILLING_JSON_BODY_BYTES);
  const purchaseId = body.purchaseId?.trim();
  if (!purchaseId) return json({ error: 'purchaseId is required' }, 400);
  const ownedFighterId = await resolveOwnedFighterId(env, auth.userId, body.fighterId);
  if (isResponse(ownedFighterId)) return ownedFighterId;

  const charge = await getGenerationCharge(env, auth.userId, purchaseId);
  if (!charge) return json({ error: 'Generation purchase not found' }, 404);
  const durableJob = await env.DB.prepare(
    'SELECT status FROM generation_jobs WHERE id = ?'
  ).bind(purchaseId).first<{ status: string }>();
  if (durableJob) {
    return json({
      error: 'This generation purchase is settled by its cloud job',
      code: 'durable_generation_settlement_managed',
      jobStatus: durableJob.status,
    }, 409);
  }
  const settlement = await settleGenerationPurchase(
    env,
    auth.userId,
    purchaseId,
    Boolean(body.success),
    ownedFighterId,
  );
  if (!settlement) return json({ error: 'Generation purchase not found' }, 404);
  if (body.success || settlement.status !== 'refunded') return json(settlement);

  const latest = await env.DB.prepare(
    'SELECT credits_balance, free_rookie_generations_used FROM users WHERE id = ?'
  ).bind(auth.userId).first<{ credits_balance: number; free_rookie_generations_used: number }>();

  return json({
    ...settlement,
    status: 'released',
    reservationReleased: true,
    creditsReleased: settlement.creditsCharged,
    creditsBalance: latest?.credits_balance ?? auth.user.credits_balance,
    freeRookieGenerationsUsed: latest?.free_rookie_generations_used ?? auth.user.free_rookie_generations_used,
  });
}

export async function settleGenerationPurchase(
  env: Env,
  userId: string,
  purchaseId: string,
  success: boolean,
  fighterId: string | null,
  successStatements: D1PreparedStatement[] = [],
): Promise<GenerationPurchaseSettlement | null> {
  let charge = await getGenerationCharge(env, userId, purchaseId);
  if (!charge) return null;

  if (success) {
    if (charge.status === 'reserved') {
      await env.DB.batch([
        env.DB.prepare(`
          UPDATE generation_charges
          SET status = 'committed',
              fighter_id = COALESCE(?, fighter_id),
              updated_at = datetime('now')
          WHERE id = ? AND user_id = ? AND status = 'reserved'
          RETURNING id
        `).bind(fighterId, charge.id, userId),
        env.DB.prepare(`
          UPDATE credit_ledger
          SET fighter_id = COALESCE(?, fighter_id)
          WHERE id = ? AND user_id = ? AND EXISTS (
            SELECT 1 FROM generation_charges
            WHERE id = ? AND user_id = ? AND status = 'committed'
          )
        `).bind(fighterId, charge.ledger_id, userId, charge.id, userId),
        ...successStatements,
      ]);
      charge = (await getGenerationCharge(env, userId, purchaseId)) ?? charge;
    } else if (charge.status === 'committed') {
      const statements: D1PreparedStatement[] = [];
      if (fighterId && !charge.fighter_id) {
        statements.push(env.DB.prepare(`
          UPDATE generation_charges
          SET fighter_id = ?, updated_at = datetime('now')
          WHERE id = ? AND user_id = ? AND fighter_id IS NULL
        `).bind(fighterId, charge.id, userId));
        statements.push(env.DB.prepare(`
          UPDATE credit_ledger
          SET fighter_id = COALESCE(?, fighter_id)
          WHERE id = ? AND user_id = ?
        `).bind(fighterId, charge.ledger_id, userId));
      }
      statements.push(...successStatements);
      if (statements.length > 0) await env.DB.batch(statements);
      charge = (await getGenerationCharge(env, userId, purchaseId)) ?? charge;
    }
    if (charge.status === 'committed') {
      await markProviderSessionsForCharge(env, userId, charge.id, 'completed');
    }
  } else if (charge.status === 'reserved') {
    await releaseReservedGenerationCharge(env, charge);
    charge = (await getGenerationCharge(env, userId, purchaseId)) ?? charge;
  }
  if (!success && charge.status === 'refunded') {
    await markProviderSessionsForCharge(env, userId, charge.id, 'cancelled');
  }

  return {
    purchaseId: charge.id,
    status: charge.status,
    creditsCharged: charge.credit_cost,
    fighterId: fighterId ?? charge.fighter_id,
  };
}

function parseStripeSignature(header: string): { timestamp: string; signatures: string[] } | null {
  const parts = header.split(',').map((part) => part.trim());
  let timestamp = '';
  const signatures: string[] = [];
  for (const part of parts) {
    const [key, value] = part.split('=');
    if (key === 't' && value) timestamp = value;
    if (key === 'v1' && value) signatures.push(value);
  }
  if (!timestamp || signatures.length === 0) return null;
  return { timestamp, signatures };
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function verifyStripeWebhook(request: Request, env: Env): Promise<Record<string, any>> {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
  }
  const signatureHeader = request.headers.get('Stripe-Signature');
  if (!signatureHeader) throw new Error('Missing Stripe-Signature header');
  const parsed = parseStripeSignature(signatureHeader);
  if (!parsed) throw new Error('Invalid Stripe-Signature header');

  const timestampMs = Number(parsed.timestamp) * 1000;
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60 * 1000) {
    throw new Error('Stripe webhook timestamp outside tolerance');
  }

  const rawBody = await readRequestText(request, MAX_STRIPE_WEBHOOK_BODY_BYTES);
  const expected = await hmacSha256Hex(env.STRIPE_WEBHOOK_SECRET, `${parsed.timestamp}.${rawBody}`);
  if (!parsed.signatures.some((sig) => constantTimeEqual(sig, expected))) {
    throw new Error('Stripe webhook signature mismatch');
  }
  return JSON.parse(rawBody) as Record<string, any>;
}

function readStripeInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function readStripeMetadata(session: Record<string, any>): Record<string, unknown> {
  return session.metadata && typeof session.metadata === 'object' ? session.metadata : {};
}

function checkoutCreditExpectation(
  session: Record<string, any>,
  expectedStripeAccountId: string,
): CheckoutCreditExpectation | null {
  const metadata = readStripeMetadata(session);
  const userId = String(metadata.user_id ?? session.client_reference_id ?? '').trim();
  const packId = String(metadata.pack_id ?? '').trim();
  const credits = readStripeInteger(metadata.credits);
  const amountCents = readStripeInteger(session.amount_total);
  const currency = String(session.currency ?? '').trim().toLowerCase();
  const stripeAccountId = String(metadata.stripe_account_id ?? '').trim();
  const legalVersion = String(metadata.legal_version ?? '').trim();
  const customerId = typeof session.customer === 'string' ? session.customer.trim() : '';
  const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent.trim() : '';
  if (
    !userId || !packId || credits === null || amountCents === null || !currency ||
    !stripeAccountId || stripeAccountId !== expectedStripeAccountId ||
    !/^\d{4}-\d{2}-\d{2}(?:\.\d+)?$/.test(legalVersion) || metadata.terms_accepted !== 'true' ||
    metadata.immediate_delivery_confirmed !== 'true' ||
    metadata.withdrawal_loss_acknowledged !== 'true' ||
    !/^cus_[A-Za-z0-9]+$/.test(customerId) ||
    !/^pi_[A-Za-z0-9]+$/.test(paymentIntentId)
  ) return null;
  return {
    userId,
    packId,
    credits,
    amountCents,
    currency,
    stripeAccountId,
    legalVersion,
    customerId,
    paymentIntentId,
  };
}

export function creditsForStripeAdjustment(
  purchasedCredits: number,
  adjustedAmountCents: number,
  purchaseAmountCents: number,
): number {
  if (
    !Number.isInteger(purchasedCredits) || purchasedCredits <= 0 ||
    !Number.isInteger(adjustedAmountCents) || adjustedAmountCents <= 0 ||
    !Number.isInteger(purchaseAmountCents) || purchaseAmountCents <= 0
  ) return 0;
  if (adjustedAmountCents >= purchaseAmountCents) return purchasedCredits;
  return Math.min(
    purchasedCredits,
    Math.ceil((purchasedCredits * adjustedAmountCents) / purchaseAmountCents),
  );
}

function isCreditedCheckoutStatus(status: string): boolean {
  return ['paid', 'partially_refunded', 'refunded', 'disputed'].includes(status);
}

function checkoutStatusAfterAdjustment(
  previousStatus: string,
  purchasedCredits: number,
  refundedCredits: number,
  disputedCredits: number,
): string {
  if (!isCreditedCheckoutStatus(previousStatus)) return previousStatus;
  if (disputedCredits > 0) return 'disputed';
  if (refundedCredits >= purchasedCredits) return 'refunded';
  if (refundedCredits > 0) return 'partially_refunded';
  return 'paid';
}

async function findCheckoutForStripeAdjustment(
  env: Env,
  sessionToken: string,
  paymentIntentId: string,
): Promise<CheckoutAdjustmentRow | null> {
  if (!sessionToken && !paymentIntentId) return null;
  return env.DB.prepare(`
    SELECT id, stripe_session_id, stripe_payment_intent_id, user_id, pack_id,
           credits, amount_cents, currency, status, legal_version, stripe_customer_id,
           refunded_amount_cents, refunded_credits, disputed_amount_cents,
           disputed_credits, reversed_credits, dispute_event_created
    FROM checkout_sessions
    WHERE (? <> '' AND id = ?)
       OR (? <> '' AND stripe_payment_intent_id = ?)
    ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
    LIMIT 1
  `).bind(
    sessionToken,
    sessionToken,
    paymentIntentId,
    paymentIntentId,
    sessionToken,
  ).first<CheckoutAdjustmentRow>();
}

function refundMetadataMatchesCheckout(
  row: CheckoutAdjustmentRow,
  charge: Record<string, any>,
  expectedStripeAccountId: string,
): boolean {
  const metadata = readStripeMetadata(charge);
  const customerId = typeof charge.customer === 'string' ? charge.customer.trim() : '';
  return metadata.session_token === row.id &&
    metadata.user_id === row.user_id &&
    metadata.pack_id === row.pack_id &&
    readStripeInteger(metadata.credits) === row.credits &&
    metadata.stripe_account_id === expectedStripeAccountId &&
    metadata.legal_version === row.legal_version &&
    metadata.terms_accepted === 'true' &&
    metadata.immediate_delivery_confirmed === 'true' &&
    metadata.withdrawal_loss_acknowledged === 'true' &&
    /^cus_[A-Za-z0-9]+$/.test(customerId) &&
    customerId === row.stripe_customer_id;
}

interface StripeAdjustmentSpec {
  eventId: string;
  eventCreated: number;
  kind: 'refund' | 'dispute';
  stripeObjectId: string;
  amountCents: number;
  targetCredits: number;
  state: string;
}

interface StripeAdjustmentResult {
  status: StripeCreditStatus;
  userId: string | null;
}

async function applyStripeCreditAdjustment(
  env: Env,
  initialRow: CheckoutAdjustmentRow,
  spec: StripeAdjustmentSpec,
): Promise<StripeAdjustmentResult> {
  let row: CheckoutAdjustmentRow | null = initialRow;

  for (let attempt = 0; attempt < 3 && row; attempt += 1) {
    const nextRefundedAmount = spec.kind === 'refund'
      ? Math.max(row.refunded_amount_cents, spec.amountCents)
      : row.refunded_amount_cents;
    const nextRefundedCredits = spec.kind === 'refund'
      ? Math.max(row.refunded_credits, spec.targetCredits)
      : row.refunded_credits;
    const staleDisputeEvent = spec.kind === 'dispute' && spec.eventCreated < row.dispute_event_created;
    if (staleDisputeEvent) return { status: 'ignored', userId: row.user_id };
    const nextDisputedAmount = spec.kind === 'dispute' ? spec.amountCents : row.disputed_amount_cents;
    const nextDisputedCredits = spec.kind === 'dispute' ? spec.targetCredits : row.disputed_credits;
    const nextDisputeEventCreated = spec.kind === 'dispute'
      ? Math.max(row.dispute_event_created, spec.eventCreated)
      : row.dispute_event_created;
    const nextReversedCredits = Math.max(nextRefundedCredits, nextDisputedCredits);
    const stateChanged = nextRefundedAmount !== row.refunded_amount_cents ||
      nextRefundedCredits !== row.refunded_credits ||
      nextDisputedAmount !== row.disputed_amount_cents ||
      nextDisputedCredits !== row.disputed_credits ||
      nextDisputeEventCreated !== row.dispute_event_created ||
      nextReversedCredits !== row.reversed_credits;
    if (!stateChanged) return { status: 'ignored', userId: row.user_id };

    const walletDelta = isCreditedCheckoutStatus(row.status)
      ? row.reversed_credits - nextReversedCredits
      : 0;
    const nextStatus = checkoutStatusAfterAdjustment(
      row.status,
      row.credits,
      nextRefundedCredits,
      nextDisputedCredits,
    );
    const updateStatement = env.DB.prepare(`
      UPDATE checkout_sessions
      SET refunded_amount_cents = ?,
          refunded_credits = ?,
          disputed_amount_cents = ?,
          disputed_credits = ?,
          reversed_credits = ?,
          dispute_event_created = ?,
          status = ?,
          updated_at = datetime('now')
      WHERE id = ?
        AND refunded_amount_cents = ?
        AND refunded_credits = ?
        AND disputed_amount_cents = ?
        AND disputed_credits = ?
        AND reversed_credits = ?
        AND dispute_event_created = ?
      RETURNING user_id
    `).bind(
      nextRefundedAmount,
      nextRefundedCredits,
      nextDisputedAmount,
      nextDisputedCredits,
      nextReversedCredits,
      nextDisputeEventCreated,
      nextStatus,
      row.id,
      row.refunded_amount_cents,
      row.refunded_credits,
      row.disputed_amount_cents,
      row.disputed_credits,
      row.reversed_credits,
      row.dispute_event_created,
    );
    const adjustmentId = `stripe-adjustment:${spec.eventId}`;
    const statements: D1PreparedStatement[] = [
      updateStatement,
      env.DB.prepare(`
        INSERT OR IGNORE INTO stripe_credit_adjustments (
          id, stripe_event_id, checkout_session_id, user_id, kind,
          stripe_object_id, amount_cents, credits_delta, state
        )
        SELECT ?, ?, id, user_id, ?, ?, ?, ?, ?
        FROM checkout_sessions
        WHERE id = ? AND changes() = 1
      `).bind(
        adjustmentId,
        spec.eventId,
        spec.kind,
        spec.stripeObjectId || null,
        spec.amountCents,
        walletDelta,
        spec.state,
        row.id,
      ),
    ];
    if (walletDelta !== 0) {
      const ledgerReason = spec.kind === 'refund'
        ? `stripe_refund:${row.stripe_session_id}`
        : walletDelta < 0
          ? `stripe_dispute_hold:${row.stripe_session_id}`
          : `stripe_dispute_release:${row.stripe_session_id}`;
      statements.push(
        env.DB.prepare(`
          INSERT OR IGNORE INTO credit_ledger (id, user_id, delta, reason, fighter_id)
          SELECT ?, user_id, credits_delta, ?, NULL
          FROM stripe_credit_adjustments
          WHERE stripe_event_id = ?
        `).bind(adjustmentId, ledgerReason, spec.eventId),
        env.DB.prepare(`
          UPDATE users
          SET credits_balance = credits_balance + COALESCE(
                (SELECT delta FROM credit_ledger WHERE id = ?),
                0
              ),
              updated_at = datetime('now')
          WHERE id = ? AND changes() = 1
        `).bind(adjustmentId, row.user_id),
      );
    }

    const results = await env.DB.batch(statements);
    if (results[0]?.results?.[0]) {
      return {
        status: walletDelta < 0 ? 'reversed' : walletDelta > 0 ? 'restored' : 'ignored',
        userId: row.user_id,
      };
    }
    row = await findCheckoutForStripeAdjustment(
      env,
      row.id,
      row.stripe_payment_intent_id ?? '',
    );
  }

  return { status: 'ignored', userId: row?.user_id ?? null };
}

async function processStripeRefundEvent(
  env: Env,
  eventId: string,
  eventCreated: number,
  charge: Record<string, any>,
  expectedStripeAccountId: string,
): Promise<StripeAdjustmentResult> {
  const metadata = readStripeMetadata(charge);
  const sessionToken = typeof metadata.session_token === 'string' ? metadata.session_token.trim() : '';
  const paymentIntentId = typeof charge.payment_intent === 'string' ? charge.payment_intent.trim() : '';
  const row = await findCheckoutForStripeAdjustment(env, sessionToken, paymentIntentId);
  const amountRefunded = readStripeInteger(charge.amount_refunded);
  const currency = String(charge.currency ?? '').trim().toLowerCase();
  if (
    !row || amountRefunded === null || currency !== row.currency.toLowerCase() ||
    !refundMetadataMatchesCheckout(row, charge, expectedStripeAccountId)
  ) return { status: 'ignored', userId: null };
  return applyStripeCreditAdjustment(env, row, {
    eventId,
    eventCreated,
    kind: 'refund',
    stripeObjectId: String(charge.id ?? ''),
    amountCents: Math.min(amountRefunded, row.amount_cents),
    targetCredits: creditsForStripeAdjustment(row.credits, amountRefunded, row.amount_cents),
    state: charge.refunded === true ? 'refunded' : 'partially_refunded',
  });
}

async function processStripeDisputeEvent(
  env: Env,
  eventId: string,
  eventCreated: number,
  dispute: Record<string, any>,
): Promise<StripeAdjustmentResult> {
  const paymentIntentId = typeof dispute.payment_intent === 'string' ? dispute.payment_intent.trim() : '';
  if (!/^pi_[A-Za-z0-9]+$/.test(paymentIntentId)) return { status: 'ignored', userId: null };
  const row = await findCheckoutForStripeAdjustment(env, '', paymentIntentId);
  const amount = readStripeInteger(dispute.amount);
  const currency = String(dispute.currency ?? '').trim().toLowerCase();
  const state = String(dispute.status ?? '').trim().toLowerCase();
  if (!row || amount === null || currency !== row.currency.toLowerCase() || !state) {
    return { status: 'ignored', userId: null };
  }
  const fundsRestored = state === 'won' || state === 'warning_closed';
  return applyStripeCreditAdjustment(env, row, {
    eventId,
    eventCreated,
    kind: 'dispute',
    stripeObjectId: String(dispute.id ?? ''),
    amountCents: fundsRestored ? 0 : Math.min(amount, row.amount_cents),
    targetCredits: fundsRestored
      ? 0
      : creditsForStripeAdjustment(row.credits, amount, row.amount_cents),
    state,
  });
}

function safeStripeAuditToken(value: unknown, maxLength = 255): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength && /^[A-Za-z0-9:._-]+$/.test(trimmed)
    ? trimmed
    : null;
}

export function stripeEventAuditPayload(
  event: Record<string, any>,
  accountId: string,
  creditStatus: StripeCreditStatus,
): string {
  const object = event.data?.object && typeof event.data.object === 'object'
    ? event.data.object as Record<string, unknown>
    : {};
  return JSON.stringify({
    accountId: safeStripeAuditToken(accountId),
    livemode: event.livemode === true,
    objectId: safeStripeAuditToken(object.id),
    objectType: safeStripeAuditToken(object.object, 64),
    paymentStatus: safeStripeAuditToken(object.payment_status ?? object.status, 32),
    creditStatus,
  });
}

async function creditPaidCheckoutSession(
  env: Env,
  stripeSessionId: string,
  sessionToken: string | null,
  expected: CheckoutCreditExpectation | null,
): Promise<'credited' | 'duplicate' | 'ignored'> {
  if (!expected) return 'ignored';
  const localSessionToken = sessionToken?.trim() ?? '';
  const ledgerId = generateId();
  const batchResults = await env.DB.batch([
    env.DB.prepare(`
      UPDATE checkout_sessions
      SET status = 'crediting',
          stripe_session_id = ?,
          stripe_customer_id = COALESCE(stripe_customer_id, ?),
          stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, ?),
          updated_at = datetime('now')
      WHERE (stripe_session_id = ? OR id = ?)
        AND status IN ('open', 'failed')
        AND user_id = ?
        AND pack_id = ?
        AND credits = ?
        AND amount_cents = ?
        AND lower(currency) = ?
        AND legal_version = ?
        AND terms_accepted = 1
        AND immediate_delivery_confirmed = 1
        AND withdrawal_loss_acknowledged = 1
        AND stripe_customer_id = ?
        AND (stripe_payment_intent_id IS NULL OR stripe_payment_intent_id = ?)
        AND EXISTS (
          SELECT 1 FROM users
          WHERE users.id = checkout_sessions.user_id
            AND users.stripe_customer_id = ?
        )
      RETURNING user_id, pack_id, credits
    `).bind(
      stripeSessionId,
      expected.customerId,
      expected.paymentIntentId,
      stripeSessionId,
      localSessionToken,
      expected.userId,
      expected.packId,
      expected.credits,
      expected.amountCents,
      expected.currency,
      expected.legalVersion,
      expected.customerId,
      expected.paymentIntentId,
      expected.customerId,
    ),
    env.DB.prepare(`
      INSERT OR IGNORE INTO credit_ledger (id, user_id, delta, reason, fighter_id, stripe_session_id)
      SELECT ?, user_id, MAX(credits - reversed_credits, 0),
             'stripe_credit_pack:' || COALESCE(pack_id, 'unknown'), NULL, ?
      FROM checkout_sessions
      WHERE stripe_session_id = ? AND status = 'crediting'
    `).bind(ledgerId, stripeSessionId, stripeSessionId),
    env.DB.prepare(`
      UPDATE users
      SET credits_balance = credits_balance + COALESCE((SELECT delta FROM credit_ledger WHERE id = ?), 0),
          updated_at = datetime('now')
      WHERE id = (SELECT user_id FROM credit_ledger WHERE id = ?)
    `).bind(ledgerId, ledgerId),
    env.DB.prepare(`
      UPDATE checkout_sessions
      SET status = CASE
            WHEN disputed_credits > 0 THEN 'disputed'
            WHEN refunded_credits >= credits THEN 'refunded'
            WHEN refunded_credits > 0 THEN 'partially_refunded'
            ELSE 'paid'
          END,
          updated_at = datetime('now')
      WHERE stripe_session_id = ? AND status = 'crediting' AND EXISTS (
        SELECT 1 FROM credit_ledger WHERE id = ?
      )
    `).bind(stripeSessionId, ledgerId),
  ]);
  const claimed = batchResults[0]?.results?.[0] as { user_id: string; pack_id: string; credits: number } | undefined;

  if (!claimed) {
    const existing = await env.DB.prepare(`
      SELECT status FROM checkout_sessions
      WHERE stripe_session_id = ? OR id = ?
      ORDER BY CASE WHEN stripe_session_id = ? THEN 0 ELSE 1 END
      LIMIT 1
    `).bind(stripeSessionId, localSessionToken, stripeSessionId).first<{ status: string }>();
    return ['paid', 'partially_refunded', 'refunded', 'disputed'].includes(existing?.status ?? '')
      ? 'duplicate'
      : 'ignored';
  }

  return 'credited';
}

export async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
  const expectedStripeAccountId = env.STRIPE_ACCOUNT_ID?.trim() ?? '';
  if (!/^acct_[A-Za-z0-9]+$/.test(expectedStripeAccountId)) {
    return json({ error: 'Billing is not configured' }, 503);
  }
  let event: Record<string, any>;
  try {
    event = await verifyStripeWebhook(request, env);
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      return json({ error: 'Request body is too large' }, 413);
    }
    const message = env.ENVIRONMENT === 'production'
      ? 'Webhook verification failed'
      : err instanceof Error ? err.message : 'Webhook verification failed';
    return json({ error: message }, 400);
  }

  const eventId = String(event.id ?? '');
  if (!eventId) return json({ error: 'Stripe event missing id' }, 400);
  const eventAccountId = typeof event.account === 'string' ? event.account.trim() : '';
  if (eventAccountId && eventAccountId !== expectedStripeAccountId) {
    return json({ error: 'Stripe event account mismatch' }, 400);
  }
  if (env.ENVIRONMENT === 'production' && event.livemode !== true) {
    return json({ error: 'Stripe test event rejected in production' }, 400);
  }
  const existing = await env.DB.prepare('SELECT id FROM stripe_events WHERE id = ?').bind(eventId).first<{ id: string }>();
  if (existing) return json({ received: true, duplicate: true });

  let creditStatus: StripeCreditStatus = null;
  let checkoutExpectation: CheckoutCreditExpectation | null = null;
  let linkedUserId: string | null = null;
  const eventCreated = readStripeInteger(event.created) ?? 0;
  if (event.type === 'checkout.session.completed') {
    const session = event.data?.object ?? {};
    const sessionId = String(session.id ?? '');
    const paymentStatus = String(session.payment_status ?? '');
    const sessionToken = typeof session.metadata?.session_token === 'string' ? session.metadata.session_token : null;
    checkoutExpectation = checkoutCreditExpectation(session, expectedStripeAccountId);
    if (sessionId && paymentStatus === 'paid') {
      creditStatus = await creditPaidCheckoutSession(
        env,
        sessionId,
        sessionToken,
        checkoutExpectation,
      );
      if (checkoutExpectation && (creditStatus === 'credited' || creditStatus === 'duplicate')) {
        linkedUserId = checkoutExpectation.userId;
      }
    }
  } else if (event.type === 'charge.refunded') {
    const adjustment = await processStripeRefundEvent(
      env,
      eventId,
      eventCreated,
      event.data?.object ?? {},
      expectedStripeAccountId,
    );
    creditStatus = adjustment.status;
    linkedUserId = adjustment.userId;
  } else if (event.type === 'charge.dispute.created' || event.type === 'charge.dispute.closed') {
    const adjustment = await processStripeDisputeEvent(
      env,
      eventId,
      eventCreated,
      event.data?.object ?? {},
    );
    creditStatus = adjustment.status;
    linkedUserId = adjustment.userId;
  }

  await env.DB.prepare(
    'INSERT OR IGNORE INTO stripe_events (id, type, payload, user_id) VALUES (?, ?, ?, ?)'
  ).bind(
    eventId,
    String(event.type ?? 'unknown'),
    stripeEventAuditPayload(event, eventAccountId || expectedStripeAccountId, creditStatus),
    linkedUserId,
  ).run();

  return json({ received: true, creditStatus });
}
