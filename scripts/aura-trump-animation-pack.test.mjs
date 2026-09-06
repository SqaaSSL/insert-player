import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const subjectRoot = join(repositoryRoot, 'artifacts/aura-animation-canary/donald-trump');

const animations = Object.freeze({
  aura_unbothered: { frameWidth: 192, uniqueFrames: 8 },
  aura_mog_check: { frameWidth: 192, uniqueFrames: 8 },
  aura_glide: { frameWidth: 192, uniqueFrames: 8 },
  aura_floor_worm: { frameWidth: 384, uniqueFrames: 8 },
  aura_one_leg: { frameWidth: 256, uniqueFrames: 8 },
  aura_shrug: { frameWidth: 192, uniqueFrames: 3 },
});

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function inspectPng(path) {
  const bytes = readFileSync(path);
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

describe('Donald Trump Champion Aura animation pack', () => {
  for (const [animationName, contract] of Object.entries(animations)) {
    it(`compiles ${animationName} from individually generated, registered frames`, () => {
      const championRoot = join(subjectRoot, animationName, 'champion');
      const statePath = join(championRoot, 'generation-state.json');
      const reportPath = join(championRoot, 'processed/report.json');
      const runtimePath = join(repositoryRoot, `public/assets/aura/donald-trump/${animationName}.png`);
      expect(existsSync(statePath)).toBe(true);
      expect(existsSync(reportPath)).toBe(true);
      expect(existsSync(runtimePath)).toBe(true);

      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      const report = JSON.parse(readFileSync(reportPath, 'utf8'));
      const selectedFrames = Object.values(state.frames);
      expect(selectedFrames).toHaveLength(contract.uniqueFrames);
      expect(selectedFrames.every((frame) => frame.status === 'completed')).toBe(true);
      expect(new Set(state.sequence)).toEqual(new Set(Object.keys(state.frames)));
      expect(state.sequence).toHaveLength(8);
      expect(report.animationName).toBe(animationName);
      expect(report.status).toBe('champion_frames_runtime_ready_human_gameplay_review_required');
      expect(report.process).toMatchObject({
        generatedIndividually: true,
        wholeSheetGeneration: false,
        authoredScale: 4,
      });
      expect(report.frames).toHaveLength(contract.uniqueFrames);

      for (const frame of report.frames) {
        expect(frame.geometry.comparison.placement.canFitCanvas).toBe(true);
        expect(Math.abs(frame.geometry.centerError)).toBeLessThanOrEqual(2);
        expect(Math.abs(frame.geometry.rootError)).toBeLessThanOrEqual(2);
        expect(sha256File(join(repositoryRoot, frame.generatedRaw.path))).toBe(
          frame.generatedRaw.sha256,
        );
        expect(sha256File(join(repositoryRoot, frame.authored4x.path))).toBe(
          frame.authored4x.sha256,
        );
        expect(sha256File(join(repositoryRoot, frame.runtime1x.path))).toBe(
          frame.runtime1x.sha256,
        );
      }

      expect(sha256File(runtimePath)).toBe(report.runtimeAtlas.sha256);
      expect(inspectPng(runtimePath)).toMatchObject({
        width: contract.frameWidth * 4,
        height: 256 * 2,
        bitDepth: 8,
        colorTypeCode: 6,
      });
      expect(JSON.stringify(state)).not.toContain('/Users/');
      expect(JSON.stringify(report)).not.toContain('/Users/');
      expect(JSON.stringify(report)).not.toContain('.writing-');
    });
  }

  it('retains reviewed rejects instead of silently overwriting paid attempts', () => {
    const floorWormState = JSON.parse(readFileSync(
      join(subjectRoot, 'aura_floor_worm/champion/generation-state.json'),
      'utf8',
    ));
    expect(floorWormState.rejectedAttempts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        frameKey: 'frame01',
        reviewedReason: 'pose_drift_reclined_instead_of_upright_guard',
      }),
    ]));
    for (const rejected of floorWormState.rejectedAttempts) {
      expect(existsSync(join(repositoryRoot, rejected.outputPath))).toBe(true);
      expect(sha256File(join(repositoryRoot, rejected.outputPath))).toBe(rejected.outputSha256);
    }
  });
});
