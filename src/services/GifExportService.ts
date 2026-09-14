import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { getAnimationList } from './CharacterPipeline';
import type { CachedSprite } from './SpriteCache';
import { getBestCachedSpriteSheet, getSpriteSheetPlaybackFrameIndices } from './SpriteSheetSource';

interface GifFrameStep {
  sourceIndex: number;
  delayMs: number;
}

interface IndexedGifFrame {
  sourceIndex: number;
  palette: number[][];
  index: Uint8Array;
}

const DEFAULT_BG = '#09061a';
const MAX_CACHED_INDEXED_BYTES = 16 * 1024 * 1024;
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
  const source = getBestCachedSpriteSheet(sprite);
  const img = await blobToImage(source.blob);
  const frameW = source.frameWidth;
  const frameH = source.frameHeight;
  const gridCols = Math.round(img.width / frameW);
  const playbackFrameIndices = getSpriteSheetPlaybackFrameIndices(animationName, sprite.animationFormat, source);
  const plan = source.highDensity && sprite.animationFormat === 'video-dense-v1'
    ? (playbackFrameIndices ?? Array.from({ length: source.frameCount }, (_, index) => index))
      .map((sourceIndex) => ({ sourceIndex, delayMs: 120 }))
    : buildGifFramePlan(animationName, source.frameCount);

  const gif = GIFEncoder();
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = frameW;
  tempCanvas.height = frameH;
  const tempCtx = tempCanvas.getContext('2d')!;
  // Copy native pixels without sampling neighboring atlas cells at the edges.
  tempCtx.imageSmoothingEnabled = false;

  // Indexed pixels use one byte each. Bound their cache so the return half of
  // an HQ attack can reuse frames without retaining every full RGBA image.
  const indexedFrames = new Map<number, IndexedGifFrame>();
  let cachedIndexedBytes = 0;
  let encodedFrame: IndexedGifFrame | undefined;
  for (let i = 0; i < plan.length; i++) {
    // Quantizing an entire HQ animation in one task would freeze the gallery.
    // Let the browser paint the loading state and handle input between frames.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const step = plan[i];
    if (encodedFrame?.sourceIndex !== step.sourceIndex) {
      encodedFrame = indexedFrames.get(step.sourceIndex);
      if (encodedFrame) {
        indexedFrames.delete(step.sourceIndex);
        indexedFrames.set(step.sourceIndex, encodedFrame);
      }
    }
    if (!encodedFrame || encodedFrame.sourceIndex !== step.sourceIndex) {
      const sc = step.sourceIndex % gridCols;
      const sr = Math.floor(step.sourceIndex / gridCols);
      tempCtx.clearRect(0, 0, frameW, frameH);
      tempCtx.fillStyle = backgroundColor;
      tempCtx.fillRect(0, 0, frameW, frameH);
      tempCtx.drawImage(img, sc * frameW, sr * frameH, frameW, frameH, 0, 0, frameW, frameH);

      const imageData = tempCtx.getImageData(0, 0, frameW, frameH);
      const palette = quantize(imageData.data, 256);
      encodedFrame = {
        sourceIndex: step.sourceIndex,
        palette,
        index: applyPalette(imageData.data, palette),
      };
      if (encodedFrame.index.byteLength <= MAX_CACHED_INDEXED_BYTES) {
        while (cachedIndexedBytes + encodedFrame.index.byteLength > MAX_CACHED_INDEXED_BYTES) {
          const oldest = indexedFrames.values().next().value!;
          indexedFrames.delete(oldest.sourceIndex);
          cachedIndexedBytes -= oldest.index.byteLength;
        }
        indexedFrames.set(step.sourceIndex, encodedFrame);
        cachedIndexedBytes += encodedFrame.index.byteLength;
      }
    }
    const frameOpts: Record<string, unknown> = {
      palette: encodedFrame.palette,
      delay: step.delayMs,
    };
    if (i === 0) frameOpts.repeat = 0;
    gif.writeFrame(encodedFrame.index, frameW, frameH, frameOpts as never);
  }

  gif.finish();
  return new Blob([new Uint8Array(gif.bytes())], { type: 'image/gif' });
}
