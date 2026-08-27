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
 * PR 1 only seals the choice. The video implementation enables its branch in
 * the later Workflow PR, so a partial rollout can never run the original
 * renderer after a caller explicitly requested video.
 */
export function generationCreationFlowAvailable(flow: GenerationCreationFlow): boolean {
  return flow === 'original';
}
