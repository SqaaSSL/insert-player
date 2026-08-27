import {
  DEFAULT_GENERATION_CREATION_FLOW,
  isGenerationCreationFlow,
  type GenerationCreationFlow,
} from '../../src/services/GenerationCreationFlow';

export function parseRequestedGenerationCreationFlow(
  value: unknown,
): GenerationCreationFlow | null {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_GENERATION_CREATION_FLOW;
  }
  return isGenerationCreationFlow(value) ? value : null;
}

/**
 * Availability is still narrowed by the billing/job authorization gates:
 * video currently requires a signed-in Champion request.
 */
export function generationCreationFlowAvailable(flow: GenerationCreationFlow): boolean {
  return flow === 'original' || flow === 'video';
}
