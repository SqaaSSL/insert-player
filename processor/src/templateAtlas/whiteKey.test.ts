import assert from 'node:assert/strict';
import test from 'node:test';
import { whiteKey, refineWhite, closedTemplateBackground } from './whiteKey.ts';

function fixture() {
  const width = 100, height = 100, raw = new Uint8Array(width * height * 4).fill(255), prior = new Uint8Array(width * height);
  const paint = (x0: number, y0: number, x1: number, y1: number, color: number[]) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) raw.set(color, (y * width + x) * 4);
  };
  paint(15, 15, 85, 85, [75, 110, 130, 255]);
  for (let y = 15; y < 85; y++) for (let x = 15; x < 85; x++) prior[y * width + x] = 255;
  paint(45, 45, 65, 65, [255, 255, 255, 255]); // Enclosed actual template background.
  for (let y = 45; y < 65; y++) for (let x = 45; x < 65; x++) prior[y * width + x] = 0;
  paint(23, 25, 35, 37, [255, 255, 255, 255]); // White shirt/logo on solid template body.
  return { width, height, raw, prior, paint };
}
test('white key removes only exterior, preserves enclosed whites and every RGB byte', () => {
  const { raw, width, height } = fixture(), original = new Uint8Array(raw), result = whiteKey(raw, width, height);
  assert.deepEqual(raw, original);
  assert.equal(result.pixels[3], 0);
  assert.equal(result.pixels[(50 * width + 50) * 4 + 3], 255);
  assert.equal(result.pixels[(30 * width + 30) * 4 + 3], 255);
  assert.equal(result.metrics.rgbChannelChanges, 0); assert.equal(result.metrics.nonExteriorAlphaChanges, 0);
});
test('closed-hole prior removes enclosed background but preserves white clothing', () => {
  const { raw, prior, width, height } = fixture(), v1 = whiteKey(raw, width, height), result = refineWhite(raw, v1.pixels, prior, width, height);
  assert.equal(result.pixels[(50 * width + 50) * 4 + 3], 0);
  assert.equal(result.pixels[(30 * width + 30) * 4 + 3], 255);
  assert.equal(result.metrics.acceptedComponents, 1);
  assert.equal(result.metrics.changedOutsideClassifiedComponents, 0);
  for (let i = 0; i < raw.length; i += 4) {
    assert.deepEqual(result.pixels.subarray(i, i + 3), raw.subarray(i, i + 3));
    assert(result.pixels[i + 3] <= v1.pixels[i + 3]);
  }
});
test('wrong nonempty silhouette fails closed and retains ambiguous components', () => {
  const { raw, width, height } = fixture(), wrong = new Uint8Array(width * height), v1 = whiteKey(raw, width, height);
  for (let y = 1; y < 12; y++) for (let x = 1; x < 12; x++) wrong[y * width + x] = 255;
  const result = refineWhite(raw, v1.pixels, wrong, width, height);
  assert.equal(result.metrics.failClosed, true); assert.equal(result.metrics.acceptedComponents, 0);
  assert.deepEqual(result.pixels, v1.pixels);
});
test('exterior template background is not accepted as a closed hole', () => {
  const { raw, prior, width, height } = fixture();
  for (let y = 0; y < 46; y++) prior[y * width + 50] = 0; // Open template-hole corridor to exterior.
  assert.equal(closedTemplateBackground(prior, width, height)[50 * width + 50], 0);
  const v1 = whiteKey(raw, width, height), result = refineWhite(raw, v1.pixels, prior, width, height);
  assert.equal(result.pixels[(50 * width + 50) * 4 + 3], 255);
});
test('not strongly white enough remains unchanged even with a matching hole', () => {
  const { raw, prior, width, height, paint } = fixture();
  paint(45, 45, 48, 65, [239, 239, 239, 255]); // 15%, exceeds allowed 10% soft-white fraction.
  const v1 = whiteKey(raw, width, height), result = refineWhite(raw, v1.pixels, prior, width, height);
  assert.equal(result.pixels[(50 * width + 50) * 4 + 3], 255);
  assert(result.metrics.components.some(component => component.reasons.includes('not_uniformly_white_enough')));
});
