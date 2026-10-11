import assert from 'node:assert/strict';
import test from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { cleanVideoSpritePixels, detectVideoSpriteBackground } from './videoSpriteBackground.ts';

async function still(backdrop: string): Promise<Buffer> {
  const canvas = createCanvas(96, 128);
  const context = canvas.getContext('2d');
  context.fillStyle = backdrop;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#5a5f66';
  context.fillRect(30, 20, 36, 100);
  return canvas.encode('png');
}

test('IMAGE 1 border decides the backdrop', async () => {
  assert.equal(await detectVideoSpriteBackground(await still('#ffffff')), 'white');
  assert.equal(await detectVideoSpriteBackground(await still('#fbfcfa')), 'white');
  assert.equal(await detectVideoSpriteBackground(await still('#00ff00')), 'chroma-green');
  assert.equal(await detectVideoSpriteBackground(await still('#d8d8d8')), 'chroma-green');
});

test('white cleanup removes the backdrop and enclosed backdrop gaps but keeps light highlights and figure RGB', () => {
  const width = 9;
  const height = 9;
  const pixel = (x: number, y: number) => (y * width + x) * 4;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p += 1) data.set([255, 255, 255, 255], p * 4);
  for (let y = 2; y <= 6; y += 1) for (let x = 2; x <= 6; x += 1) data.set([90, 95, 102, 255], pixel(x, y));
  data.set([255, 255, 255, 255], pixel(4, 4));
  data.set([232, 234, 236, 255], pixel(3, 5));
  cleanVideoSpritePixels(data, width, height, 'white');
  assert.deepEqual([...data.slice(0, 4)], [0, 0, 0, 0]);
  assert.deepEqual([...data.slice(pixel(2, 2), pixel(2, 2) + 4)], [90, 95, 102, 255]);
  assert.deepEqual([...data.slice(pixel(4, 4), pixel(4, 4) + 4)], [0, 0, 0, 0]);
  assert.deepEqual([...data.slice(pixel(3, 5), pixel(3, 5) + 4)], [232, 234, 236, 255]);
});

test('chroma-green cleanup keeps the original despill', () => {
  const data = new Uint8ClampedArray([0, 255, 0, 0, 40, 200, 60, 128, 40, 200, 60, 255]);
  cleanVideoSpritePixels(data, 3, 1, 'chroma-green');
  assert.deepEqual([...data], [0, 0, 0, 0, 40, 60, 60, 128, 40, 200, 60, 255]);
});
