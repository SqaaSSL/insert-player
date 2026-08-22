import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { installCanvasRuntime } from './canvasRuntime';

installCanvasRuntime();

const inputPath = resolve(process.argv[2] ?? '/tmp/insert-player-fixtures/idle-raw.png');
const outputPath = resolve(process.argv[3] ?? '/tmp/insert-player-fixtures/idle-node.png');
const animationName = process.argv[4] ?? 'idle';
const expectedFrameCount = Number.parseInt(process.argv[5] ?? '8', 10);
const expectedGridCols = Number.parseInt(process.argv[6] ?? '4', 10);
const expectedGridRows = Number.parseInt(process.argv[7] ?? '2', 10);

if (
  !Number.isInteger(expectedFrameCount) || expectedFrameCount <= 0 ||
  !Number.isInteger(expectedGridCols) || expectedGridCols <= 0 ||
  !Number.isInteger(expectedGridRows) || expectedGridRows <= 0
) {
  throw new Error('Frame count, grid columns, and grid rows must be positive integers.');
}

const input = await readFile(inputPath);
const { cleanSpriteSheet } = await import('../../src/services/SpritePostProcess.ts');
const cleaned = await cleanSpriteSheet(
  input.toString('base64'),
  expectedFrameCount,
  expectedGridCols,
  expectedGridRows,
  animationName,
);
await writeFile(outputPath, Buffer.from(cleaned.base64, 'base64'));

console.log(JSON.stringify({
  inputPath,
  outputPath,
  animationName,
  gridCols: cleaned.gridCols,
  gridRows: cleaned.gridRows,
  frameCount: cleaned.frameCount,
  frameW: cleaned.frameW,
  frameH: cleaned.frameH,
  usedScale: cleaned.usedScale,
}));
