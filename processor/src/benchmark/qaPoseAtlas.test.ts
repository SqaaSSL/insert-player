import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import {
  QA_POSE_ATLAS_ANIMATIONS,
  buildQaPoseAtlas,
  loadQaPoseAtlasManifest,
  parseQaPoseAtlasManifest,
} from './qaPoseAtlas.ts';

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

test('the production QA atlas is complete and keeps the no-chain safety contract', async () => {
  const manifestPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../arcade/qa-pose-atlas-2026.json');
  const { manifest } = await loadQaPoseAtlasManifest(manifestPath);
  assert.deepEqual(manifest.animations.map((entry) => entry.animation), [...QA_POSE_ATLAS_ANIMATIONS]);
  assert.equal(manifest.transferContract.previousOutputChaining, false);
  assert.equal(manifest.transferContract.automaticRetries, 0);
  assert.equal(manifest.transferContract.fallbackPolicy, 'none');
  assert.equal(manifest.animations.find((entry) => entry.animation === 'high_kick')?.impactOverride?.contentSha256,
    '43086a8d96acd9b153a1c38c3dd622bf0b7140d90d067a4459a0d3b7fd637bed');
});

test('rejects a provider-style fallback or previous-output chain', () => {
  const minimal = {
    schemaVersion: 1,
    atlasId: 'unsafe',
    status: 'qa_only',
    frame: { width: 8, height: 10 },
    transferContract: {
      referenceOrder: ['pose_frame', 'canonical_character', 'identity_photo'],
      frameIsolation: 'independent',
      previousOutputChaining: true,
      automaticRetries: 0,
      fallbackPolicy: 'none',
      activationPolicy: 'human_review_required',
    },
    sources: {},
    animations: [],
  };
  assert.throws(() => parseQaPoseAtlasManifest(minimal), /safety contract changed/);
});

test('extracts deterministic playback frames from a hash-pinned legacy export', async () => {
  const root = await mkdtemp(join(tmpdir(), 'insert-player-pose-atlas-'));
  const sourceDir = join(root, 'source');
  const blobPath = 'blobs/sprites/000/pngblob.png';
  await mkdir(dirname(join(sourceDir, blobPath)), { recursive: true });
  const canvas = createCanvas(64, 80);
  const context = canvas.getContext('2d');
  const colors = ['#d62929', '#2ca66f', '#3469d6', '#f0b83f'];
  for (let index = 0; index < 16; index += 1) {
    context.fillStyle = colors[index % colors.length];
    context.fillRect((index % 4) * 16 + 4, Math.floor(index / 4) * 20 + 4, 8, 12);
  }
  const sheetBytes = await canvas.encode('png');
  await writeFile(join(sourceDir, blobPath), sheetBytes);

  const spriteRecords = QA_POSE_ATLAS_ANIMATIONS.map((animation) => ({
    versionId: `version-${animation}`,
    animationName: animation,
    qualityTier: 'champion',
    processingVersion: 4,
    frameWidth: 16,
    frameHeight: 20,
    frameCount: 16,
    pngBlob: { $blob: blobPath },
  }));
  const sourceManifestBytes = Buffer.from(`${JSON.stringify({
    characterName: 'Synthetic QA',
    origin: 'http://localhost:5173',
    photoHash: '1'.repeat(64),
    sprites: spriteRecords,
  }, null, 2)}\n`);
  await writeFile(join(sourceDir, 'manifest.json'), sourceManifestBytes);
  const archiveBytes = Buffer.from('synthetic immutable archive fixture');
  const archivePath = join(root, 'synthetic.tar');
  await writeFile(archivePath, archiveBytes);

  const atlas = {
    schemaVersion: 1,
    atlasId: 'synthetic-atlas-v1',
    status: 'qa_only',
    frame: { width: 16, height: 20 },
    transferContract: {
      referenceOrder: ['pose_frame', 'canonical_character', 'identity_photo'],
      frameIsolation: 'independent',
      previousOutputChaining: false,
      automaticRetries: 0,
      fallbackPolicy: 'none',
      activationPolicy: 'human_review_required',
    },
    sources: {
      synthetic: {
        characterName: 'Synthetic QA',
        origin: 'http://localhost:5173',
        photoHash: '1'.repeat(64),
        archiveFileName: 'synthetic.tar',
        archiveSha256: sha256(archiveBytes),
        manifestSha256: sha256(sourceManifestBytes),
      },
    },
    animations: QA_POSE_ATLAS_ANIMATIONS.map((animation) => ({
      animation,
      sourceId: 'synthetic',
      versionId: `version-${animation}`,
      qualityTier: 'champion',
      processingVersion: 4,
      spriteBlobPath: blobPath,
      spriteSheetSha256: sha256(sheetBytes),
      sourceFrameCount: 16,
      grid: { columns: 4, rows: 4 },
      playbackFrameIndices: Array.from({
        length: animation === 'walk'
          ? 16
          : ['idle', 'ko', 'victory'].includes(animation)
            ? 8
            : ['jump', 'crouch', 'hit'].includes(animation) ? 4 : 7,
      }, (_, index) => index),
      representativeFrameIndex: 2,
      selectionRationale: 'Synthetic deterministic fixture.',
    })),
  };
  const atlasPath = join(root, 'atlas.json');
  await writeFile(atlasPath, `${JSON.stringify(atlas, null, 2)}\n`);
  const first = await buildQaPoseAtlas({
    manifestPath: atlasPath,
    sourceDirs: { synthetic: sourceDir },
    archivePaths: { synthetic: archivePath },
    outputDir: join(root, 'first'),
  });
  const second = await buildQaPoseAtlas({
    manifestPath: atlasPath,
    sourceDirs: { synthetic: sourceDir },
    archivePaths: { synthetic: archivePath },
    outputDir: join(root, 'second'),
  });
  assert.equal(first.animations.length, QA_POSE_ATLAS_ANIMATIONS.length);
  assert.equal(first.sources[0].archiveSha256, sha256(archiveBytes));
  assert.equal(first.animations[0].frames.length, 8);
  assert.ok(first.animations.every((animation) => animation.frames.every((frame) => frame.qa.margins.bottom > 0)));
  assert.deepEqual(
    first.animations.flatMap((entry) => entry.frames.map((frame) => frame.pngSha256)),
    second.animations.flatMap((entry) => entry.frames.map((frame) => frame.pngSha256)),
  );
  assert.equal(first.reviewSheet.pngSha256, second.reviewSheet.pngSha256);
  assert.equal((await readFile(join(root, 'first', 'qa-pose-atlas-review.png'))).subarray(1, 4).toString('ascii'), 'PNG');
});
