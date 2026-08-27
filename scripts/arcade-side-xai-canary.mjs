import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildInitialState,
  buildPixcliPayload,
  runBakeoff,
  uploadBakeoffSource,
  verifyBakeoffSource,
} from './arcade-side-bakeoff.mjs';
import {
  ARCADE_PROMPT_PROFILES,
  buildArcadeProviderPrompt,
} from './arcade-provider-prompts.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_MANIFEST_PATH = join(root, 'arcade/roster-2026.json');
const DEFAULT_SOURCE_DIR = join(root, '.arcade-sources');
const DEFAULT_POSE_MASTER_PATH = join(root, '.arcade-pose-masters/xai-milei-side-v1.png');
const DEFAULT_OUTPUT_DIR = join(root, '.artifacts/arcade-side-xai-pose-transfer-canary');
const DEFAULT_STATE_PATH = join(root, '.arcade-side-xai-pose-transfer-canary-state.json');
const DEFAULT_POSE_MASTER_UPLOAD_STATE_PATH = join(root, '.arcade-xai-pose-master-upload-state.json');

export const XAI_SIDE_CANARY_EXPERIMENT_ID = 'arcade-side-xai-trump-pose-transfer-v2';
export const XAI_SIDE_CANARY_CONFIRMATION = 'ARCADE_SIDE_XAI_TRUMP_POSE_TRANSFER_V2';
export const XAI_SIDE_CANARY_SLUG = 'donald-trump';
export const XAI_SIDE_CANARY_POSE_MASTER = Object.freeze({
  id: 'xai-milei-side-v1',
  slug: 'pose-master-milei-side-v1',
  bucket: 'insert-player-assets',
  jurisdiction: 'eu',
  objectKey: 'users/user_3IHDkjy0fm7LmuNGKkz3OAv71RW/fighters/f0915dca6c2cec6f509ee330e4f17b15/sources/side_raw_636d9b9f61ce7ca9a72d611346a1d303.png',
  contentSha256: '89bbecdfe8fc9cd08126f1c60b90e35ecc16427e3d0a227f0a4c1832f0960309',
});

export function buildXaiSideCanaryModel(poseMaster = XAI_SIDE_CANARY_POSE_MASTER) {
  if (!/^[a-f0-9]{64}$/.test(poseMaster?.contentSha256 ?? '')) {
    throw new Error('XAI pose-master content hash is invalid.');
  }
  return Object.freeze({
    id: 'grok-imagine-image-2-edit',
    code: 'grok2pt',
    endpoint: 'xai/grok-imagine-image/v2.0/edit',
    promptProfile: ARCADE_PROMPT_PROFILES.xaiIdentityPoseTransfer,
    referenceInputs: Object.freeze([Object.freeze({
      role: 'pose_composition_rendering_master',
      id: poseMaster.id,
      contentSha256: poseMaster.contentSha256,
    })]),
    params: Object.freeze({
      num_images: 1,
      aspect_ratio: 'auto',
      resolution: '2k',
      output_format: 'png',
      quality: 'medium',
    }),
  });
}

export const XAI_SIDE_CANARY_MODEL = buildXaiSideCanaryModel();

function parseArg(rawArgs, name, fallback = '') {
  return rawArgs.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.writing-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function readPoseMasterUploadState(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

export async function ensureXaiPoseMasterUpload(options = {}) {
  const apiKey = options.apiKey ?? '';
  if (!apiKey) throw new Error('PIXCLI_API_KEY is required.');
  const poseMasterPath = options.poseMasterPath ?? DEFAULT_POSE_MASTER_PATH;
  const uploadStatePath = options.poseMasterUploadStatePath ?? DEFAULT_POSE_MASTER_UPLOAD_STATE_PATH;
  const poseMaster = options.poseMaster ?? XAI_SIDE_CANARY_POSE_MASTER;
  const poseMasterFighter = {
    slug: poseMaster.slug,
    reference: { sourceSha256: poseMaster.contentSha256 },
  };
  const { bytes, sourceSha256 } = verifyBakeoffSource(poseMasterFighter, poseMasterPath);
  let state = readPoseMasterUploadState(uploadStatePath);
  if (state) {
    if (
      state.schemaVersion !== 1
      || state.masterId !== poseMaster.id
      || state.contentSha256 !== sourceSha256
    ) {
      throw new Error('Existing pose-master upload state belongs to a different immutable asset.');
    }
    if (state.upload?.status !== 'uploaded' || !/^[a-f0-9]{32}$/.test(state.upload?.pixcliAssetHash ?? '')) {
      throw new Error('Pose-master upload requires manual reconciliation; automatic retry is forbidden.');
    }
    return state.upload;
  }

  const save = (upload) => {
    state = {
      schemaVersion: 1,
      masterId: poseMaster.id,
      contentSha256: sourceSha256,
      upload,
    };
    writeJsonAtomic(uploadStatePath, state);
  };
  return uploadBakeoffSource({
    apiBase: (options.apiBase ?? 'https://pixcli.hilo.cx').replace(/\/$/, ''),
    apiKey,
    fighter: poseMasterFighter,
    sourceBytes: bytes,
    sourceSha256,
    save,
    fetchImpl: options.fetchImpl,
  });
}

export function buildXaiSideCanaryPlan(manifest, options = {}) {
  const model = options.model ?? XAI_SIDE_CANARY_MODEL;
  const fighter = manifest.fighters.find((entry) => entry.slug === XAI_SIDE_CANARY_SLUG);
  if (!fighter) throw new Error(`XAI SIDE canary fighter is missing: ${XAI_SIDE_CANARY_SLUG}.`);
  return [{
    slotKey: `${fighter.slug}:${model.id}:${model.promptProfile}`,
    fighter,
    model,
  }];
}

export function buildXaiSideCanaryPrompt({ fighter, model }) {
  return buildArcadeProviderPrompt({
    fighter,
    promptProfile: model.promptProfile,
  });
}

export function buildXaiSidePoseTransferPayload({
  fighter,
  model,
  sourceAssetHash,
  poseMasterAssetHash,
  prompt,
}) {
  if (!/^[a-f0-9]{32}$/.test(poseMasterAssetHash ?? '')) {
    throw new Error('XAI pose-master asset hash is invalid.');
  }
  const payload = buildPixcliPayload({ fighter, model, sourceAssetHash, prompt });
  return {
    ...payload,
    image: [poseMasterAssetHash, sourceAssetHash],
  };
}

export function buildXaiSideCanaryPayload(options) {
  return buildXaiSidePoseTransferPayload(options);
}

export function buildXaiSideCanaryInitialState(matrixSha256) {
  return buildInitialState(matrixSha256, {
    experimentId: XAI_SIDE_CANARY_EXPERIMENT_ID,
    expectedPaidCalls: 1,
  });
}

export async function runXaiSideCanary(options = {}) {
  const poseMaster = options.poseMaster ?? XAI_SIDE_CANARY_POSE_MASTER;
  const model = buildXaiSideCanaryModel(poseMaster);
  const poseMasterUpload = await ensureXaiPoseMasterUpload(options);
  return runBakeoff({
    ...options,
    experimentId: XAI_SIDE_CANARY_EXPERIMENT_ID,
    expectedPaidCalls: 1,
    planBuilder: (manifest) => buildXaiSideCanaryPlan(manifest, { model }),
    promptBuilder: buildXaiSideCanaryPrompt,
    payloadBuilder: (payloadOptions) => buildXaiSidePoseTransferPayload({
      ...payloadOptions,
      poseMasterAssetHash: poseMasterUpload.pixcliAssetHash,
    }),
  });
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const confirmation = parseArg(rawArgs, '--confirm');
  if (!rawArgs.includes('--execute') || confirmation !== XAI_SIDE_CANARY_CONFIRMATION) {
    throw new Error(`Paid execution requires --execute --confirm=${XAI_SIDE_CANARY_CONFIRMATION}.`);
  }
  const state = await runXaiSideCanary({
    apiKey: process.env.PIXCLI_API_KEY,
    apiBase: process.env.PIXCLI_BASE_URL,
    manifestPath: parseArg(rawArgs, '--manifest', DEFAULT_MANIFEST_PATH),
    sourceDir: parseArg(rawArgs, '--source-dir', DEFAULT_SOURCE_DIR),
    poseMasterPath: parseArg(rawArgs, '--pose-master', DEFAULT_POSE_MASTER_PATH),
    poseMasterUploadStatePath: parseArg(
      rawArgs,
      '--pose-master-upload-state',
      DEFAULT_POSE_MASTER_UPLOAD_STATE_PATH,
    ),
    outputDir: parseArg(rawArgs, '--output-dir', DEFAULT_OUTPUT_DIR),
    statePath: parseArg(rawArgs, '--state', DEFAULT_STATE_PATH),
  });
  const slot = Object.values(state.slots)[0];
  console.log(`XAI SIDE canary terminal: ${slot?.status ?? state.status}.`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
