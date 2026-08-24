export const LEGAL_EFFECTIVE_DATE = '23 August 2026';
export const LEGAL_VERSION = '2026-08-23.1';
export const PUBLIC_ORIGIN = 'https://insertplayer.ai';
export const PRIVACY_EMAIL = 'privacy@insertplayer.ai';
export const SUPPORT_EMAIL = 'support@insertplayer.ai';

export const LEGAL_OPERATOR = {
  name: 'Squad as a Service SL',
  taxId: 'B44599603',
  registry: 'Registro Mercantil de Madrid, section 8, sheet M-784524',
  address: 'Paseo de la Castellana 126, 8th floor right, Madrid, Spain',
} as const;

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

export function currentGenerationLegalAttestation(): GenerationLegalAttestation {
  return {
    legalVersion: LEGAL_VERSION,
    ageConfirmed: true,
    termsAccepted: true,
    photoRightsConfirmed: true,
    aiProcessingConfirmed: true,
    immediatePerformanceConfirmed: true,
    withdrawalLossAcknowledged: true,
  };
}

export function currentCheckoutLegalAttestation(): CheckoutLegalAttestation {
  return {
    legalVersion: LEGAL_VERSION,
    ageConfirmed: true,
    termsAccepted: true,
    refundPolicyAcknowledged: true,
    immediateDeliveryConfirmed: true,
    withdrawalLossAcknowledged: true,
  };
}

const GENERATION_CONSENT_STORAGE_KEY = `insert-player:generation-consent:${LEGAL_VERSION}`;

export function rememberCurrentGenerationConsent(): void {
  try {
    window.localStorage.setItem(GENERATION_CONSENT_STORAGE_KEY, 'accepted');
  } catch {
    // The operation-level checkbox still supplies consent when storage is unavailable.
  }
}

export function storedGenerationLegalAttestation(): GenerationLegalAttestation | null {
  try {
    return window.localStorage.getItem(GENERATION_CONSENT_STORAGE_KEY) === 'accepted'
      ? currentGenerationLegalAttestation()
      : null;
  } catch {
    return null;
  }
}
