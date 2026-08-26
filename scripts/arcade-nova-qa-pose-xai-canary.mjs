import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runXaiQaMotionCanary } from './arcade-motion-xai-canary.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_SOURCE_DIR = join(root, '.arcade-sources');
const DEFAULT_POSE_PATH = join(root, '.arcade-pose-masters/nova-qa-high-punch-f4.png');
const DEFAULT_CANONICAL_PATH = join(root, '.arcade-pose-masters/nova-qa-side.png');
const DEFAULT_OUTPUT_DIR = join(root, '.artifacts/arcade-nova-qa-pose-xai-canary');
const DEFAULT_STATE_PATH = join(root, '.arcade-nova-qa-high-punch-xai-state.json');
const DEFAULT_POSE_UPLOAD_STATE_PATH = join(root, '.arcade-nova-qa-high-punch-pose-upload-state.json');
const DEFAULT_CANONICAL_UPLOAD_STATE_PATH = join(root, '.arcade-nova-qa-canonical-upload-state.json');

export const XAI_NOVA_QA_POSE_CONFIRMATION = 'ARCADE_NOVA_QA_HIGH_PUNCH_F4_XAI_V1';
export const XAI_NOVA_QA_POSE_MAX_COST_USD = 0.12;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const NOVA_QA_MOTION_CANDIDATE = deepFreeze({
  schemaVersion: 1,
  candidateId: 'arcade-qa-nova-high-punch-f4-xai-v1',
  confirmation: XAI_NOVA_QA_POSE_CONFIRMATION,
  approvalRequired: true,
  fighter: {
    slug: 'nova-qa',
    fighterId: 'dec07fa06ae2e51bda95b99749274355',
  },
  motion: {
    atlasId: 'nova-qa-local-cache-2d8fbd6e-v1',
    animation: 'high_punch',
    playbackFrameNumber: 4,
    sourceFrameIndex: 3,
    asset: {
      id: 'nova-qa-high-punch-f4-v1',
      bucket: 'local-qa-archive',
      jurisdiction: 'local',
      objectKey: 'nova-qa/high_punch/frame-04.png',
      contentSha256: '0f41337e9c79265c671906f9f5081280a72f9b72c0eacba04e649cf0bcd22d61',
      width: 768,
      height: 1024,
    },
  },
  canonical: {
    id: 'nova-qa-side-v1',
    kind: 'side',
    bucket: 'local-qa-archive',
    jurisdiction: 'local',
    objectKey: 'nova-qa/sources/side.png',
    contentSha256: '50c70400e8eb53d9f2d636bade53f46e27f65b8d87565698bb44977ae89e7edd',
    width: 843,
    height: 1264,
  },
  identity: {
    kind: 'original',
    bucket: 'local-qa-archive',
    jurisdiction: 'local',
    objectKey: 'nova-qa/sources/original.png',
    contentSha256: '2d8fbd6e1b7feb4bced503c927b00807ce60104577d3ec9d8d862fe307862b44',
    width: 1024,
    height: 1536,
  },
  provider: {
    modelId: 'grok-imagine-image-2-edit',
    endpoint: 'xai/grok-imagine-image/v2.0/edit',
    provider: 'xai',
    backend: 'fal',
    catalogCostPerImage: 70000,
    estimatedCostUsd: XAI_NOVA_QA_POSE_MAX_COST_USD,
    numImages: 1,
  },
  policy: {
    expectedPaidCalls: 1,
    automaticRetries: 0,
    fallback: 'none',
    promptEnrichment: false,
    activation: false,
    humanReviewRequired: true,
  },
});

export const NOVA_QA_EXPERIMENT_MANIFEST = deepFreeze({
  version: '2026.08.26-nova-qa-local-canary-v1',
  qualityTier: 'champion',
  legalVersion: '2026-08-23.1',
  disclosure: 'Internal synthetic QA fixture. Not a public fighter and never activated by this experiment.',
  fighters: [{
    slug: 'nova-qa',
    name: 'Nova QA',
    identityName: 'Nova QA',
    rank: 1,
    challengerLine: 'Internal pose consistency fixture.',
    defaultPersonality: 'balanced',
    reference: {
      kind: 'licensed',
      sourceUrl: 'https://insertplayer.ai/',
      license: 'Original synthetic QA fixture owned by Insert Player',
      licenseUrl: 'https://insertplayer.ai/terms',
      credit: 'Insert Player internal QA fixture',
      author: 'Insert Player',
      sourceDate: '2026-08-24',
      verification: 'Exact source bytes recovered from the local Nova QA IndexedDB archive',
      sourceSha256: NOVA_QA_MOTION_CANDIDATE.identity.contentSha256,
    },
    referencePrompt: 'Using the licensed reference photo as the identity anchor, create an unofficial premium realistic 2.5D full-body arcade fighter. Preserve the person’s recognizable facial structure, dark hair, warm medium skin tone, apparent adult age, and athletic build faithfully while rendering the result as clearly AI-generated game artwork rather than documentary photography. Supplement the reference with these design details: an adult woman with long dark hair, a composed oval face, dark eyes, and a lean athletic build. Show the complete figure head-to-toe in a compact neutral ready stance, 3/4 view facing right, wearing the exact approved red cropped utility jacket over a plain white shirt, fitted black trousers, and clean white trainers. Preserve the exact canonical palette, materials, silhouette, proportions, and facial identity. No text, logos, symbols, props, or protected game styling. Pure bright green (#00FF00) background, flat and uniform with no shadows, floor, or gradients. Even studio light, crisp silhouette, realistic adult proportions, detailed hands and shoes. Not cartoon, chibi, anime, cel-shaded, caricature, or photorealistic documentary photography.',
  }],
});

function parseArg(rawArgs, name, fallback = '') {
  return rawArgs.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
}

export async function runXaiNovaQaPoseCanary(options = {}) {
  if (Number(options.maxCostUsd) !== XAI_NOVA_QA_POSE_MAX_COST_USD) {
    throw new Error(`Nova QA pose canary requires maxCostUsd=${XAI_NOVA_QA_POSE_MAX_COST_USD}.`);
  }
  return runXaiQaMotionCanary({
    ...options,
    candidate: NOVA_QA_MOTION_CANDIDATE,
    manifest: NOVA_QA_EXPERIMENT_MANIFEST,
    sourceDir: options.sourceDir ?? DEFAULT_SOURCE_DIR,
    posePath: options.posePath ?? DEFAULT_POSE_PATH,
    canonicalPath: options.canonicalPath ?? DEFAULT_CANONICAL_PATH,
    poseUploadStatePath:
      options.poseUploadStatePath ?? DEFAULT_POSE_UPLOAD_STATE_PATH,
    canonicalUploadStatePath:
      options.canonicalUploadStatePath ?? DEFAULT_CANONICAL_UPLOAD_STATE_PATH,
    statePath: options.statePath ?? DEFAULT_STATE_PATH,
    outputDir: options.outputDir ?? DEFAULT_OUTPUT_DIR,
  });
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (!rawArgs.includes('--execute')) {
    console.log(JSON.stringify({
      candidate: NOVA_QA_MOTION_CANDIDATE,
      policy: {
        paidCalls: 1,
        maxCostUsd: XAI_NOVA_QA_POSE_MAX_COST_USD,
        retries: 0,
        fallback: 'none',
        activation: false,
      },
    }, null, 2));
    return;
  }
  const confirmation = parseArg(rawArgs, '--confirm');
  const maxCostUsd = Number(parseArg(rawArgs, '--max-cost-usd'));
  if (
    confirmation !== XAI_NOVA_QA_POSE_CONFIRMATION
    || maxCostUsd !== XAI_NOVA_QA_POSE_MAX_COST_USD
  ) {
    throw new Error(
      `Paid execution requires --confirm=${XAI_NOVA_QA_POSE_CONFIRMATION} --max-cost-usd=${XAI_NOVA_QA_POSE_MAX_COST_USD}.`,
    );
  }
  const state = await runXaiNovaQaPoseCanary({
    apiKey: process.env.PIXCLI_API_KEY,
    apiBase: process.env.PIXCLI_BASE_URL,
    maxCostUsd,
    sourceDir: parseArg(rawArgs, '--source-dir', DEFAULT_SOURCE_DIR),
    posePath: parseArg(rawArgs, '--pose', DEFAULT_POSE_PATH),
    canonicalPath: parseArg(rawArgs, '--canonical', DEFAULT_CANONICAL_PATH),
    poseUploadStatePath: parseArg(
      rawArgs,
      '--pose-upload-state',
      DEFAULT_POSE_UPLOAD_STATE_PATH,
    ),
    canonicalUploadStatePath: parseArg(
      rawArgs,
      '--canonical-upload-state',
      DEFAULT_CANONICAL_UPLOAD_STATE_PATH,
    ),
    statePath: parseArg(rawArgs, '--state', DEFAULT_STATE_PATH),
    outputDir: parseArg(rawArgs, '--output-dir', DEFAULT_OUTPUT_DIR),
  });
  const slot = Object.values(state.slots)[0];
  console.log(`XAI Nova QA HIGH_PUNCH canary terminal: ${slot?.status ?? state.status}.`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
