import { describe, expect, it } from 'vitest';
import {
  GeminiContentBlockedError,
  GeminiOfficialSpriteQualityError,
  geminiContentBlockReason,
  geminiFinishReasonBlockReason,
  geminiOfficialCorrectionUsesCanonicalPoseGuide,
  geminiOfficialFrameFramingValidation,
  geminiOfficialFramingRecoveryPrompt,
  geminiOfficialRefinePrompt,
  geminiOfficialReviewCorrection,
  geminiRefinedFrameSizeValidation,
  geminiOfficialSpriteReviewPrompt,
  geminiOfficialSpritePrompt,
  geminiSpriteSequenceEndNote,
  isGeminiContentBlockedError,
  parseGeminiOfficialSpriteReview,
} from './GeminiApi';

describe('Gemini content-block handling', () => {
  it('selectively rejects official renders that touch an image edge', () => {
    expect(geminiOfficialFrameFramingValidation({
      x: 0,
      y: 180,
      w: 846,
      h: 960,
      imageW: 896,
      imageH: 1152,
    })).toEqual({ ok: false, croppedEdges: ['left'] });

    expect(geminiOfficialFrameFramingValidation({
      x: 24,
      y: 120,
      w: 820,
      h: 990,
      imageW: 896,
      imageH: 1152,
    })).toEqual({ ok: true, croppedEdges: [] });

    expect(geminiOfficialFrameFramingValidation({
      x: 24,
      y: 2,
      w: 869,
      h: 1147,
      imageW: 896,
      imageH: 1152,
    })).toEqual({ ok: false, croppedEdges: ['right', 'top', 'bottom'] });
  });

  it('shows framing recovery the rejected render without weakening pose or identity anchors', () => {
    const prompt = geminiOfficialFramingRecoveryPrompt(
      'Original fighter in a black leather jacket.',
      'low_kick',
      'low sweeping kick',
      3,
      4,
      ['left'],
    );

    expect(prompt).toContain('IMAGE 1 is the canonical identity');
    expect(prompt).toContain('IMAGE 2 is the exact pose');
    expect(prompt).toContain('IMAGE 3 is the previous rejected render');
    expect(prompt).toContain('Do not return IMAGE 3 unchanged');
    expect(prompt).toContain('at least 2% of the canvas width at the left edge');
    expect(prompt).toContain('Keep IMAGE 2\'s exact pose and floor line');
  });

  it('allows only a narrow second-attempt size recovery for low attacks', () => {
    const baseHeightRatio = 0.6884765625;
    const refinedHeightRatio = 0.906276150627615;

    expect(geminiRefinedFrameSizeValidation(
      'low_kick',
      baseHeightRatio,
      refinedHeightRatio,
    ).ok).toBe(false);
    expect(geminiRefinedFrameSizeValidation(
      'low_kick',
      baseHeightRatio,
      refinedHeightRatio,
      true,
    )).toMatchObject({ ok: true, maxRatio: 1.35 });
    expect(geminiRefinedFrameSizeValidation(
      'high_kick',
      baseHeightRatio,
      refinedHeightRatio,
      true,
    )).toMatchObject({ ok: false, maxRatio: 1.3 });
    expect(geminiRefinedFrameSizeValidation(
      'low_kick',
      baseHeightRatio,
      baseHeightRatio * 1.36,
      true,
    ).ok).toBe(false);
  });

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

  it('keeps the approved reference identity attached to official Champion sprites', () => {
    const scaffold = geminiOfficialSpritePrompt(
      'Transform the person in the licensed reference photo into a fighter in a navy suit.',
      'Generate a 2x2 idle sprite sheet.',
    );
    const refine = geminiOfficialRefinePrompt(
      'Transform the person in the licensed reference photo into a fighter in a navy suit.',
      'idle',
      'subtle breathing loop',
      1,
      4,
    );

    expect(scaffold).toContain('IMAGE 1 is the canonical identity');
    expect(scaffold).toContain('recognizable facial structure');
    expect(scaffold).toContain('Generate a 2x2 idle sprite sheet.');
    expect(scaffold).not.toContain('identity-free');
    expect(refine).toContain('IMAGE 1 is the canonical identity');
    expect(refine).toContain("IMAGE 2 is the exact pose");
    expect(refine).toContain('frame 2 of 4');
    expect(refine).not.toContain('Do not infer identity');
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

  it('closes an idle scaffold on the raised canonical guard', () => {
    const endNote = geminiSpriteSequenceEndNote('idle', 8, true, false);

    expect(endNote).toContain('IMAGE 2 shows the required END guard (frame 8)');
    expect(endNote).toContain('both fists raised');
    expect(endNote).toContain('connects cleanly back to frame 1');
  });

  it('replaces a rejected final idle pose guide with the canonical guard', () => {
    const review = {
      retry: [7],
      issues: { '7': ['animation_fidelity' as const] },
    };

    expect(geminiOfficialCorrectionUsesCanonicalPoseGuide(review, 'idle', 7, 8)).toBe(true);
    expect(geminiOfficialCorrectionUsesCanonicalPoseGuide(review, 'idle', 6, 8)).toBe(false);
    expect(geminiOfficialCorrectionUsesCanonicalPoseGuide(review, 'walk', 7, 8)).toBe(false);
    expect(geminiOfficialReviewCorrection(review, 7, 'idle', 8)).toContain(
      "return to IMAGE 1's fighting-ready guard with both fists raised",
    );
    expect(geminiOfficialReviewCorrection(review, 7, 'idle', 8)).toContain(
      'Do not lower either arm',
    );
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
