/**
 * Post-processes Gemini output images:
 * 1. Chroma-key background removal (green #00FF00)
 * 2. For single images: crop to character bbox, pad to rect
 * 3. For sprite sheets: detect actual grid layout from image,
 *    remove bg per-frame, normalize each frame with a pose-aware profile,
 *    and recompose into a clean grid
 */

import { getAnimationProfile, type AnimationProfile } from './AnimationProfiles';
import { debugInfo, publishDebugLog } from './DebugLog';
import { decontaminateGreenEdges } from './AlphaMask';
import { expandMirroredSequence } from './FrameSequence';
import { inferSpriteGridFromSubjects, type SubjectBox } from './SpriteGrid';

const ALPHA_THRESHOLD = 15;
// CELL_W/CELL_H is the per-frame resolution stored in the IndexedDB sprite
// cache — not the in-game render size. Phaser renders fighters at
// FIGHTER_WIDTH/FIGHTER_HEIGHT (192×256) via AiSpriteLoader, which downsamples
// from whatever this cache resolution is. Larger cells = higher-fidelity
// previews/GIF/RAW exports + better GPU-downsampled in-game textures, at a
// proportional cache-size cost. 4× (768×1024) puts each frame at roughly
// native Gemini output resolution so almost no detail is lost in normalization.
export const CELL_W = 768;
export const CELL_H = 1024;

const GREEN_HUE_MIN = 70;
const GREEN_HUE_MAX = 170;
const GREEN_SAT_MIN = 0.20;
const GREEN_BRIGHT_MIN = 30;
interface ReliableFrameConfig {
  minFrames: number;
  maxFrames: number;
  allowBestEffortFill?: boolean;
  referenceMode?: 'median' | 'upper-percentile';
  minAreaRatio?: number;
  minHeightRatio?: number;
  minWidthRatio?: number;
  minVerticalFill?: number;
  edgeMargin?: number;
  requireBottomMargin?: boolean;
}

const CRITICAL_ANIMATION_CONFIG: Partial<Record<string, ReliableFrameConfig>> = {
  idle: {
    minFrames: 8,
    maxFrames: 8,
    allowBestEffortFill: false,
    referenceMode: 'upper-percentile',
    minAreaRatio: 0.78,
    minHeightRatio: 0.9,
    minWidthRatio: 0.74,
    minVerticalFill: 0.56,
    edgeMargin: 4,
    requireBottomMargin: true,
  },
  walk: {
    minFrames: 12,
    maxFrames: 16,
    allowBestEffortFill: false,
    referenceMode: 'upper-percentile',
    minAreaRatio: 0.72,
    minHeightRatio: 0.82,
    minWidthRatio: 0.72,
    minVerticalFill: 0.5,
  },
  jump: { minFrames: 3, maxFrames: 4 },
  hit: { minFrames: 2, maxFrames: 4 },
  low_punch: { minFrames: 3, maxFrames: 4 },
  low_kick: { minFrames: 3, maxFrames: 4 },
  ko: {
    minFrames: 8,
    maxFrames: 8,
    allowBestEffortFill: false,
    minAreaRatio: 0.3,
    minHeightRatio: 0.25,
    minWidthRatio: 0.35,
    minVerticalFill: 0.18,
    edgeMargin: 4,
  },
  victory: {
    minFrames: 6,
    maxFrames: 8,
    allowBestEffortFill: false,
    minAreaRatio: 0.55,
    minHeightRatio: 0.7,
    minWidthRatio: 0.45,
    minVerticalFill: 0.38,
    edgeMargin: 4,
    requireBottomMargin: true,
  },
};

// ─── Single image processing (for reposed character) ─────────────────

export interface NormalizationReference {
  targetDrawHeight?: number;
  targetDrawWidth?: number;
  baselineRatio?: number;
}

export async function cleanReposedImage(
  base64: string,
  profileName = 'idle',
  normalizationReference?: NormalizationReference,
): Promise<string> {
  const img = await loadImg(`data:image/png;base64,${base64}`);
  const profile = getAnimationProfile(profileName);

  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

  const bgType = detectDominantBgColor([canvas]);
  if (bgType === 'green') {
    chromaKeyRemove(imageData);
  } else {
    lightBgRemove(imageData);
  }
  erodeAlphaEdge(imageData);
  ctx.putImageData(imageData, 0, 0);

  const bbox = findBoundingBox(imageData);
  if (!bbox) return base64;

  const normalized = normalizeCanvasToCell(canvas, bbox, profile, undefined, undefined, undefined, normalizationReference);
  if (profileName === 'crouch') {
    const targetDrawH = Math.round(normalizationReference?.targetDrawHeight ?? CELL_H * profile.targetHeightRatio);
    const targetDrawW = Math.round(normalizationReference?.targetDrawWidth ?? CELL_W * profile.targetWidthRatio);
    const message =
      `[SpritePostProcess] Reposed crouch normalize: bbox=${bbox.w}x${bbox.h}@(${bbox.x},${bbox.y}) ` +
      `target=${targetDrawW}x${targetDrawH} baseline=${(normalizationReference?.baselineRatio ?? profile.baselineRatio).toFixed(3)} scale=${normalized.usedScale.toFixed(3)}`;
    debugInfo(message);
    publishDebugLog(message);
  }

  return normalized.canvas.toDataURL('image/png').split(',')[1];
}

// Neutralizes green ambient bounce on character pixels BEFORE any segmentation
// runs. The Gemini output puts the character on a pure green background; bright
// skin/clothing highlights pick up a subtle green tint from the rendered
// "ambient bounce" of the green bg. That tint confuses both BiRefNet (DNN
// segmentation) and chroma-key — they can mistake green-tinted skin for
// background.
//
// This function fixes the input image once, then the SAME corrected image is
// fed to BOTH segmentation paths. The pure-green bg pixels (where r and b are
// both very low) are left UNTOUCHED so chroma-key can still detect and remove
// them. Only character pixels with a slight green dominance get their green
// channel pulled toward max(r, b), removing the spill without affecting hue
// of legitimately green/yellow surfaces.
function preNeutralizeGreenSpill(data: ImageData): void {
  const d = data.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];

    // Skip if green is not the dominant channel — no spill to remove here.
    if (g <= r || g <= b) continue;
    // Skip if this looks like the actual chroma background (very low r AND
    // low b) — leave for the chroma-key flood-fill to handle later.
    if (r < 55 && b < 55) continue;

    const target = Math.max(r, b);
    const excess = g - target;
    if (excess < 4) continue;

    // Pull the green channel most of the way to max(r, b). Keep ~15% of the
    // original excess so genuinely green-tinted surfaces (sweater, foliage)
    // still read as green, just without the rendered glow.
    d[i + 1] = Math.min(255, target + Math.round(excess * 0.15));
  }
}

// Public wrapper: takes a base64 PNG with green spill, returns a base64 PNG
// where the spill is neutralized on character pixels but the chroma-green bg
// is preserved untouched. Use BEFORE any segmentation step.
export async function neutralizeGreenSpillForSegmentation(base64: string): Promise<string> {
  const img = await loadImg(`data:image/png;base64,${base64}`);
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  preNeutralizeGreenSpill(imageData);
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL('image/png').split(',')[1];
}

export async function cleanReposedImagePreserveCanvas(base64: string): Promise<string> {
  const img = await loadImg(`data:image/png;base64,${base64}`);
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const bgType = detectDominantBgColor([canvas]);
  if (bgType === 'green') {
    chromaKeyRemove(imageData);
  } else {
    lightBgRemove(imageData);
  }
  ctx.putImageData(imageData, 0, 0);

  return canvas.toDataURL('image/png').split(',')[1];
}

export async function zoomTransparentImageToBottom(base64: string, scale: number): Promise<string> {
  const img = await loadImg(`data:image/png;base64,${base64}`);
  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = img.width;
  sourceCanvas.height = img.height;
  const sourceCtx = sourceCanvas.getContext('2d')!;
  sourceCtx.drawImage(img, 0, 0);

  const imageData = sourceCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
  const bbox = findBoundingBox(imageData);
  if (!bbox || scale >= 0.999) return base64;

  const out = document.createElement('canvas');
  out.width = sourceCanvas.width;
  out.height = sourceCanvas.height;
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const drawW = Math.max(1, Math.round(bbox.w * scale));
  const drawH = Math.max(1, Math.round(bbox.h * scale));
  const drawX = Math.round(bbox.x + (bbox.w - drawW) / 2);
  const drawY = Math.round(bbox.y + bbox.h - drawH);

  ctx.drawImage(
    sourceCanvas,
    bbox.x,
    bbox.y,
    bbox.w,
    bbox.h,
    drawX,
    drawY,
    drawW,
    drawH,
  );

  return out.toDataURL('image/png').split(',')[1];
}

export async function normalizeTransparentReposedImage(
  base64: string,
  profileName = 'idle',
  normalizationReference?: NormalizationReference,
): Promise<string> {
  const img = await loadImg(`data:image/png;base64,${base64}`);
  const profile = getAnimationProfile(profileName);

  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const bbox = findBoundingBox(imageData);
  if (!bbox) return base64;

  const normalized = normalizeCanvasToCell(canvas, bbox, profile, undefined, undefined, undefined, normalizationReference);
  if (profileName === 'crouch') {
    const targetDrawH = Math.round(normalizationReference?.targetDrawHeight ?? CELL_H * profile.targetHeightRatio);
    const targetDrawW = Math.round(normalizationReference?.targetDrawWidth ?? CELL_W * profile.targetWidthRatio);
    const message =
      `[SpritePostProcess] Transparent crouch normalize: bbox=${bbox.w}x${bbox.h}@(${bbox.x},${bbox.y}) ` +
      `target=${targetDrawW}x${targetDrawH} baseline=${(normalizationReference?.baselineRatio ?? profile.baselineRatio).toFixed(3)} scale=${normalized.usedScale.toFixed(3)}`;
    debugInfo(message);
    publishDebugLog(message);
  }

  return normalized.canvas.toDataURL('image/png').split(',')[1];
}

// ─── Sprite sheet processing ─────────────────────────────────────────

export interface CleanSheetResult {
  base64: string;
  rawBase64: string;
  gridCols: number;
  gridRows: number;
  frameCount: number;
  frameW: number;
  frameH: number;
  usedScale: number;
}

function sliceImageIntoGrid(img: HTMLImageElement, cols: number, rows: number): HTMLCanvasElement[] {
  const frameWidth = Math.round(img.width / cols);
  const frameHeight = Math.round(img.height / rows);
  const frames: HTMLCanvasElement[] = [];

  for (let index = 0; index < cols * rows; index += 1) {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const canvas = document.createElement('canvas');
    canvas.width = frameWidth;
    canvas.height = frameHeight;
    canvas.getContext('2d')!.drawImage(
      img,
      col * frameWidth,
      row * frameHeight,
      frameWidth,
      frameHeight,
      0,
      0,
      frameWidth,
      frameHeight,
    );
    frames.push(canvas);
  }

  return frames;
}

function findOpaqueSubjectBoxes(data: ImageData): SubjectBox[] {
  const pixels = data.data;
  const width = data.width;
  const height = data.height;
  const visited = new Uint8Array(width * height);
  const subjects: SubjectBox[] = [];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const start = y * width + x;
      if (visited[start] || pixels[start * 4 + 3] <= ALPHA_THRESHOLD) continue;

      visited[start] = 1;
      const stack = [start];
      let area = 0;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;

      while (stack.length > 0) {
        const index = stack.pop()!;
        const currentX = index % width;
        const currentY = Math.floor(index / width);
        area += 1;
        minX = Math.min(minX, currentX);
        maxX = Math.max(maxX, currentX);
        minY = Math.min(minY, currentY);
        maxY = Math.max(maxY, currentY);

        for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
          for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
            if (offsetX === 0 && offsetY === 0) continue;
            const nextX = currentX + offsetX;
            const nextY = currentY + offsetY;
            if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) continue;
            const next = nextY * width + nextX;
            if (visited[next] || pixels[next * 4 + 3] <= ALPHA_THRESHOLD) continue;
            visited[next] = 1;
            stack.push(next);
          }
        }
      }

      subjects.push({
        x: minX,
        y: minY,
        w: maxX - minX + 1,
        h: maxY - minY + 1,
        area,
      });
    }
  }

  return subjects;
}

function inferSpriteGrid(
  img: HTMLImageElement,
  bgIsGreen: boolean,
  expectedFrameCount: number,
): ReturnType<typeof inferSpriteGridFromSubjects> {
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const context = canvas.getContext('2d')!;
  context.drawImage(img, 0, 0);
  const data = context.getImageData(0, 0, canvas.width, canvas.height);
  if (bgIsGreen) {
    chromaKeyRemove(data);
  } else {
    lightBgRemove(data);
  }
  erodeAlphaEdge(data);
  return inferSpriteGridFromSubjects(
    img.width,
    img.height,
    findOpaqueSubjectBoxes(data),
    expectedFrameCount,
  );
}

export async function cleanSpriteSheet(
  base64: string,
  expectedFrameCount: number,
  expectedGridCols: number,
  expectedGridRows: number,
  animationName: string,
  maxScale?: number,
  normalizationReference?: NormalizationReference,
): Promise<CleanSheetResult> {
  const img = await loadImg(`data:image/png;base64,${base64}`);
  const profile = getAnimationProfile(animationName);

  const expectedFrames = sliceImageIntoGrid(img, expectedGridCols, expectedGridRows);
  const bgIsGreen = detectDominantBgColor(expectedFrames) === 'green';
  const inferredGrid = inferSpriteGrid(img, bgIsGreen, expectedFrameCount);
  const gridCols = inferredGrid?.cols ?? expectedGridCols;
  const gridRows = inferredGrid?.rows ?? expectedGridRows;
  if (gridCols !== expectedGridCols || gridRows !== expectedGridRows) {
    debugInfo(
      `[SpritePostProcess] Inferred ${gridCols}x${gridRows} grid from ${inferredGrid?.subjectCount ?? 0} subjects; ` +
      `prompt requested ${expectedGridCols}x${expectedGridRows}`,
    );
  } else {
    debugInfo(`[SpritePostProcess] Using ${gridCols}x${gridRows} grid (${expectedFrameCount} requested frames)`);
  }

  const srcFrameW = Math.round(img.width / gridCols);
  const srcFrameH = Math.round(img.height / gridRows);

  const rawFrames = sliceImageIntoGrid(img, gridCols, gridRows);

  for (const frame of rawFrames) {
    const ctx = frame.getContext('2d')!;
    const data = ctx.getImageData(0, 0, frame.width, frame.height);
    if (bgIsGreen) {
      chromaKeyRemove(data);
    } else {
      lightBgRemove(data);
    }
    erodeAlphaEdge(data);
    if (animationName === 'jump' || animationName === 'hit') {
      removeDetachedComponents(data, 'largest');
    } else {
      removeDetachedComponents(data, 'conservative');
    }
    ctx.putImageData(data, 0, 0);
  }

  // Drop empty trailing frames (Gemini sometimes adds blank cells to fill the grid)
  while (rawFrames.length > 1) {
    const last = rawFrames[rawFrames.length - 1];
    const ctx = last.getContext('2d')!;
    const data = ctx.getImageData(0, 0, last.width, last.height);
    if (frameHasContent(data)) break;
    rawFrames.pop();
  }

  let workingFrames = rawFrames;
  let frameBBoxes = rawFrames.map((frame) => getCanvasBoundingBox(frame));
  const criticalConfig = CRITICAL_ANIMATION_CONFIG[animationName];
  if (criticalConfig) {
    const filtered = filterCriticalAnimationFrames(
      workingFrames,
      frameBBoxes,
      srcFrameW,
      srcFrameH,
      criticalConfig,
      animationName,
    );
    workingFrames = filtered.frames;
    frameBBoxes = filtered.boxes;
  }

  if (workingFrames.length > expectedFrameCount) {
    const selectedIndices = sampleOrderedIndices(
      workingFrames.map((_, index) => index),
      expectedFrameCount,
    );
    debugInfo(
      `[SpritePostProcess] ${animationName}: sampled ${workingFrames.length} detected frames down to ${expectedFrameCount}`,
    );
    workingFrames = selectedIndices.map((index) => workingFrames[index]);
    frameBBoxes = selectedIndices.map((index) => frameBBoxes[index]);
  }

  const finalCount = workingFrames.length;
  const populatedBoxes = frameBBoxes.filter((bbox): bbox is BBox => bbox != null);
  if (populatedBoxes.length === 0) {
    return { base64, rawBase64: base64, gridCols, gridRows, frameCount: finalCount, frameW: srcFrameW, frameH: srcFrameH, usedScale: 1 };
  }
  const stableCenterXRaw = median(populatedBoxes.map((bbox) => bbox.x + bbox.w / 2));
  const lockedScale = profile.lockScaleAcrossFrames
    ? getLockedAnimationScale(populatedBoxes, profile, maxScale, normalizationReference)
    : undefined;
  if (animationName === 'crouch' || animationName === 'low_punch' || animationName === 'low_kick') {
    const boxSummary = populatedBoxes
      .map((bbox, index) => `#${index}:${bbox.w}x${bbox.h}@(${bbox.x},${bbox.y})`)
      .join(' ');
    const message =
      `[SpritePostProcess] ${animationName} normalize: boxes=${boxSummary} ` +
      `lockedScale=${lockedScale?.toFixed(3) ?? 'none'} ` +
      `reference=${normalizationReference ? `${Math.round(normalizationReference.targetDrawWidth ?? 0)}x${Math.round(normalizationReference.targetDrawHeight ?? 0)} baseline=${(normalizationReference.baselineRatio ?? 0).toFixed(3)}` : 'none'}`;
    debugInfo(message);
    publishDebugLog(message);
  }

  const cleanFrames: HTMLCanvasElement[] = [];
  const usedScales: number[] = [];
  for (let i = 0; i < workingFrames.length; i++) {
    const bbox = frameBBoxes[i];
    if (!bbox) {
      const blank = document.createElement('canvas');
      blank.width = CELL_W;
      blank.height = CELL_H;
      cleanFrames.push(blank);
      continue;
    }

    const normalized = normalizeCanvasToCell(
      workingFrames[i],
      bbox,
      profile,
      maxScale,
      stableCenterXRaw,
      lockedScale,
      normalizationReference,
    );
    const normalizedCtx = normalized.canvas.getContext('2d')!;
    const normalizedData = normalizedCtx.getImageData(
      0,
      0,
      normalized.canvas.width,
      normalized.canvas.height,
    );
    decontaminateGreenEdges(
      normalizedData.data,
      normalized.canvas.width,
      normalized.canvas.height,
    );
    normalizedCtx.putImageData(normalizedData, 0, 0);
    usedScales.push(normalized.usedScale);
    cleanFrames.push(normalized.canvas);
  }

  const outCols = computeGridCols(finalCount);
  const outRows = Math.ceil(finalCount / outCols);

  const outCanvas = document.createElement('canvas');
  outCanvas.width = outCols * CELL_W;
  outCanvas.height = outRows * CELL_H;
  const outCtx = outCanvas.getContext('2d')!;

  for (let i = 0; i < finalCount; i++) {
    const col = i % outCols;
    const row = Math.floor(i / outCols);
    outCtx.drawImage(cleanFrames[i], col * CELL_W, row * CELL_H);
  }

  const resultBase64 = outCanvas.toDataURL('image/png').split(',')[1];
  const usedScale = usedScales.length > 0 ? median(usedScales) : 1;
  debugInfo(
    `[SpritePostProcess] Cleaned ${finalCount} frames: ${srcFrameW}x${srcFrameH} → ${CELL_W}x${CELL_H} ` +
    `(grid ${gridCols}x${gridRows}, anim ${animationName}, bg: ${bgIsGreen ? 'green' : 'light'}, target ${Math.round(profile.targetHeightRatio * 100)}%, scale ${usedScale.toFixed(2)})`
  );

  return {
    base64: resultBase64,
    rawBase64: base64,
    gridCols: outCols,
    gridRows: outRows,
    frameCount: finalCount,
    frameW: CELL_W,
    frameH: CELL_H,
    usedScale,
  };
}

export async function mirrorCleanFrames(
  base64: string,
  halfFrames: number,
  totalFrames: number,
  srcCols: number,
  srcRows: number,
): Promise<CleanSheetResult> {
  const img = await loadImg(`data:image/png;base64,${base64}`);
  const frameW = Math.round(img.width / srcCols);
  const frameH = Math.round(img.height / srcRows);

  const extracted: HTMLCanvasElement[] = [];
  for (let i = 0; i < halfFrames; i++) {
    const col = i % srcCols;
    const row = Math.floor(i / srcCols);
    const c = document.createElement('canvas');
    c.width = frameW;
    c.height = frameH;
    c.getContext('2d')!.drawImage(img, col * frameW, row * frameH, frameW, frameH, 0, 0, frameW, frameH);
    extracted.push(c);
  }

  const full = expandMirroredSequence(extracted, totalFrames);

  const outCols = computeGridCols(totalFrames);
  const outRows = Math.ceil(totalFrames / outCols);

  const outCanvas = document.createElement('canvas');
  outCanvas.width = outCols * frameW;
  outCanvas.height = outRows * frameH;
  const outCtx = outCanvas.getContext('2d')!;

  for (let i = 0; i < totalFrames; i++) {
    outCtx.drawImage(full[i], (i % outCols) * frameW, Math.floor(i / outCols) * frameH);
  }

  debugInfo(`[SpritePostProcess] Mirrored ${halfFrames} → ${totalFrames} frames (${outCols}x${outRows})`);

  return {
    base64: outCanvas.toDataURL('image/png').split(',')[1],
    rawBase64: base64,
    gridCols: outCols,
    gridRows: outRows,
    frameCount: totalFrames,
    frameW,
    frameH,
    usedScale: 1,
  };
}

// ─── Grid detection ──────────────────────────────────────────────────

function detectGrid(img: HTMLImageElement): { cols: number; rows: number } {
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, img.width, img.height);
  const d = data.data;
  const w = img.width;
  const h = img.height;

  // Scan vertical lines: for each x, count how many pixels in that column are green
  const greenThreshold = 0.7;
  const vGreen = new Float64Array(w);
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = 0; y < h; y++) {
      if (isGreenPixel(d, (y * w + x) * 4)) count++;
    }
    vGreen[x] = count / h;
  }

  // Scan horizontal lines
  const hGreen = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    let count = 0;
    for (let x = 0; x < w; x++) {
      if (isGreenPixel(d, (y * w + x) * 4)) count++;
    }
    hGreen[y] = count / w;
  }

  const cols = countDividers(vGreen, w) + 1;
  const rows = countDividers(hGreen, h) + 1;

  // Clamp to reasonable values
  return {
    cols: Math.max(1, Math.min(cols, 8)),
    rows: Math.max(1, Math.min(rows, 8)),
  };
}

function isGreenPixel(d: Uint8ClampedArray, i: number): boolean {
  const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
  if (a < 128) return false;
  return g > 100 && g > r * 1.3 && g > b * 1.3;
}

function countDividers(greenRatio: Float64Array, len: number): number {
  // Find positions where green ratio is high (>70%) — these are grid dividers
  // Group consecutive high-green columns/rows into single dividers
  const threshold = 0.6;
  const minGap = len * 0.08; // minimum gap between dividers (at least 8% of dimension)
  const edgeMargin = len * 0.05; // ignore edges

  const dividers: number[] = [];
  let inDivider = false;
  let divStart = 0;

  for (let i = 0; i < len; i++) {
    if (greenRatio[i] >= threshold) {
      if (!inDivider) {
        divStart = i;
        inDivider = true;
      }
    } else if (inDivider) {
      const mid = (divStart + i) / 2;
      // Skip edge dividers
      if (mid > edgeMargin && mid < len - edgeMargin) {
        if (dividers.length === 0 || mid - dividers[dividers.length - 1] > minGap) {
          dividers.push(mid);
        }
      }
      inDivider = false;
    }
  }

  return dividers.length;
}

function frameHasContent(data: ImageData): boolean {
  const d = data.data;
  let opaquePixels = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > ALPHA_THRESHOLD) opaquePixels++;
  }
  return opaquePixels > (data.width * data.height * 0.01);
}

// ─── Grid math ───────────────────────────────────────────────────────

export function computeGridCols(frames: number): number {
  if (frames <= 4) return 2;
  if (frames <= 8) return 4;
  return 4;
}

export function computeRequestedSpriteGrid(
  animationName: string,
  frames: number,
): { cols: number; rows: number } {
  if (animationName === 'ko' && frames === 8) {
    return { cols: 2, rows: 4 };
  }
  const cols = computeGridCols(frames);
  return { cols, rows: Math.ceil(frames / cols) };
}

// ─── Background color detection ─────────────────────────────────────

function detectDominantBgColor(frames: HTMLCanvasElement[]): 'green' | 'light' {
  let greenCount = 0;
  let lightCount = 0;
  const sampleSize = 10;

  for (const frame of frames.slice(0, 4)) {
    const ctx = frame.getContext('2d')!;
    const w = frame.width;
    const h = frame.height;
    const corners = [
      ctx.getImageData(0, 0, sampleSize, sampleSize),
      ctx.getImageData(w - sampleSize, 0, sampleSize, sampleSize),
      ctx.getImageData(0, h - sampleSize, sampleSize, sampleSize),
      ctx.getImageData(w - sampleSize, h - sampleSize, sampleSize, sampleSize),
    ];

    for (const corner of corners) {
      const d = corner.data;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
        if (a < 128) continue;
        if (g > 100 && g > r * 1.3 && g > b * 1.3) greenCount++;
        else if (r > 180 && g > 180 && b > 180) lightCount++;
      }
    }
  }

  return greenCount > lightCount ? 'green' : 'light';
}

// ─── Light background removal (white/gray) ──────────────────────────

function lightBgRemove(data: ImageData): void {
  const d = data.data;
  const w = data.width;
  const h = data.height;

  // Flood-fill from edges: any near-white pixel connected to an edge is background
  const visited = new Uint8Array(w * h);
  const queue: number[] = [];

  const isLightBg = (i: number) => {
    const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
    if (a < 128) return true;
    const lum = r * 0.299 + g * 0.587 + b * 0.114;
    const sat = (Math.max(r, g, b) - Math.min(r, g, b)) / (Math.max(r, g, b) + 1);
    return lum > 200 && sat < 0.15;
  };

  // Seed edges
  for (let x = 0; x < w; x++) {
    for (const y of [0, h - 1]) {
      const idx = y * w + x;
      if (!visited[idx] && isLightBg(idx * 4)) {
        visited[idx] = 1;
        queue.push(idx);
      }
    }
  }
  for (let y = 0; y < h; y++) {
    for (const x of [0, w - 1]) {
      const idx = y * w + x;
      if (!visited[idx] && isLightBg(idx * 4)) {
        visited[idx] = 1;
        queue.push(idx);
      }
    }
  }

  // BFS flood fill
  while (queue.length > 0) {
    const idx = queue.pop()!;
    const x = idx % w;
    const y = Math.floor(idx / w);

    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const nIdx = ny * w + nx;
      if (visited[nIdx]) continue;
      if (isLightBg(nIdx * 4)) {
        visited[nIdx] = 1;
        queue.push(nIdx);
      }
    }
  }

  // Remove visited pixels + soften edges
  for (let i = 0; i < visited.length; i++) {
    if (visited[i]) {
      d[i * 4 + 3] = 0;
    }
  }

  // Anti-alias: pixels adjacent to removed pixels that are light get partial transparency
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      if (visited[idx]) continue;
      let removedNeighbors = 0;
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        if (visited[(y + dy) * w + (x + dx)]) removedNeighbors++;
      }
      if (removedNeighbors > 0) {
        const pi = idx * 4;
        const lum = d[pi] * 0.299 + d[pi + 1] * 0.587 + d[pi + 2] * 0.114;
        if (lum > 180) {
          d[pi + 3] = Math.round(d[pi + 3] * (1 - removedNeighbors * 0.2));
        }
      }
    }
  }
}

// ─── Chroma key background removal ──────────────────────────────────

// Returns true for pixels that look like background-ish green. Used by edge
// flood-fill — relaxed enough to catch anti-aliased edge spill, but still
// requires green to be the dominant channel (so skin highlights are spared).
function isFloodableGreen(r: number, g: number, b: number, a: number): boolean {
  if (a < ALPHA_THRESHOLD) return true;
  if (g < 60) return false;
  if (g <= r) return false;
  if (g <= b) return false;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max === 0 ? 0 : (max - min) / max;
  if (sat < 0.22) return false;
  // Hue must be in the green band.
  const delta = max - min;
  let hue = 0;
  if (delta > 0) {
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
    if (hue < 0) hue += 360;
  }
  return hue >= 75 && hue <= 165;
}

// Strict test: only matches near-pure Gemini chroma green. Used as a safety
// net for internal background pockets (e.g., between an arm and the torso)
// that the edge flood-fill cannot reach. Skin/face highlights never pass this.
function isStrictGreen(r: number, g: number, b: number, a: number): boolean {
  if (a < ALPHA_THRESHOLD) return true;
  if (g < 130) return false;
  if (g < r * 1.5) return false;
  if (g < b * 1.5) return false;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max === 0 ? 0 : (max - min) / max;
  return sat >= 0.55;
}

// Desaturates green spill on surviving (non-background) pixels.
// For each pixel where green is the dominant channel, push green back toward
// max(red, blue) so the green ambient bounce on the character disappears
// without losing the underlying skin/clothing tone.
function suppressGreenSpill(data: ImageData): void {
  const d = data.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    if (g <= r && g <= b) continue;
    const target = Math.max(r, b);
    if (g <= target) continue;
    // Only neutralize if green is more than ~5% above the next channel; below
    // that it's just natural variation in a green-tinted material (e.g., a
    // green sweater) that we'd be wrong to flatten.
    if (g < Math.round(target * 1.05)) continue;
    // Pull green most of the way to target — keep a touch of original green
    // so genuinely greenish surfaces still read as green, just not glowing.
    d[i + 1] = Math.round(target + (g - target) * 0.2);
  }
}

function chromaKeyRemove(data: ImageData): void {
  const d = data.data;
  const w = data.width;
  const h = data.height;
  const bg = new Uint8Array(w * h);
  const queue: number[] = [];

  // Pass 1: flood-fill from every edge pixel. A pixel joins the background
  // set only if it itself looks floodable AND it's reachable from the border.
  // This guarantees interior character pixels never get killed, even when
  // they happen to look slightly greenish (face highlights, light spill).
  const trySeed = (x: number, y: number) => {
    const idx = y * w + x;
    if (bg[idx]) return;
    const i = idx * 4;
    if (isFloodableGreen(d[i], d[i + 1], d[i + 2], d[i + 3])) {
      bg[idx] = 1;
      queue.push(idx);
    }
  };
  for (let x = 0; x < w; x++) {
    trySeed(x, 0);
    trySeed(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    trySeed(0, y);
    trySeed(w - 1, y);
  }

  while (queue.length > 0) {
    const idx = queue.pop()!;
    const x = idx % w;
    const y = Math.floor(idx / w);
    const neighbours: Array<[number, number]> = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (const [dx, dy] of neighbours) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const nIdx = ny * w + nx;
      if (bg[nIdx]) continue;
      const i = nIdx * 4;
      if (isFloodableGreen(d[i], d[i + 1], d[i + 2], d[i + 3])) {
        bg[nIdx] = 1;
        queue.push(nIdx);
      }
    }
  }

  // Pass 2: clean up internal background pockets (e.g., the gap between an
  // arm and the torso) that flood-fill could not reach. Strict test only —
  // never touches skin or clothing.
  for (let idx = 0; idx < bg.length; idx++) {
    if (bg[idx]) continue;
    const i = idx * 4;
    if (isStrictGreen(d[i], d[i + 1], d[i + 2], d[i + 3])) {
      bg[idx] = 1;
    }
  }

  // Apply background mask and produce a soft 1-pixel feather so edges aren't
  // razor-sharp against the flood-filled boundary.
  for (let idx = 0; idx < bg.length; idx++) {
    if (bg[idx]) {
      d[idx * 4 + 3] = 0;
    }
  }

  // Pass 3: kill green spill on surviving character pixels.
  suppressGreenSpill(data);
}

// ─── Alpha edge erosion (removes fringe pixels left by bg removal) ──

function erodeAlphaEdge(data: ImageData): void {
  const d = data.data;
  const w = data.width;
  const h = data.height;
  const EDGE_ALPHA = 30;

  // Pass 1: kill very-low-alpha pixels outright
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] > 0 && d[i] < EDGE_ALPHA) d[i] = 0;
  }

  // Pass 2: erode 1px from silhouette edges — any opaque pixel adjacent
  // to a transparent pixel gets removed. This strips the green/gray fringe.
  const toErase = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      if (d[idx * 4 + 3] === 0) continue;
      const neighbors = [
        d[((y - 1) * w + x) * 4 + 3],
        d[((y + 1) * w + x) * 4 + 3],
        d[(y * w + x - 1) * 4 + 3],
        d[(y * w + x + 1) * 4 + 3],
      ];
      if (neighbors.some(a => a === 0)) toErase[idx] = 1;
    }
  }
  // Also erase all edge-row/column pixels that are opaque
  for (let x = 0; x < w; x++) {
    toErase[x] = d[x * 4 + 3] > 0 ? 1 : 0;
    toErase[(h - 1) * w + x] = d[((h - 1) * w + x) * 4 + 3] > 0 ? 1 : 0;
  }
  for (let y = 0; y < h; y++) {
    toErase[y * w] = d[(y * w) * 4 + 3] > 0 ? 1 : 0;
    toErase[y * w + w - 1] = d[(y * w + w - 1) * 4 + 3] > 0 ? 1 : 0;
  }

  for (let i = 0; i < toErase.length; i++) {
    if (toErase[i]) d[i * 4 + 3] = 0;
  }
}

function removeDetachedComponents(data: ImageData, mode: 'largest' | 'conservative'): void {
  const d = data.data;
  const w = data.width;
  const h = data.height;
  const visited = new Uint8Array(w * h);
  const components: number[][] = [];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const start = y * w + x;
      if (visited[start] || d[start * 4 + 3] <= ALPHA_THRESHOLD) continue;

      visited[start] = 1;
      const stack = [start];
      const component: number[] = [];

      while (stack.length > 0) {
        const idx = stack.pop()!;
        component.push(idx);

        const cx = idx % w;
        const cy = Math.floor(idx / w);
        for (const [dx, dy] of [
          [-1, 0], [1, 0], [0, -1], [0, 1],
          [-1, -1], [1, -1], [-1, 1], [1, 1],
        ] as const) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const next = ny * w + nx;
          if (visited[next] || d[next * 4 + 3] <= ALPHA_THRESHOLD) continue;
          visited[next] = 1;
          stack.push(next);
        }
      }

      components.push(component);
    }
  }

  if (components.length <= 1) return;

  components.sort((a, b) => b.length - a.length);
  const largest = components[0].length;
  const total = components.reduce((sum, component) => sum + component.length, 0);
  const keep = new Set<number>();

  for (const idx of components[0]) keep.add(idx);

  if (mode === 'conservative') {
    const minPixels = Math.max(80, Math.round(largest * 0.12));
    for (let i = 1; i < components.length; i++) {
      const component = components[i];
      if (component.length >= minPixels && component.length >= total * 0.06) {
        for (const idx of component) keep.add(idx);
      }
    }
  } else if (largest / total < 0.7) {
    const minPixels = Math.max(120, Math.round(largest * 0.22));
    for (let i = 1; i < components.length; i++) {
      const component = components[i];
      if (component.length >= minPixels) {
        for (const idx of component) keep.add(idx);
      }
    }
  }

  for (let i = 0; i < visited.length; i++) {
    if (d[i * 4 + 3] > 0 && !keep.has(i)) {
      d[i * 4 + 3] = 0;
    }
  }
}

// ─── Shared helpers ──────────────────────────────────────────────────

function filterCriticalAnimationFrames(
  frames: HTMLCanvasElement[],
  boxes: (BBox | null)[],
  frameW: number,
  frameH: number,
  config: ReliableFrameConfig,
  animationName: string,
): { frames: HTMLCanvasElement[]; boxes: (BBox | null)[] } {
  const populated = boxes
    .map((bbox, index) => ({ bbox, index }))
    .filter((entry): entry is { bbox: BBox; index: number } => entry.bbox != null);

  if (populated.length === 0) {
    return { frames: [], boxes: [] };
  }

  const areas = populated.map(({ bbox }) => bbox.w * bbox.h);
  const heights = populated.map(({ bbox }) => bbox.h);
  const widths = populated.map(({ bbox }) => bbox.w);
  const medianArea = config.referenceMode === 'upper-percentile' ? upperPercentile(areas, 0.75) : median(areas);
  const medianHeight = config.referenceMode === 'upper-percentile' ? upperPercentile(heights, 0.75) : median(heights);
  const medianWidth = config.referenceMode === 'upper-percentile' ? upperPercentile(widths, 0.75) : median(widths);
  const edgeMargin = config.edgeMargin ?? 2;
  const minAreaRatio = config.minAreaRatio ?? 0.55;
  const minHeightRatio = config.minHeightRatio ?? 0.7;
  const minWidthRatio = config.minWidthRatio ?? 0.45;
  const minVerticalFill = config.minVerticalFill ?? 0.38;
  const requireBottomMargin = config.requireBottomMargin === true;

  const scored = populated.map(({ bbox, index }) => {
    const area = bbox.w * bbox.h;
    const areaRatio = medianArea > 0 ? area / medianArea : 1;
    const heightRatio = medianHeight > 0 ? bbox.h / medianHeight : 1;
    const widthRatio = medianWidth > 0 ? bbox.w / medianWidth : 1;
    const touchesLeft = bbox.x <= edgeMargin;
    const touchesRight = bbox.x + bbox.w >= frameW - edgeMargin;
    const touchesTop = bbox.y <= edgeMargin;
    const touchesBottom = bbox.y + bbox.h >= frameH - edgeMargin;
    const verticalFill = bbox.h / frameH;

    let score = 100;
    if (touchesLeft) score -= 45;
    if (touchesRight) score -= 45;
    if (touchesTop) score -= 35;
    if (requireBottomMargin && touchesBottom) score -= 45;
    if (areaRatio < minAreaRatio) score -= 55;
    if (areaRatio > 1.75) score -= 50;
    if (heightRatio < minHeightRatio) score -= 40;
    if (widthRatio < minWidthRatio) score -= 25;
    if (verticalFill < minVerticalFill) score -= 45;
    if (touchesBottom && verticalFill < 0.44) score -= 20;

    const valid =
      score >= 60 &&
      !touchesLeft &&
      !touchesRight &&
      !touchesTop &&
      (!requireBottomMargin || !touchesBottom) &&
      areaRatio >= minAreaRatio &&
      heightRatio >= minHeightRatio &&
      widthRatio >= minWidthRatio &&
      verticalFill >= minVerticalFill;
    return { index, score, valid };
  });

  let selectedIndices = scored.filter((entry) => entry.valid).map((entry) => entry.index);
  if (selectedIndices.length < config.minFrames && config.allowBestEffortFill !== false) {
    selectedIndices = scored
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(config.maxFrames, scored.length))
      .map((entry) => entry.index)
      .sort((a, b) => a - b);
  }

  if (selectedIndices.length > config.maxFrames) {
    selectedIndices = sampleOrderedIndices(selectedIndices, config.maxFrames);
  }

  debugInfo(
    `[SpritePostProcess] ${animationName}: kept ${selectedIndices.length}/${frames.length} reliable critical frames`,
  );

  return {
    frames: selectedIndices.map((index) => frames[index]),
    boxes: selectedIndices.map((index) => boxes[index]),
  };
}

function sampleOrderedIndices(indices: number[], count: number): number[] {
  if (indices.length <= count) return indices.slice();
  if (count <= 1) return [indices[0]];
  const sampled: number[] = [];
  for (let i = 0; i < count; i++) {
    const position = Math.round((i / (count - 1)) * (indices.length - 1));
    sampled.push(indices[position]);
  }
  return sampled;
}

interface BBox { x: number; y: number; w: number; h: number }

function getCanvasBoundingBox(canvas: HTMLCanvasElement): BBox | null {
  const ctx = canvas.getContext('2d')!;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return findBoundingBox(data);
}

function findBoundingBox(data: ImageData): BBox | null {
  const d = data.data;
  const w = data.width;
  const h = data.height;
  let minX = w, minY = h, maxX = 0, maxY = 0;
  let found = false;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > ALPHA_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        found = true;
      }
    }
  }

  if (!found) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function cropCanvas(source: HTMLCanvasElement, bbox: BBox): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = bbox.w;
  c.height = bbox.h;
  c.getContext('2d')!.drawImage(source, bbox.x, bbox.y, bbox.w, bbox.h, 0, 0, bbox.w, bbox.h);
  return c;
}

function padToRect(source: HTMLCanvasElement, w: number, h: number): HTMLCanvasElement {
  const scale = Math.min(w / source.width, h / source.height) * 0.9;
  const drawW = Math.round(source.width * scale);
  const drawH = Math.round(source.height * scale);

  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const dx = Math.round((w - drawW) / 2);
  const dy = h - Math.round(h * 0.05) - drawH;
  ctx.drawImage(source, 0, 0, source.width, source.height, dx, dy, drawW, drawH);
  return c;
}

function normalizeCanvasToCell(
  source: HTMLCanvasElement,
  bbox: BBox,
  profile: AnimationProfile,
  maxScale?: number,
  stableCenterXRaw?: number,
  lockedScale?: number,
  normalizationReference?: NormalizationReference,
): { canvas: HTMLCanvasElement; usedScale: number } {
  const targetDrawH = normalizationReference?.targetDrawHeight ?? CELL_H * profile.targetHeightRatio;
  const targetDrawW = normalizationReference?.targetDrawWidth ?? CELL_W * profile.targetWidthRatio;
  let scale = lockedScale ?? Math.min(targetDrawH / bbox.h, targetDrawW / bbox.w);
  if (maxScale != null && scale > maxScale) scale = maxScale;

  const drawW = Math.round(bbox.w * scale);
  const drawH = Math.round(bbox.h * scale);
  const rawCenterX = stableCenterXRaw ?? (bbox.x + bbox.w / 2);
  const baselineY = CELL_H * (normalizationReference?.baselineRatio ?? profile.baselineRatio);

  let dx = Math.round(CELL_W / 2 - (rawCenterX - bbox.x) * scale);
  let dy = Math.round(baselineY - drawH);

  dx = clamp(dx, 0, CELL_W - drawW);
  dy = clamp(dy, 0, CELL_H - drawH);

  const c = document.createElement('canvas');
  c.width = CELL_W;
  c.height = CELL_H;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, bbox.x, bbox.y, bbox.w, bbox.h, dx, dy, drawW, drawH);
  return { canvas: c, usedScale: scale };
}

function getLockedAnimationScale(
  boxes: BBox[],
  profile: AnimationProfile,
  maxScale?: number,
  normalizationReference?: NormalizationReference,
): number {
  const heights = boxes.map((bbox) => bbox.h).sort((a, b) => a - b);
  const widths = boxes.map((bbox) => bbox.w).sort((a, b) => a - b);
  const referenceHeight = upperPercentile(heights, 0.75);
  const referenceWidth = upperPercentile(widths, 0.75);
  let scale = Math.min(
    (normalizationReference?.targetDrawHeight ?? CELL_H * profile.targetHeightRatio) / referenceHeight,
    (normalizationReference?.targetDrawWidth ?? CELL_W * profile.targetWidthRatio) / referenceWidth,
  );
  if (maxScale != null && scale > maxScale) scale = maxScale;
  return scale;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function upperPercentile(values: number[], percentile: number): number {
  if (values.length === 0) return 1;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * percentile)));
  return sorted[index];
}

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

export async function measureOpaqueBoundsFromBase64(base64: string): Promise<BBox | null> {
  const img = await loadImg(`data:image/png;base64,${base64}`);
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return findBoundingBox(data);
}
