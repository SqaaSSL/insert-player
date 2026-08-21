import { describe, expect, it } from 'vitest';
import { decontaminateGreenEdges, unionForegroundMasks } from './AlphaMask.ts';

describe('unionForegroundMasks', () => {
  it('restores DNN-only foreground with the DNN color and alpha', () => {
    const chroma = new Uint8ClampedArray([0, 255, 0, 0]);
    const dnn = new Uint8ClampedArray([174, 126, 98, 230]);

    unionForegroundMasks(chroma, dnn);

    expect(Array.from(chroma)).toEqual([174, 126, 98, 230]);
  });

  it('does not resurrect pure chroma background as a green fringe', () => {
    const chroma = new Uint8ClampedArray([0, 255, 0, 0]);
    const dnn = new Uint8ClampedArray([4, 244, 3, 96]);

    unionForegroundMasks(chroma, dnn);

    expect(Array.from(chroma)).toEqual([0, 255, 0, 0]);
  });

  it('keeps the stronger chroma result unchanged', () => {
    const chroma = new Uint8ClampedArray([210, 82, 63, 240]);
    const dnn = new Uint8ClampedArray([202, 90, 70, 180]);

    unionForegroundMasks(chroma, dnn);

    expect(Array.from(chroma)).toEqual([210, 82, 63, 240]);
  });

  it('rejects mismatched RGBA buffers', () => {
    expect(() => unionForegroundMasks(
      new Uint8ClampedArray([0, 0, 0, 0]),
      new Uint8ClampedArray([0, 0, 0]),
    )).toThrow('equally sized RGBA');
  });
});

describe('decontaminateGreenEdges', () => {
  it('replaces a chroma fringe with nearby opaque foreground color', () => {
    const pixels = new Uint8ClampedArray([
      180, 30, 30, 255,
      60, 190, 40, 230,
      0, 255, 0, 0,
    ]);

    decontaminateGreenEdges(pixels, 3, 1);

    expect(Array.from(pixels)).toEqual([
      180, 30, 30, 255,
      180, 30, 30, 230,
      180, 30, 30, 0,
    ]);
  });

  it('also removes dark green edge contamination', () => {
    const pixels = new Uint8ClampedArray([
      24, 28, 18, 255,
      5, 56, 4, 180,
      0, 255, 0, 0,
    ]);

    decontaminateGreenEdges(pixels, 3, 1);

    expect(Array.from(pixels.slice(4, 8))).toEqual([24, 28, 18, 180]);
  });

  it('preserves a green region that continues into the opaque interior', () => {
    const greenRegion = Array.from({ length: 19 }, (_, index) => [
      35,
      150,
      45,
      index === 0 || index === 18 ? 240 : 255,
    ]).flat();
    const pixels = new Uint8ClampedArray([0, 255, 0, 0, ...greenRegion, 0, 255, 0, 0]);
    const expectedVisible = Array.from(pixels.slice(4, -4));

    decontaminateGreenEdges(pixels, 21, 1);

    expect(Array.from(pixels.slice(4, -4))).toEqual(expectedVisible);
  });

  it('leaves opaque interior green untouched', () => {
    const pixels = new Uint8ClampedArray([
      20, 130, 30, 255,
      20, 130, 30, 255,
      20, 130, 30, 255,
    ]);

    decontaminateGreenEdges(pixels, 3, 1);

    expect(Array.from(pixels)).toEqual([
      20, 130, 30, 255,
      20, 130, 30, 255,
      20, 130, 30, 255,
    ]);
  });

  it('rejects mismatched dimensions', () => {
    expect(() => decontaminateGreenEdges(new Uint8ClampedArray(8), 3, 1))
      .toThrow('dimensions do not match');
  });
});
