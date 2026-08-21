import { describe, expect, it } from 'vitest';
import { expandMirroredSequence } from './FrameSequence';

describe('expandMirroredSequence', () => {
  it('builds a seven-frame attack from four paid keyframes', () => {
    expect(expandMirroredSequence(['rest', 'windup', 'strike', 'impact'], 7)).toEqual([
      'rest',
      'windup',
      'strike',
      'impact',
      'strike',
      'windup',
      'rest',
    ]);
  });

  it('does not duplicate work for sequences already at their target length', () => {
    expect(expandMirroredSequence([0, 1, 2, 3], 4)).toEqual([0, 1, 2, 3]);
  });

  it('rejects an empty source for a non-empty result', () => {
    expect(() => expandMirroredSequence([], 1)).toThrow('empty frame sequence');
  });
});
