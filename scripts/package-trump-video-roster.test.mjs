import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { packageTrumpVideoRoster } from './package-trump-video-roster.mjs';
import { validateBundleDirectory } from './trump-video-roster-production-contract.mjs';

const ACTIONS = [
  'idle',
  'walk',
  'high_punch',
  'low_punch',
  'high_kick',
  'low_kick',
  'jump',
  'crouch',
  'hit',
  'ko',
  'victory',
];
const LOCAL_ACTIONS = ACTIONS.filter((action) => action !== 'high_kick');
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function png(marker) {
  const bytes = Buffer.alloc(25);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(1, 16);
  bytes.writeUInt32BE(1, 20);
  bytes[24] = marker;
  return bytes;
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function write(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function createFixture() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'trump-packager-test-'));
  temporaryDirectories.push(fixtureRoot);
  const rosterRoot = join(fixtureRoot, 'roster');
  const highKickRoot = join(fixtureRoot, 'high-kick');
  const outputDirectory = join(fixtureRoot, 'output');
  const artifactDirectory = join(rosterRoot, '.artifacts/arcade-trump-xai-video-roster-canary');
  const highKickDirectory = join(
    highKickRoot,
    '.artifacts/arcade-high-kick-xai-video-trump-v2-canary',
    'arcade-high-kick-xai-video-trump-v2/extracted-curated-v1',
  );

  const sprites = ACTIONS.map((animationName, index) => {
    const processed = png(index + 1);
    const raw = png(index + 21);
    return {
      animationName,
      file: `sprites/${animationName}.png`,
      rawFile: `sprites/raw/${animationName}.png`,
      sha256: digest(processed),
      rawSha256: digest(raw),
      sizeBytes: processed.length,
      rawSizeBytes: raw.length,
      sheetWidth: 1,
      sheetHeight: 1,
      rawSheetWidth: 1,
      rawSheetHeight: 1,
      frameWidth: 1,
      frameHeight: 1,
      frameCount: 1,
      processed,
      raw,
    };
  });

  const results = [];
  const qaManifest = {};
  for (const action of LOCAL_ACTIONS) {
    const sprite = sprites.find((candidate) => candidate.animationName === action);
    const actionDirectory = action === 'idle'
      ? join(artifactDirectory, 'idle-deterministic-local-v1/test-idle')
      : join(artifactDirectory, action, `test-${action}`, 'curated-v1');
    const processedPath = write(join(actionDirectory, 'playback-sheet-192x256.png'), sprite.processed);
    const rawPath = write(
      join(actionDirectory, action === 'idle' ? 'playback-sheet-192x256-on-green.png' : 'playback-sheet-768x1024.png'),
      sprite.raw,
    );
    const runtimeSheet = {
      path: processedPath,
      contentSha256: sprite.sha256,
      sizeBytes: sprite.sizeBytes,
    };
    results.push({
      action,
      outputDir: actionDirectory,
      status: 'completed',
      contractValidated: true,
      qaApproved: true,
      animationFormat: 'video-dense-v1',
      processingVersion: 5,
      ...(action === 'idle'
        ? {
            runtimeSheet: {
              ...runtimeSheet,
              width: 1,
              height: 1,
              frameWidth: 1,
              frameHeight: 1,
              frameCount: 1,
            },
          }
        : {
            extractionReport: {
              playbackFrameCount: 1,
              artifacts: {
                runtimeSheet,
                playbackSheet: {
                  path: rawPath,
                  contentSha256: sprite.rawSha256,
                  sizeBytes: sprite.rawSizeBytes,
                },
              },
            },
          }),
    });
    qaManifest[action] = action === 'idle'
      ? { deterministicLocalQaReportPath: join(actionDirectory, 'qa-report.json') }
      : { curatedExtractionReportPath: join(actionDirectory, 'extraction-report.json') };
  }

  const highKick = sprites.find((sprite) => sprite.animationName === 'high_kick');
  const highKickProcessedPath = write(join(highKickDirectory, 'playback-sheet-192x256.png'), highKick.processed);
  const highKickRawPath = write(join(highKickDirectory, 'playback-sheet-768x1024.png'), highKick.raw);
  const highKickReport = {
    uniqueFrameCount: 12,
    playbackFrameCount: 1,
    artifacts: {
      runtimeSheet: {
        path: highKickProcessedPath,
        contentSha256: highKick.sha256,
        sizeBytes: highKick.sizeBytes,
      },
      playbackSheet: {
        path: highKickRawPath,
        contentSha256: highKick.rawSha256,
        sizeBytes: highKick.rawSizeBytes,
      },
    },
  };
  const approvalDigest = 'f'.repeat(64);
  const highKickApproval = {
    status: 'approved',
    binding: {
      action: 'high_kick',
      runtimeSheetSha256: highKick.sha256,
      animationFormat: 'video-dense-v1',
      processingVersion: 5,
    },
    approvalDigestSha256: approvalDigest,
  };
  const batch = {
    schemaVersion: 2,
    experimentId: 'arcade-trump-xai-video-roster-v1',
    status: 'completed',
    results,
    reusedHighKick: {
      status: 'validated',
      qaApproved: true,
      runtimeSheetSha256: highKick.sha256,
      qaApproval: { approvalDigestSha256: approvalDigest },
    },
  };

  const batchBytes = jsonBytes(batch);
  const qaBytes = jsonBytes(qaManifest);
  const approvalBytes = jsonBytes(highKickApproval);
  const reportBytes = jsonBytes(highKickReport);
  write(join(artifactDirectory, 'batch-state.json'), batchBytes);
  write(join(artifactDirectory, 'qa/qa-manifest.json'), qaBytes);
  write(join(artifactDirectory, 'qa/high-kick-approval.json'), approvalBytes);
  write(join(highKickDirectory, 'extraction-report.json'), reportBytes);

  const sourceAssets = {
    original: png(80),
    standing: png(81),
    standingRaw: png(82),
    crouch: png(83),
    crouchRaw: png(84),
  };
  const originalSourcePath = write(join(fixtureRoot, 'donald-trump.png'), sourceAssets.original);
  write(join(artifactDirectory, 'anchors-v1/keyed-master-rgba.png'), sourceAssets.standing);
  write(join(artifactDirectory, 'anchors-v1/standing-overscan-v1.png'), sourceAssets.standingRaw);
  write(
    join(artifactDirectory, 'crouch/arcade-trump-xai-video-roster-v1-crouch/crouch-anchor-v1-rgba.png'),
    sourceAssets.crouch,
  );
  write(
    join(artifactDirectory, 'crouch/arcade-trump-xai-video-roster-v1-crouch/crouch-anchor-v1.png'),
    sourceAssets.crouchRaw,
  );
  const sourceSpecs = [
    ['original', 'original', 'original', sourceAssets.original],
    ['side', 'side', 'side', sourceAssets.standing],
    ['side_raw', 'sideRaw', 'side_raw', sourceAssets.standingRaw],
    ['upright', 'upright', 'upright', sourceAssets.standing],
    ['upright_raw', 'uprightRaw', 'upright_raw', sourceAssets.standingRaw],
    ['crouch', 'crouch', 'crouch', sourceAssets.crouch],
    ['crouch_raw', 'crouchRaw', 'crouch_raw', sourceAssets.crouchRaw],
  ];
  const contract = {
    schemaVersion: 1,
    bundleId: 'test-trump-bundle',
    fighter: {
      id: 'a'.repeat(32),
      slug: 'donald-trump',
      name: 'Donald Trump',
      photoHash: digest(sourceAssets.original),
      qualityTier: 'champion',
    },
    animationFormat: 'video-dense-v1',
    processingVersion: 5,
    sprites: sprites.map(({ processed: _processed, raw: _raw, ...sprite }) => sprite),
    sources: sourceSpecs.map(([kind, responseKey, hashKey, bytes]) => ({
      kind,
      responseKey,
      hashKey,
      file: `sources/${kind}.png`,
      sha256: digest(bytes),
      sizeBytes: bytes.length,
      width: 1,
      height: 1,
    })),
    provenance: [
      { kind: 'batch-state', file: 'provenance/batch-state.json', sha256: digest(batchBytes) },
      { kind: 'qa-manifest', file: 'provenance/qa-manifest.json', sha256: digest(qaBytes) },
      { kind: 'high-kick-approval', file: 'provenance/high-kick-approval.json', sha256: digest(approvalBytes) },
      {
        kind: 'high-kick-extraction-report',
        file: 'provenance/high-kick-extraction-report.json',
        sha256: digest(reportBytes),
      },
    ],
  };
  return { rosterRoot, highKickRoot, originalSourcePath, outputDirectory, contract };
}

describe('Trump video roster packager', () => {
  it('disables macOS copyfile metadata when spawning tar', () => {
    const fixture = createFixture();
    const fakeBin = join(dirname(fixture.outputDirectory), 'fake-bin');
    const markerPath = join(dirname(fixture.outputDirectory), 'copyfile-disable.txt');
    const fakeTar = join(fakeBin, 'tar');
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(
      fakeTar,
      '#!/bin/sh\nprintf \'%s\' "${COPYFILE_DISABLE:-}" > "${TRUMP_TAR_TEST_MARKER:?}"\n: > "$2"\n',
    );
    chmodSync(fakeTar, 0o700);

    const originalPath = process.env.PATH;
    const originalCopyfileDisable = process.env.COPYFILE_DISABLE;
    const originalMarker = process.env.TRUMP_TAR_TEST_MARKER;
    process.env.PATH = `${fakeBin}:${originalPath ?? ''}`;
    process.env.COPYFILE_DISABLE = '0';
    process.env.TRUMP_TAR_TEST_MARKER = markerPath;
    try {
      packageTrumpVideoRoster(fixture);
      expect(readFileSync(markerPath, 'utf8')).toBe('1');
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalCopyfileDisable === undefined) delete process.env.COPYFILE_DISABLE;
      else process.env.COPYFILE_DISABLE = originalCopyfileDisable;
      if (originalMarker === undefined) delete process.env.TRUMP_TAR_TEST_MARKER;
      else process.env.TRUMP_TAR_TEST_MARKER = originalMarker;
    }
  });

  it('assembles and revalidates a self-contained tar bundle', () => {
    const fixture = createFixture();
    const result = packageTrumpVideoRoster(fixture);
    expect(result.archiveSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.archiveSizeBytes).toBeGreaterThan(0);
    const validated = validateBundleDirectory(result.bundleDirectory, { contract: fixture.contract });
    expect(validated.spriteBytes).toHaveLength(11);
    expect(validated.rawSpriteBytes).toHaveLength(11);
    expect(validated.sourceBytes).toHaveLength(7);

    writeFileSync(join(result.bundleDirectory, 'sprites/idle.png'), png(99));
    expect(() => packageTrumpVideoRoster(fixture)).toThrow(/idle SHA-256 mismatch/);
    expect(readFileSync(result.archivePath).length).toBe(result.archiveSizeBytes);
  });
});
