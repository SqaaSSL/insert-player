import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { XAI_HIGH_KICK_IMPACT_POSE_MASTER } from './fetch-arcade-motion-master.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const atlas = JSON.parse(await readFile(join(root, 'arcade/qa-pose-atlas-2026.json'), 'utf8'));

describe('immutable QA pose atlas', () => {
  it('covers every runtime animation exactly once', () => {
    expect(atlas.animations.map((entry) => entry.animation)).toEqual([
      'idle',
      'walk',
      'high_punch',
      'high_kick',
      'low_punch',
      'low_kick',
      'jump',
      'crouch',
      'hit',
      'ko',
      'victory',
    ]);
  });

  it('keeps frame generation isolated and human-gated', () => {
    expect(atlas.status).toBe('qa_only');
    expect(atlas.transferContract).toEqual({
      referenceOrder: ['pose_frame', 'canonical_character', 'identity_photo'],
      frameIsolation: 'independent',
      previousOutputChaining: false,
      automaticRetries: 0,
      fallbackPolicy: 'none',
      activationPolicy: 'human_review_required',
    });
  });

  it('matches the already proven high-kick impact master byte for byte', () => {
    const override = atlas.animations.find((entry) => entry.animation === 'high_kick').impactOverride;
    expect(override).toMatchObject({
      id: XAI_HIGH_KICK_IMPACT_POSE_MASTER.id,
      bucket: XAI_HIGH_KICK_IMPACT_POSE_MASTER.bucket,
      jurisdiction: XAI_HIGH_KICK_IMPACT_POSE_MASTER.jurisdiction,
      objectKey: XAI_HIGH_KICK_IMPACT_POSE_MASTER.objectKey,
      contentSha256: XAI_HIGH_KICK_IMPACT_POSE_MASTER.contentSha256,
    });
  });
});
