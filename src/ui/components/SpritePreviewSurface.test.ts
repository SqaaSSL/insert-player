import { describe, expect, it } from 'vitest';
import { previewPlaybackFrameIndices } from './SpritePreviewSurface.tsx';

describe('HQ sprite preview playback', () => {
  it('reconstructs a dense attack ping-pong from archival unique frames', () => {
    expect(previewPlaybackFrameIndices({
      blob: new Blob(),
      rawBlob: new Blob(),
      animationName: 'high_punch',
      animationFormat: 'video-dense-v1',
      frameWidth: 192,
      frameHeight: 256,
      frameCount: 11,
      rawFrameWidth: 768,
      rawFrameHeight: 1024,
      rawFrameCount: 6,
    })).toEqual([0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 0]);
  });

  it('uses natural order for loops and timeline actions', () => {
    expect(previewPlaybackFrameIndices({
      blob: new Blob(),
      rawBlob: new Blob(),
      animationName: 'idle',
      animationFormat: 'video-dense-v1',
      frameWidth: 192,
      frameHeight: 256,
      frameCount: 8,
      rawFrameWidth: 768,
      rawFrameHeight: 1024,
      rawFrameCount: 8,
    })).toBeUndefined();
  });
});
