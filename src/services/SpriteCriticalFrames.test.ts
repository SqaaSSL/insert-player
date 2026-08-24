import { beforeAll, describe, expect, it } from 'vitest';
import { installCanvasRuntime } from '../../processor/src/canvasRuntime.ts';
import { cleanSpriteSheet, computeRequestedSpriteGrid } from './SpritePostProcess.ts';

beforeAll(() => installCanvasRuntime());

function syntheticSheet(
  cols: number,
  rows: number,
  drawFrame: (context: CanvasRenderingContext2D, index: number, width: number, height: number) => void,
): string {
  const frameWidth = 120;
  const frameHeight = 160;
  const canvas = document.createElement('canvas');
  canvas.width = cols * frameWidth;
  canvas.height = rows * frameHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Test canvas is unavailable');
  context.fillStyle = '#00ff00';
  context.fillRect(0, 0, canvas.width, canvas.height);

  for (let index = 0; index < cols * rows; index += 1) {
    context.save();
    context.translate((index % cols) * frameWidth, Math.floor(index / cols) * frameHeight);
    drawFrame(context, index, frameWidth, frameHeight);
    context.restore();
  }
  return canvas.toDataURL('image/png').split(',')[1];
}

describe('critical sprite frame validation', () => {
  it('requests landscape cells for the eight KO key poses', () => {
    expect(computeRequestedSpriteGrid('ko', 8)).toEqual({ cols: 2, rows: 4 });
    expect(computeRequestedSpriteGrid('victory', 8)).toEqual({ cols: 4, rows: 2 });
  });

  it('rejects KO fragments that cross the left or right cell boundary', async () => {
    const sheet = syntheticSheet(4, 4, (context, index, width) => {
      context.fillStyle = '#9e2638';
      if (index < 12) {
        context.fillRect(35, 18, 50, 124);
      } else if (index % 2 === 0) {
        context.fillRect(0, 82, 72, 45);
      } else {
        context.fillRect(width - 72, 82, 72, 45);
      }
    });

    const result = await cleanSpriteSheet(sheet, 16, 4, 4, 'ko');

    expect(result.frameCount).toBe(8);
  });

  it('keeps complete victory poses and rejects frames cropped at the feet', async () => {
    const sheet = syntheticSheet(4, 2, (context, index, _width, height) => {
      context.fillStyle = '#9e2638';
      if (index < 6) {
        context.fillRect(35, 18, 50, 124);
      } else {
        context.fillRect(28, 45, 64, height - 45);
      }
    });

    const result = await cleanSpriteSheet(sheet, 8, 4, 2, 'victory');

    expect(result.frameCount).toBe(6);
  });
});
