import { generateId, hashString } from './auth';
import type { Env, PublicAuthContext } from './types';

export const CURRENT_LEGAL_VERSION = '2026-08-19';

export type LegalAcceptanceAction =
  | 'fighter_generation'
  | 'fighter_retry'
  | 'fighter_upgrade'
  | 'stage_background'
  | 'intro_video'
  | 'credit_checkout';

export interface GenerationLegalAttestation {
  legalVersion: string;
  ageConfirmed: true;
  termsAccepted: true;
  photoRightsConfirmed: true;
  aiProcessingConfirmed: true;
  immediatePerformanceConfirmed: true;
  withdrawalLossAcknowledged: true;
}

export interface CheckoutLegalAttestation {
  legalVersion: string;
  ageConfirmed: true;
  termsAccepted: true;
  refundPolicyAcknowledged: true;
  immediateDeliveryConfirmed: true;
  withdrawalLossAcknowledged: true;
}

type RecordedLegalAttestation = {
  legalVersion: string;
  ageConfirmed: boolean;
  termsAccepted: boolean;
  photoRightsConfirmed?: boolean;
  aiProcessingConfirmed?: boolean;
  immediatePerformanceConfirmed?: boolean;
  refundPolicyAcknowledged?: boolean;
  immediateDeliveryConfirmed?: boolean;
  withdrawalLossAcknowledged: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function parseGenerationLegalAttestation(value: unknown): GenerationLegalAttestation | null {
  if (!isRecord(value)) return null;
  if (
    value.legalVersion !== CURRENT_LEGAL_VERSION ||
    value.ageConfirmed !== true ||
    value.termsAccepted !== true ||
    value.photoRightsConfirmed !== true ||
    value.aiProcessingConfirmed !== true ||
    value.immediatePerformanceConfirmed !== true ||
    value.withdrawalLossAcknowledged !== true
  ) {
    return null;
  }
  return value as unknown as GenerationLegalAttestation;
}

export function parseCheckoutLegalAttestation(value: unknown): CheckoutLegalAttestation | null {
  if (!isRecord(value)) return null;
  if (
    value.legalVersion !== CURRENT_LEGAL_VERSION ||
    value.ageConfirmed !== true ||
    value.termsAccepted !== true ||
    value.refundPolicyAcknowledged !== true ||
    value.immediateDeliveryConfirmed !== true ||
    value.withdrawalLossAcknowledged !== true
  ) {
    return null;
  }
  return value as unknown as CheckoutLegalAttestation;
}

export async function prepareLegalAcceptance(
  env: Env,
  auth: PublicAuthContext,
  action: LegalAcceptanceAction,
  attestation: RecordedLegalAttestation,
  contextId: string,
): Promise<D1PreparedStatement> {
  const subjectHash = await hashString(auth.userId ?? auth.rateLimitKey);
  return env.DB.prepare(`
    INSERT INTO legal_acceptances (
      id, user_id, subject_hash, action, context_id, legal_version,
      age_confirmed, terms_accepted, photo_rights_confirmed,
      ai_processing_confirmed, immediate_performance_confirmed,
      refund_policy_acknowledged, immediate_delivery_confirmed,
      withdrawal_loss_acknowledged
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    generateId(),
    auth.userId,
    subjectHash,
    action,
    contextId,
    attestation.legalVersion,
    Number(attestation.ageConfirmed),
    Number(attestation.termsAccepted),
    Number(attestation.photoRightsConfirmed ?? false),
    Number(attestation.aiProcessingConfirmed ?? false),
    Number(attestation.immediatePerformanceConfirmed ?? false),
    Number(attestation.refundPolicyAcknowledged ?? false),
    Number(attestation.immediateDeliveryConfirmed ?? false),
    Number(attestation.withdrawalLossAcknowledged),
  );
}
