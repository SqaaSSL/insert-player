import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installCanvasRuntime } from '../../processor/src/canvasRuntime.ts';
import { exportAnimationGif } from './GifExportService.ts';
import type { CachedSprite } from './SpriteCache.ts';

const imageUrls = new Map<Blob, string>();

beforeAll(() => installCanvasRuntime());

beforeEach(() => {
  // The native test canvas reads data URLs, while the browser reads object URLs.
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    const url = imageUrls.get(blob as Blob);
    if (!url) throw new Error('Missing test image');
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

afterEach(() => {
  imageUrls.clear();
  vi.restoreAllMocks();
});

function sheet(frameWidth: number, frameHeight: number, colors: string[], columns = colors.length): Blob {
  const canvas = document.createElement('canvas');
  canvas.width = frameWidth * columns;
  canvas.height = frameHeight * Math.ceil(colors.length / columns);
  const context = canvas.getContext('2d')!;
  for (const [index, color] of colors.entries()) {
    context.fillStyle = color;
    context.fillRect((index % columns) * frameWidth, Math.floor(index / columns) * frameHeight, frameWidth, frameHeight);
  }
  const dataUrl = canvas.toDataURL('image/png');
  const bytes = Uint8Array.from(atob(dataUrl.split(',')[1]), (character) => character.charCodeAt(0));
  const blob = new Blob([bytes], { type: 'image/png' });
  imageUrls.set(blob, dataUrl);
  return blob;
}

function sprite(overrides: Partial<CachedSprite> = {}): CachedSprite {
  return {
    photoHash: 'export-test',
    animationName: 'high_kick',
    qualityTier: 'champion',
    pngBlob: sheet(96, 128, ['#ffffff', '#000000']),
    frameWidth: 96,
    frameHeight: 128,
    frameCount: 2,
    createdAt: 1,
    ...overrides,
  };
}

interface GifFrameMetadata {
  width: number;
  height: number;
  delayMs: number;
  color: number[];
}

// Inspect the actual encoded GIF blocks. Solid-color source cells identify
// each exported frame through its palette without mocking the GIF encoder.
async function gifMetadata(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  expect(new TextDecoder().decode(bytes.subarray(0, 6))).toBe('GIF89a');
  const word = (position: number) => bytes[position] | (bytes[position + 1] << 8);
  const width = word(6);
  const height = word(8);
  let position = 13;
  let globalPalette = new Uint8Array();
  if (bytes[10] & 0x80) {
    const length = 3 * (1 << ((bytes[10] & 7) + 1));
    globalPalette = bytes.slice(position, position + length);
    position += length;
  }
  const skipSubBlocks = () => {
    while (bytes[position] > 0) position += bytes[position] + 1;
    position += 1;
  };
  let delayMs = 0;
  const frames: GifFrameMetadata[] = [];
  while (position < bytes.length && bytes[position] !== 0x3b) {
    const marker = bytes[position++];
    if (marker === 0x21) {
      const label = bytes[position++];
      if (label === 0xf9) delayMs = word(position + 2) * 10;
      skipSubBlocks();
      continue;
    }
    expect(marker).toBe(0x2c);
    const frameWidth = word(position + 4);
    const frameHeight = word(position + 6);
    const packed = bytes[position + 8];
    position += 9;
    let palette = globalPalette;
    if (packed & 0x80) {
      const length = 3 * (1 << ((packed & 7) + 1));
      palette = bytes.slice(position, position + length);
      position += length;
    }
    frames.push({ width: frameWidth, height: frameHeight, delayMs, color: Array.from(palette.subarray(0, 3)) });
    position += 1; // LZW minimum code size
    skipSubBlocks();
  }
  expect(bytes[position]).toBe(0x3b);
  return { width, height, frames };
}

describe('animation GIF quality', () => {
  it('exports every HQ attack frame at native resolution in the preview order and timing', async () => {
    const cached = sprite({
      animationFormat: 'video-dense-v1',
      rawPngBlob: sheet(768, 1024, ['#ff0000', '#00ff00', '#0000ff'], 2),
      rawFrameWidth: 768,
      rawFrameHeight: 1024,
      rawFrameCount: 3,
    });

    const blob = await exportAnimationGif(cached, 'high_kick');
    const gif = await gifMetadata(blob);

    expect(blob.type).toBe('image/gif');
    expect(gif.width).toBe(768);
    expect(gif.height).toBe(1024);
    expect(gif.frames).toEqual([
      [255, 0, 0], [0, 255, 0], [0, 0, 255], [0, 255, 0], [255, 0, 0],
    ].map((color) => ({ width: 768, height: 1024, delayMs: 120, color })));
  });

  it('keeps all HQ non-attack frames in forward order at the preview speed', async () => {
    const cached = sprite({
      animationName: 'idle',
      animationFormat: 'video-dense-v1',
      rawPngBlob: sheet(192, 256, ['#ff0000', '#00ff00', '#0000ff']),
      rawFrameWidth: 192,
      rawFrameHeight: 256,
      rawFrameCount: 3,
    });

    const gif = await gifMetadata(await exportAnimationGif(cached, 'idle'));

    expect(gif.frames).toEqual([
      [255, 0, 0], [0, 255, 0], [0, 0, 255],
    ].map((color) => ({ width: 192, height: 256, delayMs: 120, color })));
  });

  it('falls back to the native gameplay sheet when RAW lacks frame metadata and keeps legacy holds', async () => {
    const cached = sprite({
      rawPngBlob: sheet(768, 1024, ['#ff0000', '#00ff00', '#0000ff']),
    });

    const gif = await gifMetadata(await exportAnimationGif(cached, 'high_kick'));

    expect(gif.width).toBe(96);
    expect(gif.height).toBe(128);
    expect(gif.frames.map((frame) => frame.color)).toEqual([
      [255, 255, 255], [255, 255, 255], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0],
    ]);
    expect(gif.frames.map((frame) => frame.delayMs)).toEqual([160, 130, 130, 160, 160, 160]);
  });
});
