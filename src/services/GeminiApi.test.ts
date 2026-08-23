import { describe, expect, it } from 'vitest';
import {
  GeminiContentBlockedError,
  geminiContentBlockReason,
  geminiFinishReasonBlockReason,
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
});
