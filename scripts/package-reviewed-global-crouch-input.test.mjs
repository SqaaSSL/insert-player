import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  XAI_CANONICAL_GLOBAL_CROUCH_POSE_REFERENCE,
  XAI_CANONICAL_GLOBAL_CROUCH_PROMPT_PROFILE,
} from './arcade-xai-canonical-bundle.mjs';
import {
  packageReviewedGlobalCrouchInput,
  REVIEWED_GLOBAL_CROUCH_INPUT_CONFIRMATION,
  REVIEWED_GLOBAL_SIDE_FOR_CROUCH_DECISION,
} from './package-reviewed-global-crouch-input.mjs';

const roster = JSON.parse(readFileSync(new URL('../arcade/roster-2026.json', import.meta.url), 'utf8'));
const directories = [];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function png(label, width = 896, height = 1195) {
  const bytes = Buffer.alloc(96, 0);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  Buffer.from(label).copy(bytes, 24, 0, Math.min(64, Buffer.byteLength(label)));
  return bytes;
}

function fixture(slug = 'rosalia') {
  const directory = mkdtempSync(join(tmpdir(), 'insert-player-global-crouch-package-'));
  directories.push(directory);
  const fighter = roster.fighters.find((entry) => entry.slug === slug);
  const sideBundleDirectory = join(directory, 'side-bundle');
  const outputDirectory = join(directory, 'output');
  const poseDirectory = join(directory, 'pose');
  mkdirSync(sideBundleDirectory, { recursive: true });
  mkdirSync(poseDirectory, { recursive: true });
  const sideRawBytes = png('reviewed-side-raw');
  const sideProcessedBytes = png('reviewed-side-clean');
  const sideRawPath = join(sideBundleDirectory, 'side_raw.png');
  writeFileSync(sideRawPath, sideRawBytes);
  const poseBytes = png('trump-crouch');
  const poseEvidenceBytes = Buffer.from('{"approved":true}\n');
  const poseEvidencePath = join(poseDirectory, 'pose-evidence.json');
  writeFileSync(poseEvidencePath, poseEvidenceBytes);
  const poseManifestPath = join(poseDirectory, 'pose-manifest.json');
  writeFileSync(poseManifestPath, '{}\n');
  const sideDescriptorSha256 = 'a'.repeat(64);
  const sideBundle = {
    sourceNames: ['side'],
    descriptor: {
      bundleId: `arcade-xai-canonical-source-${slug}-side-v1`,
      fighter: { slug, name: fighter.name, originalSha256: fighter.reference.sourceSha256 },
      sources: {
        side: {
          promptSha256: 'b'.repeat(64),
          pixcliJobId: 'side-job',
          providerRequestId: 'side-provider-request',
        },
      },
    },
    sources: {
      side: {
        processed: { contentSha256: sha256(sideProcessedBytes) },
        raw: {
          absolutePath: sideRawPath,
          contentSha256: sha256(sideRawBytes),
          sizeBytes: sideRawBytes.byteLength,
          width: 896,
          height: 1195,
        },
      },
    },
  };
  const pose = {
    ...XAI_CANONICAL_GLOBAL_CROUCH_POSE_REFERENCE,
    bytes: poseBytes,
    contentSha256: XAI_CANONICAL_GLOBAL_CROUCH_POSE_REFERENCE.contentSha256,
    sizeBytes: poseBytes.byteLength,
    width: 896,
    height: 1195,
    approvalEvidence: {
      path: 'pose-evidence.json',
      contentSha256: sha256(poseEvidenceBytes),
      selector: 'approved',
      expectedValue: true,
    },
  };
  return {
    directory,
    fighter,
    outputDirectory,
    sideBundleDirectory,
    sideDescriptorSha256,
    sideBundle,
    poseManifestPath,
    pose,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('reviewed global SIDE -> CROUCH input packaging', () => {
  it('binds the exact reviewed SIDE raw as rendering while keeping Trump pose and original identity', () => {
    const value = fixture();
    const validateReviewedBundle = vi.fn();
    const validatePromptReferences = vi.fn();
    let packagedOptions;
    const receipt = packageReviewedGlobalCrouchInput({
      confirmation: REVIEWED_GLOBAL_CROUCH_INPUT_CONFIRMATION,
      sideReviewDecision: REVIEWED_GLOBAL_SIDE_FOR_CROUCH_DECISION,
      slug: 'rosalia',
      sideBundleRunId: '33040000000',
      reviewedSideDescriptorSha256: value.sideDescriptorSha256,
      reviewedBy: 'qa-reviewer',
      reviewedAt: '2026-08-27T05:30:00.000Z',
      sideBundleDirectory: value.sideBundleDirectory,
      poseManifestPath: value.poseManifestPath,
      poseManifestSha256: sha256(readFileSync(value.poseManifestPath)),
      rosterPath: new URL('../arcade/roster-2026.json', import.meta.url),
      sourceDir: join(value.directory, 'identity-source'),
      outputDirectory: value.outputDirectory,
      loadReviewedBundle: () => value.sideBundle,
      validateReviewedBundle,
      loadPoseBundle: () => ({ sources: { crouch: { pose: value.pose } } }),
      validatePromptReferences,
      packageCanonicalInput: (options) => {
        packagedOptions = options;
        return {
          slug: options.slug,
          sourceName: options.sourceName,
          sourceNames: ['crouch'],
          promptProfile: XAI_CANONICAL_GLOBAL_CROUCH_PROMPT_PROFILE,
          promptSha256: 'c'.repeat(64),
          archivePath: join(options.outputDirectory, 'rosalia-crouch--canonical-input-v1.tar.gz'),
          archiveSha256: 'd'.repeat(64),
          r2Key: `temp/arcade-xai-canonical-inputs-v1/rosalia/rosalia-crouch--${'d'.repeat(16)}.tar.gz`,
          uploaded: false,
          providerCalled: false,
        };
      },
    });

    expect(validateReviewedBundle).toHaveBeenCalledWith(value.sideBundle, value.fighter);
    expect(validatePromptReferences).toHaveBeenCalledWith(
      expect.anything(),
      XAI_CANONICAL_GLOBAL_CROUCH_PROMPT_PROFILE,
      value.fighter,
    );
    expect(packagedOptions).toMatchObject({ slug: 'rosalia', sourceName: 'crouch' });
    const derived = JSON.parse(readFileSync(packagedOptions.poseManifestPath, 'utf8'));
    expect(derived.sources.crouch.pose).toMatchObject(XAI_CANONICAL_GLOBAL_CROUCH_POSE_REFERENCE);
    expect(derived.sources.crouch.rendering).toMatchObject({
      id: 'reviewed-rosalia-side-raw-v1',
      contentSha256: value.sideBundle.sources.side.raw.contentSha256,
    });
    const evidence = JSON.parse(readFileSync(
      join(value.outputDirectory, 'reviewed-global-crouch-pose/evidence/reviewed-side-approval.json'),
      'utf8',
    ));
    expect(evidence).toMatchObject({
      status: 'approved',
      decision: REVIEWED_GLOBAL_SIDE_FOR_CROUCH_DECISION,
      sideBundleRunId: '33040000000',
      reviewedDescriptorSha256: value.sideDescriptorSha256,
      fighter: { slug: 'rosalia', photoHash: value.fighter.reference.sourceSha256 },
      side: { rawSha256: value.sideBundle.sources.side.raw.contentSha256 },
      blockingFindings: [],
    });
    expect(receipt).toMatchObject({
      status: 'prepared_private_local',
      slug: 'rosalia',
      sideReview: {
        bundleRunId: '33040000000',
        reviewedDescriptorSha256: value.sideDescriptorSha256,
        rawSha256: value.sideBundle.sources.side.raw.contentSha256,
      },
      crouchInput: { sourceName: 'crouch', providerCalled: false },
      providerCalled: false,
      imported: false,
      activated: false,
    });
  });

  it('rejects unsealed fighters or absent explicit human SIDE approval before bundle access', () => {
    const loadReviewedBundle = vi.fn();
    const common = {
      confirmation: REVIEWED_GLOBAL_CROUCH_INPUT_CONFIRMATION,
      sideReviewDecision: REVIEWED_GLOBAL_SIDE_FOR_CROUCH_DECISION,
      sideBundleRunId: '33040000000',
      reviewedSideDescriptorSha256: 'a'.repeat(64),
      reviewedBy: 'qa-reviewer',
      reviewedAt: '2026-08-27T05:30:00.000Z',
      loadReviewedBundle,
    };
    expect(() => packageReviewedGlobalCrouchInput({ ...common, slug: 'aitana' }))
      .toThrow(/sealed only for Rosalía, Ibai Llanos, and Lamine Yamal/i);
    expect(() => packageReviewedGlobalCrouchInput({
      ...common,
      slug: 'rosalia',
      sideReviewDecision: 'APPROVE_AUTOMATICALLY',
    })).toThrow(/APPROVE_REVIEWED_GLOBAL_SIDE_FOR_CROUCH_V1/);
    expect(loadReviewedBundle).not.toHaveBeenCalled();
  });
});
