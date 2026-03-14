/**
 * Post-processes Gemini output images:
 * 1. Chroma-key background removal (green #00FF00)
 * 2. For single images: crop to character bbox, pad to rect
 * 3. For sprite sheets: detect actual grid layout from image,
 *    remove bg per-frame, normalize each frame with a pose-aware profile,
 *    and recompose into a clean grid
 */

import { getAnimationProfile, type AnimationProfile } from './AnimationProfiles';

const ALPHA_THRESHOLD = 15;
export const CELL_W = 192;
export const CELL_H = 256;

const GREEN_HUE_MIN = 70;
const GREEN_HUE_MAX = 170;
const GREEN_SAT_MIN = 0.20;
const GREEN_BRIGHT_MIN = 30;
const CRITICAL_ANIMATION_CONFIG: Partial<Record<string, { minFrames: number; maxFrames: number }>> = {
  jump: { minFrames: 3, maxFrames: 4 },
  hit: { minFrames: 2, maxFrames: 4 },
};

// ─── Single image processing (for reposed character) ─────────────────

export async function cleanReposedImage(base64: string, profileName = 'idle'): Promise<string> {
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

  const normalized = normalizeCanvasToCell(canvas, bbox, profile);

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

export async function cleanSpriteSheet(
  base64: string,
  expectedFrameCount: number,
  expectedGridCols: number,
  expectedGridRows: number,
  animationName: string,
  maxScale?: number,
): Promise<CleanSheetResult> {
  const img = await loadImg(`data:image/png;base64,${base64}`);
  const profile = getAnimationProfile(animationName);

  // Always trust the expected grid dimensions from our prompt to Gemini.
  // Grid detection from green lines is unreliable (character limbs, shadows,
  // and partial green channels cause false dividers).
  const gridCols = expectedGridCols;
  const gridRows = expectedGridRows;
  console.log(`[SpritePostProcess] Using expected grid ${gridCols}x${gridRows} (${expectedFrameCount} frames)`);

  const frameCount = gridCols * gridRows;

  const srcFrameW = Math.round(img.width / gridCols);
  const srcFrameH = Math.round(img.height / gridRows);

  const rawFrames: HTMLCanvasElement[] = [];
  for (let i = 0; i < frameCount; i++) {
    const col = i % gridCols;
    const row = Math.floor(i / gridCols);
    const c = document.createElement('canvas');
    c.width = srcFrameW;
    c.height = srcFrameH;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, col * srcFrameW, row * srcFrameH, srcFrameW, srcFrameH, 0, 0, srcFrameW, srcFrameH);
    rawFrames.push(c);
  }

  // Detect dominant bg color from corner samples to choose removal strategy
  const bgIsGreen = detectDominantBgColor(rawFrames) === 'green';

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

  const finalCount = workingFrames.length;
  const populatedBoxes = frameBBoxes.filter((bbox): bbox is BBox => bbox != null);
  if (populatedBoxes.length === 0) {
    return { base64, rawBase64: base64, gridCols, gridRows, frameCount: finalCount, frameW: srcFrameW, frameH: srcFrameH, usedScale: 1 };
  }
  const stableCenterXRaw = median(populatedBoxes.map((bbox) => bbox.x + bbox.w / 2));
  const lockedScale = profile.lockScaleAcrossFrames
    ? getLockedAnimationScale(populatedBoxes, profile, maxScale)
    : undefined;

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

    const normalized = normalizeCanvasToCell(workingFrames[i], bbox, profile, maxScale, stableCenterXRaw, lockedScale);
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
  console.log(
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

  const full = [...extracted];
  const reversed = extracted.slice(1, -1).reverse();
  for (const f of reversed) {
    if (full.length >= totalFrames) break;
    full.push(f);
  }
  while (full.length < totalFrames) full.push(extracted[0]);
  full.length = totalFrames;

  const outCols = computeGridCols(totalFrames);
  const outRows = Math.ceil(totalFrames / outCols);

  const outCanvas = document.createElement('canvas');
  outCanvas.width = outCols * frameW;
  outCanvas.height = outRows * frameH;
  const outCtx = outCanvas.getContext('2d')!;

  for (let i = 0; i < totalFrames; i++) {
    outCtx.drawImage(full[i], (i % outCols) * frameW, Math.floor(i / outCols) * frameH);
  }

  console.log(`[SpritePostProcess] Mirrored ${halfFrames} → ${totalFrames} frames (${outCols}x${outRows})`);

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

function chromaKeyRemove(data: ImageData): void {
  const d = data.data;

  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
    if (a < ALPHA_THRESHOLD) { d[i + 3] = 0; continue; }

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;

    if (max < GREEN_BRIGHT_MIN) continue;

    const sat = max === 0 ? 0 : delta / max;
    if (sat < GREEN_SAT_MIN) continue;

    let hue = 0;
    if (delta > 0) {
      if (max === r) hue = 60 * (((g - b) / delta) % 6);
      else if (max === g) hue = 60 * ((b - r) / delta + 2);
      else hue = 60 * ((r - g) / delta + 4);
      if (hue < 0) hue += 360;
    }

    if (hue >= GREEN_HUE_MIN && hue <= GREEN_HUE_MAX) {
      if (sat > 0.5 && g > r && g > b) {
        d[i + 3] = 0;
      } else {
        const greenness = sat * (g / (r + g + b + 1));
        if (greenness > 0.25) {
          const alpha = Math.round(Math.max(0, 1 - (greenness - 0.25) / 0.15) * 255);
          d[i + 3] = Math.min(a, alpha);
        }
      }
    }
  }
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
  config: { minFrames: number; maxFrames: number },
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
  const medianArea = median(areas);
  const medianHeight = median(heights);
  const medianWidth = median(widths);
  const edgeMargin = 2;

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
    if (areaRatio < 0.55) score -= 55;
    if (areaRatio > 1.75) score -= 50;
    if (heightRatio < 0.7) score -= 40;
    if (widthRatio < 0.45) score -= 25;
    if (verticalFill < 0.38) score -= 45;
    if (touchesBottom && verticalFill < 0.44) score -= 20;

    const valid = score >= 60 && !touchesLeft && !touchesRight && !touchesTop;
    return { index, score, valid };
  });

  let selectedIndices = scored.filter((entry) => entry.valid).map((entry) => entry.index);
  if (selectedIndices.length < config.minFrames) {
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

  console.log(
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
): { canvas: HTMLCanvasElement; usedScale: number } {
  const targetDrawH = CELL_H * profile.targetHeightRatio;
  const targetDrawW = CELL_W * profile.targetWidthRatio;
  let scale = lockedScale ?? Math.min(targetDrawH / bbox.h, targetDrawW / bbox.w);
  if (maxScale != null && scale > maxScale) scale = maxScale;

  const drawW = Math.round(bbox.w * scale);
  const drawH = Math.round(bbox.h * scale);
  const rawCenterX = stableCenterXRaw ?? (bbox.x + bbox.w / 2);
  const baselineY = CELL_H * profile.baselineRatio;

  let dx = Math.round(CELL_W / 2 - (rawCenterX - bbox.x) * scale);
  let dy = Math.round(baselineY - drawH);

  dx = clamp(dx, 0, CELL_W - drawW);
  dy = clamp(dy, 0, CELL_H - drawH);

  const c = document.createElement('canvas');
  c.width = CELL_W;
  c.height = CELL_H;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(source, bbox.x, bbox.y, bbox.w, bbox.h, dx, dy, drawW, drawH);
  return { canvas: c, usedScale: scale };
}

function getLockedAnimationScale(
  boxes: BBox[],
  profile: AnimationProfile,
  maxScale?: number,
): number {
  const maxHeight = Math.max(...boxes.map((bbox) => bbox.h));
  const maxWidth = Math.max(...boxes.map((bbox) => bbox.w));
  let scale = Math.min(
    (CELL_H * profile.targetHeightRatio) / maxHeight,
    (CELL_W * profile.targetWidthRatio) / maxWidth,
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

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
