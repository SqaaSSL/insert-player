import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInitialState, runBakeoff } from './arcade-side-bakeoff.mjs';
import {
  XAI_SIDE_CANARY_POSE_MASTER,
  buildXaiSideCanaryModel,
  buildXaiSideCanaryPrompt,
  buildXaiSidePoseTransferPayload,
  ensureXaiPoseMasterUpload,
} from './arcade-side-xai-canary.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_MANIFEST_PATH = join(root, 'arcade/roster-2026.json');
const DEFAULT_SOURCE_DIR = join(root, '.arcade-sources');
const DEFAULT_POSE_MASTER_PATH = join(root, '.arcade-pose-masters/xai-milei-side-v1.png');
const DEFAULT_OUTPUT_DIR = join(root, '.artifacts/arcade-side-xai-global-pose-transfer');
const DEFAULT_STATE_PATH = join(root, '.arcade-side-xai-global-pose-transfer-state.json');
const DEFAULT_POSE_MASTER_UPLOAD_STATE_PATH = join(root, '.arcade-xai-pose-master-upload-state.json');

export const XAI_GLOBAL_SIDE_BATCH_EXPERIMENT_ID = 'arcade-side-xai-global-pose-transfer-v1';
export const XAI_GLOBAL_SIDE_BATCH_CONFIRMATION = 'ARCADE_SIDE_XAI_GLOBAL_4_V1';
export const XAI_GLOBAL_SIDE_BATCH_SLUGS = Object.freeze([
  'cristiano-ronaldo',
  'lionel-messi',
  'bad-bunny',
  'mrbeast',
]);

function parseArg(rawArgs, name, fallback = '') {
  return rawArgs.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
}

export function buildXaiGlobalSideBatchPlan(manifest, options = {}) {
  const model = options.model ?? buildXaiSideCanaryModel();
  return XAI_GLOBAL_SIDE_BATCH_SLUGS.map((slug) => {
    const fighter = manifest.fighters.find((entry) => entry.slug === slug);
    if (!fighter) throw new Error(`XAI global SIDE fighter is missing: ${slug}.`);
    return {
      slotKey: `${fighter.slug}:${model.id}:${model.promptProfile}`,
      fighter,
      model,
    };
  });
}

export function buildXaiGlobalSideBatchInitialState(matrixSha256) {
  return buildInitialState(matrixSha256, {
    experimentId: XAI_GLOBAL_SIDE_BATCH_EXPERIMENT_ID,
    expectedPaidCalls: XAI_GLOBAL_SIDE_BATCH_SLUGS.length,
  });
}

export async function runXaiGlobalSideBatch(options = {}) {
  const poseMaster = options.poseMaster ?? XAI_SIDE_CANARY_POSE_MASTER;
  const model = buildXaiSideCanaryModel(poseMaster);
  const poseMasterUpload = await ensureXaiPoseMasterUpload(options);
  return runBakeoff({
    ...options,
    experimentId: XAI_GLOBAL_SIDE_BATCH_EXPERIMENT_ID,
    expectedPaidCalls: XAI_GLOBAL_SIDE_BATCH_SLUGS.length,
    planBuilder: (manifest) => buildXaiGlobalSideBatchPlan(manifest, { model }),
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
  if (!rawArgs.includes('--execute') || confirmation !== XAI_GLOBAL_SIDE_BATCH_CONFIRMATION) {
    throw new Error(`Paid execution requires --execute --confirm=${XAI_GLOBAL_SIDE_BATCH_CONFIRMATION}.`);
  }
  const state = await runXaiGlobalSideBatch({
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
  const completed = Object.values(state.slots).filter((slot) => slot.status === 'completed').length;
  const failed = Object.values(state.slots).filter((slot) => slot.status !== 'completed').length;
  console.log(`XAI global SIDE batch terminal: ${completed} completed, ${failed} non-completed.`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
