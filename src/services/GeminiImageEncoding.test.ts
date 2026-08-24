import { beforeAll, describe, expect, it } from 'vitest';
import { installCanvasRuntime } from '../../processor/src/canvasRuntime.ts';
import {
  isPngBase64,
  normalizeGeneratedImageToPng,
} from './GeminiApi.ts';

beforeAll(() => installCanvasRuntime());

function encodedCanvas(mimeType: 'image/jpeg' | 'image/png'): string {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 2;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Test canvas is unavailable');
  context.fillStyle = '#b5253c';
  context.fillRect(0, 0, 2, 2);
  return canvas.toDataURL(mimeType).split(',')[1];
}

describe('Gemini image encoding', () => {
  it('keeps real PNG payloads unchanged', async () => {
    const png = encodedCanvas('image/png');

    await expect(normalizeGeneratedImageToPng(png, 'image/png')).resolves.toBe(png);
    expect(isPngBase64(png)).toBe(true);
  });

  it('normalizes a Gemini JPEG payload to a real PNG', async () => {
    const jpeg = encodedCanvas('image/jpeg');

    expect(isPngBase64(jpeg)).toBe(false);
    const normalized = await normalizeGeneratedImageToPng(jpeg, 'image/jpeg');
    expect(isPngBase64(normalized)).toBe(true);
  });
});
