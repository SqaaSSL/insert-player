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
import { XAI_HIGH_KICK_IMPACT_POSE_MASTER } from './fetch-arcade-motion-master.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_MANIFEST_PATH = join(root, 'arcade/roster-2026.json');
const DEFAULT_SOURCE_DIR = join(root, '.arcade-sources');
const DEFAULT_MOTION_MASTER_PATH = join(root, '.arcade-pose-masters/xai-high-kick-impact-v1.png');
const DEFAULT_CANONICAL_PATH = join(
  root,
  '.artifacts/arcade-side-xai-pose-transfer-canary/arcade-side-xai-trump-pose-transfer-v2/donald-trump--grok-imagine-image-2-edit--image.png',
);
const DEFAULT_OUTPUT_DIR = join(root, '.artifacts/arcade-high-kick-xai-canary');
const DEFAULT_STATE_PATH = join(root, '.arcade-high-kick-xai-trump-impact-state.json');
const DEFAULT_MOTION_UPLOAD_STATE_PATH = join(root, '.arcade-xai-high-kick-impact-upload-state.json');
const DEFAULT_CANONICAL_UPLOAD_STATE_PATH = join(root, '.arcade-xai-trump-canonical-upload-state.json');

export const XAI_HIGH_KICK_CANARY_EXPERIMENT_ID = 'arcade-high-kick-xai-trump-impact-v1';
export const XAI_HIGH_KICK_CANARY_CONFIRMATION = 'ARCADE_HIGH_KICK_XAI_TRUMP_IMPACT_V1';
export const XAI_HIGH_KICK_CANARY_SLUG = 'donald-trump';
export const XAI_HIGH_KICK_CANONICAL = Object.freeze({
  id: 'xai-trump-side-pose-transfer-v2',
  slug: 'canonical-trump-xai-side-v2',
  githubRunId: 32889507819,
  githubArtifactName: 'arcade-side-xai-trump-pose-transfer-v2-state',
  contentSha256: '9429960a62d833e1899d8572efde3f7df2cceb88ff1510b3c146e8489bf7f2c0',
});

function parseArg(rawArgs, name, fallback = '') {
  return rawArgs.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
}

export function buildXaiHighKickCanaryModel(options = {}) {
  const motionMaster = options.motionMaster ?? XAI_HIGH_KICK_IMPACT_POSE_MASTER;
  const canonical = options.canonical ?? XAI_HIGH_KICK_CANONICAL;
  for (const reference of [motionMaster, canonical]) {
    if (!/^[a-f0-9]{64}$/.test(reference?.contentSha256 ?? '')) {
      throw new Error(`XAI HIGH_KICK reference hash is invalid: ${reference?.id ?? 'unknown'}.`);
    }
  }
  return Object.freeze({
    id: 'grok-imagine-image-2-edit',
    code: 'grok2hk',
    endpoint: 'xai/grok-imagine-image/v2.0/edit',
    promptProfile: ARCADE_PROMPT_PROFILES.xaiCanonicalMotionTransfer,
    referenceInputs: Object.freeze([
      Object.freeze({
        role: 'motion_pose_composition_master',
        id: motionMaster.id,
        contentSha256: motionMaster.contentSha256,
      }),
      Object.freeze({
        role: 'canonical_character_rendering_master',
        id: canonical.id,
        contentSha256: canonical.contentSha256,
      }),
    ]),
    params: Object.freeze({
      num_images: 1,
      aspect_ratio: 'auto',
      resolution: '2k',
      output_format: 'png',
      quality: 'medium',
    }),
  });
}

export const XAI_HIGH_KICK_CANARY_MODEL = buildXaiHighKickCanaryModel();

export function buildXaiHighKickCanaryPlan(manifest, options = {}) {
  const model = options.model ?? XAI_HIGH_KICK_CANARY_MODEL;
  const fighter = manifest.fighters.find((entry) => entry.slug === XAI_HIGH_KICK_CANARY_SLUG);
  if (!fighter) throw new Error(`XAI HIGH_KICK canary fighter is missing: ${XAI_HIGH_KICK_CANARY_SLUG}.`);
  return [{
    slotKey: `${fighter.slug}:high_kick:impact:${model.id}:${model.promptProfile}`,
    fighter,
    model,
  }];
}

export function buildXaiHighKickCanaryPrompt({ fighter, model }) {
  return buildArcadeProviderPrompt({
    fighter,
    promptProfile: model.promptProfile,
  });
}

export function buildXaiHighKickCanaryPayload({
  fighter,
  model,
  sourceAssetHash,
  motionMasterAssetHash,
  canonicalAssetHash,
  prompt,
}) {
  for (const [label, hash] of [
    ['motion master', motionMasterAssetHash],
    ['canonical character', canonicalAssetHash],
  ]) {
    if (!/^[a-f0-9]{32}$/.test(hash ?? '')) throw new Error(`XAI ${label} asset hash is invalid.`);
  }
  const payload = buildPixcliPayload({ fighter, model, sourceAssetHash, prompt });
  return {
    ...payload,
    image: [motionMasterAssetHash, canonicalAssetHash, sourceAssetHash],
  };
}

export function buildXaiHighKickCanaryInitialState(matrixSha256) {
  return buildInitialState(matrixSha256, {
    experimentId: XAI_HIGH_KICK_CANARY_EXPERIMENT_ID,
    expectedPaidCalls: 1,
  });
}

async function ensureReferenceUpload(options, descriptor, path, statePath) {
  return ensureXaiPoseMasterUpload({
    ...options,
    poseMaster: descriptor,
    poseMasterPath: path,
    poseMasterUploadStatePath: statePath,
  });
}

export async function runXaiHighKickCanary(options = {}) {
  const motionMaster = options.motionMaster ?? XAI_HIGH_KICK_IMPACT_POSE_MASTER;
  const canonical = options.canonical ?? XAI_HIGH_KICK_CANONICAL;
  const model = buildXaiHighKickCanaryModel({ motionMaster, canonical });
  const motionUpload = await ensureReferenceUpload(
    options,
    motionMaster,
    options.motionMasterPath ?? DEFAULT_MOTION_MASTER_PATH,
    options.motionMasterUploadStatePath ?? DEFAULT_MOTION_UPLOAD_STATE_PATH,
  );
  const canonicalUpload = await ensureReferenceUpload(
    options,
    canonical,
    options.canonicalPath ?? DEFAULT_CANONICAL_PATH,
    options.canonicalUploadStatePath ?? DEFAULT_CANONICAL_UPLOAD_STATE_PATH,
  );
  return runBakeoff({
    ...options,
    experimentId: XAI_HIGH_KICK_CANARY_EXPERIMENT_ID,
    expectedPaidCalls: 1,
    planBuilder: (manifest) => buildXaiHighKickCanaryPlan(manifest, { model }),
    promptBuilder: buildXaiHighKickCanaryPrompt,
    payloadBuilder: (payloadOptions) => buildXaiHighKickCanaryPayload({
      ...payloadOptions,
      motionMasterAssetHash: motionUpload.pixcliAssetHash,
      canonicalAssetHash: canonicalUpload.pixcliAssetHash,
    }),
  });
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const confirmation = parseArg(rawArgs, '--confirm');
  if (!rawArgs.includes('--execute') || confirmation !== XAI_HIGH_KICK_CANARY_CONFIRMATION) {
    throw new Error(`Paid execution requires --execute --confirm=${XAI_HIGH_KICK_CANARY_CONFIRMATION}.`);
  }
  const state = await runXaiHighKickCanary({
    apiKey: process.env.PIXCLI_API_KEY,
    apiBase: process.env.PIXCLI_BASE_URL,
    manifestPath: parseArg(rawArgs, '--manifest', DEFAULT_MANIFEST_PATH),
    sourceDir: parseArg(rawArgs, '--source-dir', DEFAULT_SOURCE_DIR),
    motionMasterPath: parseArg(rawArgs, '--motion-master', DEFAULT_MOTION_MASTER_PATH),
    motionMasterUploadStatePath: parseArg(
      rawArgs,
      '--motion-master-upload-state',
      DEFAULT_MOTION_UPLOAD_STATE_PATH,
    ),
    canonicalPath: parseArg(rawArgs, '--canonical', DEFAULT_CANONICAL_PATH),
    canonicalUploadStatePath: parseArg(
      rawArgs,
      '--canonical-upload-state',
      DEFAULT_CANONICAL_UPLOAD_STATE_PATH,
    ),
    outputDir: parseArg(rawArgs, '--output-dir', DEFAULT_OUTPUT_DIR),
    statePath: parseArg(rawArgs, '--state', DEFAULT_STATE_PATH),
  });
  const slot = Object.values(state.slots)[0];
  console.log(`XAI HIGH_KICK canary terminal: ${slot?.status ?? state.status}.`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
