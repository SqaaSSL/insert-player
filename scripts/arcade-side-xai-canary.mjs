import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildInitialState,
  buildPixcliPayload,
  runBakeoff,
} from './arcade-side-bakeoff.mjs';
import {
  ARCADE_PROMPT_PROFILES,
  buildArcadeProviderPrompt,
} from './arcade-provider-prompts.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_MANIFEST_PATH = join(root, 'arcade/roster-2026.json');
const DEFAULT_SOURCE_DIR = join(root, '.arcade-sources');
const DEFAULT_OUTPUT_DIR = join(root, '.artifacts/arcade-side-xai-canary');
const DEFAULT_STATE_PATH = join(root, '.arcade-side-xai-canary-state.json');

export const XAI_SIDE_CANARY_EXPERIMENT_ID = 'arcade-side-xai-trump-realistic-adult-v1';
export const XAI_SIDE_CANARY_CONFIRMATION = 'ARCADE_SIDE_XAI_TRUMP_REALISTIC_V1';
export const XAI_SIDE_CANARY_SLUG = 'donald-trump';
export const XAI_SIDE_CANARY_MODEL = Object.freeze({
  id: 'grok-imagine-image-2-edit',
  code: 'grok2r1',
  endpoint: 'xai/grok-imagine-image/v2.0/edit',
  promptProfile: ARCADE_PROMPT_PROFILES.xaiRealisticAdult,
  params: Object.freeze({
    num_images: 1,
    aspect_ratio: '3:4',
    resolution: '2k',
    output_format: 'png',
    quality: 'medium',
  }),
});

function parseArg(rawArgs, name, fallback = '') {
  return rawArgs.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
}

export function buildXaiSideCanaryPlan(manifest) {
  const fighter = manifest.fighters.find((entry) => entry.slug === XAI_SIDE_CANARY_SLUG);
  if (!fighter) throw new Error(`XAI SIDE canary fighter is missing: ${XAI_SIDE_CANARY_SLUG}.`);
  return [{
    slotKey: `${fighter.slug}:${XAI_SIDE_CANARY_MODEL.id}:${XAI_SIDE_CANARY_MODEL.promptProfile}`,
    fighter,
    model: XAI_SIDE_CANARY_MODEL,
  }];
}

export function buildXaiSideCanaryPrompt({ fighter, model }) {
  return buildArcadeProviderPrompt({
    fighter,
    promptProfile: model.promptProfile,
  });
}

export function buildXaiSideCanaryPayload({ fighter, model, sourceAssetHash, prompt }) {
  return buildPixcliPayload({ fighter, model, sourceAssetHash, prompt });
}

export function buildXaiSideCanaryInitialState(matrixSha256) {
  return buildInitialState(matrixSha256, {
    experimentId: XAI_SIDE_CANARY_EXPERIMENT_ID,
    expectedPaidCalls: 1,
  });
}

export async function runXaiSideCanary(options = {}) {
  return runBakeoff({
    ...options,
    experimentId: XAI_SIDE_CANARY_EXPERIMENT_ID,
    expectedPaidCalls: 1,
    planBuilder: buildXaiSideCanaryPlan,
    promptBuilder: buildXaiSideCanaryPrompt,
    payloadBuilder: buildXaiSideCanaryPayload,
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
