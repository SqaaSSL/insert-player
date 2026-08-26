import { describe, expect, it, vi } from 'vitest';
import {
  NOVA_QA_EXPERIMENT_MANIFEST,
  NOVA_QA_MOTION_CANDIDATE,
  XAI_NOVA_QA_POSE_MAX_COST_USD,
  runXaiNovaQaPoseCanary,
} from './arcade-nova-qa-pose-xai-canary.mjs';
import {
  buildXaiQaMotionCanaryPayload,
  buildXaiQaMotionCanaryPlan,
  buildXaiQaMotionCanaryPrompt,
} from './arcade-motion-xai-canary.mjs';
import { validateManifest } from './seed-arcade-roster.mjs';

describe('XAI Nova QA HIGH_PUNCH comparison canary', () => {
  it('uses pose, canonical, and identity in the sealed order for one unactivated image', () => {
    expect(() => validateManifest(NOVA_QA_EXPERIMENT_MANIFEST)).not.toThrow();
    const plan = buildXaiQaMotionCanaryPlan(NOVA_QA_EXPERIMENT_MANIFEST, {
      candidate: NOVA_QA_MOTION_CANDIDATE,
    });
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      slotKey: 'arcade-qa-nova-high-punch-f4-xai-v1:grok-imagine-image-2-edit',
      fighter: { slug: 'nova-qa', name: 'Nova QA' },
      model: { params: { resolution: '2k', num_images: 1 } },
    });
    const prompt = buildXaiQaMotionCanaryPrompt(plan[0], NOVA_QA_MOTION_CANDIDATE);
    expect(prompt).toContain('exact standing high-punch impact pose from IMAGE 1');
    expect(prompt).toContain('exact approved red cropped utility jacket');
    const payload = buildXaiQaMotionCanaryPayload({
      ...plan[0],
      sourceAssetHash: 'a'.repeat(32),
      poseAssetHash: 'b'.repeat(32),
      canonicalAssetHash: 'c'.repeat(32),
      prompt,
      candidate: NOVA_QA_MOTION_CANDIDATE,
    });
    expect(payload.image).toEqual(['b'.repeat(32), 'c'.repeat(32), 'a'.repeat(32)]);
    expect(payload).toMatchObject({
      model: 'grok-imagine-image-2-edit',
      enrich_prompt: false,
      publish: false,
      params: { resolution: '2k', quality: 'medium', num_images: 1 },
    });
    expect(NOVA_QA_MOTION_CANDIDATE.provider.estimatedCostUsd).toBe(0.12);
    expect(NOVA_QA_MOTION_CANDIDATE.policy).toMatchObject({
      expectedPaidCalls: 1,
      automaticRetries: 0,
      fallback: 'none',
      activation: false,
    });
  });

  it('blocks before catalog, uploads, or inference without the exact cost authorization', async () => {
    const fetchImpl = vi.fn();
    await expect(runXaiNovaQaPoseCanary({
      apiKey: 'test-key',
      fetchImpl,
      maxCostUsd: XAI_NOVA_QA_POSE_MAX_COST_USD - 0.01,
    })).rejects.toThrow(/requires maxCostUsd=0\.12/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
