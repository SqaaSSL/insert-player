import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildInitialState,
  buildPixcliPayload,
  runBakeoff,
} from './arcade-side-bakeoff.mjs';
import { ensureXaiPoseMasterUpload } from './arcade-side-xai-canary.mjs';
import {
  ARCADE_PROMPT_PROFILES,
  buildArcadeProviderPrompt,
} from './arcade-provider-prompts.mjs';
import { QA_MOTION_CANARY } from './arcade-qa-motion-candidate.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_MANIFEST_PATH = join(root, 'arcade/roster-2026.json');
const DEFAULT_SOURCE_DIR = join(root, '.arcade-sources');
const DEFAULT_REFERENCE_DIR = join(root, '.arcade-pose-masters');
const DEFAULT_OUTPUT_DIR = join(root, '.artifacts/arcade-motion-xai-canary');
const DEFAULT_STATE_PATH = join(root, '.arcade-qa-milei-high-punch-f4-xai-state.json');
const DEFAULT_POSE_UPLOAD_STATE_PATH = join(root, '.arcade-qa-high-punch-f4-upload-state.json');
const DEFAULT_CANONICAL_UPLOAD_STATE_PATH = join(root, '.arcade-qa-milei-canonical-upload-state.json');
const REQUEST_TIMEOUT_MS = 60_000;

export const XAI_QA_MOTION_CANARY_EXPERIMENT_ID = QA_MOTION_CANARY.candidateId;
export const XAI_QA_MOTION_CANARY_CONFIRMATION = QA_MOTION_CANARY.confirmation;

function parseArg(rawArgs, name, fallback = '') {
  return rawArgs.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
}

function uploadDescriptor(reference) {
  return Object.freeze({
    id: reference.id,
    slug: reference.id,
    contentSha256: reference.contentSha256,
  });
}

function policyConstraints(candidate) {
  return Object.freeze({
    candidateId: candidate.candidateId,
    fighterSlug: candidate.fighter.slug,
    motionAnimation: candidate.motion.animation,
    playbackFrameNumber: candidate.motion.playbackFrameNumber,
    providerModelId: candidate.provider.modelId,
    providerCatalogCostPerImage: candidate.provider.catalogCostPerImage,
    maxEstimatedCostUsd: candidate.provider.estimatedCostUsd,
    humanReviewRequired: true,
  });
}

export function qaMotionCatalogPreflightRequired(statePath) {
  if (!existsSync(statePath)) return true;
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const slots = Object.values(state?.slots ?? {});
  if (slots.length === 0) return true;
  return !slots.every((slot) => (
    typeof slot?.pixcliJobId === 'string'
    || slot?.status === 'completed'
    || slot?.status === 'failed'
    || slot?.status === 'submission_rejected'
  ));
}

export async function preflightXaiQaMotionModel(options = {}) {
  const candidate = options.candidate ?? QA_MOTION_CANARY;
  const apiKey = options.apiKey ?? '';
  if (!apiKey) throw new Error('PIXCLI_API_KEY is required.');
  const apiBase = (options.apiBase ?? 'https://pixcli.hilo.cx').replace(/\/$/, '');
  const response = await (options.fetchImpl ?? fetch)(`${apiBase}/api/v1/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'User-Agent': 'insert-player-arcade-motion-canary/1.0',
    },
    signal: AbortSignal.timeout(options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`PixCLI model preflight returned non-JSON HTTP ${response.status}.`);
  }
  if (!response.ok) throw new Error(`PixCLI model preflight failed with HTTP ${response.status}.`);
  const models = Array.isArray(body) ? body : body?.models;
  if (!Array.isArray(models)) throw new Error('PixCLI model preflight returned an unsupported catalog.');
  const model = models.find((entry) => entry?.id === candidate.provider.modelId);
  if (!model) throw new Error(`Pinned PixCLI model is unavailable: ${candidate.provider.modelId}.`);
  if (
    model.provider !== candidate.provider.provider
    || model.backend !== candidate.provider.backend
    || model.cost_per_image !== candidate.provider.catalogCostPerImage
    || model.advanced_mode !== true
    || !Array.isArray(model.capabilities)
    || !model.capabilities.includes('edit')
    || !model.capabilities.includes('image-to-image')
  ) {
    throw new Error('Pinned PixCLI model contract or price changed; new human approval is required.');
  }
  return model;
}

export function buildXaiQaMotionCanaryModel(candidate = QA_MOTION_CANARY) {
  return Object.freeze({
    id: candidate.provider.modelId,
    code: 'grok2qa',
    endpoint: candidate.provider.endpoint,
    promptProfile: ARCADE_PROMPT_PROFILES.xaiCanonicalMotionTransfer,
    referenceInputs: Object.freeze([
      Object.freeze({
        role: 'motion_pose_composition_master',
        id: candidate.motion.asset.id,
        contentSha256: candidate.motion.asset.contentSha256,
      }),
      Object.freeze({
        role: 'canonical_character_rendering_master',
        id: candidate.canonical.id,
        contentSha256: candidate.canonical.contentSha256,
      }),
    ]),
    params: Object.freeze({
      num_images: candidate.provider.numImages,
      aspect_ratio: 'auto',
      resolution: '2k',
      output_format: 'png',
      quality: 'medium',
    }),
  });
}

export const XAI_QA_MOTION_CANARY_MODEL = buildXaiQaMotionCanaryModel();

export function buildXaiQaMotionCanaryPlan(manifest, options = {}) {
  const candidate = options.candidate ?? QA_MOTION_CANARY;
  const model = options.model ?? buildXaiQaMotionCanaryModel(candidate);
  const fighter = manifest.fighters.find((entry) => entry.slug === candidate.fighter.slug);
  if (!fighter) throw new Error(`QA motion fighter is missing: ${candidate.fighter.slug}.`);
  if (fighter.reference?.sourceSha256 !== candidate.identity.contentSha256) {
    throw new Error(`QA motion identity hash drifted for ${candidate.fighter.slug}.`);
  }
  return [{
    slotKey: `${candidate.candidateId}:${model.id}`,
    fighter,
    model,
  }];
}

export function buildXaiQaMotionCanaryPrompt({ fighter, model }, candidate = QA_MOTION_CANARY) {
  return buildArcadeProviderPrompt({
    fighter,
    promptProfile: model.promptProfile,
    motionAnimation: candidate.motion.animation,
  });
}

export function buildXaiQaMotionCanaryPayload({
  fighter,
  model,
  sourceAssetHash,
  poseAssetHash,
  canonicalAssetHash,
  prompt,
  candidate = QA_MOTION_CANARY,
}) {
  for (const [label, hash] of [
    ['pose frame', poseAssetHash],
    ['canonical character', canonicalAssetHash],
  ]) {
    if (!/^[a-f0-9]{32}$/.test(hash ?? '')) throw new Error(`XAI QA ${label} asset hash is invalid.`);
  }
  const payload = buildPixcliPayload({ fighter, model, sourceAssetHash, prompt });
  const marker = `ip-motion-v1-${fighter.slug}-${candidate.motion.animation.replaceAll('_', '-')}-f${candidate.motion.playbackFrameNumber}-${model.code}`;
  if (marker.length > 60) throw new Error(`PixCLI QA motion marker exceeds 60 characters: ${marker}.`);
  return {
    ...payload,
    image: [poseAssetHash, canonicalAssetHash, sourceAssetHash],
    publish_name: marker,
  };
}

export function buildXaiQaMotionCanaryInitialState(matrixSha256, candidate = QA_MOTION_CANARY) {
  return buildInitialState(matrixSha256, {
    experimentId: candidate.candidateId,
    expectedPaidCalls: 1,
    policyConstraints: policyConstraints(candidate),
  });
}

export async function runXaiQaMotionCanary(options = {}) {
  const candidate = options.candidate ?? QA_MOTION_CANARY;
  const model = buildXaiQaMotionCanaryModel(candidate);
  const statePath = options.statePath ?? DEFAULT_STATE_PATH;
  const outputDir = options.outputDir ?? DEFAULT_OUTPUT_DIR;
  if (qaMotionCatalogPreflightRequired(statePath)) {
    await preflightXaiQaMotionModel({ ...options, candidate });
  }

  const pose = uploadDescriptor(candidate.motion.asset);
  const canonical = uploadDescriptor(candidate.canonical);
  const poseUpload = await ensureXaiPoseMasterUpload({
    ...options,
    poseMaster: pose,
    poseMasterPath: options.posePath ?? join(DEFAULT_REFERENCE_DIR, `${pose.id}.png`),
    poseMasterUploadStatePath: options.poseUploadStatePath ?? DEFAULT_POSE_UPLOAD_STATE_PATH,
  });
  const canonicalUpload = await ensureXaiPoseMasterUpload({
    ...options,
    poseMaster: canonical,
    poseMasterPath: options.canonicalPath ?? join(DEFAULT_REFERENCE_DIR, `${canonical.id}.png`),
    poseMasterUploadStatePath: options.canonicalUploadStatePath ?? DEFAULT_CANONICAL_UPLOAD_STATE_PATH,
  });

  return runBakeoff({
    ...options,
    statePath,
    outputDir,
    experimentId: candidate.candidateId,
    expectedPaidCalls: 1,
    policyConstraints: policyConstraints(candidate),
    planBuilder: (manifest) => buildXaiQaMotionCanaryPlan(manifest, { candidate, model }),
    promptBuilder: (promptOptions) => buildXaiQaMotionCanaryPrompt(promptOptions, candidate),
    payloadBuilder: (payloadOptions) => buildXaiQaMotionCanaryPayload({
      ...payloadOptions,
      candidate,
      poseAssetHash: poseUpload.pixcliAssetHash,
      canonicalAssetHash: canonicalUpload.pixcliAssetHash,
    }),
  });
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const confirmation = parseArg(rawArgs, '--confirm');
  if (!rawArgs.includes('--execute') || confirmation !== XAI_QA_MOTION_CANARY_CONFIRMATION) {
    throw new Error(`Paid execution requires --execute --confirm=${XAI_QA_MOTION_CANARY_CONFIRMATION}.`);
  }
  const state = await runXaiQaMotionCanary({
    apiKey: process.env.PIXCLI_API_KEY,
    apiBase: process.env.PIXCLI_BASE_URL,
    manifestPath: parseArg(rawArgs, '--manifest', DEFAULT_MANIFEST_PATH),
    sourceDir: parseArg(rawArgs, '--source-dir', DEFAULT_SOURCE_DIR),
    posePath: parseArg(
      rawArgs,
      '--pose',
      join(DEFAULT_REFERENCE_DIR, `${QA_MOTION_CANARY.motion.asset.id}.png`),
    ),
    poseUploadStatePath: parseArg(rawArgs, '--pose-upload-state', DEFAULT_POSE_UPLOAD_STATE_PATH),
    canonicalPath: parseArg(
      rawArgs,
      '--canonical',
      join(DEFAULT_REFERENCE_DIR, `${QA_MOTION_CANARY.canonical.id}.png`),
    ),
    canonicalUploadStatePath: parseArg(
      rawArgs,
      '--canonical-upload-state',
      DEFAULT_CANONICAL_UPLOAD_STATE_PATH,
    ),
    outputDir: parseArg(rawArgs, '--output-dir', DEFAULT_OUTPUT_DIR),
    statePath: parseArg(rawArgs, '--state', DEFAULT_STATE_PATH),
  });
  const slot = Object.values(state.slots)[0];
  console.log(`XAI QA motion canary terminal: ${slot?.status ?? state.status}.`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
