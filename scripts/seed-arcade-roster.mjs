import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
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
const target = targetArg?.slice('--target='.length) ?? 'production';
const animationName = animationArg?.slice('--animation='.length) ?? '';
const sourceName = sourceArg?.slice('--source='.length) ?? '';
const activationConfirmation = activationConfirmationArg?.slice('--confirm-activation='.length) ?? '';
const videoStepConfirmation = videoStepConfirmationArg?.slice('--confirm-video-step='.length) ?? '';
const dryRun = args.has('--dry-run');
const activate = args.has('--activate');
const activateReviewed = args.has('--activate-reviewed');
const videoStep = args.has('--video-step');
const continueOnError = args.has('--continue-on-error');
const all = args.has('--all');
const resume = args.has('--resume');
const restartDraft = args.has('--restart-draft');
const prepareCanary = args.has('--prepare-canary');
const canarySide = args.has('--canary-side');
const probeSide = args.has('--probe-side');
const preflightOnly = args.has('--preflight-only');
const POLL_INTERVAL_MS = 5_000;
const JOB_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60_000;
const CLERK_TOKEN_REFRESH_SKEW_MS = 30_000;
const CLERK_TOKEN_TTL_SECONDS = 10 * 60;
let clerkBackendAuthBridgeSecret = '';
const MAX_SOURCE_UPLOAD_BYTES = 12 * 1024 * 1024;
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

async function clerkRequest(secretKey, path, init = {}) {
  const response = await fetch(`https://api.clerk.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
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

function selectFighters(manifest) {
  if (all && slugArg) throw new Error('Use either --all or --slug, not both.');
  if (
    preflightOnly
    && (dryRun || all || resume || restartDraft || prepareCanary || canarySide || probeSide || activate || activateReviewed || videoStep || animationName || sourceName)
  ) {
    throw new Error('--preflight-only requires one --slug and cannot be combined with a generation operation.');
  }
  if (animationName && sourceName) {
    throw new Error('Use either --animation or --source, not both.');
  }
  if ((animationName || sourceName) && (all || !slugArg || activate || activateReviewed || videoStep)) {
    throw new Error('--animation and --source require one --slug and cannot be combined with an activation operation.');
  }
  if (resume && (animationName || sourceName)) {
    throw new Error('--resume fills an entire fighter and cannot be combined with --animation or --source.');
  }
  if (restartDraft && (all || resume || prepareCanary || canarySide || probeSide || activate || activateReviewed || videoStep || animationName || sourceName || !slugArg)) {
    throw new Error('--restart-draft requires one --slug and cannot be combined with --all, --resume, --activate, --animation, or --source.');
  }
  if (prepareCanary && (all || resume || restartDraft || canarySide || probeSide || activate || activateReviewed || videoStep || animationName || sourceName || !slugArg)) {
    throw new Error('--prepare-canary requires one --slug and cannot be combined with another generation operation.');
  }
  if (canarySide && (all || resume || restartDraft || prepareCanary || probeSide || activate || activateReviewed || videoStep || animationName || sourceName || !slugArg)) {
    throw new Error('--canary-side requires one --slug and cannot be combined with another generation operation.');
  }
  if (probeSide && (all || resume || restartDraft || prepareCanary || canarySide || activate || activateReviewed || videoStep || animationName || sourceName || !slugArg)) {
    throw new Error('--probe-side requires one --slug and cannot be combined with another generation operation.');
  }
  if (
    activateReviewed
    && (dryRun || all || resume || restartDraft || prepareCanary || canarySide || probeSide || activate || videoStep || animationName || sourceName || !slugArg)
  ) {
    throw new Error('--activate-reviewed requires one --slug and cannot be combined with generation, resume, or dry-run.');
  }
  if (
    videoStep
    && (dryRun || all || resume || restartDraft || prepareCanary || canarySide || probeSide || activate || activateReviewed || animationName || sourceName || !slugArg)
  ) {
    throw new Error('--video-step requires one --slug and cannot be combined with generation, resume, activation, or dry-run.');
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

async function apiRequest(baseUrl, getToken, path, init = {}) {
  const token = await getToken();
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...arcadeAdminAuthHeaders(token, clerkBackendAuthBridgeSecret),
      ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

export async function activateReviewedArcadeFighter({
  manifest,
  fighter,
  approvedPhotoHash,
  baseUrl,
  token,
  requestApi = apiRequest,
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

  console.log(`\n${fighter.rank}. ${fighter.name} [reviewed activation only]`);
  const result = await requestApi(
    baseUrl,
    token,
    `/api/admin/arcade/${encodeURIComponent(entry.fighterId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(arcadePayload(manifest, fighter, 'active')),
    },
  );
  if (
    result.fighter?.fighterId !== entry.fighterId
    || result.fighter?.status !== 'active'
    || result.fighter?.public !== true
  ) {
    throw new Error(`${fighter.name} activation did not return a public active Arcade fighter.`);
  }
  console.log(`  active: ${entry.fighterId} (reviewed assets only; no generation requested)`);
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

function assertReviewGatedVideoJob(job, fighterId) {
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
  if (job.fullRunRestartRequired === true) {
    throw new Error(`Video job ${job.id} requires an explicit full-run restart; video-step will not restart it.`);
  }
  return job;
}

export function planReviewGatedVideoStep(jobs, fighterId) {
  const fighterJobs = (Array.isArray(jobs) ? jobs : []).filter((job) => job?.fighterId === fighterId);
  const active = fighterJobs.filter((job) => job.status === 'queued' || job.status === 'running');
  const awaiting = fighterJobs.filter((job) => job.reviewStatus === 'awaiting_review');
  if (active.length > 1 || awaiting.length > 1 || (active.length > 0 && awaiting.length > 0)) {
    throw new Error('Arcade Video job state is ambiguous; no generation was started.');
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
  if (!latest) return { action: 'start', job: null };
  assertReviewGatedVideoJob(latest, fighterId);
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
  };
  console.log(`  awaiting-review: ${JSON.stringify(summary)}`);
  console.log('  no approval, upload, activation, or additional action was performed');
  return summary;
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
}) {
  const startedAt = Date.now();
  let job = initialJob;
  let lastStage = '';
  while (Date.now() - startedAt < jobTimeoutMs) {
    assertReviewGatedVideoJob(job, fighterId);
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
}) {
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
  const listed = await requestApi(baseUrl, token, '/api/generation-jobs');
  if (!Array.isArray(listed.jobs)) {
    throw new Error('Generation job listing is unavailable; no Video generation was started.');
  }
  const plan = planReviewGatedVideoStep(listed.jobs, fighterId);

  if (plan.action === 'complete') {
    console.log(`  complete: ${fighter.slug} has no pending Video stages; no mutation was performed`);
    return { mode: 'complete', mutated: false, job: plan.job, review: null };
  }

  let job = plan.job;
  let mode = plan.action;
  if (plan.action === 'start' || plan.action === 'continue') {
    const started = await requestApi(
      baseUrl,
      token,
      `/api/admin/arcade/${encodeURIComponent(fighterId)}/generate`,
      {
        method: 'POST',
        body: JSON.stringify({
          legal: generationLegal(manifest),
          creationFlow: 'video',
        }),
      },
    );
    if (started.ready === true || !started.job) {
      throw new Error(
        `${fighter.name} Video endpoint returned no review-gated job; no fallback or restart was attempted.`,
      );
    }
    job = assertReviewGatedVideoJob(started.job, fighterId);
    mode = plan.action === 'continue' ? 'continued' : 'started';
  } else if (plan.action === 'poll') {
    mode = 'resumed-poll';
  } else {
    mode = 'reused-review';
  }

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
    });
  }
  assertReviewGatedVideoJob(job, fighterId);
  const reviewBody = await requestApi(
    baseUrl,
    token,
    `/api/generation-jobs/${encodeURIComponent(job.id)}/video-review`,
  );
  const review = assertAwaitingVideoReview(reviewBody.review, job);
  printAwaitingVideoReview(fighter, review, mode);
  return {
    mode,
    mutated: plan.action === 'start' || plan.action === 'continue',
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
      throw new Error(`${fighter.name} did not return a fighter id while staging its probe.`);
    }
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

async function main() {
  if (!['production', 'sandbox'].includes(target)) throw new Error('--target must be production or sandbox.');
  if (target === 'production' && !dryRun && !preflightOnly && !args.has('--confirm-production')) {
    throw new Error('Production seeding requires --confirm-production.');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  validateManifest(manifest);
  const selected = selectFighters(manifest);
  if (activateReviewed) assertReviewedActivationConfirmation(activationConfirmation);
  if (videoStep) assertReviewGatedVideoStepConfirmation(videoStepConfirmation);
  if (!activateReviewed) mkdirSync(sourceDir, { recursive: true });

  if (dryRun) {
    for (const fighter of selected) {
      const { photoHash } = readApprovedSource(manifest, fighter);
      console.log(
        `ready  ${fighter.slug}  Champion${animationName ? `:${animationName}` : sourceName ? `:source:${sourceName}` : prepareCanary ? ':prepare-canary' : canarySide ? ':canary-side' : probeSide ? ':probe-side' : resume ? ':resume' : restartDraft ? ':restart-draft' : ''}  licensed:${photoHash.slice(0, 12)}`,
      );
    }
    return;
  }
  const reviewedActivationPhotoHash = activateReviewed
    ? readApprovedSource(manifest, selected[0]).photoHash
    : '';
  const reviewGatedVideoPhotoHash = videoStep
    ? readApprovedSource(manifest, selected[0]).photoHash
    : '';

  const env = readEnvValues();
  clerkBackendAuthBridgeSecret = envValue(env, 'CLERK_BACKEND_AUTH_BRIDGE_SECRET');
  if (clerkBackendAuthBridgeSecret && clerkBackendAuthBridgeSecret.length < 32) {
    throw new Error('CLERK_BACKEND_AUTH_BRIDGE_SECRET must contain at least 32 characters.');
  }
  const defaultBaseUrl = target === 'sandbox'
    ? 'https://insert-player-api-sandbox.shellbot.workers.dev'
    : 'https://api.insertplayer.ai';
  const baseUrl = (
    envValue(env, target === 'sandbox' ? 'ASF_SANDBOX_WORKER_URL' : 'ASF_WORKER_URL')
    || envValue(env, 'VITE_API_BASE_URL')
    || defaultBaseUrl
  ).replace(/\/+$/, '');
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

  if (activateReviewed) {
    await activateReviewedArcadeFighter({
      manifest,
      fighter: selected[0],
      approvedPhotoHash: reviewedActivationPhotoHash,
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
