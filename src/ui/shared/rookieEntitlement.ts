import type { BillingProfile } from '../../services/Billing.ts';
import { isQualityTier, type QualityTier } from '../../services/QualityTiers.ts';
import type { AuthStatus } from '../authState.ts';

export type IncludedRookieStatus = 'included' | 'credits' | 'checking';

export function includedRookieStatus(
  authStatus: AuthStatus,
  billingProfile: BillingProfile | null,
): IncludedRookieStatus {
  if (authStatus === 'local' || authStatus === 'signed-out') return 'included';
  if (authStatus !== 'signed-in' || !billingProfile) return 'checking';
  return billingProfile.freeRookieGenerationsUsed < 1 ? 'included' : 'credits';
}

export function initialCreationTier(requestedTier: unknown, paidTiersAreLocked: boolean): QualityTier {
  if (
    isQualityTier(requestedTier) &&
    (!paidTiersAreLocked || requestedTier === 'rookie')
  ) {
    return requestedTier;
  }
  return paidTiersAreLocked ? 'rookie' : 'contender';
}
