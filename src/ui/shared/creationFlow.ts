import {
  generationCreationFlowOrDefault,
  type GenerationCreationFlow,
} from '../../services/GenerationCreationFlow.ts';
import type { QualityTier } from '../../services/QualityTiers.ts';
import type { AuthStatus } from '../authState.ts';

export type CreationFlow = GenerationCreationFlow;

export interface VideoCreationFlowAvailability {
  available: boolean;
  reason?: string;
}

export function videoCreationFlowAvailability(
  authStatus: AuthStatus,
  tier: QualityTier,
): VideoCreationFlowAvailability {
  if (authStatus !== 'signed-in') {
    return { available: false, reason: 'Sign in to use the cloud Video flow.' };
  }
  if (tier !== 'champion') {
    return { available: false, reason: 'Choose Champion quality to use Video.' };
  }
  return { available: true };
}

export function creationFlowForResume(value: unknown): CreationFlow {
  return generationCreationFlowOrDefault(value);
}

export function assertCreationFlowAcknowledged(
  requested: CreationFlow,
  acknowledged: unknown,
): void {
  if (acknowledged !== undefined && acknowledged !== null && acknowledged !== requested) {
    throw new Error('The server confirmed a different creation flow; no generation job was started');
  }
  if (requested === 'video' && acknowledged !== 'video') {
    throw new Error('Video creation is not enabled on this server; no generation job was started');
  }
}
