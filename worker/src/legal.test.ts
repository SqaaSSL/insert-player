import { describe, expect, it } from 'vitest';
import {
  CURRENT_LEGAL_VERSION,
  parseCheckoutLegalAttestation,
  parseGenerationLegalAttestation,
} from './legal';

describe('legal attestations', () => {
  it('accepts only the complete current generation attestation', () => {
    const current = {
      legalVersion: CURRENT_LEGAL_VERSION,
      ageConfirmed: true,
      termsAccepted: true,
      photoRightsConfirmed: true,
      aiProcessingConfirmed: true,
      immediatePerformanceConfirmed: true,
      withdrawalLossAcknowledged: true,
    };
    expect(parseGenerationLegalAttestation(current)).toEqual(current);
    expect(parseGenerationLegalAttestation({ ...current, photoRightsConfirmed: false })).toBeNull();
    expect(parseGenerationLegalAttestation({ ...current, legalVersion: 'legacy' })).toBeNull();
  });

  it('accepts only the complete current checkout attestation', () => {
    const current = {
      legalVersion: CURRENT_LEGAL_VERSION,
      ageConfirmed: true,
      termsAccepted: true,
      refundPolicyAcknowledged: true,
      immediateDeliveryConfirmed: true,
      withdrawalLossAcknowledged: true,
    };
    expect(parseCheckoutLegalAttestation(current)).toEqual(current);
    expect(parseCheckoutLegalAttestation({ ...current, termsAccepted: false })).toBeNull();
    expect(parseCheckoutLegalAttestation({ ...current, withdrawalLossAcknowledged: false })).toBeNull();
  });
});
