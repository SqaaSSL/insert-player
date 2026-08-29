import { describe, expect, it } from 'vitest';
import { decontaminateGreenEdges, unionForegroundMasks } from './AlphaMask.ts';

describe('unionForegroundMasks', () => {
  it('restores DNN-only foreground with the DNN color and alpha', () => {
    const chroma = new Uint8ClampedArray([0, 255, 0, 0]);
    const dnn = new Uint8ClampedArray([174, 126, 98, 230]);

    unionForegroundMasks(chroma, dnn, 1, 1);

    expect(Array.from(chroma)).toEqual([174, 126, 98, 230]);
  });

  it('does not resurrect pure chroma background as a green fringe', () => {
    const chroma = new Uint8ClampedArray([0, 255, 0, 0]);
    const dnn = new Uint8ClampedArray([4, 244, 3, 96]);

    unionForegroundMasks(chroma, dnn, 1, 1);

    expect(Array.from(chroma)).toEqual([0, 255, 0, 0]);
  });

  it('keeps the stronger chroma result unchanged', () => {
    const chroma = new Uint8ClampedArray([210, 82, 63, 240]);
    const dnn = new Uint8ClampedArray([202, 90, 70, 180]);

    unionForegroundMasks(chroma, dnn, 1, 1);

    expect(Array.from(chroma)).toEqual([210, 82, 63, 240]);
  });

  it('removes chroma-only background connected to an image edge', () => {
    const chroma = new Uint8ClampedArray([
      244, 244, 244, 255, 244, 244, 244, 255, 0, 255, 0, 0,
      0, 255, 0, 0, 180, 90, 70, 255, 0, 255, 0, 0,
      0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0,
    ]);
    const dnn = new Uint8ClampedArray([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 0, 0,
      0, 255, 0, 0, 180, 90, 70, 255, 0, 255, 0, 0,
      0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0,
    ]);

    unionForegroundMasks(chroma, dnn, 3, 3);

    expect(Array.from(chroma.slice(0, 8))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(Array.from(chroma.slice(16, 20))).toEqual([180, 90, 70, 255]);
  });

  it('preserves an interior chroma-only detail enclosed by DNN foreground', () => {
    const chroma = new Uint8ClampedArray(5 * 5 * 4);
    const dnn = new Uint8ClampedArray(5 * 5 * 4);
    for (let y = 1; y <= 3; y += 1) {
      for (let x = 1; x <= 3; x += 1) {
        const offset = (y * 5 + x) * 4;
        chroma.set([174, 126, 98, 255], offset);
        dnn.set([174, 126, 98, x === 2 && y === 2 ? 0 : 255], offset);
      }
    }

    unionForegroundMasks(chroma, dnn, 5, 5);

    expect(Array.from(chroma.slice((2 * 5 + 2) * 4, (2 * 5 + 2) * 4 + 4)))
      .toEqual([174, 126, 98, 255]);
  });

  it('removes an isolated pure-green chroma island rejected by the DNN', () => {
    const chroma = new Uint8ClampedArray(3 * 3 * 4);
    const dnn = new Uint8ClampedArray(3 * 3 * 4);
    chroma.set([5, 250, 4, 255], (1 * 3 + 1) * 4);

    unionForegroundMasks(chroma, dnn, 3, 3);

    expect(Array.from(chroma.slice((1 * 3 + 1) * 4, (1 * 3 + 1) * 4 + 4)))
      .toEqual([0, 0, 0, 0]);
  });

  it('rejects mismatched RGBA buffers', () => {
    expect(() => unionForegroundMasks(
      new Uint8ClampedArray([0, 0, 0, 0]),
      new Uint8ClampedArray([0, 0, 0]),
      1,
      1,
    )).toThrow('equally sized RGBA');
  });

  it('rejects mismatched dimensions', () => {
    expect(() => unionForegroundMasks(
      new Uint8ClampedArray([0, 0, 0, 0]),
      new Uint8ClampedArray([0, 0, 0, 0]),
      2,
      1,
    )).toThrow('dimensions do not match');
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
