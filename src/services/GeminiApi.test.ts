import { describe, expect, it } from 'vitest';
import {
  GeminiContentBlockedError,
  GeminiOfficialSpriteQualityError,
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

  it('keeps deterministic official QA failures distinct from provider safety blocks', () => {
    const error = new GeminiOfficialSpriteQualityError('walk only produced 13 reliable frames');
    expect(error.name).toBe('GeminiOfficialSpriteQualityError');
    expect(isGeminiContentBlockedError(error)).toBe(false);
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
    expect(prompt).toContain('render_quality');
    expect(prompt).toContain('sequence_continuity');
    expect(prompt).toContain('animation_fidelity');
    expect(prompt).toContain('{"retry":[],"issues":{}}');
  });

  it('forces a dedicated whole-cycle comparison for 16-frame walks', () => {
    const prompt = geminiOfficialSpriteReviewPrompt(
      'Original fighter in a navy suit.',
      'walk',
      'combat-ready forward walk',
      16,
      'initial-continuity',
      1,
    );

    expect(prompt).toContain('explicitly compare cells 0-7 against cells 8-15');
    expect(prompt).toContain('CONTINUITY SPECIALIST PASS');
    expect(prompt).toContain('casual civilian stroll');
  });

  it('forces a dedicated wardrobe and accessory continuity audit', () => {
    const prompt = geminiOfficialSpriteReviewPrompt(
      'Original fighter in a navy suit with bare hands, black shoes, and a red tie.',
      'idle',
      'subtle breathing loop',
      8,
      'initial-wardrobe',
      1,
    );

    expect(prompt).toContain('Inventory the visible clothing and accessories across all cells');
    expect(prompt).toContain('majority-consistent frames');
    expect(prompt).toContain('A glove, watch, ring, bracelet, prop, changed shoe, changed tie');
    expect(prompt).toContain('WARDROBE SPECIALIST PASS');
    expect(prompt).toContain('REVIEW INSTANCE: initial-wardrobe-1');
  });

  it('makes independent QA passes and format recovery requests cache-distinct', () => {
    const first = geminiOfficialSpriteReviewPrompt(
      'Original fighter in a navy suit.',
      'walk',
      'walking forward',
      16,
      'initial-local',
      1,
    );
    const second = geminiOfficialSpriteReviewPrompt(
      'Original fighter in a navy suit.',
      'walk',
      'walking forward',
      16,
      'initial-continuity',
      1,
    );
    const recovery = geminiOfficialSpriteReviewPrompt(
      'Original fighter in a navy suit.',
      'walk',
      'walking forward',
      16,
      'initial-local',
      2,
    );

    expect(first).toContain('REVIEW INSTANCE: initial-local-1');
    expect(second).toContain('REVIEW INSTANCE: initial-continuity-1');
    expect(second).not.toBe(first);
    expect(recovery).toContain('REVIEW INSTANCE: initial-local-2');
    expect(recovery).toContain('FORMAT RECOVERY');
    expect(recovery).not.toBe(first);
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
