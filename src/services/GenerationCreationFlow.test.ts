import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GENERATION_CREATION_FLOW,
  generationCreationFlowOrDefault,
  isGenerationCreationFlow,
} from './GenerationCreationFlow';

describe('generation creation flow', () => {
  it('keeps the established renderer as the default', () => {
    expect(DEFAULT_GENERATION_CREATION_FLOW).toBe('original');
    expect(generationCreationFlowOrDefault(undefined)).toBe('original');
    expect(generationCreationFlowOrDefault(null)).toBe('original');
  });

  it('recognizes only the sealed public flow ids', () => {
    expect(isGenerationCreationFlow('original')).toBe(true);
    expect(isGenerationCreationFlow('video')).toBe(true);
    expect(isGenerationCreationFlow('classic')).toBe(false);
    expect(isGenerationCreationFlow('VIDEO')).toBe(false);
    expect(() => generationCreationFlowOrDefault('classic')).toThrow(
      'Unsupported generation creation flow',
    );
  });
});
