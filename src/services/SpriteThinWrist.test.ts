import { beforeAll, describe, expect, it } from 'vitest';
import { installCanvasRuntime } from '../../processor/src/canvasRuntime';
import { cleanSpriteSheet } from './SpritePostProcess';

beforeAll(() => installCanvasRuntime());
function thinWristFixture(): string {
  const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 160;
  const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#00ff00'; ctx.fillRect(0, 0, 128, 160);
  ctx.fillStyle = '#666666'; ctx.fillRect(43, 18, 40, 125); // Body.
  ctx.fillRect(78, 52, 22, 15); // Raised forearm.
  ctx.fillRect(98, 58, 12, 2); // Valid narrow wrist, disconnected by one-pixel erosion.
  ctx.fillStyle = '#d28c54'; ctx.fillRect(109, 51, 14, 16); // Fist is part of the original silhouette.
  ctx.fillStyle = '#3344cc'; ctx.fillRect(12, 29, 4, 4); // Separate external noise must still disappear.
  return canvas.toDataURL('image/png').split(',')[1];
}
async function pixelCounts(base64: string): Promise<{ fist: number; noise: number }> {
  const image = new Image();
  await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = reject; image.src = `data:image/png;base64,${base64}`; });
  const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
  const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data; let fist = 0; let noise = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    if (pixels[i] > 170 && pixels[i + 1] > 90 && pixels[i + 1] < 175 && pixels[i + 2] < 130) fist++;
    if (pixels[i + 2] > 150 && pixels[i] < 100 && pixels[i + 1] < 120) noise++;
  }
  return { fist, noise };
}

describe('sprite cleanup preserves connected anatomy through edge erosion', () => {
  it.each(['crouch', 'jump', 'hit'])('retains the hand after a thin wrist erodes in %s while removing original detached noise', async animation => {
    const result = await cleanSpriteSheet(thinWristFixture(), 1, 1, 1, animation, undefined, { baselineRatio: 0.98 });
    const pixels = await pixelCounts(result.base64);
    expect(result.frameCount).toBe(1);
    expect(pixels.fist).toBeGreaterThan(1000);
    expect(pixels.noise).toBe(0);
  });
});
