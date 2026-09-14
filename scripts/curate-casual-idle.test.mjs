import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { curateCasualIdle, FRAME_ORDER, CURATION_ID, reorderNativeSheet } from './curate-casual-idle.mjs';
const requireProcessor = createRequire(new URL('../processor/package.json', import.meta.url));
const { createCanvas, loadImage } = requireProcessor('@napi-rs/canvas');
const hash = value => createHash('sha256').update(value).digest('hex');
const COLORS = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff', '#808080', '#ffffff'];
function sheet(cellWidth, cellHeight, missingLastRow = false) {
  const canvas = createCanvas(4 * cellWidth, 2 * cellHeight - (missingLastRow ? 1 : 0)), context = canvas.getContext('2d');
  for (let index = 0; index < 8; index++) {
    context.fillStyle = COLORS[index]; context.fillRect(index % 4 * cellWidth, Math.floor(index / 4) * cellHeight, cellWidth, cellHeight);
  }
  return canvas.toBuffer('image/png');
}
async function pixels(bytes) {
  const image = await loadImage(bytes), canvas = createCanvas(image.width, image.height), context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  return { width: image.width, height: image.height, get: (x, y) => [...context.getImageData(x, y, 1, 1).data] };
}
function fixture(directory) {
  mkdirSync(join(directory, 'outputs'));
  const sprites = ['rookie', 'contender'].map(tier => {
    const output = sheet(768, 1024), raw = tier === 'rookie' ? sheet(12, 17, true) : sheet(16, 21);
    const path = `outputs/${tier}.png`, rawPath = `outputs/${tier}-raw.png`;
    writeFileSync(join(directory, path), output); writeFileSync(join(directory, rawPath), raw);
    return { animationName: 'idle', qualityTier: tier, path, sha256: hash(output), bytes: output.length, mime: 'image/png',
      rawPath, rawSha256: hash(raw), rawBytes: raw.length, rawMime: 'image/png', rawWidth: tier === 'rookie' ? 48 : 64,
      rawHeight: tier === 'rookie' ? 33 : 42, frameWidth: 768, frameHeight: 1024, frameCount: 8, gridCols: 4, gridRows: 2,
      processingVersion: 5, animationFormat: 'legacy' };
  });
  const manifest = { schemaVersion: 1, identity: { slug: 'casual', name: 'Casual', sourceSha256: 'e29f551726c5e80941bcf63618401bbf00429d56df52f6cbb20d8da57435c210' },
    fingerprint: 'unchanged-product', phaseStatus: { canary: 'awaiting_visual_review' }, sprites };
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
  return manifest;
}

describe('explicit offline paired Casual idle derivative', () => {
  it('copies the agreed seven unique frames plus closing hold without rescaling native cells', async () => {
    const source = sheet(12, 17, true), sourcePixels = await pixels(source);
    const output = await reorderNativeSheet(source, { roundedCells: true }), result = await pixels(output.bytes);
    expect(output.geometry).toMatchObject({ sourceWidth: 48, sourceHeight: 33, width: 48, height: 34,
      cellWidth: 12, cellHeight: 17, sourceGridHeightDelta: 1 });
    for (const [index, frame] of FRAME_ORDER.entries()) {
      expect(result.get(index % 4 * 12 + 3, Math.floor(index / 4) * 17 + 3))
        .toEqual(sourcePixels.get((frame - 1) % 4 * 12 + 3, Math.floor((frame - 1) / 4) * 17 + 3));
    }
    expect(result.get(3, 33)[3]).toBe(0); // Source frame 6 is one pixel shorter under product rounded slicing.
    expect(result.get(39, 33)[3]).toBe(255); // Closing hold copies full-height source frame 2.
    await expect(reorderNativeSheet(source)).rejects.toThrow('height is not divisible');
  });
  it('dry-runs without mutation, applies both tiers atomically, preserves all originals, and is idempotent', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'casual-idle-curation-'));
    try {
      const original = fixture(directory), originalManifestBytes = readFileSync(join(directory, 'manifest.json'));
      const originals = original.sprites.flatMap(entry => [entry.path, entry.rawPath]).map(path => [path, readFileSync(join(directory, path))]);
      const plan = await curateCasualIdle(directory);
      expect(plan.status).toBe('dry-run'); expect(plan.uniqueFrameCount).toBe(7); expect(plan.playbackFrameCount).toBe(8);
      expect(readdirSync(directory).sort()).toEqual(['manifest.json', 'outputs']);
      expect(readFileSync(join(directory, 'manifest.json'))).toEqual(originalManifestBytes);
      expect((await curateCasualIdle(directory, { apply: true })).status).toBe('applied');
      const curated = JSON.parse(readFileSync(join(directory, 'manifest.json'))), appliedBytes = readFileSync(join(directory, 'manifest.json'));
      expect(curated.fingerprint).toBe(original.fingerprint); expect(curated.sprites.map(item => item.derivativeId)).toEqual([CURATION_ID, CURATION_ID]);
      expect(curated.sprites.map(item => item.qualityTier)).toEqual(['rookie', 'contender']);
      expect(curated.sprites.map(item => item.rawHeight)).toEqual([34, 42]);
      const proof = JSON.parse(readFileSync(join(directory, curated.derivatives[0].path)));
      expect(proof.frameOrderOneBased).toEqual(FRAME_ORDER); expect(proof.uniqueFrameCount).toBe(7); expect(proof.paidCalls).toBe(0);
      expect(readFileSync(join(directory, proof.originalManifest.path))).toEqual(originalManifestBytes);
      for (const [path, bytes] of originals) expect(readFileSync(join(directory, path))).toEqual(bytes);
      expect((await curateCasualIdle(directory, { apply: true })).status).toBe('already-applied');
      expect(readFileSync(join(directory, 'manifest.json'))).toEqual(appliedBytes);
      writeFileSync(join(directory, curated.sprites[0].rawPath), Buffer.from('tampered'));
      await expect(curateCasualIdle(directory)).rejects.toThrow('hash mismatch');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('fails closed for missing Champion, false raw dimensions, or a live generation lock', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'casual-idle-curation-'));
    try {
      const manifest = fixture(directory);
      const save = value => writeFileSync(join(directory, 'manifest.json'), JSON.stringify(value));
      save({ ...manifest, sprites: manifest.sprites.slice(0, 1) });
      await expect(curateCasualIdle(directory, { apply: true })).rejects.toThrow('each quality');
      save({ ...manifest, sprites: manifest.sprites.map(entry => ({ ...entry, rawHeight: entry.rawHeight + 1 })) });
      await expect(curateCasualIdle(directory, { apply: true })).rejects.toThrow();
      expect(readdirSync(directory).sort()).toEqual(['manifest.json', 'outputs']);
      save(manifest); writeFileSync(join(directory, 'execution.lock'), '{}');
      await expect(curateCasualIdle(directory, { apply: true })).rejects.toThrow('EEXIST');
      await expect(curateCasualIdle(directory)).rejects.toThrow('Generation is active');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
