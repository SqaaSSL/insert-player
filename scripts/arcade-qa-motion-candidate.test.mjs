import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  QA_MOTION_CANARY,
  validateQaMotionCandidate,
} from './arcade-qa-motion-candidate.mjs';
import {
  fetchQaMotionReference,
  qaMotionReferenceObjectPath,
  verifyQaMotionReferenceBytes,
} from './fetch-arcade-qa-motion-references.mjs';

const atlas = JSON.parse(readFileSync(new URL('../arcade/qa-pose-atlas-2026.json', import.meta.url), 'utf8'));
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('sealed Arcade QA motion candidate', () => {
  it('pins Milei, the representative HIGH_PUNCH frame, three immutable references, and one paid call', () => {
    expect(QA_MOTION_CANARY).toMatchObject({
      candidateId: 'arcade-qa-milei-high-punch-f4-xai-v1',
      confirmation: 'ARCADE_QA_MILEI_HIGH_PUNCH_F4_XAI_V1',
      fighter: { slug: 'javier-milei' },
      motion: {
        atlasId: 'arcade-qa-pose-atlas-2026-v1',
        animation: 'high_punch',
        playbackFrameNumber: 4,
        sourceFrameIndex: 3,
      },
      provider: {
        modelId: 'grok-imagine-image-2-edit',
        catalogCostPerImage: 70000,
        estimatedCostUsd: 0.07,
        numImages: 1,
      },
      policy: {
        expectedPaidCalls: 1,
        automaticRetries: 0,
        fallback: 'none',
        activation: false,
        humanReviewRequired: true,
      },
    });
    expect(QA_MOTION_CANARY.motion.asset.contentSha256).toBe(
      '0f41337e9c79265c671906f9f5081280a72f9b72c0eacba04e649cf0bcd22d61',
    );
    expect(QA_MOTION_CANARY.canonical.contentSha256).toBe(
      '41dcb1e372fdfd36b7f53ba461198fdf26e645b637e3b4417a0833414a702559',
    );
    expect(QA_MOTION_CANARY.identity.contentSha256).toBe(
      '79d329b9bc0668de2d2df78f1ac0b6a3183aa9977e92055c63165046c6009f6c',
    );
    expect(Object.isFrozen(QA_MOTION_CANARY.motion.asset)).toBe(true);
  });

  it('fails closed if the animation or representative frame drifts from the frozen atlas', () => {
    const unknownMotion = structuredClone(QA_MOTION_CANARY);
    unknownMotion.motion.animation = 'provider_improvises';
    expect(() => validateQaMotionCandidate(unknownMotion, atlas)).toThrow(/reviewed provider prompt/i);

    const wrongFrame = structuredClone(QA_MOTION_CANARY);
    wrongFrame.motion.playbackFrameNumber = 3;
    expect(() => validateQaMotionCandidate(wrongFrame, atlas)).toThrow(/playback selection/i);
  });

  it('derives private EU R2 paths and verifies exact PNG bytes', () => {
    expect(qaMotionReferenceObjectPath(QA_MOTION_CANARY.motion.asset)).toBe(
      `insert-player-assets/${QA_MOTION_CANARY.motion.asset.objectKey}`,
    );
    const bytes = Buffer.concat([PNG_SIGNATURE, Buffer.from('qa-reference')]);
    const reference = {
      ...QA_MOTION_CANARY.motion.asset,
      contentSha256: createHash('sha256').update(bytes).digest('hex'),
    };
    expect(verifyQaMotionReferenceBytes(bytes, reference)).toBe(reference.contentSha256);
    expect(() => verifyQaMotionReferenceBytes(Buffer.from('definitely-not-a-png'), reference)).toThrow(/not PNG/i);
  });

  it('can preflight both R2 references without downloading or mutating them', () => {
    const missingRoot = join(tmpdir(), `insert-player-qa-reference-${randomUUID()}`);
    const pose = fetchQaMotionReference({
      candidate: QA_MOTION_CANARY,
      role: 'pose',
      dryRun: true,
      outputPath: join(missingRoot, 'pose.png'),
    });
    const canonical = fetchQaMotionReference({
      candidate: QA_MOTION_CANARY,
      role: 'canonical',
      dryRun: true,
      outputPath: join(missingRoot, 'canonical.png'),
    });
    expect(pose).toMatchObject({ action: 'remote', role: 'pose' });
    expect(canonical).toMatchObject({ action: 'remote', role: 'canonical' });
    expect(pose.objectPath).toContain('/official-pose-masters/qa-atlas-2026-v1/high_punch/');
    expect(canonical.objectPath).toContain(`/fighters/${QA_MOTION_CANARY.fighter.fighterId}/sources/`);
  });
});
