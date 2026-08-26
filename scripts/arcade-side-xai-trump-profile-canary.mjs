import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPixcliPayload,
  runBakeoff,
} from './arcade-side-bakeoff.mjs';
import { ensureXaiPoseMasterUpload } from './arcade-side-xai-canary.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_MANIFEST_PATH = join(root, 'arcade/roster-2026.json');
const DEFAULT_SOURCE_DIR = join(root, '.arcade-sources');
const DEFAULT_POSE_PATH = join(root, '.arcade-pose-masters/trump-prod-side-raw-v1.png');
const DEFAULT_OUTPUT_DIR = join(root, '.artifacts/arcade-side-xai-trump-profile-canary');
const DEFAULT_STATE_PATH = join(root, '.arcade-side-xai-trump-profile-v4-canary-state.json');
const DEFAULT_POSE_UPLOAD_STATE_PATH = join(root, '.arcade-xai-trump-profile-master-upload-state.json');
const REQUEST_TIMEOUT_MS = 60_000;

export const XAI_TRUMP_PROFILE_EXPERIMENT_ID = 'arcade-side-xai-trump-profile-v4';
export const XAI_TRUMP_PROFILE_CONFIRMATION = 'ARCADE_SIDE_XAI_TRUMP_PROFILE_V4';
export const XAI_TRUMP_PROFILE_MAX_COST_USD = 0.12;
export const XAI_TRUMP_PROFILE_POSE_MASTER = Object.freeze({
  id: 'trump-prod-side-raw-v1',
  slug: 'pose-master-trump-prod-side-raw-v1',
  contentSha256: '5b63f16ab5dad619e64b3fbefb37cd251f688168303517c413764820d80aeb90',
});
export const XAI_TRUMP_PROFILE_MODEL = Object.freeze({
  id: 'grok-imagine-image-2-edit',
  code: 'grok2profile',
  endpoint: 'xai/grok-imagine-image/v2.0/edit',
  params: Object.freeze({
    num_images: 1,
    aspect_ratio: '3:4',
    resolution: '2k',
    output_format: 'png',
    quality: 'medium',
  }),
  referenceInputs: Object.freeze([
    Object.freeze({
      role: 'strict_screen_right_profile_pose_and_rendering_master',
      id: XAI_TRUMP_PROFILE_POSE_MASTER.id,
      contentSha256: XAI_TRUMP_PROFILE_POSE_MASTER.contentSha256,
    }),
  ]),
});

function parseArg(rawArgs, name, fallback = '') {
  return rawArgs.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
}

function exactCostAuthorization(value) {
  return Number(value) === XAI_TRUMP_PROFILE_MAX_COST_USD;
}

export function buildXaiTrumpProfilePrompt() {
  return [
    'REFERENCE ROLES — KEEP THEM STRICTLY SEPARATE:',
    'IMAGE 1 is POSE, GUARD, SCALE, COMPOSITION, WARDROBE, AND RENDERING STYLE only. Do not copy its face, hair, apparent age, skin, or identity.',
    'IMAGE 2 is the sole IDENTITY AND PHYSIQUE ANCHOR. Preserve Donald Trump’s recognizable facial geometry, age, hair, skin, and solid natural body build. Never blend the two faces.',
    '',
    'SCREEN-SPACE ORIENTATION — HARD CONSTRAINT:',
    'Tighten IMAGE 1 into an unmistakable 75–90 degree strict side profile facing the RIGHT EDGE OF THE IMAGE. The near eye is clear; the far eye is absent or only a narrow sliver. The bridge and tip of the nose form a clean silhouette against the green background. His back points toward the left edge. Shoulders and hips overlap in projection; chest, pelvis, knees, and shoe toes point toward the right edge. Never show a frontal or symmetrical face, squared shoulders, a three-quarter chest, or a turn toward the camera.',
    '',
    'IDENTITY — HARD CONSTRAINT:',
    'Replace every identity trait in IMAGE 1 with Donald Trump from IMAGE 2. Preserve the visible near eye and heavy lower eyelid and brow, nose profile, mouth profile, chin, jowls, age texture, hairline, swept blond hair, fair skin, and solid natural build while keeping the far eye occluded by the strict profile. The output must be immediately recognizable as the adult in IMAGE 2. No beautification, rejuvenation, caricature, face averaging, or documentary-photo finish.',
    '',
    'COMPOSITION AND GAME ART:',
    'Create exactly one premium semi-realistic 2.5D full-body fighting-game roster render. Place the complete figure in the lower-left portion of a vertical 3:4 canvas, leaving generous empty strike space to the right. Keep both arms, both hands, both legs, and both feet complete and anatomically connected. Use a compact fighting guard, navy suit, white shirt, red tie, and black shoes. Preserve natural adult proportions and crisp game-ready material detail.',
    '',
    'BACKGROUND AND EXCLUSIONS:',
    'Use a perfectly flat uniform pure #00FF00 background with no floor, shadow, gradient, text, logo, prop, scenery, particles, or second person. No crop, collage, sprite sheet, duplicated limb, detached anatomy, motion blur, anime, chibi, cel shading, or protected game styling.',
    '',
    'FINAL PRIORITY ORDER:',
    '1) Strict 75–90 degree screen-right profile and full-body framing. 2) Donald Trump identity and physique from IMAGE 2 without turning toward camera. 3) Guard, rendering finish, wardrobe, and background. Return one image only.',
  ].join('\n');
}

export function buildXaiTrumpProfilePlan(manifest) {
  const fighter = manifest.fighters.find((entry) => entry.slug === 'donald-trump');
  if (!fighter) throw new Error('Trump profile canary fighter is missing from the manifest.');
  if (fighter.reference?.sourceSha256 !== 'b8cdec38c5a7e8042acd2a095336a2a5b3255bf8771aedf7634860129af4c476') {
    throw new Error('Trump licensed identity hash drifted.');
  }
  return [{
    slotKey: `${XAI_TRUMP_PROFILE_EXPERIMENT_ID}:${XAI_TRUMP_PROFILE_MODEL.id}`,
    fighter,
    model: XAI_TRUMP_PROFILE_MODEL,
  }];
}

export function buildXaiTrumpProfilePayload({
  fighter,
  model,
  sourceAssetHash,
  poseMasterAssetHash,
  prompt,
}) {
  if (!/^[a-f0-9]{32}$/.test(poseMasterAssetHash ?? '')) {
    throw new Error('Trump profile pose-master asset hash is invalid.');
  }
  const payload = buildPixcliPayload({ fighter, model, sourceAssetHash, prompt });
  return {
    ...payload,
    image: [poseMasterAssetHash, sourceAssetHash],
    publish_name: 'ip-trump-side-profile-xai-v4',
  };
}

export function trumpProfileCatalogPreflightRequired(statePath) {
  if (!existsSync(statePath)) return true;
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const slots = Object.values(state?.slots ?? {});
  if (slots.length === 0) return true;
  return !slots.every((slot) => (
    typeof slot?.pixcliJobId === 'string'
    || ['completed', 'failed', 'submission_rejected'].includes(slot?.status)
  ));
}

export async function preflightXaiTrumpProfileModel(options = {}) {
  const apiKey = options.apiKey ?? '';
  if (!apiKey) throw new Error('PIXCLI_API_KEY is required.');
  const apiBase = (options.apiBase ?? 'https://pixcli.hilo.cx').replace(/\/$/, '');
  const response = await (options.fetchImpl ?? fetch)(`${apiBase}/api/v1/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'User-Agent': 'insert-player-trump-profile-canary/1.0',
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
  const model = Array.isArray(models)
    ? models.find((entry) => entry?.id === XAI_TRUMP_PROFILE_MODEL.id)
    : null;
  if (
    !model
    || model.provider !== 'xai'
    || model.backend !== 'fal'
    || model.cost_per_image !== 70000
    || model.advanced_mode !== true
    || !model.capabilities?.includes('edit')
    || !model.capabilities?.includes('image-to-image')
  ) {
    throw new Error('Pinned Trump profile model contract changed; new human approval is required.');
  }
  return model;
}

export async function runXaiTrumpProfileCanary(options = {}) {
  if (!exactCostAuthorization(options.maxCostUsd)) {
    throw new Error(`Trump profile canary requires maxCostUsd=${XAI_TRUMP_PROFILE_MAX_COST_USD}.`);
  }
  const statePath = options.statePath ?? DEFAULT_STATE_PATH;
  if (trumpProfileCatalogPreflightRequired(statePath)) {
    await preflightXaiTrumpProfileModel(options);
  }
  const poseUpload = await ensureXaiPoseMasterUpload({
    ...options,
    poseMaster: XAI_TRUMP_PROFILE_POSE_MASTER,
    poseMasterPath: options.poseMasterPath ?? DEFAULT_POSE_PATH,
    poseMasterUploadStatePath:
      options.poseMasterUploadStatePath ?? DEFAULT_POSE_UPLOAD_STATE_PATH,
  });
  return runBakeoff({
    ...options,
    statePath,
    outputDir: options.outputDir ?? DEFAULT_OUTPUT_DIR,
    experimentId: XAI_TRUMP_PROFILE_EXPERIMENT_ID,
    expectedPaidCalls: 1,
    policyConstraints: {
      maxAuthorizedCostUsd: XAI_TRUMP_PROFILE_MAX_COST_USD,
      expectedReferenceImages: 2,
      humanReviewRequiredBeforeVideo: true,
      productionPointers: false,
    },
    planBuilder: buildXaiTrumpProfilePlan,
    promptBuilder: buildXaiTrumpProfilePrompt,
    payloadBuilder: (payloadOptions) => buildXaiTrumpProfilePayload({
      ...payloadOptions,
      poseMasterAssetHash: poseUpload.pixcliAssetHash,
    }),
  });
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (!rawArgs.includes('--execute')) {
    console.log(JSON.stringify({
      experimentId: XAI_TRUMP_PROFILE_EXPERIMENT_ID,
      model: XAI_TRUMP_PROFILE_MODEL,
      prompt: buildXaiTrumpProfilePrompt(),
      policy: { paidCalls: 1, maxCostUsd: XAI_TRUMP_PROFILE_MAX_COST_USD, activation: false },
    }, null, 2));
    return;
  }
  const confirmation = parseArg(rawArgs, '--confirm');
  const maxCostUsd = Number(parseArg(rawArgs, '--max-cost-usd'));
  if (confirmation !== XAI_TRUMP_PROFILE_CONFIRMATION || !exactCostAuthorization(maxCostUsd)) {
    throw new Error(
      `Paid execution requires --confirm=${XAI_TRUMP_PROFILE_CONFIRMATION} --max-cost-usd=${XAI_TRUMP_PROFILE_MAX_COST_USD}.`,
    );
  }
  const state = await runXaiTrumpProfileCanary({
    apiKey: process.env.PIXCLI_API_KEY,
    apiBase: process.env.PIXCLI_BASE_URL,
    maxCostUsd,
    manifestPath: parseArg(rawArgs, '--manifest', DEFAULT_MANIFEST_PATH),
    sourceDir: parseArg(rawArgs, '--source-dir', DEFAULT_SOURCE_DIR),
    poseMasterPath: parseArg(rawArgs, '--pose-master', DEFAULT_POSE_PATH),
    poseMasterUploadStatePath: parseArg(
      rawArgs,
      '--pose-master-upload-state',
      DEFAULT_POSE_UPLOAD_STATE_PATH,
    ),
    outputDir: parseArg(rawArgs, '--output-dir', DEFAULT_OUTPUT_DIR),
    statePath: parseArg(rawArgs, '--state', DEFAULT_STATE_PATH),
  });
  const slot = Object.values(state.slots)[0];
  console.log(`XAI Trump profile canary terminal: ${slot?.status ?? state.status}.`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
