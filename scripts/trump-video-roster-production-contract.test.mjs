import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TRUMP_VIDEO_ROSTER_CONTRACT,
  contractSha256,
  expectedBundleManifest,
  readPngDimensions,
  validateBundleDirectory,
} from './trump-video-roster-production-contract.mjs';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function png(width, height, marker = 0) {
  const bytes = Buffer.alloc(25);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = marker;
  return bytes;
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fixtureContract(processed, raw, source, provenance) {
  return {
    schemaVersion: 1,
    bundleId: 'test-bundle',
    fighter: {
      id: 'a'.repeat(32),
      slug: 'test-fighter',
      name: 'Test Fighter',
      photoHash: digest(source),
      qualityTier: 'champion',
    },
    animationFormat: 'video-dense-v1',
    processingVersion: 5,
    sprites: [{
      animationName: 'idle',
      file: 'sprites/idle.png',
      rawFile: 'sprites/raw/idle.png',
      sha256: digest(processed),
      rawSha256: digest(raw),
      sizeBytes: processed.length,
      rawSizeBytes: raw.length,
      sheetWidth: 2,
      sheetHeight: 1,
      rawSheetWidth: 2,
      rawSheetHeight: 1,
      frameWidth: 1,
      frameHeight: 1,
      frameCount: 2,
    }],
    sources: [{
      kind: 'original',
      responseKey: 'original',
      hashKey: 'original',
      file: 'sources/original.png',
      sha256: digest(source),
      sizeBytes: source.length,
      width: 1,
      height: 1,
    }],
    provenance: [{
      kind: 'test-provenance',
      file: 'provenance/test.json',
      sha256: digest(provenance),
    }],
  };
}

describe('sealed Trump video roster contract', () => {
  it('pins all physical sprite frames, raw sheets, and canonical sources', () => {
    expect(TRUMP_VIDEO_ROSTER_CONTRACT.sprites.map((sprite) => sprite.frameCount)).toEqual([
      8, 12, 11, 13, 23, 17, 8, 6, 6, 12, 12,
    ]);
    expect(TRUMP_VIDEO_ROSTER_CONTRACT.sprites).toHaveLength(11);
    expect(TRUMP_VIDEO_ROSTER_CONTRACT.sprites.every((sprite) => (
      /^[a-f0-9]{64}$/.test(sprite.sha256)
      && /^[a-f0-9]{64}$/.test(sprite.rawSha256)
      && sprite.rawFile.startsWith('sprites/raw/')
    ))).toBe(true);
    expect(TRUMP_VIDEO_ROSTER_CONTRACT.sources.map((source) => source.kind)).toEqual([
      'original', 'side', 'side_raw', 'upright', 'upright_raw', 'crouch', 'crouch_raw',
    ]);
    expect(contractSha256()).toMatch(/^[a-f0-9]{64}$/);
  });

  it('reads PNG dimensions without decoding pixels', () => {
    expect(readPngDimensions(png(1536, 768))).toEqual({ width: 1536, height: 768 });
    expect(() => readPngDimensions(Buffer.from('not a png'))).toThrow(/valid signature/);
  });

  it('accepts only the exact manifest and file set', () => {
    const directory = mkdtempSync(join(tmpdir(), 'trump-contract-test-'));
    temporaryDirectories.push(directory);
    const processed = png(2, 1, 1);
    const raw = png(2, 1, 2);
    const source = png(1, 1, 3);
    const provenance = Buffer.from('{"approved":true}\n');
    const contract = fixtureContract(processed, raw, source, provenance);
    mkdirSync(join(directory, 'sprites/raw'), { recursive: true });
    mkdirSync(join(directory, 'sources'), { recursive: true });
    mkdirSync(join(directory, 'provenance'), { recursive: true });
    writeFileSync(join(directory, 'sprites/idle.png'), processed);
    writeFileSync(join(directory, 'sprites/raw/idle.png'), raw);
    writeFileSync(join(directory, 'sources/original.png'), source);
    writeFileSync(join(directory, 'provenance/test.json'), provenance);
    writeFileSync(
      join(directory, 'manifest.json'),
      `${JSON.stringify(expectedBundleManifest(contract), null, 2)}\n`,
    );

    const validated = validateBundleDirectory(directory, { contract });
    expect(validated.spriteBytes.get('idle')).toEqual(processed);
    expect(validated.rawSpriteBytes.get('idle')).toEqual(raw);
    expect(validated.sourceBytes.get('original')).toEqual(source);

    writeFileSync(join(directory, 'unexpected.txt'), 'nope');
    expect(() => validateBundleDirectory(directory, { contract })).toThrow(/file list/);
  });
});
