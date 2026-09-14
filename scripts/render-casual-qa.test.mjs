import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { frameBounds, renderCasualQa, verifiedFile } from './render-casual-qa.mjs';
const requireProcessor = createRequire(new URL('../processor/package.json', import.meta.url));
const { createCanvas } = requireProcessor('@napi-rs/canvas');
const hash = value => createHash('sha256').update(value).digest('hex');

describe('offline Casual QA renderer', () => {
  it('measures empty cells, exact alpha bounds and contact with cell edges', () => {
    const pixels = new Uint8ClampedArray(4 * 3 * 4);
    expect(frameBounds(pixels, 4, 3).empty).toBe(true);
    pixels[(1 * 4 + 1) * 4 + 3] = 255;
    pixels[(2 * 4 + 3) * 4 + 3] = 20;
    expect(frameBounds(pixels, 4, 3)).toMatchObject({ empty: false, opaquePixels: 2, touchesCellEdge: true,
      bounds: { x: 1, y: 1, width: 3, height: 2, right: 3, bottom: 2 } });
  });
  it('renders verified comparison frames while leaving all input bytes unchanged', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'casual-offline-qa-'));
    try {
      mkdirSync(join(directory, 'outputs'));
      const sheet = createCanvas(16, 12), context = sheet.getContext('2d');
      context.fillStyle = '#808080'; context.fillRect(2, 2, 4, 9); context.fillRect(10, 1, 4, 10);
      const bytes = sheet.toBuffer('image/png'); const path = 'outputs/fixture.png'; writeFileSync(join(directory, path), bytes);
      const base = { animationName: 'idle', path, sha256: hash(bytes), rawPath: path, rawSha256: hash(bytes),
        frameWidth: 8, frameHeight: 12, frameCount: 2, gridCols: 2, gridRows: 1, rawWidth: 16, rawHeight: 12 };
      const manifest = { schemaVersion: 1, identity: { slug: 'casual', name: 'Casual' }, fingerprint: 'test',
        sprites: [{ ...base, qualityTier: 'rookie' }, { ...base, qualityTier: 'contender' }] };
      const manifestText = JSON.stringify(manifest); writeFileSync(join(directory, 'manifest.json'), manifestText);
      const result = await renderCasualQa(directory);
      expect(result.availableAnimations).toEqual(['idle']); expect(result.visuals).toHaveLength(2);
      const report = JSON.parse(readFileSync(join(directory, result.report), 'utf8'));
      expect(report.animations[0].frames).toHaveLength(2);
      expect(report.animations[0].raw).toMatchObject({ width: 16, height: 12 });
      expect(readFileSync(join(directory, path))).toEqual(bytes);
      expect(readFileSync(join(directory, 'manifest.json'), 'utf8')).toBe(manifestText);
      writeFileSync(join(directory, path), Buffer.from('changed'));
      await expect(renderCasualQa(directory)).rejects.toThrow('hash mismatch');
      expect(() => verifiedFile(directory, '../elsewhere', 'irrelevant')).toThrow('escapes');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
