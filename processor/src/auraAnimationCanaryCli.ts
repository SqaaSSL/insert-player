import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage, type SKRSContext2D } from '@napi-rs/canvas';

const GRID_COLUMNS = 4;
const GRID_ROWS = 2;
const SOURCE_FRAME_WIDTH = 192;
const DEFAULT_TARGET_FRAME_WIDTH = SOURCE_FRAME_WIDTH;
const TARGET_FRAME_HEIGHT = 256;
const TARGET_BASELINE_Y = 238;
const ALPHA_THRESHOLD = 32;
const ROOT_BAND_HEIGHT = 12;
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface FrameMeasurement {
  frame: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  rootX: number;
}

function argument(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : '';
  if (!value || value.startsWith('--')) throw new Error(`Missing --${name}`);
  return resolve(value);
}

function optionalPositiveIntegerArgument(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const raw = process.argv[index + 1] ?? '';
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid --${name}: ${raw}`);
  return value;
}

function measureFrames(
  context: SKRSContext2D,
  width: number,
  frameWidth: number,
): FrameMeasurement[] {
  const pixels = context.getImageData(0, 0, width, TARGET_FRAME_HEIGHT * GRID_ROWS).data;
  return Array.from({ length: GRID_COLUMNS * GRID_ROWS }, (_, frameIndex) => {
    const originX = (frameIndex % GRID_COLUMNS) * frameWidth;
    const originY = Math.floor(frameIndex / GRID_COLUMNS) * TARGET_FRAME_HEIGHT;
    let minX = frameWidth;
    let minY = TARGET_FRAME_HEIGHT;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < TARGET_FRAME_HEIGHT; y += 1) {
      for (let x = 0; x < frameWidth; x += 1) {
        const alpha = pixels[((originY + y) * width + originX + x) * 4 + 3];
        if (alpha < ALPHA_THRESHOLD) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    if (maxX < minX || maxY < minY) throw new Error(`Frame ${frameIndex + 1} has no foreground`);

    let rootXTotal = 0;
    let rootPixels = 0;
    for (let y = Math.max(0, maxY - ROOT_BAND_HEIGHT); y <= maxY; y += 1) {
      for (let x = 0; x < frameWidth; x += 1) {
        const alpha = pixels[((originY + y) * width + originX + x) * 4 + 3];
        if (alpha < ALPHA_THRESHOLD) continue;
        rootXTotal += x;
        rootPixels += 1;
      }
    }
    if (rootPixels === 0) throw new Error(`Frame ${frameIndex + 1} has no measurable root`);
    return {
      frame: frameIndex + 1,
      minX,
      minY,
      maxX,
      maxY,
      rootX: rootXTotal / rootPixels,
    };
  });
}

function decontaminateGreenScreen(context: SKRSContext2D, width: number, height: number): void {
  const imageData = context.getImageData(0, 0, width, height);
  const pixels = imageData.data;
  const clampByte = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const alpha = pixels[offset + 3];
    if (alpha === 0) {
      pixels[offset] = 0;
      pixels[offset + 1] = 0;
      pixels[offset + 2] = 0;
      continue;
    }
    if (alpha < 255) {
      pixels[offset] = clampByte((pixels[offset] * 255) / alpha);
      pixels[offset + 1] = clampByte(((pixels[offset + 1] - (255 - alpha)) * 255) / alpha);
      pixels[offset + 2] = clampByte((pixels[offset + 2] * 255) / alpha);
    }
    const red = pixels[offset];
    const green = pixels[offset + 1];
    const blue = pixels[offset + 2];
    const neutral = Math.max(red, blue);
    if (green > neutral * 1.05) {
      pixels[offset + 1] = clampByte(neutral + (green - neutral) * 0.2);
    }
  }
  context.putImageData(imageData, 0, 0);
}

async function main(): Promise<void> {
  const input = argument('input');
  const output = argument('output');
  const qaOutput = argument('qa-output');
  const targetFrameWidth = optionalPositiveIntegerArgument('frame-width', DEFAULT_TARGET_FRAME_WIDTH);
  if (targetFrameWidth < SOURCE_FRAME_WIDTH) {
    throw new Error(`--frame-width must be at least ${SOURCE_FRAME_WIDTH}`);
  }
  const targetRootX = Math.floor(targetFrameWidth / 2);
  const temporaryDirectory = await mkdtemp(`${tmpdir()}/insert-player-aura-canary-`);
  const keyedPath = resolve(temporaryDirectory, 'keyed.png');
  try {
    const ffmpeg = spawnSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', input,
      '-vf', `chromakey=0x00FF00:0.20:0.08,format=rgba,scale=${SOURCE_FRAME_WIDTH * GRID_COLUMNS}:${TARGET_FRAME_HEIGHT * GRID_ROWS}:flags=lanczos`,
      '-frames:v', '1', keyedPath,
    ], { encoding: 'utf8' });
    if (ffmpeg.status !== 0) throw new Error(ffmpeg.stderr || 'ffmpeg chroma cleanup failed');

    const keyed = await loadImage(await readFile(keyedPath));
    const sourceWidth = SOURCE_FRAME_WIDTH * GRID_COLUMNS;
    const expectedHeight = TARGET_FRAME_HEIGHT * GRID_ROWS;
    if (keyed.width !== sourceWidth || keyed.height !== expectedHeight) {
      throw new Error(`Unexpected keyed sheet dimensions ${keyed.width}x${keyed.height}`);
    }
    const sourceCanvas = createCanvas(sourceWidth, expectedHeight);
    const sourceContext = sourceCanvas.getContext('2d');
    sourceContext.drawImage(keyed, 0, 0);
    decontaminateGreenScreen(sourceContext, sourceWidth, expectedHeight);
    const before = measureFrames(sourceContext, sourceWidth, SOURCE_FRAME_WIDTH);

    const expectedWidth = targetFrameWidth * GRID_COLUMNS;
    const outputCanvas = createCanvas(expectedWidth, expectedHeight);
    const outputContext = outputCanvas.getContext('2d');
    outputContext.clearRect(0, 0, expectedWidth, expectedHeight);
    const offsets = before.map((measurement, frameIndex) => {
      const dx = Math.round(targetRootX - measurement.rootX);
      const dy = TARGET_BASELINE_Y - measurement.maxY;
      if (
        measurement.minX + dx < 0 || measurement.maxX + dx >= targetFrameWidth ||
        measurement.minY + dy < 0 || measurement.maxY + dy >= TARGET_FRAME_HEIGHT
      ) {
        throw new Error(`Frame ${measurement.frame} would crop during root registration`);
      }
      const sourceX = (frameIndex % GRID_COLUMNS) * SOURCE_FRAME_WIDTH;
      const sourceY = Math.floor(frameIndex / GRID_COLUMNS) * TARGET_FRAME_HEIGHT;
      const destinationX = (frameIndex % GRID_COLUMNS) * targetFrameWidth;
      outputContext.drawImage(
        sourceCanvas,
        sourceX,
        sourceY,
        SOURCE_FRAME_WIDTH,
        TARGET_FRAME_HEIGHT,
        destinationX + dx,
        sourceY + dy,
        SOURCE_FRAME_WIDTH,
        TARGET_FRAME_HEIGHT,
      );
      return { frame: measurement.frame, dx, dy };
    });

    const after = measureFrames(outputContext, expectedWidth, targetFrameWidth);
    if (after.some((measurement) => (
      measurement.maxY !== TARGET_BASELINE_Y || Math.abs(measurement.rootX - targetRootX) > 1
    ))) {
      throw new Error('Registered Aura canary failed root-line invariants');
    }

    await mkdir(dirname(output), { recursive: true });
    await mkdir(dirname(qaOutput), { recursive: true });
    await writeFile(output, outputCanvas.toBuffer('image/png'));
    await writeFile(qaOutput, `${JSON.stringify({
      schemaVersion: 1,
      input: relative(PROJECT_ROOT, input),
      output: relative(PROJECT_ROOT, output),
      grid: { columns: GRID_COLUMNS, rows: GRID_ROWS },
      frame: { width: targetFrameWidth, height: TARGET_FRAME_HEIGHT, count: GRID_COLUMNS * GRID_ROWS },
      registrationTarget: { rootX: targetRootX, baselineY: TARGET_BASELINE_Y },
      before,
      offsets,
      after,
    }, null, 2)}\n`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
