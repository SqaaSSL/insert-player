import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HUMANOID_TEMPLATE_CANARY_CHECKPOINT,
  HUMANOID_TEMPLATE_CANARY_POSE_IDS,
  HUMANOID_TEMPLATE_MODEL,
  HUMANOID_TEMPLATE_REPAIR_CONFIRMATION,
  HUMANOID_TEMPLATE_REPAIR_FRAMES,
  HUMANOID_TEMPLATE_REPAIR_POLICY,
  HUMANOID_TEMPLATE_REPAIR_POSE_IDS,
  buildHumanoidTemplatePrompt,
  buildHumanoidTemplateRepairDirective,
  buildHumanoidTemplateRepairPayload,
  buildHumanoidTemplateRepairPrompt,
  executeHumanoidTemplateBatch,
  parseHumanoidTemplateCliArgs,
  verifyHumanoidTemplateCanaryArtifact,
  verifyHumanoidTemplateCanaryCheckpointState,
} from './humanoid-pose-template-xai-selective-v5.mjs';

const workflowPath = resolve('.github/workflows/humanoid-pose-template-xai-v5-repair.yml');

function repairPose(index) {
  return {
    poseId: HUMANOID_TEMPLATE_REPAIR_POSE_IDS[index],
    sourceSlots: [HUMANOID_TEMPLATE_REPAIR_FRAMES[index]],
  };
}

describe('humanoid V5 nineteen-pose repair continuation', () => {
  it('pins the exact reviewed canary artifact and decrypted checkpoint lineage', () => {
    expect(HUMANOID_TEMPLATE_CANARY_CHECKPOINT).toEqual({
      sourceRunId: '33343450009',
      artifactId: '9741312074',
      artifactName: 'humanoid-neutral-medium-xai-selective-v5-encrypted',
      artifactZipSha256: '420adad6d1f4a97cbf18d3f00ec5f1676800f35988d97ac1d6b7d3594e840dcd',
      ciphertextName: 'humanoid-selective-v5-checkpoint.tar.gz.ipenc',
      ciphertextSha256: 'd48a3f78e0a1491fc36ca4310f723e8b9e0c00b3f4946d6970175bcacdfb293e',
      generatorCommitSha: '0a66f1631958a5a96100eac8d39b9f9cc0cbed5f',
      stateSha256: '77f519280e9701d833362c32f9cb008a238557eb02ad921a4f432f74d9a8c867',
      manifestSha256: '88db095eb86f716a798ba7c873c698ea87f1150da07d1b3909f500f39cc87578',
      planSha256: '51f7763cecb4ba9cc761846d5ae7a076660610c018bf4b180aea12eab31a8ac9',
      status: 'canary_complete_human_review_required',
      completedPoseCount: 5,
      totalCostMicrocredits: 500_000,
    });
  });

  it('selects exactly the nineteen unpaid poses and no paid canary pose', () => {
    expect(HUMANOID_TEMPLATE_REPAIR_FRAMES).toEqual([
      { animationName: 'high_kick', frameNumber: 4 },
      { animationName: 'high_kick', frameNumber: 5 },
      { animationName: 'high_punch', frameNumber: 2 },
      { animationName: 'high_punch', frameNumber: 4 },
      { animationName: 'high_punch', frameNumber: 6 },
      { animationName: 'idle', frameNumber: 4 },
      { animationName: 'ko', frameNumber: 1 },
      { animationName: 'ko', frameNumber: 3 },
      { animationName: 'ko', frameNumber: 4 },
      { animationName: 'ko', frameNumber: 5 },
      { animationName: 'ko', frameNumber: 8 },
      { animationName: 'ko', frameNumber: 11 },
      { animationName: 'low_kick', frameNumber: 4 },
      { animationName: 'low_kick', frameNumber: 5 },
      { animationName: 'low_kick', frameNumber: 7 },
      { animationName: 'low_kick', frameNumber: 9 },
      { animationName: 'low_punch', frameNumber: 6 },
      { animationName: 'victory', frameNumber: 4 },
      { animationName: 'victory', frameNumber: 9 },
    ]);
    expect(HUMANOID_TEMPLATE_REPAIR_POSE_IDS).toEqual([
      'pose-009-1c68f61f7b8e',
      'pose-010-08c72b553ad3',
      'pose-019-39abc3e8c7c8',
      'pose-021-f9ad82f8f8e1',
      'pose-023-b51d09cf8edc',
      'pose-032-45917e89bfe6',
      'pose-045-7d8079f55708',
      'pose-047-85c06b8f3ff4',
      'pose-048-a238272c2686',
      'pose-049-2def2dd84191',
      'pose-052-3230240640e1',
      'pose-055-5655accf5650',
      'pose-060-3f470ba7a879',
      'pose-061-86dfa9041794',
      'pose-063-9b96aee26b28',
      'pose-065-c469b54664bc',
      'pose-070-6b1de52c67b6',
      'pose-074-e755e505b366',
      'pose-079-f70b975fff94',
    ]);
    expect(new Set(HUMANOID_TEMPLATE_REPAIR_POSE_IDS).size).toBe(19);
    expect(HUMANOID_TEMPLATE_REPAIR_POSE_IDS.some((poseId) => HUMANOID_TEMPLATE_CANARY_POSE_IDS.includes(poseId))).toBe(false);
  });

  it('locks one exact frame-specific directive after the unchanged V5 pose and identity prompt', () => {
    for (let index = 0; index < HUMANOID_TEMPLATE_REPAIR_POSE_IDS.length; index += 1) {
      const pose = repairPose(index);
      const directive = buildHumanoidTemplateRepairDirective(pose);
      expect(directive).toContain(`POSE CHECK — ${pose.sourceSlots[0].animationName.replace('_', ' ').toUpperCase()} FRAME ${pose.sourceSlots[0].frameNumber}`);
      expect(directive).toContain('exactly as in IMAGE 1');
      expect(buildHumanoidTemplateRepairPrompt(pose)).toBe(`${buildHumanoidTemplatePrompt(pose)}\n\n${directive}`);
    }
  });

  it('builds only the maximum-quality two-reference no-publish repair payload', () => {
    const pose = repairPose(0);
    expect(buildHumanoidTemplateRepairPayload({
      poseAssetHash: 'a'.repeat(32),
      identityAssetHash: 'b'.repeat(32),
      pose,
    })).toEqual({
      prompt: buildHumanoidTemplateRepairPrompt(pose),
      model: 'grok-imagine-image-2-edit',
      image: ['a'.repeat(32), 'b'.repeat(32)],
      params: {
        num_images: 1,
        aspect_ratio: 'auto',
        resolution: '2k',
        output_format: 'png',
        quality: 'medium',
      },
      enrich_prompt: false,
      search: false,
      output_format: 'url',
      publish: false,
      publish_name: 'ip-humanoid-selective-v5-repair-009',
    });
    expect(() => buildHumanoidTemplateRepairPayload({
      poseAssetHash: 'a'.repeat(32),
      identityAssetHash: 'b'.repeat(32),
      pose: { poseId: HUMANOID_TEMPLATE_CANARY_POSE_IDS[0], sourceSlots: [{ animationName: 'high_kick', frameNumber: 2 }] },
    })).toThrow(/19 sealed continuation poses/i);
  });

  it('caps the continuation at nineteen POSTs, $1.90 expected, and $2.09 catalog maximum', () => {
    expect(HUMANOID_TEMPLATE_MODEL.expectedTwoReferenceCostMicrocredits).toBe(100_000);
    expect(HUMANOID_TEMPLATE_MODEL.catalogMaximumCostMicrocredits).toBe(110_000);
    expect(HUMANOID_TEMPLATE_REPAIR_POLICY.paidCalls).toBe(19);
    expect(HUMANOID_TEMPLATE_REPAIR_POLICY.maximumTotalCostMicrocredits).toBe(1_900_000);
    expect(HUMANOID_TEMPLATE_REPAIR_POLICY.catalogMaximumTotalCostMicrocredits).toBe(2_090_000);
    expect(HUMANOID_TEMPLATE_REPAIR_POLICY.preservedCanaryPaidCalls).toBe(5);
    expect(HUMANOID_TEMPLATE_REPAIR_POLICY.combinedReviewedPoseCount).toBe(24);
    expect(HUMANOID_TEMPLATE_REPAIR_POLICY.combinedExpectedCostMicrocredits).toBe(2_400_000);
    expect(HUMANOID_TEMPLATE_REPAIR_POLICY.automaticRetries).toBe(0);
    expect(HUMANOID_TEMPLATE_REPAIR_POLICY.fallback).toBe('none');
    expect(HUMANOID_TEMPLATE_REPAIR_POLICY.fullBatch).toBe(false);
    expect(HUMANOID_TEMPLATE_REPAIR_POLICY.import).toBe(false);
    expect(HUMANOID_TEMPLATE_REPAIR_POLICY.activation).toBe(false);
  });

  it('has no full execution mode and requires the exact repair confirmation before any API work', async () => {
    expect(parseHumanoidTemplateCliArgs([
      '--prepare-repair',
      '--mode=repair',
      '--work-dir=/tmp/humanoid-v5-repair-test',
    ])).toMatchObject({ prepareRepair: true, execute: false, mode: 'repair' });
    expect(parseHumanoidTemplateCliArgs([
      '--execute',
      '--mode=repair',
      `--confirm=${HUMANOID_TEMPLATE_REPAIR_CONFIRMATION}`,
      '--work-dir=/tmp/humanoid-v5-repair-test',
    ])).toMatchObject({ execute: true, mode: 'repair', confirmation: HUMANOID_TEMPLATE_REPAIR_CONFIRMATION });
    expect(() => parseHumanoidTemplateCliArgs(['--execute', '--mode=full'])).toThrow(/full mode does not exist/i);
    await expect(executeHumanoidTemplateBatch({
      mode: 'repair',
      confirmation: 'wrong',
    })).rejects.toThrow(/Exact V5 selective repair confirmation/i);
  });

  it('rejects an altered artifact or decrypted state before continuation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'humanoid-v5-artifact-test-'));
    const stateDirectory = mkdtempSync(join(tmpdir(), 'humanoid-v5-state-test-'));
    try {
      writeFileSync(join(directory, HUMANOID_TEMPLATE_CANARY_CHECKPOINT.ciphertextName), 'altered ciphertext');
      writeFileSync(
        join(directory, `${HUMANOID_TEMPLATE_CANARY_CHECKPOINT.ciphertextName}.sha256`),
        `${HUMANOID_TEMPLATE_CANARY_CHECKPOINT.ciphertextSha256}  ${HUMANOID_TEMPLATE_CANARY_CHECKPOINT.ciphertextName}\n`,
      );
      writeFileSync(join(directory, 'checkpoint-metadata.json'), '{}\n');
      expect(() => verifyHumanoidTemplateCanaryArtifact(directory)).toThrow(/ciphertext SHA-256 changed/i);
      mkdirSync(join(stateDirectory, 'nested'));
      const statePath = join(stateDirectory, 'state.json');
      writeFileSync(statePath, '{}\n');
      expect(() => verifyHumanoidTemplateCanaryCheckpointState({ statePath })).toThrow(/state SHA-256 changed/i);
    } finally {
      rmSync(directory, { recursive: true, force: true });
      rmSync(stateDirectory, { recursive: true, force: true });
    }
  });

  it('keeps the paid workflow single-use, commit-bound, encrypted, and non-activating', async () => {
    const workflow = await import('node:fs').then(({ readFileSync }) => readFileSync(workflowPath, 'utf8'));
    expect(workflow).toContain('SOURCE_RUN_ID: \'33343450009\'');
    expect(workflow).toContain("SOURCE_ARTIFACT_ID: '9741312074'");
    expect(workflow).toContain('SOURCE_ARTIFACT_ZIP_SHA256: 420adad6d1f4a97cbf18d3f00ec5f1676800f35988d97ac1d6b7d3594e840dcd');
    expect(workflow).toContain('SOURCE_CIPHERTEXT_SHA256: d48a3f78e0a1491fc36ca4310f723e8b9e0c00b3f4946d6970175bcacdfb293e');
    expect(workflow).toContain('SOURCE_GENERATOR_SHA: 0a66f1631958a5a96100eac8d39b9f9cc0cbed5f');
    expect(workflow).toContain("expected='GENERATE_HUMANOID_POSE_TEMPLATE_XAI_REPAIR_V5_19'");
    expect(workflow).toContain('"$GITHUB_RUN_ATTEMPT" == \'1\'');
    expect(workflow).toContain('"$REQUESTED_GENERATOR_SHA" == "$GITHUB_SHA"');
    expect(workflow).toContain('ref: ${{ steps.authorize.outputs.generator_sha }}');
    expect(workflow).toContain('actions/artifacts/$SOURCE_ARTIFACT_ID/zip');
    expect(workflow).toContain('--verify-canary-artifact');
    expect(workflow).toContain('--prepare-repair');
    expect(workflow).toContain('--mode=repair');
    expect(workflow).not.toContain('--mode=full');
    expect(workflow).not.toContain('continue-on-error: true');
    expect(workflow).not.toMatch(/npm run arcade:(?:import|activate)/);
    expect(workflow).not.toMatch(/wrangler (?:deploy|d1)/);
    const cleanupIndex = workflow.indexOf('Remove every plaintext checkpoint before artifact upload');
    const uploadIndex = workflow.indexOf('Preserve only ciphertext, checksum, and non-sensitive lineage');
    expect(cleanupIndex).toBeGreaterThan(0);
    expect(uploadIndex).toBeGreaterThan(cleanupIndex);
    const uploadPaths = workflow.match(/path: \|\n((?:\s{12}.+\n){3})\s{10}if-no-files-found:/)?.[1]
      ?.trim().split('\n').map((line) => line.trim());
    expect(uploadPaths).toEqual([
      '.humanoid-v5-repair-encrypted-artifact/humanoid-selective-v5-repair-checkpoint.tar.gz.ipenc',
      '.humanoid-v5-repair-encrypted-artifact/humanoid-selective-v5-repair-checkpoint.tar.gz.ipenc.sha256',
      '.humanoid-v5-repair-encrypted-artifact/checkpoint-metadata.json',
    ]);
  });
});
