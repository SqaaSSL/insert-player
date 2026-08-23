import { describe, expect, it } from 'vitest';
import {
  GeminiContentBlockedError,
  geminiContentBlockReason,
  geminiFinishReasonBlockReason,
  geminiOfficialPosePrompt,
  geminiOfficialRefinePrompt,
  geminiOfficialSpriteReviewPrompt,
  geminiOfficialSpritePrompt,
  geminiOfficialTextOnlyPrompt,
  isGeminiContentBlockedError,
  parseGeminiOfficialSpriteReview,
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
    expect(scaffold).toContain('identity-free silhouette guide for the canonical starting pose');
    expect(scaffold).toContain('Generate a 2x2 idle sprite sheet.');
    expect(refine).toContain('identity-free silhouette guide');
    expect(refine).toContain('frame 2 of 4');
    expect(refine).toContain('Do not infer identity');
  });

  it('adds controlled correction instructions to an official frame retry', () => {
    const prompt = geminiOfficialRefinePrompt(
      'Original fighter in a navy suit.',
      'idle',
      'subtle breathing loop',
      3,
      8,
      'Use dimensional realistic 2.5D shading and preserve the complete body.',
    );

    expect(prompt).toContain('QUALITY CORRECTION (CRITICAL)');
    expect(prompt).toContain('dimensional realistic 2.5D shading');
  });

  it('reviews official sprite sheets without asking Gemini to identify the avatar', () => {
    const prompt = geminiOfficialSpriteReviewPrompt(
      'Original fighter in a navy suit.',
      'idle',
      'subtle breathing loop',
      8,
    );

    expect(prompt).toContain('Do not identify, name, or compare');
    expect(prompt).toContain('indexed 0 through 7');
    expect(prompt).toContain('render_style');
    expect(prompt).toContain('{"retry":[],"issues":{}}');
  });

  it('parses and validates closed-category official sprite QA results', () => {
    expect(parseGeminiOfficialSpriteReview(
      '```json\n{"retry":[3,1,3],"issues":{"1":["anatomy"],"3":["render_style","outfit_continuity"]}}\n```',
      8,
    )).toEqual({
      retry: [1, 3],
      issues: {
        '1': ['anatomy'],
        '3': ['render_style', 'outfit_continuity'],
      },
    });
    expect(() => parseGeminiOfficialSpriteReview(
      '{"retry":[8],"issues":{"8":["render_style"]}}',
      8,
    )).toThrow('invalid frame index');
    expect(() => parseGeminiOfficialSpriteReview(
      '{"retry":[2],"issues":{"2":["celebrity_similarity"]}}',
      8,
    )).toThrow('invalid issue');
  });
});
