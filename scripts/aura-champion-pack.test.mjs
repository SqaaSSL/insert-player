import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(
  repositoryRoot,
  'artifacts/aura-animation-canary/donald-trump/aura_six_seven/manifest.json',
);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const report = JSON.parse(
  readFileSync(join(repositoryRoot, manifest.qa.reportPath), 'utf8'),
);

function resolveArtifact(path) {
  return join(repositoryRoot, path);
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function expectFileHash(path, expectedHash) {
  const absolutePath = resolveArtifact(path);
  expect(existsSync(absolutePath), `Missing artifact: ${path}`).toBe(true);
  expect(sha256File(absolutePath), `Hash drift: ${path}`).toBe(expectedHash);
}

function inspectPng(path) {
  const bytes = readFileSync(resolveArtifact(path));
  expect(bytes.subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24],
    colorTypeCode: bytes[25],
  };
}

describe('Donald Trump Six-Seven Champion Aura pack', () => {
  it('locks the proven pose-first, per-frame Champion generation contract', () => {
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.qualityTarget).toBe('champion');
    expect(manifest.generation.model).toBe('grok-imagine-image-2-edit');
    expect(manifest.generation.wholeSheetGeneration).toBe(false);
    expect(manifest.generation.mode).toContain('one pose-first');
    expect(manifest.generation.referenceOrder).toEqual([
      'IMAGE 1: approved Template Zero pose and registration master',
      'IMAGE 2: trusted Donald Trump Champion character and rendering master',
      'IMAGE 3: original Donald Trump identity safeguard',
    ]);
    expect(manifest.sources.trumpChampionCanonical.sha256).toBe(
      '10a1f057097edec2c770f033d50d06b5cf8e2bd08d0320df9640366e24a00d54',
    );
    expect(manifest.sources.trumpOriginal.sha256).toBe(
      'af76d813828ebd4d56b1b18b44de3f850f3c7968022aafab2ece6514d15829fc',
    );
  });

  it('uses six independent masters and interleaves the corrected opposite-hand extremes', () => {
    const uniqueKeys = [
      'previous01',
      'leftHandHigh',
      'previous03',
      'rightHandHigh',
      'previous05',
      'previous07',
    ];
    expect(manifest.keyframes.uniqueGenerated).toBe(uniqueKeys.length);
    expect(manifest.keyframes.sequence).toEqual([
      'previous01',
      'leftHandHigh',
      'previous03',
      'rightHandHigh',
      'previous05',
      'leftHandHigh',
      'previous07',
      'rightHandHigh',
    ]);
    expect(new Set(manifest.keyframes.sequence)).toEqual(new Set(uniqueKeys));

    for (const key of uniqueKeys) {
      const frame = manifest.keyframes[key];
      expectFileHash(frame.rawPath, frame.rawSha256);
      expectFileHash(frame.registeredPath, frame.registeredSha256);
      expect(inspectPng(frame.rawPath)).toMatchObject({
        width: 1776,
        height: 2368,
        bitDepth: 8,
        colorTypeCode: 2,
      });
      expect(inspectPng(frame.registeredPath)).toMatchObject({
        width: 1536,
        height: 2048,
        bitDepth: 8,
        colorTypeCode: 6,
      });
    }
  });

  it('keeps deterministic registration inside tolerance and compiles both atlases correctly', () => {
    expectFileHash(manifest.qa.reportPath, manifest.qa.reportSha256);
    expect(report.process.generatedIndividually).toBe(true);
    expect(report.process.wholeSheetGeneration).toBe(false);
    expect(report.frames).toHaveLength(6);
    for (const frame of report.frames) {
      expect(frame.findings).toEqual([]);
      expect(frame.geometry.centerError).toBeLessThanOrEqual(
        manifest.qa.registeredCenterTolerancePixels,
      );
      expect(frame.geometry.rootError).toBeLessThanOrEqual(
        manifest.qa.registeredRootTolerancePixels,
      );
      expect(frame.geometry.comparison.placement.canFitCanvas).toBe(true);
    }

    const archival = manifest.compilation.archivalAtlas;
    expectFileHash(archival.path, archival.sha256);
    expect(inspectPng(archival.path)).toMatchObject({
      width: archival.frameWidth * archival.gridColumns,
      height: archival.frameHeight * archival.gridRows,
      bitDepth: 8,
      colorTypeCode: 6,
    });

    const runtime = manifest.compilation.runtime;
    expectFileHash(runtime.path, runtime.sha256);
    expect(inspectPng(runtime.path)).toMatchObject({
      width: runtime.frameWidth * runtime.gridColumns,
      height: runtime.frameHeight * runtime.gridRows,
      bitDepth: 8,
      colorTypeCode: 6,
    });
    expect(runtime.frameCount).toBe(manifest.keyframes.sequence.length);
  });

  it('records paid-call selection, rejection, and real Phaser playback without temp paths', () => {
    expectFileHash(
      manifest.generation.generationState.path,
      manifest.generation.generationState.sha256,
    );
    const state = JSON.parse(
      readFileSync(resolveArtifact(manifest.generation.generationState.path), 'utf8'),
    );
    expect(Object.values(state.frames).filter((frame) => frame.status === 'completed')).toHaveLength(6);
    expect(state.rejectedAttempts).toHaveLength(1);
    expect(state.frames.rightHandHigh.outputSha256).toBe(
      manifest.keyframes.rightHandHigh.rawSha256,
    );
    expect(state.rejectedAttempts[0].outputSha256).toBe(manifest.rejected[0].sha256);
    const selectedRawHashes = Object.values(manifest.keyframes)
      .filter((value) => value && typeof value === 'object' && 'rawSha256' in value)
      .map((frame) => frame.rawSha256);
    expect(selectedRawHashes).not.toContain(state.rejectedAttempts[0].outputSha256);
    expect(manifest.generation.costDisclosure).toMatchObject({
      selectedCalls: 6,
      rejectedCalls: 1,
      observedCalls: 7,
      observedAttemptCostMicrocredits: 770000,
    });

    expectFileHash(manifest.qa.gameplayReview.path, manifest.qa.gameplayReview.sha256);
    expect(manifest.qa.gameplayReview).toMatchObject({
      width: 1280,
      height: 720,
      result: 'pass-atlas-loaded-and-animated-in-phaser',
    });
    expect(JSON.stringify(manifest)).not.toContain('.writing-');
    expect(JSON.stringify(report)).not.toContain('.writing-');
    expect(JSON.stringify(state)).not.toContain('/Users/');
  });
});
