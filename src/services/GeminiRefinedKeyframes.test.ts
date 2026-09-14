import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installCanvasRuntime } from '../../processor/src/canvasRuntime.ts';
import { apiFetch } from './ApiClient';
import { GeminiOfficialSpriteQualityError, geminiSheetRefined } from './GeminiApi';
import { cleanSpriteSheet, mirrorCleanFrames, type CleanSheetResult } from './SpritePostProcess';

vi.mock('./ApiClient', async importOriginal => ({
  ...await importOriginal<typeof import('./ApiClient')>(),
  apiFetch: vi.fn(),
}));
vi.mock('./SpritePostProcess', async importOriginal => {
  const original = await importOriginal<typeof import('./SpritePostProcess')>();
  return {
    ...original,
    cleanSpriteSheet: vi.fn(),
    mirrorCleanFrames: vi.fn(original.mirrorCleanFrames),
    // This regression isolates loss of a paid keyframe during normalization.
    // Framing and segmentation have their own pixel-fixture tests.
    cleanReposedImagePreserveCanvas: vi.fn(async (image: string) => image),
    measureOpaqueBoundsFromBase64: vi.fn(async () => null),
  };
});

beforeAll(() => installCanvasRuntime());
beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(cleanSpriteSheet).mockReset();
  vi.mocked(mirrorCleanFrames).mockClear();
});

function poseImage(index: number, sheet = false): string {
  const canvas = document.createElement('canvas');
  canvas.width = sheet ? 96 : 48;
  canvas.height = sheet ? 128 : 64;
  const context = canvas.getContext('2d')!;
  const colors = ['#a14444', '#44a144', '#4444a1', '#a18844'];
  for (let cell = 0; cell < (sheet ? 4 : 1); cell++) {
    context.fillStyle = colors[sheet ? cell : index];
    context.fillRect((cell % 2) * 48 + 12, Math.floor(cell / 2) * 64 + 8, 24, 48);
  }
  return canvas.toDataURL('image/png').split(',')[1];
}

function prepareRefinement(survivingKeyframes: number) {
  const scaffold = poseImage(0, true);
  const result: CleanSheetResult = {
    base64: scaffold, rawBase64: scaffold, frameCount: 4,
    frameW: 48, frameH: 64, gridCols: 2, gridRows: 2, usedScale: 1,
  };
  vi.mocked(cleanSpriteSheet)
    .mockResolvedValueOnce(result)
    .mockResolvedValueOnce({ ...result, frameCount: survivingKeyframes });
  let request = 0;
  vi.mocked(apiFetch).mockImplementation(async () => {
    const image = request++ === 0 ? scaffold : poseImage(request - 2);
    return new Response(JSON.stringify({ candidates: [{ content: {
      parts: [{ inlineData: { mimeType: 'image/png', data: image } }],
    } }] }));
  });
  return poseImage(0);
}

describe('ordinary Champion attack keyframe completeness', () => {
  it('rejects four paid keyframes normalized down to three before mirroring can disguise the loss', async () => {
    const reference = prepareRefinement(3);
    // Deliberately no officialDescription: ordinary user characters need this guard too.
    const result = geminiSheetRefined(reference, 'low_kick', 'low sweeping kick', 7,
      undefined, undefined, undefined, { enableBgRemoval: false });
    await expect(result).rejects.toBeInstanceOf(GeminiOfficialSpriteQualityError);
    await expect(result).rejects.toThrow('only produced 3 reliable keyframes (need 4)');
    expect(apiFetch).toHaveBeenCalledTimes(5); // One scaffold and four independent refines.
    expect(cleanSpriteSheet).toHaveBeenCalledTimes(2);
    expect(vi.mocked(cleanSpriteSheet).mock.calls[1].slice(1, 5)).toEqual([4, 2, 2, 'low_kick']);
    // The scaffold already mirrored its valid 4 frames; the damaged refined set must not.
    expect(mirrorCleanFrames).toHaveBeenCalledOnce();
    expect(vi.mocked(mirrorCleanFrames).mock.calls[0].slice(1)).toEqual([4, 7, 2, 2]);
  });

  it('still expands four retained ordinary attack keyframes into seven playback frames', async () => {
    const reference = prepareRefinement(4);
    await expect(geminiSheetRefined(reference, 'low_kick', 'low sweeping kick', 7,
      undefined, undefined, undefined, { enableBgRemoval: false }))
      .resolves.toMatchObject({ frameCount: 7 });
    expect(apiFetch).toHaveBeenCalledTimes(5);
    expect(mirrorCleanFrames).toHaveBeenCalledTimes(2);
    expect(vi.mocked(mirrorCleanFrames).mock.calls[1].slice(1)).toEqual([4, 7, 2, 2]);
  });
});
