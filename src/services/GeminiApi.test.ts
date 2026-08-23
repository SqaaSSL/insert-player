import { describe, expect, it } from 'vitest';
import {
  GeminiContentBlockedError,
  geminiContentBlockReason,
  geminiFinishReasonBlockReason,
  geminiOfficialPosePrompt,
  geminiOfficialRefinePrompt,
  geminiOfficialSpritePrompt,
  geminiOfficialTextOnlyPrompt,
  isGeminiContentBlockedError,
} from './GeminiApi';

describe('Gemini content-block handling', () => {
  it('classifies HTTP-200 responses that contain only a prompt block', () => {
    expect(geminiContentBlockReason({
      promptFeedback: { blockReason: 'OTHER' },
    })).toBe('OTHER');
    expect(geminiContentBlockReason({ promptFeedback: {} })).toBeNull();
  });

  it('recognizes explicit provider blocks without classifying ordinary failures', () => {
    expect(isGeminiContentBlockedError(new GeminiContentBlockedError('OTHER'))).toBe(true);
    expect(isGeminiContentBlockedError(new Error('IMAGE_SAFETY response'))).toBe(true);
    expect(isGeminiContentBlockedError(new Error('IMAGE_OTHER response'))).toBe(true);
    expect(isGeminiContentBlockedError(new Error('network timeout'))).toBe(false);
  });

  it('treats image-only declines as eligible for the safe synthetic retry', () => {
    expect(geminiFinishReasonBlockReason('IMAGE_OTHER')).toBe('IMAGE_OTHER');
    expect(geminiFinishReasonBlockReason('IMAGE_SAFETY')).toBe('IMAGE_SAFETY');
    expect(geminiFinishReasonBlockReason('STOP')).toBeNull();
    expect(geminiFinishReasonBlockReason(null)).toBeNull();
  });

  it('builds an explicit text-only fallback for licensed official fighters', () => {
    const prompt = geminiOfficialTextOnlyPrompt('Create an original fighter in a navy suit.');

    expect(prompt).toContain('from the written description only');
    expect(prompt).toContain('Do not depict, identify, or reproduce any real person');
    expect(prompt).toContain('Create an original fighter in a navy suit.');
  });

  it('keeps official source views text-only and anatomically constrained', () => {
    const prompt = geminiOfficialPosePrompt('Original fighter in a navy suit.', 'crouch');

    expect(prompt).toContain('written description only');
    expect(prompt).toContain('extreme classic 2D fighting-game crouch guard');
    expect(prompt).toContain('two arms');
    expect(prompt).toContain('two legs');
  });

  it('uses written identity plus identity-free pose guidance for official Champion sprites', () => {
    const scaffold = geminiOfficialSpritePrompt(
      'Original fighter in a navy suit.',
      'Generate a 2x2 idle sprite sheet.',
    );
    const refine = geminiOfficialRefinePrompt(
      'Original fighter in a navy suit.',
      'idle',
      'subtle breathing loop',
      1,
      4,
    );

    expect(scaffold).toContain('without an identity reference image');
    expect(scaffold).toContain('Generate a 2x2 idle sprite sheet.');
    expect(refine).toContain('identity-free silhouette guide');
    expect(refine).toContain('frame 2 of 4');
    expect(refine).toContain('Do not infer identity');
  });
});
