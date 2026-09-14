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
 * video uses the legacy Champion job contract for preserved continuations and
 * internal reviewed roster generation; it is no longer a new public purchase.
 */
export function generationCreationFlowAvailable(flow: GenerationCreationFlow): boolean {
  return flow === 'original' || flow === 'video';
}
