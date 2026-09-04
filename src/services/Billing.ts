import { apiFetch, type ApiRequestContext } from './ApiClient';
import type { GenerationBillingOperation, QualityTier } from './QualityTiers';
import type { GenerationCreationFlow } from './GenerationCreationFlow';
import {
  storedGenerationLegalAttestation,
  type CheckoutLegalAttestation,
  type GenerationLegalAttestation,
} from '../ui/legal.ts';
import { STAGE_FORGE_CREDIT_COST } from '../shared/StageForgePricing.ts';

export interface GenerationAuthorization {
  authorized: boolean;
  creationFlow?: GenerationCreationFlow;
  purchaseId?: string;
  providerSessionId?: string;
  providerSessionExpiresAt?: string;
  providerCallLimit?: number;
  providerCostLimitCents?: number;
  mode?: 'anonymous_rookie' | 'free_rookie' | 'credits' | 'continuation';
  artifactRunId?: string;
  resumedFromJobId?: string;
  message?: string;
  error?: string;
  requiredCredits?: number;
  creditsBalance?: number;
  reservationExpiresAt?: string;
}

export interface CreditPack {
  id: string;
  label: string;
  credits: number;
  amountCents: number;
  currency: string;
}

export interface BillingProfile {
  creditsBalance: number;
  freeRookieGenerationsUsed: number;
  planTier: 'free' | 'pro' | 'studio' | 'admin';
}

export type CreditCheckoutVerificationState = 'pending' | 'complete' | 'failed';

export interface CreditCheckoutVerification {
  sessionId: string;
  state: CreditCheckoutVerificationState;
  processorStatus: string;
  packId: string;
  credits: number;
  creditsBalance: number;
  updatedAt: string;
}

export interface CreditCheckoutVerificationResult {
  checkout?: CreditCheckoutVerification;
  error?: string;
  retryable?: boolean;
}

export interface CreditPackLoadResult {
  status: 'ready' | 'local' | 'unavailable';
  packs: CreditPack[];
  message?: string;
}

export interface BillingProfileLoadResult {
  status: 'ready' | 'signed-out' | 'local' | 'unavailable';
  profile: BillingProfile | null;
  message?: string;
}

export type ProviderSessionPurpose = 'stage_background' | 'intro_video';

export interface ProviderSessionAuthorization {
  providerSessionId?: string;
  providerSessionExpiresAt?: string;
  providerCallLimit?: number;
  error?: string;
}

export interface StageForgeAuthorization extends ProviderSessionAuthorization {
  authorized: boolean;
  purchaseId?: string;
  creditsCharged: number;
  creditsBalance?: number;
  mode?: 'credits' | 'local';
}

type BillingErrorBody = {
  error?: unknown;
  message?: unknown;
  requiredCredits?: unknown;
  creditsBalance?: unknown;
};

function isLocalDevWithoutApi(): boolean {
  return !String(import.meta.env.VITE_API_BASE_URL ?? '').trim() && import.meta.env.DEV;
}

async function readBillingJson<T extends object>(res: Response): Promise<T & BillingErrorBody> {
  try {
    const json = await res.json();
    if (json && typeof json === 'object') return json as T & BillingErrorBody;
  } catch {
    // Empty/non-JSON Worker responses fall through to the caller's status fallback.
  }
  return {} as T & BillingErrorBody;
}

function formatBillingError(body: BillingErrorBody, fallback: string): string {
  if (body.error === 'Not enough credits' && typeof body.requiredCredits === 'number') {
    const balance = typeof body.creditsBalance === 'number' ? ` You have ${body.creditsBalance}.` : '';
    const unit = body.requiredCredits === 1 ? 'credit' : 'credits';
    return `Not enough credits. ${body.requiredCredits} ${unit} required.${balance}`;
  }
  if (typeof body.error === 'string' && body.error.trim()) return body.error.trim();
  if (typeof body.message === 'string' && body.message.trim()) return body.message.trim();
  return fallback;
}

export async function loadCreditPacks(context?: ApiRequestContext): Promise<CreditPackLoadResult> {
  if (isLocalDevWithoutApi()) return { status: 'local', packs: [] };

  try {
    const res = await apiFetch('/api/billing/packs', {}, context);
    const json = await readBillingJson<{ packs?: CreditPack[] }>(res);
    if (!res.ok) {
      return {
        status: 'unavailable',
        packs: [],
        message: formatBillingError(json, `Credit packs failed (${res.status})`),
      };
    }
    return { status: 'ready', packs: json.packs ?? [] };
  } catch (error) {
    return {
      status: 'unavailable',
      packs: [],
      message: error instanceof Error ? error.message : 'Credit packs request failed',
    };
  }
}

export async function listCreditPacks(context?: ApiRequestContext): Promise<CreditPack[]> {
  return (await loadCreditPacks(context)).packs;
}

export async function startCreditCheckout(
  packId: string,
  legal: CheckoutLegalAttestation,
  context?: ApiRequestContext,
): Promise<{ checkoutUrl?: string; sessionId?: string; error?: string }> {
  try {
    const res = await apiFetch('/api/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packId, legal }),
    }, context);
    const json = await readBillingJson<{ checkoutUrl?: string; sessionId?: string }>(res);
    if (!res.ok) {
      return { error: formatBillingError(json, `Checkout failed (${res.status})`) };
    }
    if (
      typeof json.checkoutUrl !== 'string' || !json.checkoutUrl ||
      typeof json.sessionId !== 'string' || json.sessionId.length > 255 ||
      !/^cs_[A-Za-z0-9_]+$/.test(json.sessionId)
    ) {
      return { error: 'Checkout failed: the Stripe session could not be recorded' };
    }
    return { checkoutUrl: json.checkoutUrl, sessionId: json.sessionId };
  } catch (err: any) {
    return {
      error: err?.message ? `Checkout failed: ${err.message}` : 'Checkout failed',
    };
  }
}

function parseCreditCheckoutVerification(
  value: unknown,
  expectedSessionId: string,
): CreditCheckoutVerification | null {
  if (!value || typeof value !== 'object') return null;
  const checkout = value as Partial<CreditCheckoutVerification>;
  if (
    checkout.sessionId !== expectedSessionId ||
    !['pending', 'complete', 'failed'].includes(checkout.state ?? '') ||
    typeof checkout.processorStatus !== 'string' || !checkout.processorStatus ||
    typeof checkout.packId !== 'string' || !checkout.packId ||
    !Number.isSafeInteger(checkout.credits) || Number(checkout.credits) <= 0 ||
    !Number.isSafeInteger(checkout.creditsBalance) ||
    typeof checkout.updatedAt !== 'string' || !checkout.updatedAt
  ) return null;
  return checkout as CreditCheckoutVerification;
}

export async function verifyCreditCheckoutSession(
  sessionId: string,
  context?: ApiRequestContext,
): Promise<CreditCheckoutVerificationResult> {
  const normalizedSessionId = sessionId.trim();
  if (!/^cs_[A-Za-z0-9_]+$/.test(normalizedSessionId) || normalizedSessionId.length > 255) {
    return { error: 'Checkout verification requires a valid Stripe session.' };
  }
  if (isLocalDevWithoutApi() && !context?.apiBaseUrl) {
    return { error: 'Checkout verification requires cloud billing.' };
  }

  try {
    const res = await apiFetch(
      `/api/billing/checkout-status?session_id=${encodeURIComponent(normalizedSessionId)}`,
      {},
      context,
    );
    const json = await readBillingJson<{ checkout?: unknown }>(res);
    if (!res.ok) {
      return {
        error: formatBillingError(json, `Checkout verification failed (${res.status})`),
        retryable: res.status === 404 || res.status >= 500,
      };
    }
    const checkout = parseCreditCheckoutVerification(json.checkout, normalizedSessionId);
    if (!checkout) return { error: 'Checkout verification returned an invalid session.', retryable: true };
    return { checkout };
  } catch (err: any) {
    return {
      error: err?.message ? `Checkout verification failed: ${err.message}` : 'Checkout verification failed',
      retryable: true,
    };
  }
}

export async function loadBillingProfile(context?: ApiRequestContext): Promise<BillingProfileLoadResult> {
  if (isLocalDevWithoutApi()) return { status: 'local', profile: null };

  try {
    const res = await apiFetch('/auth/me', {}, context);
    if (!res.ok) {
      return {
        status: 'unavailable',
        profile: null,
        message: `Credit balance failed (${res.status})`,
      };
    }
    const json = await res.json() as {
      user?: {
        creditsBalance?: number;
        freeRookieGenerationsUsed?: number;
        planTier?: BillingProfile['planTier'];
      } | null;
    };
    if (!json.user) return { status: 'signed-out', profile: null };
    return {
      status: 'ready',
      profile: {
        creditsBalance: Number(json.user.creditsBalance ?? 0),
        freeRookieGenerationsUsed: Number(json.user.freeRookieGenerationsUsed ?? 0),
        planTier: json.user.planTier ?? 'free',
      },
    };
  } catch (error) {
    return {
      status: 'unavailable',
      profile: null,
      message: error instanceof Error ? error.message : 'Credit balance request failed',
    };
  }
}

export async function getBillingProfile(context?: ApiRequestContext): Promise<BillingProfile | null> {
  return (await loadBillingProfile(context)).profile;
}

export async function authorizeGeneration(
  tier: QualityTier,
  operation: GenerationBillingOperation,
  fighterId?: string | null,
  turnstileToken?: string | null,
  legal?: GenerationLegalAttestation | null,
  context?: ApiRequestContext,
  resumeJobId?: string | null,
  creationFlow: GenerationCreationFlow = 'original',
): Promise<GenerationAuthorization> {
  if (isLocalDevWithoutApi()) {
    return { authorized: true, message: 'Local generation authorization skipped.' };
  }

  try {
    const res = await apiFetch('/api/billing/generation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tier,
        operation,
        fighterId: fighterId ?? null,
        resumeJobId: resumeJobId ?? null,
        turnstileToken: turnstileToken ?? null,
        legal: legal ?? null,
        creationFlow,
      }),
    }, context);
    const json = await readBillingJson<GenerationAuthorization>(res);
    if (res.ok) return { ...json, authorized: true };
    return {
      ...json,
      authorized: false,
      error: formatBillingError(json, `Generation authorization failed (${res.status})`),
    };
  } catch (err: any) {
    return {
      authorized: false,
      error: err?.message ? `Generation authorization failed: ${err.message}` : 'Generation authorization failed',
    };
  }
}

export async function finishGenerationPurchase(
  purchaseId: string | null | undefined,
  success: boolean,
  fighterId?: string | null,
  context?: ApiRequestContext,
): Promise<void> {
  if (!purchaseId || isLocalDevWithoutApi()) return;

  const res = await apiFetch('/api/billing/generation/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ purchaseId, success, fighterId: fighterId ?? null }),
  }, context);
  if (!res.ok) {
    const json = await readBillingJson<Record<string, never>>(res);
    throw new Error(formatBillingError(json, `Generation purchase update failed (${res.status})`));
  }
}

export async function authorizeStageForge(
  context?: ApiRequestContext,
): Promise<StageForgeAuthorization> {
  if (isLocalDevWithoutApi()) {
    return {
      authorized: true,
      creditsCharged: 0,
      mode: 'local',
    };
  }

  const legal = storedGenerationLegalAttestation();
  if (!legal) {
    return {
      authorized: false,
      creditsCharged: 0,
      error: 'Accept the current AI generation terms before forging a stage.',
    };
  }

  try {
    const res = await apiFetch('/api/billing/stage-forge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ legal }),
    }, context);
    const json = await readBillingJson<Omit<StageForgeAuthorization, 'authorized'>>(res);
    if (res.ok) {
      return {
        ...json,
        authorized: true,
        creditsCharged: typeof json.creditsCharged === 'number'
          ? json.creditsCharged
          : STAGE_FORGE_CREDIT_COST,
      };
    }
    return {
      ...json,
      authorized: false,
      creditsCharged: 0,
      error: formatBillingError(json, `Stage Forge authorization failed (${res.status})`),
    };
  } catch (err: any) {
    return {
      authorized: false,
      creditsCharged: 0,
      error: err?.message
        ? `Stage Forge authorization failed: ${err.message}`
        : 'Stage Forge authorization failed',
    };
  }
}

export async function authorizeProviderSession(
  purpose: ProviderSessionPurpose,
  context?: ApiRequestContext,
): Promise<ProviderSessionAuthorization> {
  if (isLocalDevWithoutApi()) return {};
  const legal = storedGenerationLegalAttestation();
  if (!legal) {
    return { error: 'Accept the current generation terms in New Fighter or Roster Lab first' };
  }

  try {
    const res = await apiFetch('/api/provider-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purpose, legal }),
    }, context);
    const json = await readBillingJson<ProviderSessionAuthorization>(res);
    if (res.ok) return json;
    return { ...json, error: formatBillingError(json, `Provider session failed (${res.status})`) };
  } catch (err: any) {
    return {
      error: err?.message ? `Provider session failed: ${err.message}` : 'Provider session failed',
    };
  }
}
