import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { getAnimationList } from './CharacterPipeline';
import type { CachedSprite } from './SpriteCache';

interface GifFrameStep {
  sourceIndex: number;
  delayMs: number;
}

const DEFAULT_BG = '#09061a';
const ANIM_DURATION_MS = new Map(
  getAnimationList().map((anim) => [anim.name, Math.round(anim.duration * 1000)]),
);

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image'));
    };
    img.src = url;
  });
}

function pushHold(steps: GifFrameStep[], sourceIndex: number, delayMs: number, holdMs: number): void {
  const repeats = Math.max(0, Math.round(holdMs / Math.max(10, delayMs)));
  for (let i = 0; i < repeats; i++) {
    steps.push({ sourceIndex, delayMs });
  }
}

function buildGifFramePlan(animationName: string, frameCount: number): GifFrameStep[] {
  const totalDurationMs = ANIM_DURATION_MS.get(animationName) ?? Math.max(frameCount * 110, 900);
  const baseDelayMs = clamp(Math.round(totalDurationMs / Math.max(1, frameCount)), 80, 160);
  const steps: GifFrameStep[] = [];
  const peakIndex = Math.floor(frameCount / 2);

  switch (animationName) {
    case 'idle':
      for (let i = 0; i < frameCount; i++) steps.push({ sourceIndex: i, delayMs: clamp(baseDelayMs, 110, 160) });
      break;
    case 'walk':
      for (let i = 0; i < frameCount; i++) steps.push({ sourceIndex: i, delayMs: clamp(baseDelayMs, 80, 110) });
      break;
    case 'jump':
      pushHold(steps, 0, baseDelayMs, 140);
      for (let i = 0; i < frameCount; i++) {
        steps.push({ sourceIndex: i, delayMs: clamp(baseDelayMs, 100, 150) });
        if (i === peakIndex) pushHold(steps, i, baseDelayMs, 180);
      }
      pushHold(steps, frameCount - 1, baseDelayMs, 220);
      break;
    case 'crouch':
      pushHold(steps, 0, baseDelayMs, 120);
      for (let i = 0; i < frameCount; i++) {
        steps.push({ sourceIndex: i, delayMs: clamp(baseDelayMs, 100, 150) });
      }
      pushHold(steps, frameCount - 1, baseDelayMs, 260);
      break;
    case 'hit':
      pushHold(steps, 0, baseDelayMs, 80);
      for (let i = 0; i < frameCount; i++) {
        steps.push({ sourceIndex: i, delayMs: clamp(baseDelayMs, 90, 130) });
      }
      pushHold(steps, frameCount - 1, baseDelayMs, 260);
      break;
    case 'ko':
      for (let i = 0; i < frameCount; i++) {
        steps.push({ sourceIndex: i, delayMs: clamp(baseDelayMs, 90, 130) });
      }
      pushHold(steps, frameCount - 1, baseDelayMs, 1200);
      break;
    case 'victory':
      pushHold(steps, 0, baseDelayMs, 120);
      for (let i = 0; i < frameCount; i++) {
        steps.push({ sourceIndex: i, delayMs: clamp(baseDelayMs, 100, 150) });
        if (i === peakIndex) pushHold(steps, i, baseDelayMs, 220);
      }
      pushHold(steps, frameCount - 1, baseDelayMs, 900);
      break;
    case 'high_punch':
    case 'low_punch':
      pushHold(steps, 0, baseDelayMs, 80);
      for (let i = 0; i < frameCount; i++) {
        steps.push({ sourceIndex: i, delayMs: clamp(baseDelayMs, 85, 120) });
        if (i === peakIndex) pushHold(steps, i, baseDelayMs, 170);
      }
      pushHold(steps, frameCount - 1, baseDelayMs, 260);
      break;
    case 'high_kick':
    case 'low_kick':
      pushHold(steps, 0, baseDelayMs, 90);
      for (let i = 0; i < frameCount; i++) {
        steps.push({ sourceIndex: i, delayMs: clamp(baseDelayMs, 90, 130) });
        if (i === peakIndex) pushHold(steps, i, baseDelayMs, 220);
      }
      pushHold(steps, frameCount - 1, baseDelayMs, 320);
      break;
    default:
      for (let i = 0; i < frameCount; i++) {
        steps.push({ sourceIndex: i, delayMs: baseDelayMs });
      }
      pushHold(steps, frameCount - 1, baseDelayMs, 220);
      break;
  }

  return steps;
}

export async function exportAnimationGif(
  sprite: CachedSprite,
  animationName: string,
  backgroundColor = DEFAULT_BG,
): Promise<Blob> {
  const img = await blobToImage(sprite.pngBlob);
  const frameW = sprite.frameWidth;
  const frameH = sprite.frameHeight;
  const gridCols = Math.round(img.width / frameW);
  const plan = buildGifFramePlan(animationName, sprite.frameCount);

  const gif = GIFEncoder();
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = frameW;
  tempCanvas.height = frameH;
  const tempCtx = tempCanvas.getContext('2d')!;
  tempCtx.imageSmoothingEnabled = true;
  tempCtx.imageSmoothingQuality = 'high';

  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];
    const sc = step.sourceIndex % gridCols;
    const sr = Math.floor(step.sourceIndex / gridCols);
    tempCtx.clearRect(0, 0, frameW, frameH);
    tempCtx.fillStyle = backgroundColor;
    tempCtx.fillRect(0, 0, frameW, frameH);
    tempCtx.drawImage(img, sc * frameW, sr * frameH, frameW, frameH, 0, 0, frameW, frameH);

    const imageData = tempCtx.getImageData(0, 0, frameW, frameH);
    const palette = quantize(imageData.data, 256);
    const index = applyPalette(imageData.data, palette);
    const frameOpts: Record<string, unknown> = {
      palette,
      delay: step.delayMs,
    };
    if (i === 0) frameOpts.repeat = 0;
    gif.writeFrame(index, frameW, frameH, frameOpts as never);
  }

  gif.finish();
  return new Blob([new Uint8Array(gif.bytes())], { type: 'image/gif' });
}
