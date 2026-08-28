import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(root, 'arcade/roster-2026.json');
const sourceDir = join(root, '.arcade-sources');
const statePath = join(root, '.arcade-state.json');
const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const targetArg = rawArgs.find((arg) => arg.startsWith('--target='));
const slugArg = rawArgs.find((arg) => arg.startsWith('--slug='));
const animationArg = rawArgs.find((arg) => arg.startsWith('--animation='));
const sourceArg = rawArgs.find((arg) => arg.startsWith('--source='));
const activationConfirmationArg = rawArgs.find((arg) => arg.startsWith('--confirm-activation='));
const videoStepConfirmationArg = rawArgs.find((arg) => arg.startsWith('--confirm-video-step='));
const resumeVideoRunFromArg = rawArgs.find((arg) => arg.startsWith('--resume-video-run-from='));
const restartVideoRunFromArg = rawArgs.find((arg) => arg.startsWith('--restart-video-run-from='));
const videoReviewDecisionArg = rawArgs.find((arg) => arg.startsWith('--video-review-decision='));
const reviewedManifestRunIdArg = rawArgs.find((arg) => arg.startsWith('--reviewed-manifest-run-id='));
const videoReviewJobIdArg = rawArgs.find((arg) => arg.startsWith('--video-review-job-id='));
const videoReviewCandidateIdArg = rawArgs.find((arg) => arg.startsWith('--video-review-candidate-id='));
const videoReviewRevisionArg = rawArgs.find((arg) => arg.startsWith('--video-review-revision='));
const videoReviewReportSha256Arg = rawArgs.find((arg) => arg.startsWith('--video-review-report-sha256='));
const videoReviewSelectedIndicesArg = rawArgs.find((arg) => arg.startsWith('--video-review-selected-indices='));
const videoReviewReasonArg = rawArgs.find((arg) => arg.startsWith('--video-review-reason='));
const videoReviewExportDirArg = rawArgs.find((arg) => arg.startsWith('--video-review-export-dir='));
const reviewedCanonicalManifestArg = rawArgs.find((arg) => arg.startsWith('--reviewed-canonical-manifest='));
const reviewedVideoFinalJobIdArg = rawArgs.find((arg) => arg.startsWith('--reviewed-video-final-job-id='));
const expectedDeployedShaArg = rawArgs.find((arg) => arg.startsWith('--expected-deployed-sha='));
const postApprovedRecurationArg = rawArgs.find((arg) => arg.startsWith('--post-approved-recuration='));
const recurationDescriptorArg = rawArgs.find((arg) => arg.startsWith('--recuration-descriptor='));
const recurationDescriptorSha256Arg = rawArgs.find((arg) => arg.startsWith('--recuration-descriptor-sha256='));
const recurationConfirmationArg = rawArgs.find((arg) => arg.startsWith('--confirm-recuration='));
const target = targetArg?.slice('--target='.length) ?? 'production';
const animationName = animationArg?.slice('--animation='.length) ?? '';
const sourceName = sourceArg?.slice('--source='.length) ?? '';
const activationConfirmation = activationConfirmationArg?.slice('--confirm-activation='.length) ?? '';
const videoStepConfirmation = videoStepConfirmationArg?.slice('--confirm-video-step='.length) ?? '';
const resumeVideoRunFrom = resumeVideoRunFromArg?.slice('--resume-video-run-from='.length) ?? '';
const restartVideoRunFrom = restartVideoRunFromArg?.slice('--restart-video-run-from='.length) ?? '';
const videoReviewDecision = videoReviewDecisionArg?.slice('--video-review-decision='.length) ?? '';
const videoReviewJobId = videoReviewJobIdArg?.slice('--video-review-job-id='.length) ?? '';
const videoReviewCandidateId = videoReviewCandidateIdArg?.slice('--video-review-candidate-id='.length) ?? '';
const videoReviewRevision = videoReviewRevisionArg?.slice('--video-review-revision='.length) ?? '';
const videoReviewReportSha256 = videoReviewReportSha256Arg
  ?.slice('--video-review-report-sha256='.length) ?? '';
const videoReviewSelectedIndices = videoReviewSelectedIndicesArg
  ?.slice('--video-review-selected-indices='.length) ?? '';
const videoReviewReason = videoReviewReasonArg?.slice('--video-review-reason='.length) ?? '';
const videoReviewExportDir = videoReviewExportDirArg?.slice('--video-review-export-dir='.length) ?? '';
const reviewedManifestRunId = reviewedManifestRunIdArg?.slice('--reviewed-manifest-run-id='.length) ?? '';
const reviewedCanonicalManifestPath = reviewedCanonicalManifestArg
  ?.slice('--reviewed-canonical-manifest='.length) ?? '';
const reviewedVideoFinalJobId = reviewedVideoFinalJobIdArg
  ?.slice('--reviewed-video-final-job-id='.length) ?? '';
const expectedDeployedSha = expectedDeployedShaArg?.slice('--expected-deployed-sha='.length) ?? '';
const postApprovedRecuration = postApprovedRecurationArg
  ?.slice('--post-approved-recuration='.length) ?? '';
const recurationDescriptorPath = recurationDescriptorArg
  ?.slice('--recuration-descriptor='.length) ?? '';
const recurationDescriptorSha256 = recurationDescriptorSha256Arg
  ?.slice('--recuration-descriptor-sha256='.length) ?? '';
const recurationConfirmation = recurationConfirmationArg
  ?.slice('--confirm-recuration='.length) ?? '';
const dryRun = args.has('--dry-run');
const activate = args.has('--activate');
const activateReviewed = args.has('--activate-reviewed');
const videoStep = args.has('--video-step');
const videoReviewInspect = args.has('--video-review-inspect');
const videoReview = videoReviewDecision.length > 0 || videoReviewInspect;
const postApprovedRecurationOperation = postApprovedRecuration.length > 0;
const reviewedVideoOperation = activateReviewed || videoStep || videoReview || postApprovedRecurationOperation;
const acceptRecurationNeedsReview = args.has('--accept-needs-review');
const continueOnError = args.has('--continue-on-error');
const all = args.has('--all');
const resume = args.has('--resume');
const restartDraft = args.has('--restart-draft');
const registerDraft = args.has('--register-draft');
const prepareCanary = args.has('--prepare-canary');
const canarySide = args.has('--canary-side');
const probeSide = args.has('--probe-side');
const preflightOnly = args.has('--preflight-only');
const POLL_INTERVAL_MS = 5_000;
const JOB_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60_000;
const VIDEO_REVIEW_ADJUST_TIMEOUT_MS = 3 * 60_000;
const CLERK_TOKEN_REFRESH_SKEW_MS = 30_000;
const CLERK_TOKEN_TTL_SECONDS = 10 * 60;
let clerkBackendAuthBridgeSecret = '';
const MAX_SOURCE_UPLOAD_BYTES = 12 * 1024 * 1024;
const MAX_REVIEWED_VIDEO_ASSET_BYTES = 32 * 1024 * 1024;
const REVIEWED_PRODUCTION_API_ORIGIN = 'https://api.insertplayer.ai';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PLAYABLE_ANIMATION_NAMES = [
  'idle',
  'walk',
  'high_punch',
  'low_punch',
  'high_kick',
  'low_kick',
  'jump',
  'crouch',
  'hit',
  'ko',
  'victory',
];
const PLAYABLE_ANIMATIONS = new Set(PLAYABLE_ANIMATION_NAMES);
export const REVIEW_GATED_VIDEO_ACTIONS = Object.freeze([
  'idle',
  'walk',
  'high_punch',
  'high_kick',
  'low_punch',
  'low_kick',
  'jump',
  'crouch',
  'hit',
  'ko',
  'victory',
]);
const REVIEW_GATED_VIDEO_ACTION_SET = new Set(REVIEW_GATED_VIDEO_ACTIONS);
const CANONICAL_SOURCE_NAMES = ['side', 'upright', 'crouch'];
const CANONICAL_SOURCES = new Set(CANONICAL_SOURCE_NAMES);
export const REVIEWED_ARCADE_ACTIVATION_CONFIRMATION = 'ACTIVATE_REVIEWED_ARCADE_FIGHTER_PRODUCTION';
export const REVIEW_GATED_VIDEO_STEP_CONFIRMATION = 'START_REVIEW_GATED_VIDEO_ARCADE_PRODUCTION';
export const REVIEW_GATED_VIDEO_RESUME_CONFIRMATION = 'RESUME_FAILED_REVIEW_GATED_VIDEO_ARCADE_PRODUCTION';
export const REVIEW_GATED_VIDEO_RESTART_CONFIRMATION = 'RESTART_REVIEW_GATED_VIDEO_ARCADE_PRODUCTION';
export const REVIEW_GATED_VIDEO_REVIEW_CONFIRMATIONS = Object.freeze({
  inspect: 'INSPECT_REVIEW_GATED_VIDEO_ARCADE_PRODUCTION',
  approve: 'APPROVE_REVIEW_GATED_VIDEO_ARCADE_PRODUCTION',
  adjust: 'ADJUST_REVIEW_GATED_VIDEO_ARCADE_PRODUCTION',
  reject: 'REJECT_AND_ABANDON_REVIEW_GATED_VIDEO_RUN_PRODUCTION',
});
export const POST_APPROVED_RECURATION_CONFIRMATIONS = Object.freeze({
  stage: 'STAGE_POST_APPROVED_RECURATION_PRODUCTION',
  promote: 'PROMOTE_POST_APPROVED_RECURATION_PRODUCTION',
  rollback: 'ROLLBACK_POST_APPROVED_RECURATION_PRODUCTION',
});
export const POST_APPROVED_RECURATION_DESCRIPTOR_KIND = 'post-approved-video-recuration-v1';
export const REVIEWED_CANONICAL_SOURCE_MODE = 'reviewed-current-v1';
export const VIDEO_DENSE_ANIMATION_FORMAT = 'video-dense-v1';
export const VIDEO_DENSE_PROCESSING_VERSION = 6;
const VIDEO_DENSE_PROCESSING_VERSIONS = new Set([5, VIDEO_DENSE_PROCESSING_VERSION]);
const COMPLETE_REVIEWED_VIDEO_STAGES = Object.freeze([
  ...CANONICAL_SOURCE_NAMES.map((name) => `source:${name}`),
  ...REVIEW_GATED_VIDEO_ACTIONS.map((name) => `sprite:${name}`),
]);
const LICENSED_REFERENCE_PROMPT = /\blicensed reference photo\b|\bperson in (?:this|the) licensed photo\b/i;
const IDENTITY_ERASING_PROMPT = /\bwritten description only\b|\b(?:new|own) clearly synthetic face\b/i;
const APPROVED_ARCADE_PROVIDER_CONTRACT = {
  schemaVersion: 1,
  processorRuntimeRevision: 'meterkey-transport-v1',
  allowedGenerationProviders: ['gemini'],
  sourceModels: {
    side: 'gemini-3-pro-image',
    upright: 'gemini-3-pro-image',
    crouch: 'gemini-3-pro-image',
  },
  championAnimation: {
    scaffoldModel: 'gemini-3.1-flash-image',
    renderModel: 'gemini-3-pro-image',
    reviewModel: 'gemini-3-pro-image',
  },
  fallbackPolicy: 'fail-closed',
};

export function assertApprovedArcadeGenerationContract(payload) {
  const contract = payload?.contract;
  const providers = contract?.allowedGenerationProviders;
  const expected = APPROVED_ARCADE_PROVIDER_CONTRACT;
  const approved = payload?.ready === true
    && payload?.runtime === 'canvas-skia'
    && payload?.videoSpriteCompiler?.schemaVersion === 1
    && payload?.videoSpriteCompiler?.processingVersion === VIDEO_DENSE_PROCESSING_VERSION
    && contract?.schemaVersion === expected.schemaVersion
    && contract?.processorRuntimeRevision === expected.processorRuntimeRevision
    && Array.isArray(providers)
    && providers.length === 1
    && providers[0] === expected.allowedGenerationProviders[0]
    && contract?.sourceModels?.side === expected.sourceModels.side
    && contract?.sourceModels?.upright === expected.sourceModels.upright
    && contract?.sourceModels?.crouch === expected.sourceModels.crouch
    && contract?.championAnimation?.scaffoldModel === expected.championAnimation.scaffoldModel
    && contract?.championAnimation?.renderModel === expected.championAnimation.renderModel
    && contract?.championAnimation?.reviewModel === expected.championAnimation.reviewModel
    && contract?.fallbackPolicy === expected.fallbackPolicy;
  if (!approved) {
    throw new Error(
      'Arcade generation aborted before mutation: the deployed image processor did not prove the approved Gemini-only contract.',
    );
  }
  return contract;
}

function parseEnvText(text, values) {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && value && !values.has(key)) values.set(key, value);
  }
}

function readEnvValues() {
  const values = new Map();
  const files = target === 'sandbox'
    ? ['.env.sandbox.local', '.env.sandbox', '.env.local', '.env']
    : ['.env.production.local', '.env.production', '.env.local', '.env'];
  for (const file of files) {
    const path = join(root, file);
    if (existsSync(path)) parseEnvText(readFileSync(path, 'utf8'), values);
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value) values.set(key, value);
  }
  return values;
}

function envValue(values, key) {
  return values.get(key)?.trim() ?? '';
}

function decodeJwtPayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('The Arcade admin credential is not a Clerk JWT.');
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('The Arcade admin Clerk JWT payload could not be decoded.');
  }
}

function jwtExpiresAt(token) {
  return Number(decodeJwtPayload(token).exp ?? 0) * 1000;
}

function clerkErrorDetail(body, fallback) {
  const message = body?.errors?.[0]?.long_message ?? body?.errors?.[0]?.message;
  return typeof message === 'string' && message.trim() ? message.trim() : fallback;
}

export async function clerkRequest(secretKey, path, init = {}, request = fetch) {
  const response = await request(`https://api.clerk.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Clerk ${init.method ?? 'GET'} ${path} returned non-JSON (${response.status}).`);
  }
  if (!response.ok) {
    throw new Error(clerkErrorDetail(body, `Clerk ${init.method ?? 'GET'} ${path} failed with HTTP ${response.status}.`));
  }
  return body;
}

async function createClerkAdminTokenProvider(secretKey, userId) {
  const params = new URLSearchParams({
    user_id: userId,
    status: 'active',
    limit: '20',
  });
  const listed = await clerkRequest(secretKey, `/sessions?${params}`);
  const sessions = Array.isArray(listed.data) ? listed.data : Array.isArray(listed) ? listed : [];
  const session = sessions.find((entry) => entry?.user_id === userId && entry?.status === 'active');
  if (!session?.id) {
    throw new Error('The configured Arcade admin has no active Clerk session. Sign in to the target app and retry.');
  }

  let cachedToken = '';
  let cachedExpiresAt = 0;
  return async () => {
    if (cachedToken && cachedExpiresAt > Date.now() + CLERK_TOKEN_REFRESH_SKEW_MS) return cachedToken;
    const created = await clerkRequest(secretKey, `/sessions/${encodeURIComponent(session.id)}/tokens`, {
      method: 'POST',
      body: JSON.stringify({ expires_in_seconds: CLERK_TOKEN_TTL_SECONDS }),
    });
    if (typeof created.jwt !== 'string' || !created.jwt) {
      throw new Error('Clerk did not return an Arcade admin session token.');
    }
    const claims = decodeJwtPayload(created.jwt);
    if (claims.sub !== userId) throw new Error('Clerk returned a token for a different Arcade admin.');
    cachedToken = created.jwt;
    cachedExpiresAt = jwtExpiresAt(cachedToken);
    return cachedToken;
  };
}

function createStaticTokenProvider(token) {
  const claims = decodeJwtPayload(token);
  if (Number(claims.exp ?? 0) * 1000 < Date.now() + 5 * 60 * 1000) {
    throw new Error('The Arcade admin Clerk JWT is expired or expires in under five minutes.');
  }
  return async () => {
    if (jwtExpiresAt(token) <= Date.now() + CLERK_TOKEN_REFRESH_SKEW_MS) {
      throw new Error('The Arcade admin Clerk JWT expired while seeding. Use the Clerk secret-key flow for long jobs.');
    }
    return token;
  };
}

function readState() {
  if (!existsSync(statePath)) return { version: 1, targets: {} };
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  return state && typeof state === 'object' ? state : { version: 1, targets: {} };
}

function writeState(state) {
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(statePath, 0o600);
}

function fighterReference(manifest, fighter) {
  return fighter.reference ?? manifest.reference;
}

export function validateManifest(manifest) {
  if (manifest.qualityTier !== 'champion') throw new Error('The official Arcade roster must use Champion.');
  if (!Array.isArray(manifest.fighters) || manifest.fighters.length === 0) {
    throw new Error('The Arcade manifest has no fighters.');
  }
  const slugs = new Set();
  const ranks = new Set();
  for (const fighter of manifest.fighters) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fighter.slug ?? '')) {
      throw new Error(`Invalid Arcade slug: ${String(fighter.slug)}`);
    }
    if (slugs.has(fighter.slug)) throw new Error(`Duplicate Arcade slug: ${fighter.slug}`);
    if (!Number.isInteger(fighter.rank) || fighter.rank < 1 || fighter.rank > 999) {
      throw new Error(`Invalid Arcade rank for ${fighter.slug}`);
    }
    if (ranks.has(fighter.rank)) throw new Error(`Duplicate Arcade rank: ${fighter.rank}`);
    if (!fighter.name || !fighter.challengerLine || !fighter.referencePrompt) {
      throw new Error(`Incomplete Arcade manifest entry: ${fighter.slug}`);
    }
    if (
      !LICENSED_REFERENCE_PROMPT.test(fighter.referencePrompt)
      || IDENTITY_ERASING_PROMPT.test(fighter.referencePrompt)
    ) {
      throw new Error(
        `Arcade prompt for ${fighter.slug} must preserve the approved licensed-photo identity and cannot request a text-only replacement face.`,
      );
    }
    const reference = fighterReference(manifest, fighter);
    if (
      reference?.kind !== 'licensed'
      || typeof reference.sourceUrl !== 'string'
      || !reference.sourceUrl.startsWith('https://')
      || typeof reference.licenseUrl !== 'string'
      || !reference.licenseUrl.startsWith('https://')
      || !reference.license
      || !reference.credit
      || !reference.author
      || !reference.sourceDate
      || !reference.verification
      || !/^[a-f0-9]{64}$/.test(reference.sourceSha256 ?? '')
    ) {
      throw new Error(`Incomplete licensed-photo provenance for ${fighter.slug}`);
    }
    slugs.add(fighter.slug);
    ranks.add(fighter.rank);
  }
}

export function assertReviewedActivationConfirmation(value) {
  if (value !== REVIEWED_ARCADE_ACTIVATION_CONFIRMATION) {
    throw new Error(
      `Reviewed Arcade activation requires --confirm-activation=${REVIEWED_ARCADE_ACTIVATION_CONFIRMATION}.`,
    );
  }
}

export function assertReviewGatedVideoStepConfirmation(value) {
  if (value !== REVIEW_GATED_VIDEO_STEP_CONFIRMATION) {
    throw new Error(
      `Review-gated Video generation requires --confirm-video-step=${REVIEW_GATED_VIDEO_STEP_CONFIRMATION}.`,
    );
  }
}

export function assertReviewGatedVideoRecoveryConfirmation(operation, value) {
  const expected = operation === 'resume-failed'
    ? REVIEW_GATED_VIDEO_RESUME_CONFIRMATION
    : operation === 'restart-full'
      ? REVIEW_GATED_VIDEO_RESTART_CONFIRMATION
      : null;
  if (!expected || value !== expected) {
    throw new Error(`Review-gated Video ${operation} requires --confirm-video-step=${expected ?? 'a supported recovery confirmation'}.`);
  }
}

export function assertReviewGatedVideoReviewConfirmation(decision, value) {
  const expected = REVIEW_GATED_VIDEO_REVIEW_CONFIRMATIONS[decision];
  if (!expected || value !== expected) {
    throw new Error(`Review-gated Video ${decision} requires --confirm-video-step=${expected ?? 'a supported review confirmation'}.`);
  }
}

export function assertPostApprovedRecurationConfirmation(operation, value) {
  const expected = POST_APPROVED_RECURATION_CONFIRMATIONS[operation];
  if (!expected || value !== expected) {
    throw new Error(
      `Post-approved Video recuration ${operation} requires --confirm-recuration=${expected ?? 'a supported recuration confirmation'}.`,
    );
  }
  return expected;
}

function exactVideoJobId(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) {
    throw new Error(`${label} must be an exact 32-character lowercase hex Video job id.`);
  }
  return value;
}

export function assertReviewedVideoFinalJobId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) {
    throw new Error(
      'Reviewed Arcade activation requires --reviewed-video-final-job-id=<32 lowercase hex chars>.',
    );
  }
  return value;
}

export function assertPinnedProductionWorkerHealth(health, expectedSha) {
  if (typeof expectedSha !== 'string' || !/^[a-f0-9]{40}$/.test(expectedSha)) {
    throw new Error('A full lowercase deployed commit SHA is required for the production Worker pin.');
  }
  const tagPattern = new RegExp(`^prod-${expectedSha}-[1-9][0-9]*$`);
  if (
    health?.status !== 'ok'
    || health.environment !== 'production'
    || health.storage?.d1 !== 'bound'
    || health.storage?.r2 !== 'bound'
    || typeof health.workerVersion?.id !== 'string'
    || !health.workerVersion.id
    || typeof health.workerVersion?.tag !== 'string'
    || !tagPattern.test(health.workerVersion.tag)
  ) {
    throw new Error(`Live Worker is not the healthy production deployment for exact SHA ${expectedSha}.`);
  }
  return health.workerVersion.tag;
}

export function assertReviewedProductionApiOrigin(value) {
  const baseUrl = typeof value === 'string' ? value : '';
  if (baseUrl !== REVIEWED_PRODUCTION_API_ORIGIN) {
    throw new Error(
      `Reviewed production operations require exact ${REVIEWED_PRODUCTION_API_ORIGIN} `
      + 'origin with no credentials, port, path, query, or fragment.',
    );
  }
  return REVIEWED_PRODUCTION_API_ORIGIN;
}

export async function pinProductionWorkerHealth({
  baseUrl,
  configuredHealthUrl = '',
  expectedSha,
  requestHealth = fetch,
}) {
  const workerUrl = new URL(assertReviewedProductionApiOrigin(baseUrl));
  const expectedHealthUrl = new URL('/health', workerUrl).toString();
  const healthUrl = configuredHealthUrl?.trim() || expectedHealthUrl;
  if (new URL(healthUrl).toString() !== expectedHealthUrl) {
    throw new Error('ASF_WORKER_HEALTH_URL must be the /health endpoint of ASF_WORKER_URL.');
  }
  const response = await requestHealth(healthUrl, {
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response?.ok) {
    throw new Error(`Worker health failed with HTTP ${response?.status ?? 'unknown'}.`);
  }
  const health = await response.json();
  const tag = assertPinnedProductionWorkerHealth(health, expectedSha);
  console.log(`Worker health pinned to ${tag}.`);
  return { healthUrl, tag };
}

function hasExactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function assertReviewedCanonicalManifest(value, expected = {}) {
  if (!hasExactKeys(value, [
    'schemaVersion',
    'canonicalSourceMode',
    'slug',
    'fighterId',
    'photoHash',
    'canonicalSourceHashes',
  ])) {
    throw new Error('Reviewed canonical manifest must use the exact reviewed-current-v1 schema.');
  }
  if (
    value.schemaVersion !== 1 || value.canonicalSourceMode !== REVIEWED_CANONICAL_SOURCE_MODE ||
    typeof value.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.slug) ||
    typeof value.fighterId !== 'string' || !/^[a-f0-9]{32}$/.test(value.fighterId) ||
    typeof value.photoHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.photoHash) ||
    !hasExactKeys(value.canonicalSourceHashes, CANONICAL_SOURCE_NAMES)
  ) {
    throw new Error('Reviewed canonical manifest identity or source hash schema is invalid.');
  }
  for (const sourceName of CANONICAL_SOURCE_NAMES) {
    const pair = value.canonicalSourceHashes[sourceName];
    if (
      !hasExactKeys(pair, ['processedSha256', 'rawSha256']) ||
      typeof pair.processedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(pair.processedSha256) ||
      typeof pair.rawSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(pair.rawSha256)
    ) {
      throw new Error(`Reviewed canonical manifest ${sourceName} hashes are invalid.`);
    }
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (expectedValue !== undefined && value[key] !== expectedValue) {
      throw new Error(`Reviewed canonical manifest ${key} does not match the selected fighter.`);
    }
  }
  return value;
}

function selectFighters(manifest) {
  if (all && slugArg) throw new Error('Use either --all or --slug, not both.');
  if (
    preflightOnly
    && (dryRun || all || resume || restartDraft || registerDraft || prepareCanary || canarySide || probeSide || activate || reviewedVideoOperation || animationName || sourceName)
  ) {
    throw new Error('--preflight-only requires one --slug and cannot be combined with a generation operation.');
  }
  if (animationName && sourceName) {
    throw new Error('Use either --animation or --source, not both.');
  }
  if (
    (animationName || sourceName)
    && (all || !slugArg || activate || (reviewedVideoOperation && !postApprovedRecurationOperation))
  ) {
    throw new Error('--animation and --source require one --slug and cannot be combined with an activation operation.');
  }
  if (resume && (animationName || sourceName)) {
    throw new Error('--resume fills an entire fighter and cannot be combined with --animation or --source.');
  }
  if (restartDraft && (all || resume || registerDraft || prepareCanary || canarySide || probeSide || activate || reviewedVideoOperation || animationName || sourceName || !slugArg)) {
    throw new Error('--restart-draft requires one --slug and cannot be combined with --all, --resume, --activate, --animation, or --source.');
  }
  if (registerDraft && (all || resume || restartDraft || prepareCanary || canarySide || probeSide || activate || reviewedVideoOperation || animationName || sourceName || !slugArg)) {
    throw new Error('--register-draft requires one --slug and cannot be combined with another generation operation.');
  }
  if (prepareCanary && (all || resume || restartDraft || registerDraft || canarySide || probeSide || activate || reviewedVideoOperation || animationName || sourceName || !slugArg)) {
    throw new Error('--prepare-canary requires one --slug and cannot be combined with another generation operation.');
  }
  if (canarySide && (all || resume || restartDraft || registerDraft || prepareCanary || probeSide || activate || reviewedVideoOperation || animationName || sourceName || !slugArg)) {
    throw new Error('--canary-side requires one --slug and cannot be combined with another generation operation.');
  }
  if (probeSide && (all || resume || restartDraft || registerDraft || prepareCanary || canarySide || activate || reviewedVideoOperation || animationName || sourceName || !slugArg)) {
    throw new Error('--probe-side requires one --slug and cannot be combined with another generation operation.');
  }
  if (
    activateReviewed
    && (dryRun || all || resume || restartDraft || registerDraft || prepareCanary || canarySide || probeSide || activate || videoStep || videoReview || postApprovedRecurationOperation || animationName || sourceName || !slugArg)
  ) {
    throw new Error('--activate-reviewed requires one --slug and cannot be combined with generation, resume, or dry-run.');
  }
  if (
    videoStep
    && (dryRun || all || resume || restartDraft || registerDraft || prepareCanary || canarySide || probeSide || activate || activateReviewed || videoReview || postApprovedRecurationOperation || animationName || sourceName || !slugArg)
  ) {
    throw new Error('--video-step requires one --slug and cannot be combined with generation, resume, activation, or dry-run.');
  }
  if (
    videoReview
    && (dryRun || all || resume || restartDraft || registerDraft || prepareCanary || canarySide || probeSide || activate || activateReviewed || videoStep || postApprovedRecurationOperation || animationName || sourceName || !slugArg)
  ) {
    throw new Error('--video-review-decision requires one --slug and cannot be combined with generation, resume, activation, or dry-run.');
  }
  if (postApprovedRecurationOperation && (
    dryRun || all || resume || restartDraft || registerDraft || prepareCanary || canarySide || probeSide
    || activate || activateReviewed || videoStep || videoReview || sourceName || !slugArg || !animationName
  )) {
    throw new Error(
      '--post-approved-recuration requires exactly one --slug and --animation and cannot be combined with generation, review, activation, or dry-run.',
    );
  }
  if (postApprovedRecurationOperation && !['stage', 'promote', 'rollback'].includes(postApprovedRecuration)) {
    throw new Error('--post-approved-recuration must be stage, promote, or rollback.');
  }
  if (resumeVideoRunFrom && restartVideoRunFrom) {
    throw new Error('Choose exactly one of --resume-video-run-from or --restart-video-run-from.');
  }
  if ((resumeVideoRunFrom || restartVideoRunFrom) && !videoStep) {
    throw new Error('Video recovery arguments are supported only with --video-step.');
  }
  if (videoReviewInspect && videoReviewDecision) {
    throw new Error('Video review inspect cannot be combined with a review decision.');
  }
  if (
    videoReviewExportDir
    && !videoStep
    && !videoReviewInspect
    && videoReviewDecision !== 'adjust'
    && postApprovedRecuration !== 'stage'
  ) {
    throw new Error('Video review export requires --video-step, --video-review-inspect, adjust, or post-approved recuration stage.');
  }
  if (videoReviewDecision === 'adjust' && !videoReviewExportDir) {
    throw new Error('Video review adjust requires a private export destination for the new revision.');
  }
  if (reviewedManifestRunId && !videoStep && !videoReview) {
    throw new Error('--reviewed-manifest-run-id requires a review-gated Video operation.');
  }
  if (reviewedCanonicalManifestPath && !videoStep && !videoReview) {
    throw new Error('--reviewed-canonical-manifest is supported only with --video-step or --video-review-decision.');
  }
  if (reviewedVideoFinalJobId && !activateReviewed) {
    throw new Error('--reviewed-video-final-job-id is supported only with --activate-reviewed.');
  }
  if (expectedDeployedSha && !reviewedVideoOperation) {
    throw new Error('--expected-deployed-sha is supported only with a reviewed Video operation.');
  }
  if ((recurationDescriptorPath || recurationDescriptorSha256 || recurationConfirmation || acceptRecurationNeedsReview)
    && !postApprovedRecurationOperation) {
    throw new Error('Recuration descriptor, confirmation, and needs-review arguments require --post-approved-recuration.');
  }
  if (animationName && !PLAYABLE_ANIMATIONS.has(animationName)) {
    throw new Error(`Unknown playable animation: ${animationName}`);
  }
  if (sourceName && !CANONICAL_SOURCES.has(sourceName)) {
    throw new Error(`Unknown canonical source: ${sourceName}`);
  }
  if (all) return manifest.fighters;
  const slug = slugArg?.slice('--slug='.length);
  if (!slug) throw new Error('Choose --all or --slug=<fighter>.');
  const fighter = manifest.fighters.find((entry) => entry.slug === slug);
  if (!fighter) throw new Error(`Unknown Arcade fighter: ${slug}`);
  return [fighter];
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readApprovedSource(manifest, fighter) {
  const sourcePath = join(sourceDir, `${fighter.slug}.png`);
  if (!existsSync(sourcePath)) throw new Error(`Missing licensed source photo: ${sourcePath}`);
  const sourceBytes = readFileSync(sourcePath);
  if (sourceBytes.byteLength > MAX_SOURCE_UPLOAD_BYTES) {
    throw new Error(`Licensed source photo exceeds the 12 MiB upload limit: ${fighter.slug}`);
  }
  if (!sourceBytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) {
    throw new Error(`Licensed source photo is not a valid PNG input: ${fighter.slug}`);
  }
  const photoHash = sha256(sourceBytes);
  const expectedHash = fighterReference(manifest, fighter).sourceSha256;
  if (photoHash !== expectedHash) {
    throw new Error(`Licensed source hash mismatch for ${fighter.slug}; review the photo and update the manifest deliberately.`);
  }
  return { sourceBytes, photoHash };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function arcadePayload(manifest, fighter, status, slug = fighter.slug) {
  const reference = fighterReference(manifest, fighter);
  return {
    slug,
    rank: fighter.rank,
    challengerLine: fighter.challengerLine,
    defaultPersonality: fighter.defaultPersonality,
    reference: {
      kind: reference.kind,
      sourceUrl: reference.sourceUrl,
      license: reference.license,
      credit: reference.credit,
    },
    generationPrompt: fighter.referencePrompt,
    status,
  };
}

function generationLegal(manifest) {
  return {
    legalVersion: manifest.legalVersion,
    ageConfirmed: true,
    termsAccepted: true,
    photoRightsConfirmed: true,
    aiProcessingConfirmed: true,
    immediatePerformanceConfirmed: true,
    withdrawalLossAcknowledged: true,
  };
}

export function arcadeAdminAuthHeaders(token, backendBridgeSecret = '') {
  return {
    Authorization: `Bearer ${token}`,
    'X-Insert-Player-Admin-Seed': 'clerk-backend',
    ...(backendBridgeSecret
      ? { 'X-Insert-Player-Clerk-Backend-Auth': backendBridgeSecret }
      : {}),
  };
}

export async function apiRequest(baseUrl, getToken, path, init = {}, request = fetch) {
  const {
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    ...requestInit
  } = init;
  const token = await getToken();
  const response = await request(`${baseUrl}${path}`, {
    ...requestInit,
    headers: {
      ...arcadeAdminAuthHeaders(token, clerkBackendAuthBridgeSecret),
      ...(expectedDeployedSha
        ? { 'X-Insert-Player-Expected-Worker-Sha': expectedDeployedSha }
        : {}),
      ...(requestInit.body && !(requestInit.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(requestInit.headers ?? {}),
    },
    redirect: 'error',
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${init.method ?? 'GET'} ${path} returned non-JSON (${response.status}).`);
  }
  if (!response.ok) {
    const detail = typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
    const context = [body.code, body.reason, body.model, body.retryAt]
      .filter((value) => typeof value === 'string' && value);
    throw new Error(`${init.method ?? 'GET'} ${path} failed: ${detail}${context.length > 0 ? ` (${context.join(', ')})` : ''}`);
  }
  return body;
}

function exactReviewedVideoAssetDigest(headers) {
  const rawEtag = headers.get('ETag');
  const etagMatch = rawEtag === null
    ? null
    : /^(?:W\/)?"([a-f0-9]{64})"$/.exec(rawEtag);
  if (rawEtag !== null && !etagMatch) {
    throw new Error('Reviewed Video provenance asset returned a malformed SHA-256 ETag.');
  }
  const rawContentSha256 = headers.get('X-Content-SHA256');
  if (rawContentSha256 !== null && !/^[a-f0-9]{64}$/.test(rawContentSha256)) {
    throw new Error('Reviewed Video provenance asset returned a malformed content SHA-256.');
  }
  const etagDigest = etagMatch?.[1] ?? null;
  if (etagDigest && rawContentSha256 && etagDigest !== rawContentSha256) {
    throw new Error('Reviewed Video provenance asset returned conflicting integrity digests.');
  }
  const digest = rawContentSha256 ?? etagDigest;
  if (!digest) {
    throw new Error('Reviewed Video provenance asset returned no exact integrity digest.');
  }
  return digest;
}

export async function apiAssetRequest(baseUrl, getToken, path, request = fetch) {
  if (typeof path !== 'string' || !path.startsWith('/api/generation-jobs/')) {
    throw new Error('Reviewed Video provenance attempted to read an untrusted asset path.');
  }
  const token = await getToken();
  const response = await request(`${baseUrl}${path}`, {
    headers: {
      ...arcadeAdminAuthHeaders(token, clerkBackendAuthBridgeSecret),
      ...(expectedDeployedSha
        ? { 'X-Insert-Player-Expected-Worker-Sha': expectedDeployedSha }
        : {}),
    },
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`GET ${path} failed with HTTP ${response.status}.`);
  }
  const assetDigest = exactReviewedVideoAssetDigest(response.headers);
  const declaredLength = Number(response.headers.get('Content-Length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REVIEWED_VIDEO_ASSET_BYTES) {
    throw new Error(`Reviewed Video provenance asset exceeds ${MAX_REVIEWED_VIDEO_ASSET_BYTES} bytes.`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_REVIEWED_VIDEO_ASSET_BYTES) {
    throw new Error(`Reviewed Video provenance asset exceeds ${MAX_REVIEWED_VIDEO_ASSET_BYTES} bytes.`);
  }
  return {
    bytes,
    etag: assetDigest,
    contentType: response.headers.get('Content-Type')?.split(';', 1)[0]?.trim() ?? '',
  };
}

export function findCurrentArcadeEntry(adminEntries, slug) {
  const current = adminEntries.filter((entry) => entry?.slug === slug && entry?.status !== 'retired');
  if (current.length > 1) {
    throw new Error(`Multiple current Arcade fighters use slug ${slug}; resolve the roster collision before resuming.`);
  }
  return current[0] ?? null;
}

export function planSideDraftPreparation(entry, slug, { allowCreate = false, mode = 'canary' } = {}) {
  if (!entry) {
    if (allowCreate) return { action: 'create', entry: null };
    throw new Error(`No current Arcade fighter exists for ${slug}. Stage its private draft first.`);
  }
  if (!/^[a-f0-9]{32}$/.test(entry.fighterId ?? '')) {
    throw new Error(`Current Arcade fighter ${slug} has an invalid id.`);
  }
  if (entry.status !== 'draft') {
    throw new Error(`Arcade ${mode}s are restricted to draft fighters; ${slug} is ${entry.status}.`);
  }
  return { action: 'reuse', entry };
}

export function assertNewArcadeDraftIdentity(adminEntries, fighterId, slug) {
  const collision = adminEntries.find((entry) => entry?.fighterId === fighterId);
  if (collision) {
    throw new Error(
      `${slug} resolved to existing Arcade fighter ${collision.slug ?? fighterId}; `
      + 'refusing to mutate a reused photo identity.',
    );
  }
  return fighterId;
}

export function planArcadeDraftRegistration(current, fighterId, slug, photoHash, shouldRestartDraft) {
  if (shouldRestartDraft) {
    if (!current) throw new Error(`No current Arcade draft exists for ${slug}.`);
    if (current.status !== 'draft') {
      throw new Error(`Arcade fighter ${slug} is ${current.status}; only a draft can be restarted before review.`);
    }
    if (current.fighterId !== fighterId) {
      throw new Error(`Arcade fighter ${slug} did not resolve to its content-addressed cloud fighter.`);
    }
    return { slug: current.slug, restartFullGeneration: true };
  }
  if (current?.fighterId === fighterId) {
    throw new Error(`Arcade fighter ${slug} already exists; use --resume or --restart-draft explicitly.`);
  }
  return {
    slug: current ? `${slug.slice(0, 49)}-next-${photoHash.slice(0, 8)}` : slug,
    restartFullGeneration: false,
  };
}

export function planFighterResume(fighter) {
  const sources = fighter?.sources ?? {};
  const sourceReady = {
    side: Boolean(sources.side && sources.sideRaw),
    upright: Boolean(sources.upright && sources.uprightRaw),
    crouch: Boolean(sources.crouch && sources.crouchRaw),
  };
  const firstMissingSource = CANONICAL_SOURCE_NAMES.findIndex((name) => !sourceReady[name]);
  const sourceNames = firstMissingSource === -1
    ? []
    : CANONICAL_SOURCE_NAMES.slice(firstMissingSource);
  const currentAnimations = new Set(
    (Array.isArray(fighter?.sprites) ? fighter.sprites : [])
      .filter((sprite) => sprite?.qualityTier === 'champion' && PLAYABLE_ANIMATIONS.has(sprite?.animationName))
      .map((sprite) => sprite.animationName),
  );
  const animationNames = sourceNames.length > 0
    ? [...PLAYABLE_ANIMATION_NAMES]
    : PLAYABLE_ANIMATION_NAMES.filter((name) => !currentAnimations.has(name));
  return {
    sourceNames,
    animationNames,
    ready: sourceNames.length === 0 && animationNames.length === 0,
  };
}

export function assertReviewedActivationDraft({
  manifest,
  fighter,
  entry,
  owned,
  approvedPhotoHash,
}) {
  if (!entry) {
    throw new Error(`No current Arcade fighter exists for ${fighter.slug}. Stage and review its private draft first.`);
  }
  if (!/^[a-f0-9]{32}$/.test(entry.fighterId ?? '')) {
    throw new Error(`Current Arcade fighter ${fighter.slug} has an invalid id.`);
  }
  if (entry.status !== 'draft') {
    throw new Error(`Reviewed activation is restricted to draft fighters; ${fighter.slug} is ${entry.status}.`);
  }

  const reference = fighterReference(manifest, fighter);
  const manifestMismatches = [
    entry.slug === fighter.slug ? null : 'slug',
    entry.rank === fighter.rank ? null : 'rank',
    entry.fighterName === fighter.name ? null : 'name',
    entry.qualityTier === 'champion' ? null : 'tier',
    entry.public === false ? null : 'visibility',
    entry.challengerLine === fighter.challengerLine ? null : 'challengerLine',
    entry.defaultPersonality === fighter.defaultPersonality ? null : 'defaultPersonality',
    entry.reference?.kind === reference.kind ? null : 'reference.kind',
    entry.reference?.sourceUrl === reference.sourceUrl ? null : 'reference.sourceUrl',
    entry.reference?.license === reference.license ? null : 'reference.license',
    entry.reference?.credit === reference.credit ? null : 'reference.credit',
    entry.generationPrompt === fighter.referencePrompt ? null : 'generationPrompt',
  ].filter(Boolean);
  if (manifestMismatches.length > 0) {
    throw new Error(
      `${fighter.name} draft does not match the reviewed roster manifest: ${manifestMismatches.join(', ')}.`,
    );
  }

  if (approvedPhotoHash !== reference.sourceSha256) {
    throw new Error(`${fighter.name} approved local source hash does not match the roster manifest.`);
  }
  if (!owned || owned.id !== entry.fighterId) {
    throw new Error(`${fighter.name} private asset manifest is unavailable or belongs to another fighter.`);
  }
  if (
    owned.name !== fighter.name
    || owned.qualityTier !== 'champion'
    || owned.public !== false
  ) {
    throw new Error(`${fighter.name} private fighter metadata changed after review.`);
  }
  if (
    owned.photoHash !== approvedPhotoHash
    || !owned.sources?.original
    || owned.sourceHashes?.original !== approvedPhotoHash
  ) {
    throw new Error(`${fighter.name} private fighter does not match the approved licensed-photo hash.`);
  }

  const plan = planFighterResume(owned);
  const currentSprites = new Map(
    (Array.isArray(owned.sprites) ? owned.sprites : [])
      .filter((sprite) => sprite?.qualityTier === 'champion')
      .map((sprite) => [sprite.animationName, sprite]),
  );
  const missingSpritePointers = PLAYABLE_ANIMATION_NAMES.filter((name) => {
    const sprite = currentSprites.get(name);
    return !sprite?.url || !sprite?.rawUrl;
  });
  if (!plan.ready || missingSpritePointers.length > 0) {
    const missing = [
      ...plan.sourceNames.map((name) => `source:${name}`),
      ...plan.animationNames.map((name) => `sprite:${name}`),
      ...missingSpritePointers.map((name) => `sprite:${name}:clean/raw`),
    ];
    throw new Error(
      `${fighter.name} reviewed draft is incomplete and cannot be activated: ${[...new Set(missing)].join(', ')}.`,
    );
  }

  return { fighterId: entry.fighterId };
}

function sameExactStringSet(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const values = new Set(actual);
  return values.size === expected.length && expected.every((value) => values.has(value));
}

function reviewedVideoAssetBytes(result, label) {
  const bytes = Buffer.isBuffer(result)
    ? result
    : result?.bytes instanceof Uint8Array
      ? Buffer.from(result.bytes)
      : null;
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_REVIEWED_VIDEO_ASSET_BYTES) {
    throw new Error(`${label} did not return bounded immutable bytes.`);
  }
  return bytes;
}

function assertApprovedVideoReviewForActivation(review, job, expectedAction, sequenceOrder, artifactRunId) {
  const mismatches = [
    review?.jobId === job.id ? null : 'jobId',
    review?.artifactRunId === artifactRunId ? null : 'artifactRunId',
    /^[a-f0-9]{32}$/.test(review?.candidateId ?? '') ? null : 'candidateId',
    review?.action === expectedAction ? null : 'action',
    review?.sequenceOrder === sequenceOrder ? null : 'sequenceOrder',
    review?.status === 'approved' ? null : 'status',
    Number.isInteger(review?.revision) && review.revision >= 1 ? null : 'revision',
    /^[a-f0-9]{64}$/.test(review?.reportSha256 ?? '') ? null : 'reportSha256',
    ['technical_pass', 'needs_review'].includes(review?.technicalOutcome) ? null : 'technicalOutcome',
    review?.animationFormat === VIDEO_DENSE_ANIMATION_FORMAT ? null : 'animationFormat',
    VIDEO_DENSE_PROCESSING_VERSIONS.has(review?.processingVersion) ? null : 'processingVersion',
    Number.isInteger(review?.frameCount) && review.frameCount >= 2 ? null : 'frameCount',
    Number.isInteger(review?.rawFrameCount) && review.rawFrameCount >= 2 ? null : 'rawFrameCount',
    typeof review?.reviewedAt === 'string' && review.reviewedAt ? null : 'reviewedAt',
  ].filter(Boolean);
  if (mismatches.length > 0) {
    throw new Error(
      `Reviewed Video approval ${sequenceOrder + 1}/11 failed its sealed provenance: ${mismatches.join(', ')}.`,
    );
  }
  return review;
}

export async function verifyReviewedVideoActivationProvenance({
  fighterId,
  owned,
  finalJobId,
  baseUrl,
  token,
  requestApi = apiRequest,
  requestAsset = apiAssetRequest,
}) {
  assertReviewedVideoFinalJobId(finalJobId);
  const currentSprites = new Map(
    (Array.isArray(owned?.sprites) ? owned.sprites : [])
      .filter((sprite) => sprite?.qualityTier === 'champion')
      .map((sprite) => [sprite.animationName, sprite]),
  );
  const seenJobs = new Set();
  const seenCandidates = new Set();
  const approvals = [];
  let artifactRunId = '';
  let jobId = finalJobId;

  const readLineageJob = async (lineageJobId) => {
    if (!/^[a-f0-9]{32}$/.test(lineageJobId) || seenJobs.has(lineageJobId)) {
      throw new Error('Reviewed Video job chain is invalid or cyclic.');
    }
    seenJobs.add(lineageJobId);
    const jobBody = await requestApi(
      baseUrl,
      token,
      `/api/generation-jobs/${encodeURIComponent(lineageJobId)}`,
    );
    const job = assertReviewGatedVideoJob(
      jobBody.job,
      fighterId,
      null,
      { allowFullRunRestartRequired: true },
    );
    if (!artifactRunId) artifactRunId = job.artifactRunId;
    if (job.id !== lineageJobId || job.artifactRunId !== artifactRunId) {
      throw new Error('Reviewed Video job chain crossed its sealed run identity.');
    }
    return job;
  };

  const assertObsoleteRetryJob = (job, sequenceOrder) => {
    const mismatches = [
      ['failed', 'cancelled'].includes(job.status) ? null : 'status',
      job.reviewStatus === 'none' ? null : 'reviewStatus',
      job.fullRunRestartRequired === false ? null : 'restartRequired',
      job.resumable === false ? null : 'resumable',
    ].filter(Boolean);
    if (mismatches.length > 0) {
      throw new Error(
        `Reviewed Video retry predecessor before job ${sequenceOrder + 1}/11 failed its sealed contract: ${mismatches.join(', ')}.`,
      );
    }
  };

  let job = await readLineageJob(jobId);

  for (let sequenceOrder = REVIEW_GATED_VIDEO_ACTIONS.length - 1; sequenceOrder >= 0; sequenceOrder -= 1) {
    const jobMismatches = [
      job.id === jobId ? null : 'id',
      job.artifactRunId === artifactRunId ? null : 'artifactRunId',
      job.status === 'succeeded' ? null : 'status',
      job.reviewStatus === 'approved' ? null : 'reviewStatus',
      job.fullRunRestartRequired !== true ? null : 'restartRequired',
    ].filter(Boolean);
    if (jobMismatches.length > 0) {
      throw new Error(
        `Reviewed Video job ${sequenceOrder + 1}/11 failed its completed-run contract: ${jobMismatches.join(', ')}.`,
      );
    }
    if (sequenceOrder === REVIEW_GATED_VIDEO_ACTIONS.length - 1) {
      if (
        job.stage !== 'complete'
        || job.resumable === true
        || !sameExactStringSet(job.completedStages, COMPLETE_REVIEWED_VIDEO_STAGES)
        || !Array.isArray(job.pendingStages)
        || job.pendingStages.length !== 0
        || job.preservedArtifactCount !== COMPLETE_REVIEWED_VIDEO_STAGES.length
      ) {
        throw new Error(
          'Final victory job does not prove one completed 14-stage reviewed Video run.',
        );
      }
    }

    const reviewBody = await requestApi(
      baseUrl,
      token,
      `/api/generation-jobs/${encodeURIComponent(job.id)}/video-review`,
    );
    const expectedAction = REVIEW_GATED_VIDEO_ACTIONS[sequenceOrder];
    const review = assertApprovedVideoReviewForActivation(
      reviewBody.review,
      job,
      expectedAction,
      sequenceOrder,
      artifactRunId,
    );
    if (seenCandidates.has(review.candidateId)) {
      throw new Error('Reviewed Video approval chain reuses a candidate id.');
    }
    seenCandidates.add(review.candidateId);

    const sprite = currentSprites.get(expectedAction);
    const spriteMismatches = [
      sprite ? null : 'missing',
      sprite?.qualityTier === 'champion' ? null : 'tier',
      sprite?.animationFormat === VIDEO_DENSE_ANIMATION_FORMAT ? null : 'animationFormat',
      VIDEO_DENSE_PROCESSING_VERSIONS.has(sprite?.processingVersion) ? null : 'processingVersion',
      sprite?.frameWidth === 192 ? null : 'frameWidth',
      sprite?.frameHeight === 256 ? null : 'frameHeight',
      sprite?.frameCount === review.frameCount ? null : 'frameCount',
      typeof sprite?.url === 'string' && sprite.url ? null : 'url',
      typeof sprite?.rawUrl === 'string' && sprite.rawUrl ? null : 'rawUrl',
      /^[a-f0-9]{64}$/.test(sprite?.contentHash ?? '') ? null : 'contentHash',
      /^[a-f0-9]{64}$/.test(sprite?.rawContentHash ?? '') ? null : 'rawContentHash',
    ].filter(Boolean);
    if (spriteMismatches.length > 0) {
      throw new Error(
        `Current ${expectedAction} sprite is not a complete video-dense-v1 Champion pointer: ${spriteMismatches.join(', ')}.`,
      );
    }

    const revision = review.revision;
    const assetPrefix = `/api/generation-jobs/${encodeURIComponent(job.id)}/video-review/assets`;
    const [runtimeResult, rawResult] = await Promise.all([
      requestAsset(baseUrl, token, `${assetPrefix}/runtime?revision=${revision}`),
      requestAsset(baseUrl, token, `${assetPrefix}/raw?revision=${revision}`),
    ]);
    const runtimeBytes = reviewedVideoAssetBytes(runtimeResult, `${expectedAction} runtime`);
    const rawBytes = reviewedVideoAssetBytes(rawResult, `${expectedAction} raw`);
    const runtimeSha256 = sha256(runtimeBytes);
    const rawSha256 = sha256(rawBytes);
    if (runtimeSha256 !== sprite.contentHash || rawSha256 !== sprite.rawContentHash) {
      throw new Error(
        `Current ${expectedAction} sprite bytes do not match approved Video revision ${revision}.`,
      );
    }
    if (
      (runtimeResult?.etag && runtimeResult.etag !== runtimeSha256)
      || (rawResult?.etag && rawResult.etag !== rawSha256)
    ) {
      throw new Error(`Approved ${expectedAction} Video asset ETag does not match its bytes.`);
    }
    approvals.push({
      action: expectedAction,
      sequenceOrder,
      jobId: job.id,
      candidateId: review.candidateId,
      revision,
      reportSha256: review.reportSha256,
      runtimeSha256,
      rawSha256,
    });

    let previousJobId = job.resumedFromJobId;
    let previousApprovedJob = null;
    while (previousJobId != null) {
      const predecessor = await readLineageJob(previousJobId);
      if (predecessor.status === 'succeeded' && predecessor.reviewStatus === 'approved') {
        previousApprovedJob = predecessor;
        break;
      }
      assertObsoleteRetryJob(predecessor, sequenceOrder);
      previousJobId = predecessor.resumedFromJobId;
    }
    if (sequenceOrder === 0) {
      if (previousApprovedJob) {
        throw new Error('Reviewed Video root job unexpectedly resumes another job.');
      }
    } else {
      if (!previousApprovedJob) {
        throw new Error(`Reviewed Video job ${sequenceOrder + 1}/11 has no sealed predecessor.`);
      }
      job = previousApprovedJob;
      jobId = job.id;
    }
  }

  if (
    approvals.length !== REVIEW_GATED_VIDEO_ACTIONS.length
    || approvals[0]?.action !== 'victory'
    || approvals.at(-1)?.action !== 'idle'
  ) {
    throw new Error('Reviewed Video activation did not prove all eleven approvals through final victory.');
  }
  return {
    schemaVersion: 1,
    fighterId,
    artifactRunId,
    finalJobId,
    animationFormat: VIDEO_DENSE_ANIMATION_FORMAT,
    approvedActionCount: approvals.length,
    finalAction: 'victory',
    currentSpritesVerified: true,
    approvals: approvals.reverse(),
  };
}

export async function activateReviewedArcadeFighter({
  manifest,
  fighter,
  approvedPhotoHash,
  reviewedVideoFinalJobId,
  baseUrl,
  token,
  requestApi = apiRequest,
  requestAsset = apiAssetRequest,
}) {
  const admin = await requestApi(baseUrl, token, '/api/admin/arcade');
  const adminEntries = Array.isArray(admin.fighters) ? admin.fighters : [];
  const entry = findCurrentArcadeEntry(adminEntries, fighter.slug);
  if (!entry) {
    throw new Error(`No current Arcade fighter exists for ${fighter.slug}. Stage and review its private draft first.`);
  }
  if (entry.status !== 'draft') {
    throw new Error(`Reviewed activation is restricted to draft fighters; ${fighter.slug} is ${entry.status}.`);
  }
  if (!/^[a-f0-9]{32}$/.test(entry.fighterId ?? '')) {
    throw new Error(`Current Arcade fighter ${fighter.slug} has an invalid id.`);
  }

  const detail = await requestApi(
    baseUrl,
    token,
    `/api/fighters/${encodeURIComponent(entry.fighterId)}`,
  );
  const owned = detail.fighter;
  assertReviewedActivationDraft({ manifest, fighter, entry, owned, approvedPhotoHash });
  const provenance = await verifyReviewedVideoActivationProvenance({
    fighterId: entry.fighterId,
    owned,
    finalJobId: reviewedVideoFinalJobId,
    baseUrl,
    token,
    requestApi,
    requestAsset,
  });

  console.log(`\n${fighter.rank}. ${fighter.name} [reviewed activation only]`);
  const result = await requestApi(
    baseUrl,
    token,
    `/api/admin/arcade/${encodeURIComponent(entry.fighterId)}/activate-reviewed-video`,
    {
      method: 'POST',
      body: JSON.stringify({
        finalJobId: reviewedVideoFinalJobId,
        arcadeUpdatedAt: entry.updatedAt,
        fighterUpdatedAt: owned.updatedAt,
      }),
    },
  );
  if (
    result.fighter?.fighterId !== entry.fighterId
    || result.fighter?.status !== 'active'
    || result.fighter?.public !== true
    || result.provenance?.schemaVersion !== 1
    || result.provenance?.artifactRunId !== provenance.artifactRunId
    || result.provenance?.finalJobId !== reviewedVideoFinalJobId
    || result.provenance?.approvedActionCount !== REVIEW_GATED_VIDEO_ACTIONS.length
    || result.provenance?.finalAction !== 'victory'
    || result.provenance?.animationFormat !== VIDEO_DENSE_ANIMATION_FORMAT
    || result.provenance?.currentSpritesVerified !== true
  ) {
    throw new Error(
      `${fighter.name} activation did not return the atomically proven public Video fighter.`,
    );
  }
  console.log(
    `  active: ${entry.fighterId} (11/11 ${provenance.animationFormat} approvals from ${provenance.artifactRunId}; no generation requested)`,
  );
  return result.fighter;
}

export function assertReviewGatedVideoDraft({
  manifest,
  fighter,
  entry,
  owned,
  approvedPhotoHash,
}) {
  if (!entry) {
    throw new Error(`No current Arcade fighter exists for ${fighter.slug}. Stage its private draft first.`);
  }
  if (!/^[a-f0-9]{32}$/.test(entry.fighterId ?? '')) {
    throw new Error(`Current Arcade fighter ${fighter.slug} has an invalid id.`);
  }
  const reference = fighterReference(manifest, fighter);
  const mismatches = [
    entry.slug === fighter.slug ? null : 'slug',
    entry.rank === fighter.rank ? null : 'rank',
    entry.fighterName === fighter.name ? null : 'name',
    entry.qualityTier === 'champion' ? null : 'tier',
    entry.public === false ? null : 'visibility',
    entry.status === 'draft' ? null : 'status',
    entry.challengerLine === fighter.challengerLine ? null : 'challengerLine',
    entry.defaultPersonality === fighter.defaultPersonality ? null : 'defaultPersonality',
    entry.reference?.kind === reference.kind ? null : 'reference.kind',
    entry.reference?.sourceUrl === reference.sourceUrl ? null : 'reference.sourceUrl',
    entry.reference?.license === reference.license ? null : 'reference.license',
    entry.reference?.credit === reference.credit ? null : 'reference.credit',
    entry.generationPrompt === fighter.referencePrompt ? null : 'generationPrompt',
  ].filter(Boolean);
  if (mismatches.length > 0) {
    throw new Error(
      `${fighter.name} is not the exact private Champion draft from the reviewed roster manifest: ${mismatches.join(', ')}.`,
    );
  }
  if (approvedPhotoHash !== reference.sourceSha256) {
    throw new Error(`${fighter.name} approved local source hash does not match the roster manifest.`);
  }
  if (
    !owned || owned.id !== entry.fighterId || owned.name !== fighter.name ||
    owned.qualityTier !== 'champion' || owned.public !== false
  ) {
    throw new Error(`${fighter.name} private Champion fighter metadata does not match its Arcade draft.`);
  }
  if (
    owned.photoHash !== approvedPhotoHash || !owned.sources?.original ||
    owned.sourceHashes?.original !== approvedPhotoHash
  ) {
    throw new Error(`${fighter.name} private original does not match the approved licensed-photo hash.`);
  }
  return { fighterId: entry.fighterId };
}

function assertReviewGatedVideoJob(
  job,
  fighterId,
  reviewedCanonicalManifest = null,
  { allowFullRunRestartRequired = false } = {},
) {
  if (!job || !/^[a-f0-9]{32}$/.test(job.id ?? '')) {
    throw new Error('Review-gated Video generation returned an invalid job id.');
  }
  const mismatches = [
    job.fighterId === fighterId ? null : 'fighter',
    job.tier === 'champion' ? null : 'tier',
    job.creationFlow === 'video' ? null : 'creationFlow',
    job.operation === 'fighter_generation' ? null : 'operation',
    /^[a-f0-9]{32}$/.test(job.artifactRunId ?? '') ? null : 'artifactRunId',
    job.targetKind == null ? null : 'targetKind',
    job.targetName == null ? null : 'targetName',
  ].filter(Boolean);
  if (mismatches.length > 0) {
    throw new Error(`Review-gated Video job crossed its sealed scope: ${mismatches.join(', ')}.`);
  }
  if (job.fullRunRestartRequired === true && !allowFullRunRestartRequired) {
    throw new Error(`Video job ${job.id} requires an explicit full-run restart; video-step will not restart it.`);
  }
  if (reviewedCanonicalManifest && (
    job.canonicalSourceMode !== reviewedCanonicalManifest.canonicalSourceMode
    || JSON.stringify(job.canonicalSourceHashes) !== JSON.stringify(
      reviewedCanonicalManifest.canonicalSourceHashes,
    )
  )) {
    throw new Error(
      `Video job ${job.id} is not sealed to the separately reviewed canonical manifest.`,
    );
  }
  return job;
}

export function planReviewGatedVideoStep(
  jobs,
  fighterId,
  { resumeFromJobId = '', restartFromJobId = '' } = {},
) {
  const fighterJobs = (Array.isArray(jobs) ? jobs : []).filter((job) => job?.fighterId === fighterId);
  const recoveryOperation = resumeFromJobId
    ? 'resume-failed'
    : restartFromJobId
      ? 'restart-full'
      : '';
  const recoveryJobId = resumeFromJobId || restartFromJobId;
  const active = fighterJobs.filter((job) => job.status === 'queued' || job.status === 'running');
  const awaiting = fighterJobs.filter((job) => job.reviewStatus === 'awaiting_review');
  if (active.length > 1 || awaiting.length > 1 || (active.length > 0 && awaiting.length > 0)) {
    throw new Error('Arcade Video job state is ambiguous; no generation was started.');
  }
  if (recoveryOperation && (active.length > 0 || awaiting.length > 0)) {
    throw new Error(
      `Video ${recoveryOperation} source is no longer the latest job; use the normal step operation to inspect its successor.`,
    );
  }
  if (active.length === 1) {
    assertReviewGatedVideoJob(active[0], fighterId);
    return { action: 'poll', job: active[0] };
  }
  if (awaiting.length === 1) {
    const job = assertReviewGatedVideoJob(awaiting[0], fighterId);
    if (job.status !== 'succeeded') {
      throw new Error(`Video job ${job.id} is awaiting review without a succeeded terminal state.`);
    }
    return { action: 'reuse-review', job };
  }

  const latest = fighterJobs.find((job) => job?.creationFlow === 'video');
  if (!latest) {
    if (recoveryOperation) {
      throw new Error(`Video ${recoveryOperation} source job was not found for this fighter.`);
    }
    return { action: 'start', job: null };
  }
  assertReviewGatedVideoJob(latest, fighterId, null, {
    allowFullRunRestartRequired: recoveryOperation === 'restart-full',
  });
  if (recoveryOperation) {
    if (latest.id !== recoveryJobId) {
      throw new Error(
        `Video ${recoveryOperation} source ${recoveryJobId} is not the latest Video job for this fighter.`,
      );
    }
    if (recoveryOperation === 'resume-failed') {
      if (
        !['failed', 'cancelled'].includes(latest.status)
        || latest.resumable !== true
        || latest.fullRunRestartRequired === true
      ) {
        throw new Error(
          `Video job ${latest.id} is not an exact resumable local failure; no continuation was started.`,
        );
      }
      return { action: 'resume-failed', job: latest };
    }
    const terminalStatus = ['failed', 'cancelled'].includes(latest.status)
      || (
        latest.status === 'succeeded'
        && ['rejected', 'approved'].includes(latest.reviewStatus)
      );
    if (
      !terminalStatus
      || latest.fullRunRestartRequired !== true
      || latest.resumable === true
    ) {
      throw new Error(
        `Video job ${latest.id} is not an exact terminal restart-required run; no full restart was started.`,
      );
    }
    return { action: 'restart-full', job: latest };
  }
  if (latest.status === 'failed' || latest.status === 'cancelled') {
    throw new Error(
      `Video job ${latest.id} is ${latest.status}; video-step never retries or restarts a failed run automatically.`,
    );
  }
  if (latest.status !== 'succeeded') {
    throw new Error(`Video job ${latest.id} has unsupported status ${String(latest.status)}.`);
  }
  if (latest.reviewStatus === 'rejected') {
    throw new Error(`Video job ${latest.id} was rejected and requires an explicit full-run restart.`);
  }
  if (latest.reviewStatus === 'approved') {
    if (latest.resumable === true) return { action: 'continue', job: latest };
    if (Array.isArray(latest.pendingStages) && latest.pendingStages.length === 0) {
      return { action: 'complete', job: latest };
    }
    throw new Error(
      `Approved Video job ${latest.id} is not safely continuable; inspect the run before any new generation.`,
    );
  }
  throw new Error(
    `Succeeded Video job ${latest.id} has unsupported review state ${String(latest.reviewStatus)}.`,
  );
}

export function assertAwaitingVideoReview(review, job) {
  if (
    !review || review.jobId !== job.id || review.artifactRunId !== job.artifactRunId ||
    !/^[a-f0-9]{32}$/.test(review.candidateId ?? '') ||
    !Number.isInteger(review.revision) || review.revision < 1 ||
    !/^[a-f0-9]{64}$/.test(review.reportSha256 ?? '') ||
    !REVIEW_GATED_VIDEO_ACTION_SET.has(review.action) ||
    review.sequenceOrder !== REVIEW_GATED_VIDEO_ACTIONS.indexOf(review.action) ||
    review.status !== 'awaiting_review' ||
    !['technical_pass', 'needs_review', 'reject'].includes(review.technicalOutcome)
  ) {
    throw new Error(`Video review for job ${job.id} failed its sealed identity or technical-report contract.`);
  }
  return review;
}

function exactSelectedVideoIndices(value, label) {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(`${label} must be an exact JSON array of integer source-frame indices.`);
    }
  }
  if (
    !Array.isArray(parsed) || parsed.length < 2
    || !parsed.every((entry) => Number.isSafeInteger(entry) && entry >= 0)
    || new Set(parsed).size !== parsed.length
  ) {
    throw new Error(`${label} must be an exact JSON array of unique non-negative integer source-frame indices.`);
  }
  return parsed;
}

function assertExactVideoReviewBinding(review, job, binding) {
  assertAwaitingVideoReview(review, job);
  const mismatches = [
    review.jobId === binding.jobId ? null : 'jobId',
    review.candidateId === binding.candidateId ? null : 'candidateId',
    review.revision === binding.revision ? null : 'revision',
    review.reportSha256 === binding.reportSha256 ? null : 'reportSha256',
    review.animationFormat === VIDEO_DENSE_ANIMATION_FORMAT ? null : 'animationFormat',
    VIDEO_DENSE_PROCESSING_VERSIONS.has(review.processingVersion) ? null : 'processingVersion',
    Number.isInteger(review.sourceFrameCount) && review.sourceFrameCount >= 2
      ? null : 'sourceFrameCount',
    Array.isArray(review.selectedVideoIndices) ? null : 'selectedVideoIndices',
  ].filter(Boolean);
  if (mismatches.length > 0) {
    throw new Error(`Video review decision binding changed before mutation: ${mismatches.join(', ')}.`);
  }
  return review;
}

export async function runReviewGatedVideoDecision({
  manifest,
  fighter,
  approvedPhotoHash,
  reviewedCanonicalManifest,
  reviewedManifestRunId,
  reviewedManifestSha256,
  baseUrl,
  token,
  decision,
  jobId,
  candidateId,
  revision,
  reportSha256,
  selectedVideoIndices = null,
  reason = '',
  destination = '',
  requestApi = apiRequest,
  requestAsset = apiAssetRequest,
}) {
  if (!['approve', 'adjust', 'reject'].includes(decision)) {
    throw new Error('Video review decision must be approve, adjust, or reject.');
  }
  exactVideoJobId(jobId, 'Video review jobId');
  exactVideoJobId(candidateId, 'Video review candidateId');
  const exactRevision = Number(revision);
  if (!Number.isInteger(exactRevision) || exactRevision < 1 || exactRevision > 100) {
    throw new Error('Video review revision must be an exact integer from 1 to 100.');
  }
  if (typeof reportSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(reportSha256)) {
    throw new Error('Video review reportSha256 must be an exact lowercase SHA-256.');
  }
  if (!reviewedCanonicalManifest) {
    throw new Error('Video review decisions require the exact separately reviewed canonical manifest.');
  }
  if (!/^[1-9][0-9]*$/.test(reviewedManifestRunId ?? '') ||
    !/^[a-f0-9]{64}$/.test(reviewedManifestSha256 ?? '')) {
    throw new Error('Video review decisions require the exact manifest producer run and file SHA-256.');
  }
  const requestedIndices = decision === 'reject'
    ? null
    : exactSelectedVideoIndices(selectedVideoIndices, 'Video review selected indices');
  const rejectionReason = typeof reason === 'string' ? reason.trim() : '';
  if (decision === 'reject' && (rejectionReason.length < 8 || rejectionReason.length > 300)) {
    throw new Error('Video rejection requires an explicit reason from 8 to 300 characters.');
  }
  if (decision !== 'reject' && rejectionReason) {
    throw new Error('A Video rejection reason is accepted only with the reject decision.');
  }
  if (decision === 'adjust' && !destination) {
    throw new Error('Video adjustment requires a private artifact destination for its new revision.');
  }

  const admin = await requestApi(baseUrl, token, '/api/admin/arcade');
  const entry = findCurrentArcadeEntry(Array.isArray(admin.fighters) ? admin.fighters : [], fighter.slug);
  if (!entry) throw new Error(`No current Arcade fighter exists for ${fighter.slug}.`);
  const detail = await requestApi(
    baseUrl,
    token,
    `/api/fighters/${encodeURIComponent(entry.fighterId)}`,
  );
  const { fighterId } = assertReviewGatedVideoDraft({
    manifest,
    fighter,
    entry,
    owned: detail.fighter,
    approvedPhotoHash,
  });
  assertReviewedCanonicalManifest(reviewedCanonicalManifest, {
    slug: fighter.slug,
    fighterId,
    photoHash: approvedPhotoHash,
  });
  const jobBody = await requestApi(
    baseUrl,
    token,
    `/api/generation-jobs/${encodeURIComponent(jobId)}`,
  );
  const job = assertReviewGatedVideoJob(jobBody.job, fighterId, reviewedCanonicalManifest);
  if (job.id !== jobId) throw new Error('Video review job identity changed before mutation.');
  const reviewPath = `/api/generation-jobs/${encodeURIComponent(jobId)}/video-review`;
  const reviewBody = await requestApi(baseUrl, token, reviewPath);
  const review = assertExactVideoReviewBinding(reviewBody.review, job, {
    jobId, candidateId, revision: exactRevision, reportSha256,
  });
  if (
    decision === 'approve'
    && JSON.stringify(requestedIndices) !== JSON.stringify(review.selectedVideoIndices)
  ) {
    throw new Error('Approve selected indices do not exactly match the bound current revision.');
  }
  if (
    decision === 'adjust'
    && JSON.stringify(requestedIndices) === JSON.stringify(review.selectedVideoIndices)
  ) {
    throw new Error('Adjust requires a deliberately different exact frame selection.');
  }
  const requestBody = {
    candidateId,
    revision: exactRevision,
    reportSha256,
    ...(decision === 'adjust' ? { selectedVideoIndices: requestedIndices } : {}),
    ...(decision === 'reject' ? { reason: rejectionReason } : {}),
  };
  const result = await requestApi(baseUrl, token, `${reviewPath}/${decision}`, {
    method: 'POST',
    body: JSON.stringify(requestBody),
    ...(decision === 'adjust' ? { requestTimeoutMs: VIDEO_REVIEW_ADJUST_TIMEOUT_MS } : {}),
  });
  const updated = result.review;
  const identityChanged = !updated
    || updated.jobId !== job.id
    || updated.artifactRunId !== job.artifactRunId
    || updated.candidateId !== review.candidateId
    || updated.action !== review.action
    || updated.sequenceOrder !== review.sequenceOrder
    || updated.animationFormat !== VIDEO_DENSE_ANIMATION_FORMAT
    || !VIDEO_DENSE_PROCESSING_VERSIONS.has(updated.processingVersion);
  if (identityChanged) {
    throw new Error('Video review decision response crossed its sealed job, run, or action identity.');
  }
  if (decision === 'approve' && (
    updated.status !== 'approved'
    || updated.revision !== exactRevision
    || updated.reportSha256 !== reportSha256
    || JSON.stringify(updated.selectedVideoIndices) !== JSON.stringify(requestedIndices)
    || updated.continuationAvailable !== (review.action !== 'victory')
  )) {
    throw new Error('Video approval response did not preserve the exact bound revision.');
  }
  if (decision === 'adjust' && (
    updated.status !== 'awaiting_review'
    || updated.revision !== exactRevision + 1
    || !/^[a-f0-9]{64}$/.test(updated.reportSha256 ?? '')
    || updated.reportSha256 === reportSha256
    || JSON.stringify(updated.selectedVideoIndices) !== JSON.stringify(requestedIndices)
  )) {
    throw new Error('Video adjustment response did not return the exact next local revision.');
  }
  if (decision === 'reject' && (
    updated.status !== 'rejected'
    || updated.revision !== exactRevision
    || updated.reportSha256 !== reportSha256
    || updated.fullRunRestartRequired !== true
  )) {
    throw new Error('Video rejection response did not terminalize the exact bound run.');
  }
  const descriptor = decision === 'adjust'
    ? await exportAwaitingVideoReviewArtifact({
        baseUrl,
        token,
        fighter,
        job,
        review: updated,
        destination,
        reviewedCanonicalManifest,
        reviewedManifestRunId,
        reviewedManifestSha256,
        requestAsset,
      })
    : null;
  console.log(`  video-review-${decision}: ${JSON.stringify({
    fighter: fighter.slug,
    jobId,
    artifactRunId: job.artifactRunId,
    candidateId,
    action: review.action,
    revision: updated.revision,
    reportSha256: updated.reportSha256,
    selectedVideoIndices: updated.selectedVideoIndices,
    status: updated.status,
  })}`);
  return { decision, job, before: review, review: updated, descriptor };
}

export async function runReviewGatedVideoInspection({
  manifest,
  fighter,
  approvedPhotoHash,
  reviewedCanonicalManifest,
  reviewedManifestRunId,
  reviewedManifestSha256,
  baseUrl,
  token,
  jobId,
  candidateId,
  revision,
  reportSha256,
  destination,
  requestApi = apiRequest,
  requestAsset = apiAssetRequest,
}) {
  if (!destination) throw new Error('Video review inspection requires a private artifact destination.');
  exactVideoJobId(jobId, 'Video review jobId');
  exactVideoJobId(candidateId, 'Video review candidateId');
  const exactRevision = Number(revision);
  if (!Number.isInteger(exactRevision) || exactRevision < 1 || exactRevision > 100) {
    throw new Error('Video review revision must be an exact integer from 1 to 100.');
  }
  if (typeof reportSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(reportSha256)) {
    throw new Error('Video review reportSha256 must be an exact lowercase SHA-256.');
  }
  if (!reviewedCanonicalManifest || !/^[1-9][0-9]*$/.test(reviewedManifestRunId)) {
    throw new Error('Video review inspection requires the exact reviewed manifest and producer run id.');
  }
  if (!/^[a-f0-9]{64}$/.test(reviewedManifestSha256)) {
    throw new Error('Video review inspection requires the exact reviewed manifest file SHA-256.');
  }
  const admin = await requestApi(baseUrl, token, '/api/admin/arcade');
  const entry = findCurrentArcadeEntry(Array.isArray(admin.fighters) ? admin.fighters : [], fighter.slug);
  if (!entry) throw new Error(`No current Arcade fighter exists for ${fighter.slug}.`);
  const detail = await requestApi(baseUrl, token, `/api/fighters/${encodeURIComponent(entry.fighterId)}`);
  const { fighterId } = assertReviewGatedVideoDraft({
    manifest, fighter, entry, owned: detail.fighter, approvedPhotoHash,
  });
  assertReviewedCanonicalManifest(reviewedCanonicalManifest, {
    slug: fighter.slug, fighterId, photoHash: approvedPhotoHash,
  });
  const jobBody = await requestApi(
    baseUrl, token, `/api/generation-jobs/${encodeURIComponent(jobId)}`,
  );
  const job = assertReviewGatedVideoJob(jobBody.job, fighterId, reviewedCanonicalManifest);
  if (job.id !== jobId) throw new Error('Video review job identity changed before inspection.');
  const reviewBody = await requestApi(
    baseUrl, token, `/api/generation-jobs/${encodeURIComponent(jobId)}/video-review`,
  );
  const review = assertExactVideoReviewBinding(reviewBody.review, job, {
    jobId, candidateId, revision: exactRevision, reportSha256,
  });
  const descriptor = await exportAwaitingVideoReviewArtifact({
    baseUrl,
    token,
    fighter,
    job,
    review,
    destination,
    reviewedCanonicalManifest,
    reviewedManifestRunId,
    reviewedManifestSha256,
    requestAsset,
  });
  console.log(`  video-review-inspect: ${JSON.stringify({
    fighter: fighter.slug, jobId, candidateId, revision: exactRevision, reportSha256,
  })}`);
  return { job, review, descriptor };
}

function printAwaitingVideoReview(fighter, review, mode) {
  const summary = {
    fighter: fighter.slug,
    mode,
    jobId: review.jobId,
    artifactRunId: review.artifactRunId,
    candidateId: review.candidateId,
    revision: review.revision,
    reportSha256: review.reportSha256,
    action: review.action,
    technicalOutcome: review.technicalOutcome,
    selectedVideoIndices: review.selectedVideoIndices,
  };
  console.log(`  awaiting-review: ${JSON.stringify(summary)}`);
  console.log('  no approval, upload, activation, or additional action was performed');
  return summary;
}

function writeVideoJobRecoveryDescriptor({
  destination,
  fighter,
  mode,
  operation,
  job,
  reviewedCanonicalManifest,
  reviewedManifestRunId,
  reviewedManifestSha256,
  expectedWorkerSha,
}) {
  if (!destination) return null;
  mkdirSync(destination, { recursive: true });
  const descriptor = {
    schemaVersion: 1,
    fighter: fighter.slug,
    mode,
    operation,
    jobId: job.id,
    artifactRunId: job.artifactRunId,
    resumedFromJobId: job.resumedFromJobId ?? null,
    reviewedCanonicalSourceMode: reviewedCanonicalManifest?.canonicalSourceMode ?? null,
    reviewedCanonicalSourceHashes: reviewedCanonicalManifest?.canonicalSourceHashes ?? null,
    reviewedManifestRunId,
    reviewedManifestSha256,
    expectedWorkerSha,
  };
  writeFileSync(
    join(destination, 'video-job-descriptor.json'),
    `${JSON.stringify(descriptor, null, 2)}\n`,
    { mode: 0o600 },
  );
  return descriptor;
}

async function exportAwaitingVideoReviewArtifact({
  baseUrl,
  token,
  fighter,
  job,
  review,
  destination,
  reviewedCanonicalManifest = null,
  reviewedManifestRunId = '',
  reviewedManifestSha256 = '',
  requestAsset = apiAssetRequest,
}) {
  const definitions = [
    ['video', 'video', 'video.mp4', 'video/mp4'],
    ['contactSheet', 'contact-sheet', 'contact-sheet.png', 'image/png'],
    ['uniqueSheet', 'unique-sheet', 'unique-sheet.png', 'image/png'],
    ['runtime', 'runtime', 'runtime.png', 'image/png'],
    ['raw', 'raw', 'raw.png', 'image/png'],
    ['report', 'report', 'report.json', 'application/json'],
  ];
  mkdirSync(destination, { recursive: true });
  const exportedAssets = {};
  for (const [assetName, routeKind, filename, expectedContentType] of definitions) {
    const path = review.assets?.[assetName];
    const expectedPrefix = `/api/generation-jobs/${encodeURIComponent(job.id)}/video-review/assets/`;
    const expectedPath = `${expectedPrefix}${routeKind}?revision=${review.revision}`;
    if (path !== expectedPath) {
      throw new Error(`Video review ${assetName} asset path is not bound to job ${job.id}.`);
    }
    const result = await requestAsset(baseUrl, token, path);
    const digest = sha256(result.bytes);
    if (
      result.contentType !== expectedContentType
      || !/^[a-f0-9]{64}$/.test(result.etag)
      || result.etag !== digest
    ) {
      throw new Error(`Video review ${assetName} asset failed its MIME or ETag integrity binding.`);
    }
    writeFileSync(join(destination, filename), result.bytes, { mode: 0o600 });
    exportedAssets[assetName] = { filename, sha256: digest, contentType: result.contentType };
  }
  const descriptor = {
    schemaVersion: 1,
    fighter: fighter.slug,
    fighterId: job.fighterId,
    jobId: job.id,
    artifactRunId: job.artifactRunId,
    candidateId: review.candidateId,
    revision: review.revision,
    reportSha256: review.reportSha256,
    action: review.action,
    sequenceOrder: review.sequenceOrder,
    technicalOutcome: review.technicalOutcome,
    selectedVideoIndices: review.selectedVideoIndices,
    sourceFrameCount: review.sourceFrameCount,
    animationFormat: review.animationFormat,
    processingVersion: review.processingVersion,
    reviewedCanonicalSourceMode: reviewedCanonicalManifest?.canonicalSourceMode ?? null,
    reviewedCanonicalSourceHashes: reviewedCanonicalManifest?.canonicalSourceHashes ?? null,
    reviewedManifestRunId,
    reviewedManifestSha256,
    assets: exportedAssets,
  };
  writeFileSync(
    join(destination, 'review-descriptor.json'),
    `${JSON.stringify(descriptor, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(`  review-artifact: ${destination}`);
  return descriptor;
}

const POST_APPROVED_RECURATION_ASSETS = Object.freeze([
  ['runtime', 'runtime', 'runtime.png', 'image/png'],
  ['raw', 'raw', 'raw.png', 'image/png'],
  ['contactSheet', 'contact-sheet', 'contact-sheet.png', 'image/png'],
  ['uniqueSheet', 'unique-sheet', 'unique-sheet.png', 'image/png'],
  ['report', 'report', 'report.json', 'application/json'],
  ['video', 'video', 'video.mp4', 'video/mp4'],
]);

function exactSha256(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be an exact lowercase SHA-256.`);
  }
  return value;
}

function exactRecurationRevision(value, label) {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 10_000) {
    throw new Error(`${label} must be an exact integer from 1 to 10000.`);
  }
  return revision;
}

function assertPngBytes(bytes, label) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength <= PNG_SIGNATURE.byteLength
    || !bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) {
    throw new Error(`${label} is not a PNG.`);
  }
}

function assertMp4Bytes(bytes, label) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 12
    || bytes.subarray(4, 8).toString('ascii') !== 'ftyp') {
    throw new Error(`${label} is not an ISO BMFF/MP4 video.`);
  }
}

function assertJsonBytes(bytes, label) {
  try {
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
    return parsed;
  } catch {
    throw new Error(`${label} is not a JSON object.`);
  }
}

function exactCurrentChampionSprite(owned, action) {
  const matches = (Array.isArray(owned?.sprites) ? owned.sprites : []).filter(
    (sprite) => sprite?.animationName === action && sprite?.qualityTier === 'champion',
  );
  if (matches.length !== 1) {
    throw new Error(`Active global has ${matches.length} current Champion ${action} sprites; expected exactly one.`);
  }
  const sprite = matches[0];
  if (
    sprite.animationFormat !== VIDEO_DENSE_ANIMATION_FORMAT
    || !VIDEO_DENSE_PROCESSING_VERSIONS.has(sprite.processingVersion)
    || !Number.isInteger(sprite.frameCount) || sprite.frameCount < 2
    || !Number.isInteger(sprite.rawFrameCount) || sprite.rawFrameCount < 2
    || !/^[a-f0-9]{64}$/.test(sprite.contentHash ?? '')
    || !/^[a-f0-9]{64}$/.test(sprite.rawContentHash ?? '')
    || typeof sprite.url !== 'string' || !sprite.url
    || typeof sprite.rawUrl !== 'string' || !sprite.rawUrl
  ) {
    throw new Error(`Active global ${action} sprite is not a sealed ${VIDEO_DENSE_ANIMATION_FORMAT} Champion asset.`);
  }
  return sprite;
}

async function readExactActiveGlobal({ fighter, action, baseUrl, token, requestApi }) {
  const admin = await requestApi(baseUrl, token, '/api/admin/arcade');
  const entry = findCurrentArcadeEntry(Array.isArray(admin.fighters) ? admin.fighters : [], fighter.slug);
  if (
    !entry || entry.slug !== fighter.slug || entry.fighterName !== fighter.name
    || !/^[a-f0-9]{32}$/.test(entry.fighterId ?? '')
    || entry.qualityTier !== 'champion' || entry.status !== 'active' || entry.public !== true
  ) {
    throw new Error(`${fighter.name} is not the exact active public Champion global.`);
  }
  const detail = await requestApi(baseUrl, token, `/api/fighters/${encodeURIComponent(entry.fighterId)}`);
  const owned = detail.fighter;
  if (
    !owned || owned.id !== entry.fighterId || owned.name !== fighter.name
    || owned.qualityTier !== 'champion' || owned.public !== true
  ) {
    throw new Error(`${fighter.name} private owner view does not match the active global.`);
  }
  return { entry, owned, sprite: exactCurrentChampionSprite(owned, action) };
}

function assertApprovedRecurationSourceReview(review, job, binding) {
  const mismatches = [
    review?.jobId === job.id ? null : 'jobId',
    review?.artifactRunId === job.artifactRunId ? null : 'artifactRunId',
    review?.candidateId === binding.candidateId ? null : 'candidateId',
    review?.action === binding.action ? null : 'action',
    review?.status === 'approved' ? null : 'status',
    review?.revision === binding.revision ? null : 'revision',
    review?.reportSha256 === binding.reportSha256 ? null : 'reportSha256',
    ['technical_pass', 'needs_review'].includes(review?.technicalOutcome) ? null : 'technicalOutcome',
    review?.animationFormat === VIDEO_DENSE_ANIMATION_FORMAT ? null : 'animationFormat',
    VIDEO_DENSE_PROCESSING_VERSIONS.has(review?.processingVersion) ? null : 'processingVersion',
    Array.isArray(review?.selectedVideoIndices) ? null : 'selectedVideoIndices',
    Number.isInteger(review?.frameCount) && review.frameCount >= 2 ? null : 'frameCount',
    Number.isInteger(review?.rawFrameCount) && review.rawFrameCount >= 2 ? null : 'rawFrameCount',
  ].filter(Boolean);
  if (mismatches.length > 0) {
    throw new Error(`Post-approved recuration source crossed its sealed approval: ${mismatches.join(', ')}.`);
  }
  return review;
}

function assertPostApprovedRecurationProposal(proposal, binding) {
  if (!hasExactKeys(proposal, [
    'jobId', 'candidateId', 'action', 'fromRevision', 'fromReportSha256',
    'revision', 'reportSha256', 'processedSha256', 'processingVersion',
    'technicalOutcome', 'selectedVideoIndices', 'frameCount', 'rawFrameCount', 'assets',
  ])) {
    throw new Error('Post-approved recuration stage returned an unexpected proposal schema.');
  }
  const revision = exactRecurationRevision(proposal.revision, 'Proposal revision');
  const mismatches = [
    proposal.jobId === binding.jobId ? null : 'jobId',
    proposal.candidateId === binding.candidateId ? null : 'candidateId',
    proposal.action === binding.action ? null : 'action',
    proposal.fromRevision === binding.revision ? null : 'fromRevision',
    proposal.fromReportSha256 === binding.reportSha256 ? null : 'fromReportSha256',
    revision > binding.revision ? null : 'revision',
    /^[a-f0-9]{64}$/.test(proposal.reportSha256 ?? '') ? null : 'reportSha256',
    /^[a-f0-9]{64}$/.test(proposal.processedSha256 ?? '') ? null : 'processedSha256',
    proposal.processedSha256 !== binding.processedSha256 ? null : 'processedSha256Changed',
    proposal.processingVersion === VIDEO_DENSE_PROCESSING_VERSION ? null : 'processingVersion',
    ['technical_pass', 'needs_review'].includes(proposal.technicalOutcome) ? null : 'technicalOutcome',
    JSON.stringify(proposal.selectedVideoIndices) === JSON.stringify(binding.selectedVideoIndices)
      ? null : 'selectedVideoIndices',
    Number.isInteger(proposal.frameCount) && proposal.frameCount >= 2 ? null : 'frameCount',
    Number.isInteger(proposal.rawFrameCount) && proposal.rawFrameCount >= 2 ? null : 'rawFrameCount',
    hasExactKeys(proposal.assets, POST_APPROVED_RECURATION_ASSETS.map(([name]) => name))
      ? null : 'assets',
  ].filter(Boolean);
  if (mismatches.length > 0) {
    throw new Error(`Post-approved recuration proposal changed its exact binding: ${mismatches.join(', ')}.`);
  }
  return proposal;
}

function assertEmptyPrivateExportDestination(destination) {
  if (typeof destination !== 'string' || !destination.trim()) {
    throw new Error('Post-approved recuration stage requires a private export destination.');
  }
  const path = resolve(destination);
  if (existsSync(path) && readdirSync(path).length > 0) {
    throw new Error('Post-approved recuration export destination must be empty; existing evidence is never overwritten.');
  }
  return path;
}

async function exportPostApprovedRecurationProposal({
  baseUrl,
  token,
  fighter,
  job,
  sourceReview,
  sourceSprite,
  proposal,
  destination,
  expectedWorkerSha,
  requestAsset = apiAssetRequest,
}) {
  const privateDestination = assertEmptyPrivateExportDestination(destination);
  const fetched = await Promise.all(POST_APPROVED_RECURATION_ASSETS.map(async (
    [assetName, routeKind, filename, expectedContentType],
  ) => {
    const expectedPath = `/api/generation-jobs/${encodeURIComponent(job.id)}/video-review/assets/${routeKind}?revision=${proposal.revision}`;
    if (proposal.assets[assetName] !== expectedPath) {
      throw new Error(`Post-approved recuration ${assetName} path is not bound to staged revision ${proposal.revision}.`);
    }
    const result = await requestAsset(baseUrl, token, expectedPath);
    const digest = sha256(result.bytes);
    if (result.contentType !== expectedContentType || result.etag !== digest) {
      throw new Error(`Post-approved recuration ${assetName} failed MIME or immutable digest verification.`);
    }
    if (expectedContentType === 'image/png') assertPngBytes(result.bytes, assetName);
    if (expectedContentType === 'application/json') assertJsonBytes(result.bytes, assetName);
    if (expectedContentType === 'video/mp4') assertMp4Bytes(result.bytes, assetName);
    return {
      assetName,
      filename,
      result,
      metadata: {
        filename,
        sha256: digest,
        contentType: result.contentType,
        byteLength: result.bytes.byteLength,
      },
    };
  }));
  const assets = Object.fromEntries(fetched.map(({ assetName, metadata }) => [assetName, metadata]));
  if (assets.runtime.sha256 !== proposal.processedSha256) {
    throw new Error('Staged runtime bytes do not match proposal processedSha256.');
  }
  const reportJson = assertJsonBytes(
    fetched.find(({ assetName }) => assetName === 'report').result.bytes,
    'report',
  );
  if (
    reportJson.action !== proposal.action
    || reportJson.processingVersion !== proposal.processingVersion
    || reportJson.animationFormat !== VIDEO_DENSE_ANIMATION_FORMAT
    || reportJson.reportSha256 !== proposal.reportSha256
    || JSON.stringify(reportJson.extraction?.selectedVideoIndices)
      !== JSON.stringify(proposal.selectedVideoIndices)
    || reportJson.contract?.playbackFrameCount !== proposal.frameCount
    || reportJson.artifacts?.runtimeSheet?.sha256 !== proposal.processedSha256
    || reportJson.artifacts?.rawUniqueFramesSheet?.sha256 !== assets.raw.sha256
    || reportJson.artifacts?.rawUniqueFramesSheet?.frameCount !== proposal.rawFrameCount
    || reportJson.decision?.outcome !== proposal.technicalOutcome
  ) {
    throw new Error('Staged report JSON does not bind the proposed frames and emitted assets.');
  }
  const descriptor = assertPostApprovedRecurationDescriptor({
    schemaVersion: 1,
    kind: POST_APPROVED_RECURATION_DESCRIPTOR_KIND,
    target: 'production',
    expectedWorkerSha,
    fighter: { slug: fighter.slug, fighterId: job.fighterId },
    jobId: job.id,
    artifactRunId: job.artifactRunId,
    candidateId: proposal.candidateId,
    action: proposal.action,
    from: {
      revision: sourceReview.revision,
      reportSha256: sourceReview.reportSha256,
      processedSha256: sourceSprite.contentHash,
      rawSha256: sourceSprite.rawContentHash,
      processingVersion: sourceSprite.processingVersion,
      technicalOutcome: sourceReview.technicalOutcome,
      selectedVideoIndices: sourceReview.selectedVideoIndices,
      frameCount: sourceSprite.frameCount,
      rawFrameCount: sourceSprite.rawFrameCount,
    },
    to: {
      revision: proposal.revision,
      reportSha256: proposal.reportSha256,
      processedSha256: proposal.processedSha256,
      rawSha256: assets.raw.sha256,
      processingVersion: proposal.processingVersion,
      technicalOutcome: proposal.technicalOutcome,
      selectedVideoIndices: proposal.selectedVideoIndices,
      frameCount: proposal.frameCount,
      rawFrameCount: proposal.rawFrameCount,
    },
    assets,
  });
  const descriptorBytes = Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`);
  const descriptorSha256 = sha256(descriptorBytes);
  mkdirSync(privateDestination, { recursive: true, mode: 0o700 });
  chmodSync(privateDestination, 0o700);
  for (const { filename, result } of fetched) {
    writeFileSync(join(privateDestination, filename), result.bytes, { mode: 0o600 });
  }
  const descriptorPath = join(privateDestination, 'recuration-descriptor.json');
  writeFileSync(descriptorPath, descriptorBytes, { mode: 0o600 });
  writeFileSync(
    join(privateDestination, 'recuration-descriptor.sha256'),
    `${descriptorSha256}  recuration-descriptor.json\n`,
    { mode: 0o600 },
  );
  console.log(`  post-approved-recuration-artifact: ${privateDestination}`);
  console.log(`  sealed-descriptor-sha256: ${descriptorSha256}`);
  return { descriptor, descriptorPath, descriptorSha256 };
}

function assertRecurationSide(value, label) {
  if (!hasExactKeys(value, [
    'revision', 'reportSha256', 'processedSha256', 'rawSha256', 'processingVersion',
    'technicalOutcome', 'selectedVideoIndices', 'frameCount', 'rawFrameCount',
  ])) {
    throw new Error(`Recuration descriptor ${label} binding has an unexpected schema.`);
  }
  exactRecurationRevision(value.revision, `${label} revision`);
  exactSha256(value.reportSha256, `${label} reportSha256`);
  exactSha256(value.processedSha256, `${label} processedSha256`);
  exactSha256(value.rawSha256, `${label} rawSha256`);
  exactSelectedVideoIndices(value.selectedVideoIndices, `${label} selectedVideoIndices`);
  if (
    !VIDEO_DENSE_PROCESSING_VERSIONS.has(value.processingVersion)
    || !['technical_pass', 'needs_review'].includes(value.technicalOutcome)
    || !Number.isInteger(value.frameCount) || value.frameCount < 2
    || !Number.isInteger(value.rawFrameCount) || value.rawFrameCount < 2
  ) {
    throw new Error(`Recuration descriptor ${label} metadata is invalid.`);
  }
}

export function assertPostApprovedRecurationDescriptor(value, expected = {}) {
  if (!hasExactKeys(value, [
    'schemaVersion', 'kind', 'target', 'expectedWorkerSha', 'fighter', 'jobId',
    'artifactRunId', 'candidateId', 'action', 'from', 'to', 'assets',
  ])) {
    throw new Error('Post-approved recuration descriptor has an unexpected schema.');
  }
  if (
    value.schemaVersion !== 1 || value.kind !== POST_APPROVED_RECURATION_DESCRIPTOR_KIND
    || value.target !== 'production' || !/^[a-f0-9]{40}$/.test(value.expectedWorkerSha ?? '')
    || !hasExactKeys(value.fighter, ['slug', 'fighterId'])
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.fighter.slug ?? '')
    || !/^[a-f0-9]{32}$/.test(value.fighter.fighterId ?? '')
    || !/^[a-f0-9]{32}$/.test(value.jobId ?? '')
    || !/^[a-f0-9]{32}$/.test(value.artifactRunId ?? '')
    || !/^[a-f0-9]{32}$/.test(value.candidateId ?? '')
    || !REVIEW_GATED_VIDEO_ACTION_SET.has(value.action)
    || !hasExactKeys(value.assets, POST_APPROVED_RECURATION_ASSETS.map(([name]) => name))
  ) {
    throw new Error('Post-approved recuration descriptor identity is invalid.');
  }
  assertRecurationSide(value.from, 'from');
  assertRecurationSide(value.to, 'to');
  if (
    value.to.revision <= value.from.revision
    || value.to.reportSha256 === value.from.reportSha256
    || value.to.processedSha256 === value.from.processedSha256
  ) {
    throw new Error('Post-approved recuration descriptor does not describe a new immutable revision.');
  }
  for (const [assetName, _routeKind, filename, contentType] of POST_APPROVED_RECURATION_ASSETS) {
    const asset = value.assets[assetName];
    if (
      !hasExactKeys(asset, ['filename', 'sha256', 'contentType', 'byteLength'])
      || asset.filename !== filename || asset.contentType !== contentType
      || !/^[a-f0-9]{64}$/.test(asset.sha256 ?? '')
      || !Number.isSafeInteger(asset.byteLength) || asset.byteLength < 1
    ) {
      throw new Error(`Post-approved recuration descriptor ${assetName} evidence is invalid.`);
    }
  }
  if (
    value.assets.runtime.sha256 !== value.to.processedSha256
    || value.assets.raw.sha256 !== value.to.rawSha256
  ) {
    throw new Error('Post-approved recuration descriptor assets do not seal the target revision.');
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    const actualValue = key === 'slug' ? value.fighter.slug
      : key === 'fighterId' ? value.fighter.fighterId
        : value[key];
    if (expectedValue !== undefined && actualValue !== expectedValue) {
      throw new Error(`Post-approved recuration descriptor ${key} does not match the requested operation.`);
    }
  }
  return value;
}

export function readSealedPostApprovedRecurationDescriptor(path, expectedSha256, expected = {}) {
  exactSha256(expectedSha256, 'Recuration descriptor SHA-256');
  if (typeof path !== 'string' || !path.trim()) {
    throw new Error('Promote/rollback requires --recuration-descriptor.');
  }
  const bytes = readFileSync(resolve(path));
  if (sha256(bytes) !== expectedSha256) {
    throw new Error('Recuration descriptor bytes do not match --recuration-descriptor-sha256.');
  }
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Recuration descriptor is not valid JSON.');
  }
  const descriptor = assertPostApprovedRecurationDescriptor(value, expected);
  const evidenceDirectory = dirname(resolve(path));
  const evidenceBytes = {};
  for (const [assetName, _routeKind, filename, contentType] of POST_APPROVED_RECURATION_ASSETS) {
    const bytes = readFileSync(join(evidenceDirectory, filename));
    const sealed = descriptor.assets[assetName];
    if (bytes.byteLength !== sealed.byteLength || sha256(bytes) !== sealed.sha256) {
      throw new Error(`Recuration descriptor ${assetName} evidence no longer matches its sealed bytes.`);
    }
    if (contentType === 'image/png') assertPngBytes(bytes, `${assetName} evidence`);
    if (contentType === 'application/json') assertJsonBytes(bytes, `${assetName} evidence`);
    if (contentType === 'video/mp4') assertMp4Bytes(bytes, `${assetName} evidence`);
    evidenceBytes[assetName] = bytes;
  }
  const report = assertJsonBytes(evidenceBytes.report, 'report evidence');
  if (
    report.action !== descriptor.action
    || report.processingVersion !== descriptor.to.processingVersion
    || report.animationFormat !== VIDEO_DENSE_ANIMATION_FORMAT
    || report.reportSha256 !== descriptor.to.reportSha256
    || JSON.stringify(report.extraction?.selectedVideoIndices)
      !== JSON.stringify(descriptor.to.selectedVideoIndices)
    || report.contract?.playbackFrameCount !== descriptor.to.frameCount
    || report.artifacts?.runtimeSheet?.sha256 !== descriptor.to.processedSha256
    || report.artifacts?.rawUniqueFramesSheet?.sha256 !== descriptor.to.rawSha256
    || report.artifacts?.rawUniqueFramesSheet?.frameCount !== descriptor.to.rawFrameCount
    || report.decision?.outcome !== descriptor.to.technicalOutcome
  ) {
    throw new Error('Recuration descriptor report evidence no longer binds the staged target.');
  }
  return descriptor;
}

export async function stagePostApprovedVideoRecuration({
  fighter,
  action,
  baseUrl,
  token,
  jobId,
  candidateId,
  revision,
  reportSha256,
  selectedVideoIndices,
  destination,
  expectedWorkerSha,
  requestApi = apiRequest,
  requestAsset = apiAssetRequest,
}) {
  assertReviewedProductionApiOrigin(baseUrl);
  exactVideoJobId(jobId, 'Post-approved recuration jobId');
  exactVideoJobId(candidateId, 'Post-approved recuration candidateId');
  const exactRevision = exactRecurationRevision(revision, 'Post-approved recuration revision');
  exactSha256(reportSha256, 'Post-approved recuration reportSha256');
  const requestedIndices = exactSelectedVideoIndices(
    selectedVideoIndices,
    'Post-approved recuration selected indices',
  );
  if (!REVIEW_GATED_VIDEO_ACTION_SET.has(action)) throw new Error(`Unknown recuration action: ${action}`);
  if (!/^[a-f0-9]{40}$/.test(expectedWorkerSha ?? '')) {
    throw new Error('Post-approved recuration requires the exact deployed Worker SHA.');
  }
  assertEmptyPrivateExportDestination(destination);
  const { entry, sprite } = await readExactActiveGlobal({
    fighter, action, baseUrl, token, requestApi,
  });
  const jobBody = await requestApi(baseUrl, token, `/api/generation-jobs/${encodeURIComponent(jobId)}`);
  const job = assertReviewGatedVideoJob(jobBody.job, entry.fighterId, null, {
    allowFullRunRestartRequired: true,
  });
  if (job.id !== jobId) throw new Error('Post-approved recuration job identity changed before stage.');
  const reviewPath = `/api/generation-jobs/${encodeURIComponent(jobId)}/video-review`;
  const reviewBody = await requestApi(baseUrl, token, reviewPath);
  const review = assertApprovedRecurationSourceReview(reviewBody.review, job, {
    candidateId, action, revision: exactRevision, reportSha256,
  });
  if (
    review.processingVersion !== sprite.processingVersion
    || review.frameCount !== sprite.frameCount
    || review.rawFrameCount !== sprite.rawFrameCount
  ) {
    throw new Error('Post-approved recuration source review does not match the active sprite metadata.');
  }
  if (JSON.stringify(requestedIndices) === JSON.stringify(review.selectedVideoIndices)) {
    throw new Error('Post-approved recuration requires a deliberately different exact frame selection.');
  }
  const result = await requestApi(baseUrl, token, `${reviewPath}/recuration/stage`, {
    method: 'POST',
    body: JSON.stringify({
      candidateId,
      revision: exactRevision,
      reportSha256,
      selectedVideoIndices: requestedIndices,
    }),
    requestTimeoutMs: VIDEO_REVIEW_ADJUST_TIMEOUT_MS,
  });
  const proposal = assertPostApprovedRecurationProposal(result.proposal, {
    jobId,
    candidateId,
    action,
    revision: exactRevision,
    reportSha256,
    processedSha256: sprite.contentHash,
    selectedVideoIndices: requestedIndices,
  });
  const exported = await exportPostApprovedRecurationProposal({
    baseUrl,
    token,
    fighter,
    job,
    sourceReview: review,
    sourceSprite: sprite,
    proposal,
    destination,
    expectedWorkerSha,
    requestAsset,
  });
  console.log(`  post-approved-recuration-stage: ${JSON.stringify({
    fighter: fighter.slug,
    action,
    jobId,
    candidateId,
    fromRevision: exactRevision,
    toRevision: proposal.revision,
    reportSha256: proposal.reportSha256,
    processedSha256: proposal.processedSha256,
    technicalOutcome: proposal.technicalOutcome,
    providerCalls: 0,
  })}`);
  return { job, review, proposal, ...exported };
}

export async function publicArcadeSmokeRequest(baseUrl, path, request = fetch) {
  assertReviewedProductionApiOrigin(baseUrl);
  if (typeof path !== 'string' || !path.startsWith('/api/arcade?recurationSmoke=')) {
    throw new Error('Public recuration smoke attempted an untrusted API path.');
  }
  const response = await request(`${baseUrl}${path}`, {
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { 'Cache-Control': 'no-cache' },
  });
  if (!response?.ok) throw new Error(`Public Arcade recuration smoke failed with HTTP ${response?.status ?? 'unknown'}.`);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Public Arcade recuration smoke returned non-JSON.');
  }
}

export async function recurationSpriteAssetRequest({
  baseUrl,
  token,
  url,
  publicAsset,
  request = fetch,
}) {
  const base = new URL(assertReviewedProductionApiOrigin(baseUrl));
  const assetUrl = new URL(url);
  const expectedPrefix = publicAsset ? '/public-assets/' : '/assets/';
  if (
    assetUrl.origin !== base.origin || assetUrl.username || assetUrl.password
    || assetUrl.search || assetUrl.hash || !assetUrl.pathname.startsWith(expectedPrefix)
  ) {
    throw new Error(`Recuration smoke attempted an untrusted ${publicAsset ? 'public' : 'private'} asset URL.`);
  }
  const headers = publicAsset ? {} : {
    ...arcadeAdminAuthHeaders(await token(), clerkBackendAuthBridgeSecret),
    ...(expectedDeployedSha
      ? { 'X-Insert-Player-Expected-Worker-Sha': expectedDeployedSha }
      : {}),
  };
  const response = await request(assetUrl.toString(), {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response?.ok) throw new Error(`Recuration asset smoke failed with HTTP ${response?.status ?? 'unknown'}.`);
  const declaredLength = Number(response.headers.get('Content-Length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REVIEWED_VIDEO_ASSET_BYTES) {
    throw new Error('Recuration smoke asset exceeds the reviewed asset limit.');
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_REVIEWED_VIDEO_ASSET_BYTES) {
    throw new Error('Recuration smoke asset exceeds the reviewed asset limit.');
  }
  return {
    bytes,
    contentType: response.headers.get('Content-Type')?.split(';', 1)[0]?.trim() ?? '',
  };
}

function assertSmokeSprite(fighter, action, binding, label) {
  const matches = (Array.isArray(fighter?.sprites) ? fighter.sprites : []).filter(
    (sprite) => sprite?.animationName === action && sprite?.qualityTier === 'champion',
  );
  const sprite = matches[0];
  if (
    matches.length !== 1 || sprite.contentHash !== binding.processedSha256
    || sprite.processingVersion !== binding.processingVersion
    || sprite.frameCount !== binding.frameCount
    || sprite.animationFormat !== VIDEO_DENSE_ANIMATION_FORMAT
    || typeof sprite.url !== 'string' || !sprite.url
  ) {
    throw new Error(`${label} smoke did not expose the exact promoted ${action} runtime.`);
  }
  return sprite;
}

export async function verifyPostApprovedRecurationSmoke({
  baseUrl,
  token,
  descriptor,
  targetBinding,
  requestApi = apiRequest,
  requestPublicApi = publicArcadeSmokeRequest,
  requestSpriteAsset = recurationSpriteAssetRequest,
}) {
  const privateBody = await requestApi(
    baseUrl,
    token,
    `/api/fighters/${encodeURIComponent(descriptor.fighter.fighterId)}`,
  );
  if (
    privateBody.fighter?.id !== descriptor.fighter.fighterId
    || privateBody.fighter?.public !== true
    || privateBody.fighter?.qualityTier !== 'champion'
  ) {
    throw new Error('Private recuration smoke crossed the active global identity.');
  }
  const privateSprite = assertSmokeSprite(
    privateBody.fighter, descriptor.action, targetBinding, 'Private',
  );
  if (
    privateSprite.rawContentHash !== targetBinding.rawSha256
    || typeof privateSprite.rawUrl !== 'string' || !privateSprite.rawUrl
  ) {
    throw new Error('Private recuration smoke did not expose the exact promoted HQ asset.');
  }
  const publicBody = await requestPublicApi(
    baseUrl,
    `/api/arcade?recurationSmoke=${targetBinding.processedSha256}`,
  );
  const publicMatches = (Array.isArray(publicBody.fighters) ? publicBody.fighters : []).filter(
    (entry) => entry?.id === descriptor.fighter.fighterId
      && entry?.arcade?.slug === descriptor.fighter.slug,
  );
  if (publicMatches.length !== 1 || publicMatches[0].public !== true) {
    throw new Error('Public recuration smoke did not return the exact active global.');
  }
  const publicSprite = assertSmokeSprite(
    publicMatches[0], descriptor.action, targetBinding, 'Public',
  );
  if (typeof publicSprite.hqUrl !== 'string' || !publicSprite.hqUrl) {
    throw new Error('Public recuration smoke did not expose the promoted HQ gameplay derivative.');
  }
  const [privateRuntime, privateRaw, publicRuntime, publicRaw] = await Promise.all([
    requestSpriteAsset({ baseUrl, token, url: privateSprite.url, publicAsset: false }),
    requestSpriteAsset({ baseUrl, token, url: privateSprite.rawUrl, publicAsset: false }),
    requestSpriteAsset({ baseUrl, token, url: publicSprite.url, publicAsset: true }),
    requestSpriteAsset({ baseUrl, token, url: publicSprite.hqUrl, publicAsset: true }),
  ]);
  for (const [label, result, expectedSha256] of [
    ['private runtime', privateRuntime, targetBinding.processedSha256],
    ['private raw', privateRaw, targetBinding.rawSha256],
    ['public runtime', publicRuntime, targetBinding.processedSha256],
    ['public HQ', publicRaw, targetBinding.rawSha256],
  ]) {
    if (result.contentType !== 'image/png') throw new Error(`${label} smoke returned the wrong MIME type.`);
    assertPngBytes(result.bytes, `${label} smoke`);
    if (sha256(result.bytes) !== expectedSha256) {
      throw new Error(`${label} smoke bytes do not match the exact promoted digest.`);
    }
  }
  return {
    privateCurrentVerified: true,
    publicCurrentVerified: true,
    processedSha256: targetBinding.processedSha256,
    rawSha256: targetBinding.rawSha256,
  };
}

export async function purgePostApprovedRecurationCache(context, purge = null) {
  if (purge == null) {
    return { configured: false, purged: false, reason: 'no-cache-purge-integration' };
  }
  if (typeof purge !== 'function') throw new Error('Recuration cache purge integration must be a function.');
  const result = await purge(Object.freeze({ ...context }));
  if (result !== true && result?.purged !== true) {
    throw new Error('Configured recuration cache purge did not prove success.');
  }
  return { configured: true, purged: true };
}

function assertPromotedRecurationReview(review, descriptor, targetBinding) {
  const mismatches = [
    review?.jobId === descriptor.jobId ? null : 'jobId',
    review?.artifactRunId === descriptor.artifactRunId ? null : 'artifactRunId',
    review?.candidateId === descriptor.candidateId ? null : 'candidateId',
    review?.action === descriptor.action ? null : 'action',
    review?.status === 'approved' ? null : 'status',
    review?.revision === targetBinding.revision ? null : 'revision',
    review?.reportSha256 === targetBinding.reportSha256 ? null : 'reportSha256',
    review?.technicalOutcome === targetBinding.technicalOutcome ? null : 'technicalOutcome',
    review?.animationFormat === VIDEO_DENSE_ANIMATION_FORMAT ? null : 'animationFormat',
    review?.processingVersion === targetBinding.processingVersion ? null : 'processingVersion',
    review?.frameCount === targetBinding.frameCount ? null : 'frameCount',
    review?.rawFrameCount === targetBinding.rawFrameCount ? null : 'rawFrameCount',
    JSON.stringify(review?.selectedVideoIndices) === JSON.stringify(targetBinding.selectedVideoIndices)
      ? null : 'selectedVideoIndices',
  ].filter(Boolean);
  if (mismatches.length > 0) {
    throw new Error(`Post-approved recuration promote response changed its sealed target: ${mismatches.join(', ')}.`);
  }
  return review;
}

export async function promotePostApprovedVideoRecuration({
  operation,
  fighter,
  action,
  descriptor,
  baseUrl,
  token,
  acceptNeedsReview = false,
  requestApi = apiRequest,
  requestPublicApi = publicArcadeSmokeRequest,
  requestSpriteAsset = recurationSpriteAssetRequest,
  purgeCache = null,
}) {
  assertReviewedProductionApiOrigin(baseUrl);
  if (!['promote', 'rollback'].includes(operation)) {
    throw new Error('Post-approved recuration mutation must be promote or rollback.');
  }
  assertPostApprovedRecurationDescriptor(descriptor, { slug: fighter.slug, action });
  const currentBinding = operation === 'promote' ? descriptor.from : descriptor.to;
  const targetBinding = operation === 'promote' ? descriptor.to : descriptor.from;
  if (targetBinding.technicalOutcome === 'needs_review' && acceptNeedsReview !== true) {
    throw new Error(`${operation} of a needs_review revision requires --accept-needs-review.`);
  }
  const { entry, sprite } = await readExactActiveGlobal({
    fighter, action, baseUrl, token, requestApi,
  });
  if (
    entry.fighterId !== descriptor.fighter.fighterId
    || sprite.contentHash !== currentBinding.processedSha256
    || sprite.rawContentHash !== currentBinding.rawSha256
    || sprite.processingVersion !== currentBinding.processingVersion
    || sprite.frameCount !== currentBinding.frameCount
    || sprite.rawFrameCount !== currentBinding.rawFrameCount
  ) {
    throw new Error(`Post-approved recuration ${operation} current pointer does not match the descriptor source.`);
  }
  const jobBody = await requestApi(
    baseUrl, token, `/api/generation-jobs/${encodeURIComponent(descriptor.jobId)}`,
  );
  const job = assertReviewGatedVideoJob(jobBody.job, entry.fighterId, null, {
    allowFullRunRestartRequired: true,
  });
  if (job.id !== descriptor.jobId || job.artifactRunId !== descriptor.artifactRunId) {
    throw new Error(`Post-approved recuration ${operation} crossed its sealed job lineage.`);
  }
  const reviewPath = `/api/generation-jobs/${encodeURIComponent(descriptor.jobId)}/video-review`;
  const currentReviewBody = await requestApi(baseUrl, token, reviewPath);
  assertApprovedRecurationSourceReview(currentReviewBody.review, job, {
    candidateId: descriptor.candidateId,
    action,
    revision: currentBinding.revision,
    reportSha256: currentBinding.reportSha256,
  });
  const body = {
    candidateId: descriptor.candidateId,
    fromRevision: currentBinding.revision,
    fromReportSha256: currentBinding.reportSha256,
    fromProcessedSha256: currentBinding.processedSha256,
    toRevision: targetBinding.revision,
    toReportSha256: targetBinding.reportSha256,
    toProcessedSha256: targetBinding.processedSha256,
    ...(targetBinding.technicalOutcome === 'needs_review' ? { acceptNeedsReview: true } : {}),
  };
  const result = await requestApi(baseUrl, token, `${reviewPath}/recuration/promote`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const review = assertPromotedRecurationReview(result.review, descriptor, targetBinding);
  const cache = await purgePostApprovedRecurationCache({
    operation,
    fighterId: descriptor.fighter.fighterId,
    slug: descriptor.fighter.slug,
    action,
    processedSha256: targetBinding.processedSha256,
  }, purgeCache);
  const smoke = await verifyPostApprovedRecurationSmoke({
    baseUrl,
    token,
    descriptor,
    targetBinding,
    requestApi,
    requestPublicApi,
    requestSpriteAsset,
  });
  console.log(`  post-approved-recuration-${operation}: ${JSON.stringify({
    fighter: fighter.slug,
    action,
    jobId: descriptor.jobId,
    candidateId: descriptor.candidateId,
    fromRevision: currentBinding.revision,
    toRevision: targetBinding.revision,
    reportSha256: targetBinding.reportSha256,
    processedSha256: targetBinding.processedSha256,
    publicCurrentVerified: smoke.publicCurrentVerified,
    privateCurrentVerified: smoke.privateCurrentVerified,
    cachePurgeConfigured: cache.configured,
    providerCalls: 0,
  })}`);
  return { operation, review, body, cache, smoke };
}

async function waitForAwaitingVideoReview({
  baseUrl,
  token,
  fighter,
  fighterId,
  initialJob,
  requestApi,
  pause,
  pollIntervalMs,
  jobTimeoutMs,
  reviewedCanonicalManifest,
}) {
  const startedAt = Date.now();
  let job = initialJob;
  let lastStage = '';
  while (Date.now() - startedAt < jobTimeoutMs) {
    assertReviewGatedVideoJob(job, fighterId, reviewedCanonicalManifest);
    const stage = `${job.status}:${job.reviewStatus ?? 'none'}:${job.stage}:${job.progressCurrent}/${job.progressTotal}`;
    if (stage !== lastStage) {
      console.log(`  ${fighter.name}: ${stage}`);
      lastStage = stage;
    }
    if (job.status === 'succeeded' && job.reviewStatus === 'awaiting_review') return job;
    if (job.status === 'failed' || job.status === 'cancelled') {
      throw new Error(
        `${fighter.name} Video generation ${job.status}: ${job.errorMessage ?? job.errorCode ?? 'unknown error'}; no restart was attempted.`,
      );
    }
    if (job.status === 'succeeded') {
      throw new Error(
        `${fighter.name} Video generation succeeded without entering awaiting_review (${String(job.reviewStatus)}).`,
      );
    }
    if (job.status !== 'queued' && job.status !== 'running') {
      throw new Error(`${fighter.name} Video generation returned unsupported status ${String(job.status)}.`);
    }
    await pause(pollIntervalMs);
    const refreshed = await requestApi(
      baseUrl,
      token,
      `/api/generation-jobs/${encodeURIComponent(job.id)}`,
    );
    job = refreshed.job;
  }
  throw new Error(`${fighter.name} Video generation exceeded the two-hour safety timeout.`);
}

export async function runReviewGatedVideoStep({
  manifest,
  fighter,
  approvedPhotoHash,
  baseUrl,
  token,
  requestApi = apiRequest,
  pause = sleep,
  pollIntervalMs = POLL_INTERVAL_MS,
  jobTimeoutMs = JOB_TIMEOUT_MS,
  reviewedCanonicalManifest = null,
  resumeFromJobId = '',
  restartFromJobId = '',
  reviewArtifactDir = '',
  requestAsset = apiAssetRequest,
  reviewedManifestRunId = '',
  reviewedManifestSha256 = '',
  expectedWorkerSha = expectedDeployedSha,
}) {
  if ((resumeFromJobId || restartFromJobId) && !reviewedCanonicalManifest) {
    throw new Error('Video recovery requires the exact separately reviewed canonical manifest.');
  }
  const admin = await requestApi(baseUrl, token, '/api/admin/arcade');
  const entry = findCurrentArcadeEntry(Array.isArray(admin.fighters) ? admin.fighters : [], fighter.slug);
  if (!entry) throw new Error(`No current Arcade fighter exists for ${fighter.slug}.`);
  const detail = await requestApi(
    baseUrl,
    token,
    `/api/fighters/${encodeURIComponent(entry.fighterId)}`,
  );
  const { fighterId } = assertReviewGatedVideoDraft({
    manifest,
    fighter,
    entry,
    owned: detail.fighter,
    approvedPhotoHash,
  });
  if (reviewedCanonicalManifest) {
    assertReviewedCanonicalManifest(reviewedCanonicalManifest, {
      slug: fighter.slug,
      fighterId,
      photoHash: approvedPhotoHash,
    });
  }
  const listed = await requestApi(
    baseUrl,
    token,
    `/api/generation-jobs?fighterId=${encodeURIComponent(fighterId)}`,
  );
  if (!Array.isArray(listed.jobs)) {
    throw new Error('Generation job listing is unavailable; no Video generation was started.');
  }
  const plan = planReviewGatedVideoStep(listed.jobs, fighterId, {
    resumeFromJobId,
    restartFromJobId,
  });
  if (plan.job && reviewedCanonicalManifest) {
    const exactUnsealedLegacyRestartRoot = plan.action === 'restart-full'
      && ['failed', 'cancelled'].includes(plan.job.status)
      && plan.job.reviewStatus === 'none'
      && plan.job.fullRunRestartRequired === true
      && plan.job.resumable === false
      && plan.job.artifactRunId === plan.job.id
      && plan.job.canonicalSourceMode == null
      && plan.job.canonicalSourceHashes == null
      && plan.job.preservedArtifactCount === 0
      && Array.isArray(plan.job.completedStages)
      && plan.job.completedStages.length === 0;
    assertReviewGatedVideoJob(
      plan.job,
      fighterId,
      exactUnsealedLegacyRestartRoot ? null : reviewedCanonicalManifest,
      {
        allowFullRunRestartRequired: plan.action === 'restart-full',
      },
    );
  }

  if (plan.action === 'complete') {
    console.log(`  complete: ${fighter.slug} has no pending Video stages; no mutation was performed`);
    return { mode: 'complete', mutated: false, job: plan.job, review: null };
  }

  let job = plan.job;
  let mode = plan.action;
  if (
    plan.action === 'start' || plan.action === 'continue'
    || plan.action === 'resume-failed' || plan.action === 'restart-full'
  ) {
    const started = await requestApi(
      baseUrl,
      token,
      `/api/admin/arcade/${encodeURIComponent(fighterId)}/generate`,
      {
        method: 'POST',
        body: JSON.stringify({
          legal: generationLegal(manifest),
          creationFlow: 'video',
          ...(plan.action === 'restart-full' ? { restart: true } : {}),
          ...(plan.job ? { recoveryFromJobId: plan.job.id } : {}),
          ...(reviewedCanonicalManifest ? {
            canonicalSourceMode: reviewedCanonicalManifest.canonicalSourceMode,
            canonicalSourceHashes: reviewedCanonicalManifest.canonicalSourceHashes,
          } : {}),
        }),
      },
    );
    if (started.ready === true || !started.job) {
      throw new Error(
        `${fighter.name} Video endpoint returned no review-gated job; no fallback or restart was attempted.`,
      );
    }
    job = assertReviewGatedVideoJob(started.job, fighterId, reviewedCanonicalManifest);
    if (plan.action === 'resume-failed' && (
      job.id === plan.job.id
      || job.artifactRunId !== plan.job.artifactRunId
      || job.resumedFromJobId !== plan.job.id
    )) {
      throw new Error('Video failed-run recovery did not return the exact same-run continuation.');
    }
    if (plan.action === 'restart-full' && (
      job.id === plan.job.id
      || job.artifactRunId !== job.id
      || job.artifactRunId === plan.job.artifactRunId
      || job.resumedFromJobId != null
    )) {
      throw new Error('Video full restart did not return a fresh sealed root run.');
    }
    mode = plan.action === 'continue'
      ? 'continued'
      : plan.action === 'resume-failed'
        ? 'resumed-failed'
        : plan.action === 'restart-full'
          ? 'restarted-full'
          : 'started';
  } else if (plan.action === 'poll') {
    mode = 'resumed-poll';
  } else {
    mode = 'reused-review';
  }

  console.log(`  video-job: ${JSON.stringify({
    fighter: fighter.slug,
    mode,
    jobId: job.id,
    artifactRunId: job.artifactRunId,
    resumedFromJobId: job.resumedFromJobId ?? null,
  })}`);
  writeVideoJobRecoveryDescriptor({
    destination: reviewArtifactDir,
    fighter,
    mode,
    operation: plan.action,
    job,
    reviewedCanonicalManifest,
    reviewedManifestRunId,
    reviewedManifestSha256,
    expectedWorkerSha,
  });

  if (plan.action !== 'reuse-review') {
    job = await waitForAwaitingVideoReview({
      baseUrl,
      token,
      fighter,
      fighterId,
      initialJob: job,
      requestApi,
      pause,
      pollIntervalMs,
      jobTimeoutMs,
      reviewedCanonicalManifest,
    });
  }
  assertReviewGatedVideoJob(job, fighterId, reviewedCanonicalManifest);
  const reviewBody = await requestApi(
    baseUrl,
    token,
    `/api/generation-jobs/${encodeURIComponent(job.id)}/video-review`,
  );
  const review = assertAwaitingVideoReview(reviewBody.review, job);
  printAwaitingVideoReview(fighter, review, mode);
  if (reviewArtifactDir) {
    await exportAwaitingVideoReviewArtifact({
      baseUrl,
      token,
      fighter,
      job,
      review,
      destination: reviewArtifactDir,
      reviewedCanonicalManifest,
      reviewedManifestRunId,
      reviewedManifestSha256,
      requestAsset,
    });
  }
  return {
    mode,
    mutated: ['start', 'continue', 'resume-failed', 'restart-full'].includes(plan.action),
    job,
    review,
  };
}

function checkpointState(state, manifest, fighter, fighterId, photoHash, status, progress = {}) {
  state.targets[target] ??= {};
  const previous = state.targets[target][fighter.slug] ?? {};
  state.targets[target][fighter.slug] = {
    ...previous,
    fighterId,
    photoHash,
    status,
    manifestVersion: manifest.version,
    ...progress,
    updatedAt: new Date().toISOString(),
  };
  writeState(state);
}

async function uploadOriginalSource(baseUrl, token, fighterId, fighter, sourceBytes) {
  const form = new FormData();
  form.set('kind', 'original');
  form.set('file', new Blob([sourceBytes], { type: 'image/png' }), `${fighter.slug}.png`);
  await apiRequest(baseUrl, token, `/api/fighters/${fighterId}/sources`, {
    method: 'POST',
    body: form,
  });
}

async function loadOwnedFighter(baseUrl, token, fighterId, fighter) {
  const detail = await apiRequest(baseUrl, token, `/api/fighters/${fighterId}`);
  if (!detail.fighter || detail.fighter.id !== fighterId) {
    throw new Error(`${fighter.name} private asset manifest is unavailable.`);
  }
  return detail.fighter;
}

async function generateSource({
  manifest,
  fighter,
  baseUrl,
  token,
  fighterId,
  name,
  restart = false,
  canary = false,
  probe = false,
}) {
  console.log(`  source:${name}`);
  const generation = await apiRequest(
    baseUrl,
    token,
    `/api/admin/arcade/${fighterId}/generate/source/${encodeURIComponent(name)}`,
    {
      method: 'POST',
      body: JSON.stringify({
        legal: generationLegal(manifest),
        ...(restart ? { restart: true } : {}),
        ...(canary ? { canary: true } : {}),
        ...(probe ? { probe: true } : {}),
      }),
    },
  );
  if (!generation.job?.id) throw new Error(`${fighter.name} source generation returned no job.`);
  await waitForJob(baseUrl, token, fighter, generation.job.id);
}

async function generateAnimation({ manifest, fighter, baseUrl, token, fighterId, name }) {
  console.log(`  animation:${name}`);
  const generation = await apiRequest(
    baseUrl,
    token,
    `/api/admin/arcade/${fighterId}/generate/${encodeURIComponent(name)}`,
    {
      method: 'POST',
      body: JSON.stringify({ legal: generationLegal(manifest) }),
    },
  );
  if (!generation.job?.id) throw new Error(`${fighter.name} animation generation returned no job.`);
  await waitForJob(baseUrl, token, fighter, generation.job.id);
}

async function waitForJob(baseUrl, token, fighter, jobId) {
  const startedAt = Date.now();
  let lastStage = '';
  while (Date.now() - startedAt < JOB_TIMEOUT_MS) {
    const body = await apiRequest(baseUrl, token, `/api/generation-jobs/${encodeURIComponent(jobId)}`);
    const job = body.job;
    if (!job) throw new Error(`Generation job ${jobId} disappeared.`);
    const stage = `${job.status}:${job.stage}:${job.progressCurrent}/${job.progressTotal}`;
    if (stage !== lastStage) {
      console.log(`  ${fighter.name}: ${stage}`);
      lastStage = stage;
    }
    if (job.status === 'succeeded') return job;
    if (job.status === 'failed' || job.status === 'cancelled') {
      throw new Error(`${fighter.name} generation ${job.status}: ${job.errorMessage ?? job.errorCode ?? 'unknown error'}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`${fighter.name} generation exceeded the two-hour safety timeout.`);
}

async function seedFighter({ manifest, fighter, baseUrl, token, adminEntries, state }) {
  const { sourceBytes, photoHash } = readApprovedSource(manifest, fighter);
  console.log(`\n${fighter.rank}. ${fighter.name} [Champion]`);

  const created = await apiRequest(baseUrl, token, '/api/fighters', {
    method: 'POST',
    body: JSON.stringify({
      name: fighter.name,
      photoHash,
      qualityTier: 'champion',
      public: false,
    }),
  });
  const fighterId = created.fighter?.id;
  if (!/^[a-f0-9]{32}$/.test(fighterId ?? '')) throw new Error(`${fighter.name} did not return a fighter id.`);

  await uploadOriginalSource(baseUrl, token, fighterId, fighter, sourceBytes);

  const current = findCurrentArcadeEntry(adminEntries, fighter.slug);
  const registration = planArcadeDraftRegistration(
    current,
    fighterId,
    fighter.slug,
    photoHash,
    restartDraft,
  );
  await apiRequest(baseUrl, token, `/api/admin/arcade/${fighterId}`, {
    method: 'PATCH',
    body: JSON.stringify(arcadePayload(manifest, fighter, 'draft', registration.slug)),
  });
  checkpointState(state, manifest, fighter, fighterId, photoHash, 'draft', { complete: false });

  const generation = await apiRequest(baseUrl, token, `/api/admin/arcade/${fighterId}/generate`, {
    method: 'POST',
    body: JSON.stringify({
      legal: generationLegal(manifest),
      ...(registration.restartFullGeneration ? { restart: true } : {}),
    }),
  });
  if (generation.job?.id) await waitForJob(baseUrl, token, fighter, generation.job.id);
  else if (!generation.ready) throw new Error(`${fighter.name} generation returned neither a job nor a ready fighter.`);

  if (activate) {
    if (current && current.fighterId !== fighterId) {
      await apiRequest(baseUrl, token, `/api/admin/arcade/${current.fighterId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'retired' }),
      });
    }
    try {
      await apiRequest(baseUrl, token, `/api/admin/arcade/${fighterId}`, {
        method: 'PATCH',
        body: JSON.stringify(arcadePayload(manifest, fighter, 'active')),
      });
    } catch (error) {
      if (current && current.fighterId !== fighterId) {
        await apiRequest(baseUrl, token, `/api/admin/arcade/${current.fighterId}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'active' }),
        }).catch(() => {});
      }
      throw error;
    }
  }

  checkpointState(state, manifest, fighter, fighterId, photoHash, activate ? 'active' : 'draft', {
    complete: true,
    refreshAnimations: false,
  });
  console.log(`  ${activate ? 'active' : 'draft'}: ${fighterId}`);
}

async function resumeFighter({ manifest, fighter, baseUrl, token, adminEntries, state }) {
  const { sourceBytes, photoHash } = readApprovedSource(manifest, fighter);
  let entry = findCurrentArcadeEntry(adminEntries, fighter.slug);
  let fighterId = entry?.fighterId ?? '';
  let status = entry?.status === 'active' ? 'active' : 'draft';
  console.log(`\n${fighter.rank}. ${fighter.name} [Champion resume]`);

  if (!entry) {
    const created = await apiRequest(baseUrl, token, '/api/fighters', {
      method: 'POST',
      body: JSON.stringify({
        name: fighter.name,
        photoHash,
        qualityTier: 'champion',
        public: false,
      }),
    });
    fighterId = created.fighter?.id;
    if (!/^[a-f0-9]{32}$/.test(fighterId ?? '')) {
      throw new Error(`${fighter.name} did not return a fighter id.`);
    }
    await uploadOriginalSource(baseUrl, token, fighterId, fighter, sourceBytes);
    await apiRequest(baseUrl, token, `/api/admin/arcade/${fighterId}`, {
      method: 'PATCH',
      body: JSON.stringify(arcadePayload(manifest, fighter, 'draft')),
    });
    checkpointState(state, manifest, fighter, fighterId, photoHash, 'draft', { complete: false });
  }

  if (!/^[a-f0-9]{32}$/.test(fighterId)) {
    throw new Error(`Current Arcade fighter ${fighter.slug} has an invalid id.`);
  }

  let owned = await loadOwnedFighter(baseUrl, token, fighterId, fighter);
  if (owned.photoHash !== photoHash) {
    throw new Error(
      `${fighter.name} uses a different licensed-photo hash; create a reviewed replacement instead of resuming it.`,
    );
  }
  if (owned.qualityTier !== 'champion' || owned.name !== fighter.name) {
    const updated = await apiRequest(baseUrl, token, `/api/fighters/${fighterId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: fighter.name, qualityTier: 'champion' }),
    });
    owned = updated.fighter;
  }

  const currentOriginalHash = owned.sourceHashes?.original ?? null;
  if (!owned.sources?.original) {
    const hasCanonicalSource = CANONICAL_SOURCE_NAMES.some((name) => owned.sources?.[name]);
    if (hasCanonicalSource) {
      throw new Error(`${fighter.name} has canonical assets but no verifiable original; review it before resuming.`);
    }
    await uploadOriginalSource(baseUrl, token, fighterId, fighter, sourceBytes);
    owned = await loadOwnedFighter(baseUrl, token, fighterId, fighter);
  } else if (currentOriginalHash !== photoHash) {
    throw new Error(`${fighter.name} original asset hash does not match its approved licensed photo.`);
  }

  let plan = planFighterResume(owned);
  const workingStatus = status === 'active' && !plan.ready ? 'draft' : status;
  if (workingStatus !== status) status = workingStatus;
  await apiRequest(baseUrl, token, `/api/admin/arcade/${fighterId}`, {
    method: 'PATCH',
    body: JSON.stringify(arcadePayload(manifest, fighter, status)),
  });

  const previousState = state.targets[target]?.[fighter.slug] ?? {};
  const refreshAnimations = Boolean(previousState.refreshAnimations) || plan.sourceNames.length > 0;
  const previousPendingAnimations = Array.isArray(previousState.pendingAnimations)
    ? new Set(previousState.pendingAnimations.filter((name) => PLAYABLE_ANIMATIONS.has(name)))
    : null;
  let pendingAnimations = plan.sourceNames.length > 0
    ? [...PLAYABLE_ANIMATION_NAMES]
    : previousState.refreshAnimations && previousPendingAnimations
      ? PLAYABLE_ANIMATION_NAMES.filter((name) => previousPendingAnimations.has(name))
      : refreshAnimations
        ? [...PLAYABLE_ANIMATION_NAMES]
        : plan.animationNames;
  checkpointState(state, manifest, fighter, fighterId, photoHash, status, {
    complete: false,
    refreshAnimations,
    pendingSources: plan.sourceNames,
    pendingAnimations,
  });

  for (const name of plan.sourceNames) {
    await generateSource({ manifest, fighter, baseUrl, token, fighterId, name });
    const refreshed = await loadOwnedFighter(baseUrl, token, fighterId, fighter);
    plan = planFighterResume(refreshed);
    checkpointState(state, manifest, fighter, fighterId, photoHash, status, {
      complete: false,
      refreshAnimations: true,
      pendingSources: plan.sourceNames,
      pendingAnimations: PLAYABLE_ANIMATION_NAMES,
    });
    pendingAnimations = [...PLAYABLE_ANIMATION_NAMES];
  }

  owned = await loadOwnedFighter(baseUrl, token, fighterId, fighter);
  plan = planFighterResume(owned);
  if (plan.sourceNames.length > 0) {
    throw new Error(`${fighter.name} still lacks canonical sources: ${plan.sourceNames.join(', ')}.`);
  }
  const animations = pendingAnimations;
  for (let index = 0; index < animations.length; index += 1) {
    const name = animations[index];
    await generateAnimation({ manifest, fighter, baseUrl, token, fighterId, name });
    checkpointState(state, manifest, fighter, fighterId, photoHash, status, {
      complete: false,
      refreshAnimations: true,
      pendingSources: [],
      pendingAnimations: animations.slice(index + 1),
    });
  }

  owned = await loadOwnedFighter(baseUrl, token, fighterId, fighter);
  plan = planFighterResume(owned);
  if (!plan.ready) {
    throw new Error(
      `${fighter.name} resume finished incomplete (sources: ${plan.sourceNames.join(', ') || 'none'}; animations: ${plan.animationNames.join(', ') || 'none'}).`,
    );
  }

  if (activate && status !== 'active') {
    await apiRequest(baseUrl, token, `/api/admin/arcade/${fighterId}`, {
      method: 'PATCH',
      body: JSON.stringify(arcadePayload(manifest, fighter, 'active')),
    });
    status = 'active';
  }
  checkpointState(state, manifest, fighter, fighterId, photoHash, status, {
    complete: true,
    refreshAnimations: false,
    pendingSources: [],
    pendingAnimations: [],
  });
  console.log(`  ${status}: ${fighterId} (3 sources, 11 Champion animations)`);
}

async function seedAnimation({ manifest, fighter, baseUrl, token, adminEntries }) {
  const entry = findCurrentArcadeEntry(adminEntries, fighter.slug);
  if (!/^[a-f0-9]{32}$/.test(entry?.fighterId ?? '')) {
    throw new Error(`No current Arcade fighter exists for ${fighter.slug}. Seed the fighter before retrying an animation.`);
  }

  console.log(`\n${fighter.rank}. ${fighter.name} [Champion ${animationName}]`);
  await generateAnimation({ manifest, fighter, baseUrl, token, fighterId: entry.fighterId, name: animationName });
  console.log(`  archived ${animationName}: ${entry.fighterId}`);
}

async function seedSource({ manifest, fighter, baseUrl, token, adminEntries }) {
  const entry = findCurrentArcadeEntry(adminEntries, fighter.slug);
  if (!/^[a-f0-9]{32}$/.test(entry?.fighterId ?? '')) {
    throw new Error(`No current Arcade fighter exists for ${fighter.slug}. Seed the fighter before retrying a source.`);
  }

  console.log(`\n${fighter.rank}. ${fighter.name} [Champion source:${sourceName}]`);
  await generateSource({ manifest, fighter, baseUrl, token, fighterId: entry.fighterId, name: sourceName });
  console.log(`  archived source:${sourceName}: ${entry.fighterId}`);
}

async function seedSideCanary({ manifest, fighter, baseUrl, token, adminEntries, state }) {
  const { entry, photoHash } = await prepareSideDraft({
    manifest,
    fighter,
    baseUrl,
    token,
    adminEntries,
    state,
    mode: 'canary',
  });

  console.log(`\n${fighter.rank}. ${fighter.name} [Champion source:side canary]`);
  await generateSource({
    manifest,
    fighter,
    baseUrl,
    token,
    fighterId: entry.fighterId,
    name: 'side',
    restart: true,
    canary: true,
  });

  const owned = await loadOwnedFighter(baseUrl, token, entry.fighterId, fighter);
  if (!owned.sources?.side || !owned.sources?.sideRaw) {
    throw new Error(`${fighter.name} side canary did not archive both clean and raw assets.`);
  }
  checkpointState(state, manifest, fighter, entry.fighterId, photoHash, 'draft', {
    complete: false,
    canary: 'side',
    canaryPrepared: true,
    canaryReady: true,
    pendingSources: ['upright', 'crouch'],
    pendingAnimations: PLAYABLE_ANIMATION_NAMES,
  });
  console.log(`  canary ready: ${entry.fighterId} (side only; awaiting visual approval)`);
}

async function seedSideProbe({ manifest, fighter, baseUrl, token, adminEntries, state }) {
  const { entry, photoHash } = await prepareSideDraft({
    manifest,
    fighter,
    baseUrl,
    token,
    adminEntries,
    state,
    mode: 'probe',
    allowCreate: true,
  });

  console.log(`\n${fighter.rank}. ${fighter.name} [single-call Champion source:side probe]`);
  try {
    await generateSource({
      manifest,
      fighter,
      baseUrl,
      token,
      fighterId: entry.fighterId,
      name: 'side',
      restart: true,
      probe: true,
    });
  } catch (error) {
    checkpointState(state, manifest, fighter, entry.fighterId, photoHash, 'draft', {
      complete: false,
      probe: 'side',
      probePrepared: true,
      probeReady: false,
      probeResult: 'failed',
      pendingSources: ['side', 'upright', 'crouch'],
      pendingAnimations: PLAYABLE_ANIMATION_NAMES,
    });
    throw error;
  }

  const owned = await loadOwnedFighter(baseUrl, token, entry.fighterId, fighter);
  if (!owned.sources?.side || !owned.sources?.sideRaw) {
    throw new Error(`${fighter.name} side probe succeeded without archiving both clean and raw assets.`);
  }
  checkpointState(state, manifest, fighter, entry.fighterId, photoHash, 'draft', {
    complete: false,
    probe: 'side',
    probePrepared: true,
    probeReady: true,
    probeResult: 'generated',
    pendingSources: ['upright', 'crouch'],
    pendingAnimations: PLAYABLE_ANIMATION_NAMES,
  });
  console.log(`  probe generated: ${entry.fighterId} (side only; no continuation started)`);
}

async function prepareSideDraft({
  manifest,
  fighter,
  baseUrl,
  token,
  adminEntries,
  state,
  mode = 'canary',
  allowCreate = false,
}) {
  const preparation = planSideDraftPreparation(
    findCurrentArcadeEntry(adminEntries, fighter.slug),
    fighter.slug,
    { allowCreate, mode },
  );
  let entry = preparation.entry;
  if (preparation.action === 'create') {
    const { photoHash } = readApprovedSource(manifest, fighter);
    const created = await apiRequest(baseUrl, token, '/api/fighters', {
      method: 'POST',
      body: JSON.stringify({
        name: fighter.name,
        photoHash,
        qualityTier: 'champion',
        public: false,
      }),
    });
    const fighterId = created.fighter?.id;
    if (!/^[a-f0-9]{32}$/.test(fighterId ?? '')) {
      throw new Error(`${fighter.name} did not return a fighter id while staging its ${mode}.`);
    }
    assertNewArcadeDraftIdentity(adminEntries, fighterId, fighter.slug);
    entry = { fighterId, slug: fighter.slug, status: 'draft' };
  }

  const { sourceBytes, photoHash } = readApprovedSource(manifest, fighter);
  let owned = await loadOwnedFighter(baseUrl, token, entry.fighterId, fighter);
  if (owned.photoHash !== photoHash) {
    throw new Error(`${fighter.name} draft does not match the approved licensed-photo hash.`);
  }

  console.log(`\n${fighter.rank}. ${fighter.name} [prepare Champion source:side ${mode}]`);
  await uploadOriginalSource(baseUrl, token, entry.fighterId, fighter, sourceBytes);
  const patched = await apiRequest(baseUrl, token, `/api/admin/arcade/${entry.fighterId}`, {
    method: 'PATCH',
    body: JSON.stringify(arcadePayload(manifest, fighter, 'draft')),
  });
  owned = await loadOwnedFighter(baseUrl, token, entry.fighterId, fighter);
  if (owned.photoHash !== photoHash || !owned.sources?.original) {
    throw new Error(`${fighter.name} approved original was not durably repaired.`);
  }
  if (patched.fighter?.generationPrompt !== fighter.referencePrompt) {
    throw new Error(`${fighter.name} private Arcade prompt did not match manifest v3 after PATCH.`);
  }
  const progress = mode === 'probe'
    ? { probe: 'side', probePrepared: true, probeReady: false }
    : mode === 'register'
      ? { draftRegistered: true }
      : { canary: 'side', canaryPrepared: true, canaryReady: false };
  checkpointState(state, manifest, fighter, entry.fighterId, photoHash, 'draft', {
    complete: false,
    ...progress,
    pendingSources: ['upright', 'crouch'],
    pendingAnimations: PLAYABLE_ANIMATION_NAMES,
  });
  console.log(`  ${mode} prepared: ${entry.fighterId} (original repaired; manifest v3 frozen; no inference started)`);
  return { entry, photoHash };
}

async function prepareSideCanary(options) {
  return prepareSideDraft({ ...options, mode: 'canary' });
}

async function registerArcadeDraft(options) {
  return prepareSideDraft({ ...options, mode: 'register', allowCreate: true });
}

async function main() {
  if (!['production', 'sandbox'].includes(target)) throw new Error('--target must be production or sandbox.');
  if (target === 'production' && !dryRun && !preflightOnly && !args.has('--confirm-production')) {
    throw new Error('Production seeding requires --confirm-production.');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  validateManifest(manifest);
  const selected = selectFighters(manifest);
  if (activateReviewed) assertReviewedActivationConfirmation(activationConfirmation);
  if (videoStep) {
    if (resumeVideoRunFrom) {
      exactVideoJobId(resumeVideoRunFrom, 'Video resume source');
      assertReviewGatedVideoRecoveryConfirmation('resume-failed', videoStepConfirmation);
    } else if (restartVideoRunFrom) {
      exactVideoJobId(restartVideoRunFrom, 'Video restart source');
      assertReviewGatedVideoRecoveryConfirmation('restart-full', videoStepConfirmation);
    } else {
      assertReviewGatedVideoStepConfirmation(videoStepConfirmation);
    }
  }
  if (videoReview) {
    assertReviewGatedVideoReviewConfirmation(
      videoReviewInspect ? 'inspect' : videoReviewDecision,
      videoStepConfirmation,
    );
  }
  if (postApprovedRecurationOperation) {
    if (target !== 'production') {
      throw new Error('Post-approved global recuration is production-only.');
    }
    assertPostApprovedRecurationConfirmation(postApprovedRecuration, recurationConfirmation);
    if (videoReviewReason) {
      throw new Error('Post-approved recuration does not accept a rejection reason.');
    }
    if (postApprovedRecuration === 'stage') {
      if (
        !videoReviewJobId || !videoReviewCandidateId || !videoReviewRevision
        || !videoReviewReportSha256 || !videoReviewSelectedIndices || !videoReviewExportDir
      ) {
        throw new Error(
          'Recuration stage requires exact video review job, candidate, revision, report SHA, selected indices, and private export dir.',
        );
      }
      if (recurationDescriptorPath || recurationDescriptorSha256 || acceptRecurationNeedsReview) {
        throw new Error('Recuration stage does not accept a descriptor or --accept-needs-review.');
      }
    } else {
      if (!recurationDescriptorPath || !recurationDescriptorSha256) {
        throw new Error('Recuration promote/rollback requires a descriptor path and explicit descriptor SHA-256.');
      }
      if (
        videoReviewJobId || videoReviewCandidateId || videoReviewRevision
        || videoReviewReportSha256 || videoReviewSelectedIndices || videoReviewExportDir
      ) {
        throw new Error('Recuration promote/rollback takes every mutable binding only from the sealed descriptor.');
      }
    }
  }
  if (activateReviewed) assertReviewedVideoFinalJobId(reviewedVideoFinalJobId);
  if (target === 'production' && (videoStep || videoReview) && !reviewedCanonicalManifestPath) {
    throw new Error(
      'Production review-gated Video operations require --reviewed-canonical-manifest from a separately reviewed run.',
    );
  }
  if (
    target === 'production'
    && (videoStep || videoReview)
    && !/^[1-9][0-9]*$/.test(reviewedManifestRunId)
  ) {
    throw new Error(
      'Production review-gated Video operations require --reviewed-manifest-run-id from the approved producer.',
    );
  }
  if (target === 'production' && reviewedVideoOperation && !/^[a-f0-9]{40}$/.test(expectedDeployedSha)) {
    throw new Error(
      'Production reviewed Video operations require --expected-deployed-sha=<full lowercase GITHUB_SHA>.',
    );
  }
  if (!activateReviewed && !postApprovedRecurationOperation) {
    mkdirSync(sourceDir, { recursive: true });
  }

  if (dryRun) {
    for (const fighter of selected) {
      const { photoHash } = readApprovedSource(manifest, fighter);
      console.log(
        `ready  ${fighter.slug}  Champion${animationName ? `:${animationName}` : sourceName ? `:source:${sourceName}` : registerDraft ? ':register-draft' : prepareCanary ? ':prepare-canary' : canarySide ? ':canary-side' : probeSide ? ':probe-side' : resume ? ':resume' : restartDraft ? ':restart-draft' : ''}  licensed:${photoHash.slice(0, 12)}`,
      );
    }
    return;
  }
  const reviewedActivationPhotoHash = activateReviewed
    ? readApprovedSource(manifest, selected[0]).photoHash
    : '';
  const reviewGatedVideoPhotoHash = videoStep || videoReview
    ? readApprovedSource(manifest, selected[0]).photoHash
    : '';
  const reviewedCanonicalManifest = reviewedCanonicalManifestPath
    ? assertReviewedCanonicalManifest(
        JSON.parse(readFileSync(resolve(reviewedCanonicalManifestPath), 'utf8')),
        {
          slug: selected[0].slug,
          photoHash: reviewGatedVideoPhotoHash,
        },
      )
    : null;
  const reviewedManifestSha256 = reviewedCanonicalManifestPath
    ? sha256(readFileSync(resolve(reviewedCanonicalManifestPath)))
    : '';

  const env = readEnvValues();
  clerkBackendAuthBridgeSecret = envValue(env, 'CLERK_BACKEND_AUTH_BRIDGE_SECRET');
  if (clerkBackendAuthBridgeSecret && clerkBackendAuthBridgeSecret.length < 32) {
    throw new Error('CLERK_BACKEND_AUTH_BRIDGE_SECRET must contain at least 32 characters.');
  }
  const defaultBaseUrl = target === 'sandbox'
    ? 'https://insert-player-api-sandbox.shellbot.workers.dev'
    : 'https://api.insertplayer.ai';
  const configuredBaseUrl = (
    envValue(env, target === 'sandbox' ? 'ASF_SANDBOX_WORKER_URL' : 'ASF_WORKER_URL')
    || envValue(env, 'VITE_API_BASE_URL')
    || defaultBaseUrl
  );
  const baseUrl = target === 'production' && reviewedVideoOperation
    ? assertReviewedProductionApiOrigin(configuredBaseUrl)
    : configuredBaseUrl.replace(/\/+$/, '');
  if (target === 'production' && reviewedVideoOperation) {
    await pinProductionWorkerHealth({
      baseUrl,
      configuredHealthUrl: envValue(env, 'ASF_WORKER_HEALTH_URL'),
      expectedSha: expectedDeployedSha,
    });
  }
  const staticToken = envValue(env, 'ASF_ARCADE_ADMIN_JWT') || envValue(env, 'ASF_CLERK_JWT');
  const clerkSecretKey = envValue(env, 'ASF_ARCADE_CLERK_SECRET_KEY')
    || (preflightOnly ? envValue(env, 'ASF_ARCADE_PREFLIGHT_KEY') : '');
  const clerkUserId = envValue(env, 'ASF_ARCADE_ADMIN_CLERK_USER_ID');
  if (Boolean(clerkSecretKey) !== Boolean(clerkUserId)) {
    throw new Error('Set both ASF_ARCADE_CLERK_SECRET_KEY and ASF_ARCADE_ADMIN_CLERK_USER_ID.');
  }
  if (!staticToken && !clerkSecretKey) {
    throw new Error(
      'Set ASF_ARCADE_CLERK_SECRET_KEY plus ASF_ARCADE_ADMIN_CLERK_USER_ID, '
      + 'or provide a long-lived ASF_ARCADE_ADMIN_JWT. Never commit these values.',
    );
  }
  const token = clerkSecretKey
    ? await createClerkAdminTokenProvider(clerkSecretKey, clerkUserId)
    : createStaticTokenProvider(staticToken);

  if (postApprovedRecurationOperation) {
    if (postApprovedRecuration === 'stage') {
      await stagePostApprovedVideoRecuration({
        fighter: selected[0],
        action: animationName,
        baseUrl,
        token,
        jobId: videoReviewJobId,
        candidateId: videoReviewCandidateId,
        revision: videoReviewRevision,
        reportSha256: videoReviewReportSha256,
        selectedVideoIndices: videoReviewSelectedIndices,
        destination: videoReviewExportDir,
        expectedWorkerSha: expectedDeployedSha,
      });
      return;
    }
    const descriptor = readSealedPostApprovedRecurationDescriptor(
      recurationDescriptorPath,
      recurationDescriptorSha256,
      {
        slug: selected[0].slug,
        action: animationName,
        expectedWorkerSha: expectedDeployedSha,
      },
    );
    const result = await promotePostApprovedVideoRecuration({
      operation: postApprovedRecuration,
      fighter: selected[0],
      action: animationName,
      descriptor,
      baseUrl,
      token,
      acceptNeedsReview: acceptRecurationNeedsReview,
    });
    if (!result.cache.configured) {
      console.warn(
        '  cache-purge: no integration configured; exact private/public cache-busted byte smokes passed instead.',
      );
    }
    return;
  }

  if (activateReviewed) {
    await activateReviewedArcadeFighter({
      manifest,
      fighter: selected[0],
      approvedPhotoHash: reviewedActivationPhotoHash,
      reviewedVideoFinalJobId,
      baseUrl,
      token,
    });
    return;
  }

  if (videoStep) {
    await runReviewGatedVideoStep({
      manifest,
      fighter: selected[0],
      approvedPhotoHash: reviewGatedVideoPhotoHash,
      baseUrl,
      token,
      reviewedCanonicalManifest,
      resumeFromJobId: resumeVideoRunFrom,
      restartFromJobId: restartVideoRunFrom,
      reviewArtifactDir: videoReviewExportDir,
      reviewedManifestRunId,
      reviewedManifestSha256,
    });
    return;
  }

  if (videoReviewInspect) {
    await runReviewGatedVideoInspection({
      manifest,
      fighter: selected[0],
      approvedPhotoHash: reviewGatedVideoPhotoHash,
      reviewedCanonicalManifest,
      reviewedManifestRunId,
      reviewedManifestSha256,
      baseUrl,
      token,
      jobId: videoReviewJobId,
      candidateId: videoReviewCandidateId,
      revision: videoReviewRevision,
      reportSha256: videoReviewReportSha256,
      destination: videoReviewExportDir,
    });
    return;
  }

  if (videoReview) {
    await runReviewGatedVideoDecision({
      manifest,
      fighter: selected[0],
      approvedPhotoHash: reviewGatedVideoPhotoHash,
      reviewedCanonicalManifest,
      reviewedManifestRunId,
      reviewedManifestSha256,
      baseUrl,
      token,
      decision: videoReviewDecision,
      jobId: videoReviewJobId,
      candidateId: videoReviewCandidateId,
      revision: videoReviewRevision,
      reportSha256: videoReviewReportSha256,
      selectedVideoIndices: videoReviewSelectedIndices,
      reason: videoReviewReason,
      destination: videoReviewExportDir,
    });
    return;
  }

  const providerPreflight = await apiRequest(
    baseUrl,
    token,
    '/api/admin/arcade/generation-contract',
  );
  const providerContract = assertApprovedArcadeGenerationContract(providerPreflight);
  console.log(
    `provider  Gemini-only (sources ${providerContract.sourceModels.side}; `
    + `Champion scaffold ${providerContract.championAnimation.scaffoldModel}; `
    + `frames ${providerContract.championAnimation.renderModel}; fail-closed)`,
  );
  if (preflightOnly) return;

  const admin = await apiRequest(baseUrl, token, '/api/admin/arcade');
  const adminEntries = Array.isArray(admin.fighters) ? admin.fighters : [];
  if (animationName) {
    await seedAnimation({
      manifest,
      fighter: selected[0],
      baseUrl,
      token,
      adminEntries,
    });
    return;
  }
  if (sourceName) {
    await seedSource({
      manifest,
      fighter: selected[0],
      baseUrl,
      token,
      adminEntries,
    });
    return;
  }
  const state = readState();
  if (registerDraft) {
    await registerArcadeDraft({
      manifest,
      fighter: selected[0],
      baseUrl,
      token,
      adminEntries,
      state,
    });
    return;
  }
  if (prepareCanary) {
    await prepareSideCanary({
      manifest,
      fighter: selected[0],
      baseUrl,
      token,
      adminEntries,
      state,
    });
    return;
  }
  if (probeSide) {
    await seedSideProbe({
      manifest,
      fighter: selected[0],
      baseUrl,
      token,
      adminEntries,
      state,
    });
    return;
  }
  if (canarySide) {
    await seedSideCanary({
      manifest,
      fighter: selected[0],
      baseUrl,
      token,
      adminEntries,
      state,
    });
    return;
  }
  const failures = [];
  for (const fighter of selected) {
    try {
      const operation = resume ? resumeFighter : seedFighter;
      await operation({ manifest, fighter, baseUrl, token, adminEntries, state });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      failures.push(`${fighter.name}: ${detail}`);
      console.error(`  failed: ${detail}`);
      if (!continueOnError) break;
    }
  }
  if (failures.length > 0) throw new Error(`Arcade seed failed:\n${failures.join('\n')}`);
  console.log(
    `\n${resume ? 'Resumed' : 'Seeded'} ${selected.length} Champion Arcade fighter${selected.length === 1 ? '' : 's'} on ${target}.`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
