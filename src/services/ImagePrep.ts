/**
 * Standardizes a character image for the sprite pipeline:
 * 1. Remove background (make transparent)
 * 2. Auto-crop to bounding box of visible pixels
 * 3. Pad to a standard aspect ratio with the character centered
 * 4. Ensure character faces right
 *
 * Returns a base64 PNG (no data: prefix).
 */

import { debugWarn } from './DebugLog';

const STANDARD_SIZE = 512;
const PADDING_RATIO = 0.08;
const BG_THRESHOLD = 30;

export async function prepareBaseImage(base64: string): Promise<string> {
  const img = await loadImg(`data:image/png;base64,${base64}`);

  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  removeBackground(imageData, canvas.width, canvas.height);
  ctx.putImageData(imageData, 0, 0);

  const bbox = findBoundingBox(imageData, canvas.width, canvas.height);
  if (!bbox) {
    debugWarn('[ImagePrep] No visible pixels found, returning original');
    return base64;
  }

  const cropped = cropToBox(ctx, bbox);

  if (!isFacingRight(cropped)) {
    flipHorizontal(cropped);
  }

  const padded = padToSquare(cropped);

  const outCanvas = document.createElement('canvas');
  outCanvas.width = STANDARD_SIZE;
  outCanvas.height = STANDARD_SIZE;
  const outCtx = outCanvas.getContext('2d')!;
  outCtx.drawImage(padded, 0, 0, STANDARD_SIZE, STANDARD_SIZE);

  return outCanvas.toDataURL('image/png').split(',')[1];
}

function removeBackground(data: ImageData, w: number, h: number): void {
  const d = data.data;

  // Sample corners to estimate background color
  const bgSamples: number[][] = [];
  const sampleSize = Math.max(4, Math.round(Math.min(w, h) * 0.03));

  for (let y = 0; y < sampleSize; y++) {
    for (let x = 0; x < sampleSize; x++) {
      bgSamples.push(getPixel(d, x, y, w));
      bgSamples.push(getPixel(d, w - 1 - x, y, w));
      bgSamples.push(getPixel(d, x, h - 1 - y, w));
      bgSamples.push(getPixel(d, w - 1 - x, h - 1 - y, w));
    }
  }

  const avgBg = [
    Math.round(bgSamples.reduce((s, p) => s + p[0], 0) / bgSamples.length),
    Math.round(bgSamples.reduce((s, p) => s + p[1], 0) / bgSamples.length),
    Math.round(bgSamples.reduce((s, p) => s + p[2], 0) / bgSamples.length),
  ];

  for (let i = 0; i < d.length; i += 4) {
    const dr = Math.abs(d[i] - avgBg[0]);
    const dg = Math.abs(d[i + 1] - avgBg[1]);
    const db = Math.abs(d[i + 2] - avgBg[2]);
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);

    if (dist < BG_THRESHOLD) {
      d[i + 3] = 0;
    } else if (dist < BG_THRESHOLD * 2) {
      const alpha = Math.round(((dist - BG_THRESHOLD) / BG_THRESHOLD) * 255);
      d[i + 3] = Math.min(d[i + 3], alpha);
    }
  }
}

function getPixel(d: Uint8ClampedArray, x: number, y: number, w: number): number[] {
  const i = (y * w + x) * 4;
  return [d[i], d[i + 1], d[i + 2], d[i + 3]];
}

interface BBox { x: number; y: number; w: number; h: number }

function findBoundingBox(data: ImageData, w: number, h: number): BBox | null {
  const d = data.data;
  let minX = w, minY = h, maxX = 0, maxY = 0;
  let found = false;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const alpha = d[(y * w + x) * 4 + 3];
      if (alpha > 10) {
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

function cropToBox(ctx: CanvasRenderingContext2D, bbox: BBox): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = bbox.w;
  canvas.height = bbox.h;
  const c = canvas.getContext('2d')!;
  c.drawImage(ctx.canvas, bbox.x, bbox.y, bbox.w, bbox.h, 0, 0, bbox.w, bbox.h);
  return canvas;
}

function isFacingRight(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width;
  const h = canvas.height;

  // Analyze the top 40% (head/torso) to determine facing direction.
  // More opaque mass on the left side = face is pointing right (body leans back).
  // More mass on the right side = face is pointing left.
  const headH = Math.round(h * 0.4);
  const data = ctx.getImageData(0, 0, w, headH).data;

  let leftMass = 0;
  let rightMass = 0;
  const midX = w / 2;

  for (let y = 0; y < headH; y++) {
    for (let x = 0; x < w; x++) {
      const alpha = data[(y * w + x) * 4 + 3];
      if (alpha > 30) {
        if (x < midX) leftMass += alpha;
        else rightMass += alpha;
      }
    }
  }

  // If mass is roughly equal, assume already facing right
  const ratio = leftMass / (rightMass || 1);
  return ratio >= 0.7;
}

function flipHorizontal(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d')!;
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.scale(-1, 1);
  ctx.drawImage(canvas, -canvas.width, 0);
  ctx.restore();
}

function padToSquare(source: HTMLCanvasElement): HTMLCanvasElement {
  const maxDim = Math.max(source.width, source.height);
  const pad = Math.round(maxDim * PADDING_RATIO);
  const size = maxDim + pad * 2;

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  // Place character centered horizontally, anchored to the bottom
  const dx = Math.round((size - source.width) / 2);
  const dy = size - pad - source.height;
  ctx.drawImage(source, dx, dy);

  return canvas;
}

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
