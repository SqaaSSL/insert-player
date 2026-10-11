import { createCanvas, loadImage } from '@napi-rs/canvas';
import { VideoSpriteCompileError } from './videoSpriteContract.ts';
import { whiteKey, WHITE_KEY_POLICY } from './templateAtlas/whiteKey.ts';

/**
 * The backdrop a Video move was generated on. IMAGE 1 decides it: the provider
 * keeps its canvas, so a canonical padded onto white yields a white clip. Green
 * stays the default; white exists for Champions whose neutral grey outfit takes
 * on green or magenta casts against chroma green (Elon Musk, 2026-10).
 */
export type VideoSpriteBackground = 'chroma-green' | 'white';

export const VIDEO_SPRITE_PIXEL_CLEANUP: Readonly<Record<VideoSpriteBackground, string>> = Object.freeze({
  'chroma-green': 'transparent-rgb-zero+translucent-green-despill-v1',
  white: `transparent-rgb-zero+${WHITE_KEY_POLICY.method}+enclosed-strong-white-v1`,
});

/**
 * A video has no template prior for the gaps that open between limbs and torso,
 * so an enclosed white component counts as backdrop when it is nearly all
 * strong white (the shades the border key removes outright) and not a speck.
 */
export const VIDEO_WHITE_HOLE_POLICY = Object.freeze({
  minimumAreaFraction: 0.0001,
  minimumStrongWhiteFraction: 0.9,
});

const BORDER_SAMPLE_STEP = 8;
const WHITE_MINIMUM_CHANNEL = 235;
const WHITE_MAXIMUM_CHROMA = 12;

/** Classifies IMAGE 1 by the per-channel median of its border pixels. */
export async function detectVideoSpriteBackground(canonicalBytes: Uint8Array): Promise<VideoSpriteBackground> {
  let image;
  try {
    image = await loadImage(Buffer.from(canonicalBytes));
  } catch {
    throw new VideoSpriteCompileError('invalid_canonical', 'The canonical source is not a decodable image.');
  }
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const { data, width, height } = context.getImageData(0, 0, image.width, image.height);
  const channels: [number[], number[], number[]] = [[], [], []];
  const sample = (x: number, y: number) => {
    const offset = (y * width + x) * 4;
    for (let channel = 0; channel < 3; channel += 1) channels[channel].push(data[offset + channel]);
  };
  for (let x = 0; x < width; x += BORDER_SAMPLE_STEP) { sample(x, 0); sample(x, height - 1); }
  for (let y = 0; y < height; y += BORDER_SAMPLE_STEP) { sample(0, y); sample(width - 1, y); }
  const [red, green, blue] = channels.map((values) => values.sort((a, b) => a - b)[values.length >> 1]);
  const minimum = Math.min(red, green, blue);
  return minimum >= WHITE_MINIMUM_CHANNEL && Math.max(red, green, blue) - minimum <= WHITE_MAXIMUM_CHROMA
    ? 'white'
    : 'chroma-green';
}

/** FFmpeg keys chroma green itself; a white backdrop stays opaque (padded white) for the border-connected white key. */
export function videoSpriteKeyFilter(background: VideoSpriteBackground): string {
  return background === 'white' ? 'format=rgba' : 'chromakey=0x00FF00:0.20:0.08,format=rgba';
}

export function videoSpritePadColor(background: VideoSpriteBackground): string {
  return background === 'white' ? '0xFFFFFFFF' : '0x00000000';
}

/** Removes the backdrop from one normalized RGBA frame in place. */
export function cleanVideoSpritePixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  background: VideoSpriteBackground,
): void {
  if (background === 'white') {
    data.set(whiteKey(data, width, height).pixels);
    clearEnclosedWhite(data, width, height);
  }
  for (let offset = 0; offset < data.length; offset += 4) {
    const alpha = data[offset + 3];
    if (alpha === 0) {
      data[offset] = 0;
      data[offset + 1] = 0;
      data[offset + 2] = 0;
      continue;
    }
    if (
      background === 'chroma-green' &&
      alpha < 250 &&
      data[offset + 1] > Math.max(data[offset], data[offset + 2]) + 8
    ) {
      data[offset + 1] = Math.max(data[offset], data[offset + 2]);
    }
  }
}

function whiteness(data: Uint8ClampedArray, offset: number): { candidate: boolean; strong: boolean; minimum: number } {
  const minimum = Math.min(data[offset], data[offset + 1], data[offset + 2]);
  const chroma = Math.max(data[offset], data[offset + 1], data[offset + 2]) - minimum;
  const candidate = minimum >= WHITE_KEY_POLICY.minimumChannel && chroma <= WHITE_KEY_POLICY.maximumChroma;
  return { candidate, strong: candidate && minimum >= WHITE_KEY_POLICY.fullyTransparentMinimum, minimum };
}

/** Fades enclosed, still-opaque white components that are almost entirely strong white. */
function clearEnclosedWhite(data: Uint8ClampedArray, width: number, height: number): void {
  const n = width * height;
  const seen = new Uint8Array(n);
  const queue = new Uint32Array(n);
  const minimumArea = Math.max(1, Math.ceil(n * VIDEO_WHITE_HOLE_POLICY.minimumAreaFraction));
  for (let start = 0; start < n; start += 1) {
    if (seen[start] || data[start * 4 + 3] === 0 || !whiteness(data, start * 4).candidate) continue;
    let head = 0;
    let tail = 0;
    let strong = 0;
    seen[start] = 1;
    queue[tail++] = start;
    while (head < tail) {
      const p = queue[head++];
      if (whiteness(data, p * 4).strong) strong += 1;
      const x = p % width;
      const neighbours = [x ? p - 1 : -1, x + 1 < width ? p + 1 : -1, p >= width ? p - width : -1, p + width < n ? p + width : -1];
      for (const q of neighbours) {
        if (q < 0 || seen[q] || data[q * 4 + 3] === 0 || !whiteness(data, q * 4).candidate) continue;
        seen[q] = 1;
        queue[tail++] = q;
      }
    }
    if (tail < minimumArea || strong < tail * VIDEO_WHITE_HOLE_POLICY.minimumStrongWhiteFraction) continue;
    for (let index = 0; index < tail; index += 1) {
      const offset = queue[index] * 4;
      const { minimum } = whiteness(data, offset);
      const t = Math.max(0, Math.min(1, (WHITE_KEY_POLICY.fullyTransparentMinimum - minimum) /
        (WHITE_KEY_POLICY.fullyTransparentMinimum - WHITE_KEY_POLICY.minimumChannel)));
      data[offset + 3] = Math.round(data[offset + 3] * t * t * (3 - 2 * t));
    }
  }
}
