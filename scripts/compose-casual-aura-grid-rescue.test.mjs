import { describe, expect, it } from 'vitest';
import { auraGridCompositionOptions } from './compose-casual-aura-grid-rescue.mjs';

describe('Casual Aura grid composition guard', () => {
  const review = ['--review=review.json', `--review-sha256=${'a'.repeat(64)}`];
  it('defaults to offline candidate assembly only', () => {
    expect(auraGridCompositionOptions(review).apply).toBe(false);
    expect(() => auraGridCompositionOptions(['--review=review.json'])).toThrow();
    expect(() => auraGridCompositionOptions([...review, '--execute'])).toThrow();
  });
  it('requires exact assembled sheet review and explicit apply confirmation', () => {
    expect(() => auraGridCompositionOptions([...review, '--apply'])).toThrow();
    expect(() => auraGridCompositionOptions([...review, '--apply', '--confirm=casual-aura-grid-rescue-v1'])).toThrow();
    expect(auraGridCompositionOptions([...review, '--apply', '--confirm=casual-aura-grid-rescue-v1', `--sheets-reviewed=${'b'.repeat(64)}`]).apply).toBe(true);
    expect(() => auraGridCompositionOptions([...review, '--review=another.json'])).toThrow();
  });
});
