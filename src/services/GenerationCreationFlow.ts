export const GENERATION_CREATION_FLOWS = ['original', 'video'] as const;

export type GenerationCreationFlow = typeof GENERATION_CREATION_FLOWS[number];

export const DEFAULT_GENERATION_CREATION_FLOW: GenerationCreationFlow = 'original';

export function isGenerationCreationFlow(value: unknown): value is GenerationCreationFlow {
  return value === 'original' || value === 'video';
}

export function generationCreationFlowOrDefault(value: unknown): GenerationCreationFlow {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_GENERATION_CREATION_FLOW;
  }
  if (isGenerationCreationFlow(value)) return value;
  throw new Error('Unsupported generation creation flow');
}
