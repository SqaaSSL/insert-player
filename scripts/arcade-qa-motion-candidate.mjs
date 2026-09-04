import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARCADE_MOTION_TRANSFER_SPECS } from './arcade-provider-prompts.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const QA_MOTION_CANARY_PATH = join(root, 'arcade/qa-motion-canary-2026.json');
export const QA_POSE_ATLAS_PATH = join(root, 'arcade/qa-pose-atlas-2026.json');

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value ?? {}).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} keys are not sealed.`);
  }
}

function assertHash(value, label) {
  if (!/^[a-f0-9]{64}$/.test(value ?? '')) throw new Error(`${label} SHA-256 is invalid.`);
}

function assertAsset(asset, label, options = {}) {
  const idRequired = options.idRequired !== false;
  assertExactKeys(
    asset,
    [
      ...(idRequired ? ['id'] : []),
      'bucket',
      'jurisdiction',
      'objectKey',
      'contentSha256',
      'width',
      'height',
      ...(options.extraKeys ?? []),
    ],
    label,
  );
  if (idRequired && !/^[a-z0-9-]+$/.test(asset.id ?? '')) throw new Error(`${label} id is invalid.`);
  if (asset.bucket !== 'insert-player-assets' || asset.jurisdiction !== 'eu') {
    throw new Error(`${label} must use the private EU production bucket.`);
  }
  if (typeof asset.objectKey !== 'string' || asset.objectKey.startsWith('/') || asset.objectKey.includes('..')) {
    throw new Error(`${label} object key is invalid.`);
  }
  assertHash(asset.contentSha256, label);
  for (const dimension of ['width', 'height']) {
    if (!Number.isSafeInteger(asset[dimension]) || asset[dimension] < 256 || asset[dimension] > 4096) {
      throw new Error(`${label} ${dimension} is invalid.`);
    }
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function validateQaMotionCandidate(candidate, atlas) {
  assertExactKeys(
    candidate,
    ['schemaVersion', 'candidateId', 'confirmation', 'approvalRequired', 'fighter', 'motion', 'canonical', 'identity', 'provider', 'policy'],
    'QA motion candidate',
  );
  if (candidate.schemaVersion !== 1) throw new Error('Unsupported QA motion candidate schema.');
  if (!/^arcade-qa-[a-z0-9-]+-v[0-9]+$/.test(candidate.candidateId ?? '')) {
    throw new Error('QA motion candidate id is invalid.');
  }
  if (!/^ARCADE_QA_[A-Z0-9_]+_V[0-9]+$/.test(candidate.confirmation ?? '')) {
    throw new Error('QA motion confirmation is invalid.');
  }
  if (candidate.approvalRequired !== true) throw new Error('QA motion candidate must require approval.');

  assertExactKeys(candidate.fighter, ['slug', 'fighterId'], 'QA fighter');
  if (!/^[a-z0-9-]+$/.test(candidate.fighter.slug ?? '')) throw new Error('QA fighter slug is invalid.');
  if (!/^[a-f0-9]{32}$/.test(candidate.fighter.fighterId ?? '')) throw new Error('QA fighter id is invalid.');

  assertExactKeys(
    candidate.motion,
    ['atlasId', 'animation', 'playbackFrameNumber', 'sourceFrameIndex', 'asset'],
    'QA motion',
  );
  if (atlas?.atlasId !== candidate.motion.atlasId) throw new Error('QA motion atlas id is not pinned.');
  if (!ARCADE_MOTION_TRANSFER_SPECS[candidate.motion.animation]) {
    throw new Error('QA motion lacks a reviewed provider prompt contract.');
  }
  const animation = atlas.animations?.find((entry) => entry.animation === candidate.motion.animation);
  if (!animation) throw new Error('QA motion is missing from the frozen atlas.');
  if (!Number.isSafeInteger(candidate.motion.playbackFrameNumber) || candidate.motion.playbackFrameNumber < 1) {
    throw new Error('QA playback frame number is invalid.');
  }
  const selectedSourceFrame = animation.playbackFrameIndices[candidate.motion.playbackFrameNumber - 1];
  if (selectedSourceFrame !== candidate.motion.sourceFrameIndex) {
    throw new Error('QA motion frame does not match the frozen atlas playback selection.');
  }
  if (animation.representativeFrameIndex !== candidate.motion.sourceFrameIndex) {
    throw new Error('QA motion canary must use the reviewed representative frame.');
  }
  assertAsset(candidate.motion.asset, 'QA pose frame');
  if (candidate.motion.asset.width !== atlas.frame?.width || candidate.motion.asset.height !== atlas.frame?.height) {
    throw new Error('QA pose frame dimensions do not match the atlas.');
  }

  assertAsset(candidate.canonical, 'QA canonical', { extraKeys: ['kind'] });
  assertAsset(candidate.identity, 'QA identity', { idRequired: false, extraKeys: ['kind'] });
  if (candidate.canonical.kind !== 'side' || candidate.identity.kind !== 'original') {
    throw new Error('QA canonical and identity kinds are not pinned.');
  }
  for (const reference of [candidate.canonical, candidate.identity]) {
    if (!reference.objectKey.includes(`/fighters/${candidate.fighter.fighterId}/sources/`)) {
      throw new Error('QA fighter reference points at a different fighter.');
    }
  }

  assertExactKeys(
    candidate.provider,
    ['modelId', 'endpoint', 'provider', 'backend', 'catalogCostPerImage', 'estimatedCostUsd', 'numImages'],
    'QA provider',
  );
  if (
    candidate.provider.modelId !== 'grok-imagine-image-2-edit'
    || candidate.provider.endpoint !== 'xai/grok-imagine-image/v2.0/edit'
    || candidate.provider.provider !== 'xai'
    || candidate.provider.backend !== 'fal'
    || candidate.provider.catalogCostPerImage !== 70000
    || candidate.provider.estimatedCostUsd !== 0.07
    || candidate.provider.numImages !== 1
  ) {
    throw new Error('QA provider contract has changed and requires a new candidate.');
  }

  assertExactKeys(
    candidate.policy,
    ['expectedPaidCalls', 'automaticRetries', 'fallback', 'promptEnrichment', 'activation', 'humanReviewRequired'],
    'QA policy',
  );
  if (
    candidate.policy.expectedPaidCalls !== 1
    || candidate.policy.automaticRetries !== 0
    || candidate.policy.fallback !== 'none'
    || candidate.policy.promptEnrichment !== false
    || candidate.policy.activation !== false
    || candidate.policy.humanReviewRequired !== true
  ) {
    throw new Error('QA one-call policy is not fail-closed.');
  }
  return deepFreeze(candidate);
}

export function loadQaMotionCandidate(options = {}) {
  const candidate = JSON.parse(readFileSync(options.candidatePath ?? QA_MOTION_CANARY_PATH, 'utf8'));
  const atlas = JSON.parse(readFileSync(options.atlasPath ?? QA_POSE_ATLAS_PATH, 'utf8'));
  return validateQaMotionCandidate(candidate, atlas);
}

export const QA_MOTION_CANARY = loadQaMotionCandidate();
