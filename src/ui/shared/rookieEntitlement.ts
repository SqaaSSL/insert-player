import type { BillingProfile } from '../../services/Billing.ts';
import { isQualityTier, offeredQualityTier, type QualityTier } from '../../services/QualityTiers.ts';
import type { AuthStatus } from '../authState.ts';
import { quoteGenerationPackage, type GenerationPackage } from '../../services/GenerationPackages.ts';

export type IncludedRookieStatus = 'included' | 'credits' | 'checking' | 'account-required';

export function includedRookieStatus(
  authStatus: AuthStatus,
  billingProfile: BillingProfile | null,
  creationPackage: GenerationPackage = 'complete',
): IncludedRookieStatus {
  if (creationPackage === 'aura' && (authStatus === 'signed-out' || authStatus === 'local')) return 'account-required';
  if (authStatus === 'local' || authStatus === 'signed-out') return 'included';
  if (authStatus !== 'signed-in' || !billingProfile) return 'checking';
  return billingProfile.freeRookieGenerationsUsed < 1 ? 'included' : 'credits';
}

export function initialCreationTier(requestedTier: unknown, paidTiersAreLocked: boolean, creationPackage?: GenerationPackage): QualityTier {
  if (
    isQualityTier(requestedTier) &&
    (!paidTiersAreLocked || requestedTier === 'rookie')
  ) {
    return offeredQualityTier(requestedTier);
  }
  return paidTiersAreLocked || creationPackage === 'aura' ? 'rookie' : 'contender';
}

/** The same visible price is sent to authorization. A missing account quote
 * never permits the server to silently replace an included Rookie with credits. */
export function expectedCreationCredits(
  tier: QualityTier,
  creationPackage: GenerationPackage,
  authStatus: AuthStatus,
  billingProfile: BillingProfile | null,
): number | null {
  if (authStatus !== 'signed-in' || !billingProfile
    || !Number.isSafeInteger(billingProfile.freeRookieGenerationsUsed)
    || billingProfile.freeRookieGenerationsUsed < 0) return null;
  return tier === 'rookie' && includedRookieStatus(authStatus, billingProfile, creationPackage) === 'included'
    ? 0 : quoteGenerationPackage(tier, creationPackage).creditCost;
}
