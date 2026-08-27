import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const assetDirectory = join(root, 'public/assets/stages/signature');
const expectedFiles = [
  'executive-rumble-v2.png',
  'la-jaula-304-v1.png',
  'mars-incorporated-v1.png',
  'tablao-3000-v1.png',
];

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const maxAssetBytes = 1_250_000;

describe('signature stage assets', () => {
  it('contains exactly the four versioned PNG files', async () => {
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
});
