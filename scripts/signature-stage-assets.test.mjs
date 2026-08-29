import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const assetDirectory = join(root, 'public/assets/stages/signature');
const seedFiles = [
  'executive-rumble-v2.png',
  'insert-player-arena-seed-v1.png',
  'la-jaula-304-v1.png',
  'mars-incorporated-v1.png',
  'tablao-3000-v1.png',
];
const activeFiles = [
  'executive-rumble-pipeline-v1.png',
  'insert-player-arena-pipeline-v1.png',
  'la-jaula-304-pipeline-v1.png',
  'mars-incorporated-pipeline-v1.png',
  'tablao-3000-pipeline-v1.png',
];
const expectedFiles = [...seedFiles, ...activeFiles].sort();
const manifestPath = join(root, 'arcade/signature-stage-pipeline-2026.json');

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const maxAssetBytes = 1_250_000;

describe('signature stage assets', () => {
  it('preserves every seed beside its pipeline-derived active version', async () => {
    const entries = await readdir(assetDirectory, { withFileTypes: true });

    expect(entries.every((entry) => entry.isFile())).toBe(true);
    expect(entries.map((entry) => entry.name).sort()).toEqual(expectedFiles);
  });

  it.each(expectedFiles)('%s is a production-sized 1024x576 PNG', async (fileName) => {
    const assetPath = join(assetDirectory, fileName);
    const [asset, metadata] = await Promise.all([readFile(assetPath), stat(assetPath)]);

    expect(asset.subarray(0, pngSignature.length)).toEqual(pngSignature);
    expect(asset.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect(asset.readUInt32BE(16)).toBe(1024);
    expect(asset.readUInt32BE(20)).toBe(576);
    expect(metadata.size).toBeLessThanOrEqual(maxAssetBytes);
  });

  it('pins the exact pipeline contract and content hashes', async () => {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

    expect(manifest.pipeline).toEqual({
      operation: 'stage_background',
      sourceMode: 'transform-scene',
      model: 'gemini-3.1-flash-image',
      output: { format: 'png', width: 1024, height: 576 },
      normalization: { bottomShadeAlpha: 0.04, verticalBias: 0.92 },
    });
    expect(manifest.stages).toHaveLength(5);

    const manifestFiles = manifest.stages
      .flatMap((stage) => [stage.seed, stage.active])
      .map((asset) => asset.path.replace('/assets/stages/signature/', ''))
      .sort();
    expect(manifestFiles).toEqual(expectedFiles);

    for (const stage of manifest.stages) {
      for (const asset of [stage.seed, stage.active]) {
        const fileName = asset.path.replace('/assets/stages/signature/', '');
        const bytes = await readFile(join(assetDirectory, fileName));
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(asset.sha256);
      }
    }
  });
});
