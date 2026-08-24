import { apiFetch, type ApiRequestContext } from './ApiClient';
import type { GenerationBillingOperation, QualityTier } from './QualityTiers';
import {
  storedGenerationLegalAttestation,
  type CheckoutLegalAttestation,
  type GenerationLegalAttestation,
} from '../ui/legal.ts';

export interface GenerationAuthorization {
  authorized: boolean;
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

export type ProviderSessionPurpose = 'stage_background' | 'intro_video';

export interface ProviderSessionAuthorization {
  providerSessionId?: string;
  providerSessionExpiresAt?: string;
  providerCallLimit?: number;
  error?: string;
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
    return `Not enough credits. ${body.requiredCredits} credits required.${balance}`;
  }
  if (typeof body.error === 'string' && body.error.trim()) return body.error.trim();
  if (typeof body.message === 'string' && body.message.trim()) return body.message.trim();
  return fallback;
}

export async function listCreditPacks(context?: ApiRequestContext): Promise<CreditPack[]> {
  if (isLocalDevWithoutApi()) return [];

  try {
    const res = await apiFetch('/api/billing/packs', {}, context);
    if (!res.ok) return [];
    const json = await res.json() as { packs?: CreditPack[] };
    return json.packs ?? [];
  } catch {
    return [];
  }
}

export async function startCreditCheckout(
  packId: string,
  legal: CheckoutLegalAttestation,
  context?: ApiRequestContext,
): Promise<{ checkoutUrl?: string; error?: string }> {
  try {
    const res = await apiFetch('/api/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packId, legal }),
    }, context);
    const json = await readBillingJson<{ checkoutUrl?: string }>(res);
    if (!res.ok) {
      return { error: formatBillingError(json, `Checkout failed (${res.status})`) };
    }
    return { checkoutUrl: json.checkoutUrl };
  } catch (err: any) {
    return {
      error: err?.message ? `Checkout failed: ${err.message}` : 'Checkout failed',
    };
  }
}

export async function getBillingProfile(context?: ApiRequestContext): Promise<BillingProfile | null> {
  if (isLocalDevWithoutApi()) return null;

  try {
    const res = await apiFetch('/auth/me', {}, context);
    if (!res.ok) return null;
    const json = await res.json() as {
      user?: {
        creditsBalance?: number;
        freeRookieGenerationsUsed?: number;
        planTier?: BillingProfile['planTier'];
      } | null;
    };
    if (!json.user) return null;
    return {
      creditsBalance: Number(json.user.creditsBalance ?? 0),
      freeRookieGenerationsUsed: Number(json.user.freeRookieGenerationsUsed ?? 0),
      planTier: json.user.planTier ?? 'free',
    };
  } catch {
    return null;
  }
}

export async function authorizeGeneration(
  tier: QualityTier,
  operation: GenerationBillingOperation,
  fighterId?: string | null,
  turnstileToken?: string | null,
  legal?: GenerationLegalAttestation | null,
  context?: ApiRequestContext,
  resumeJobId?: string | null,
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
