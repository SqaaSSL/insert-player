import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
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
const target = targetArg?.slice('--target='.length) ?? 'production';
const animationName = animationArg?.slice('--animation='.length) ?? '';
const dryRun = args.has('--dry-run');
const activate = args.has('--activate');
const continueOnError = args.has('--continue-on-error');
const all = args.has('--all');
const POLL_INTERVAL_MS = 5_000;
const JOB_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60_000;
const CLERK_TOKEN_REFRESH_SKEW_MS = 30_000;
const CLERK_TOKEN_TTL_SECONDS = 10 * 60;
const MAX_SOURCE_UPLOAD_BYTES = 12 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PLAYABLE_ANIMATIONS = new Set([
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
]);

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

function validateManifest(manifest) {
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

function selectFighters(manifest) {
  if (all && slugArg) throw new Error('Use either --all or --slug, not both.');
  if (animationName && (all || !slugArg || activate)) {
    throw new Error('--animation requires one --slug and cannot be combined with --all or --activate.');
  }
  if (animationName && !PLAYABLE_ANIMATIONS.has(animationName)) {
    throw new Error(`Unknown playable animation: ${animationName}`);
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

async function apiRequest(baseUrl, getToken, path, init = {}) {
  const token = await getToken();
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Insert-Player-Admin-Seed': 'clerk-backend',
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
    throw new Error(`${init.method ?? 'GET'} ${path} failed: ${detail}`);
  }
  return body;
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

  const form = new FormData();
  form.set('kind', 'original');
  form.set('file', new Blob([sourceBytes], { type: 'image/png' }), `${fighter.slug}.png`);
  await apiRequest(baseUrl, token, `/api/fighters/${fighterId}/sources`, {
    method: 'POST',
    body: form,
  });

  const current = adminEntries.find((entry) => entry.slug === fighter.slug && entry.status !== 'retired');
  const currentForFighter = adminEntries.find((entry) => entry.fighterId === fighterId);
  const temporarySlug = current && current.fighterId !== fighterId
    ? `${fighter.slug.slice(0, 49)}-next-${photoHash.slice(0, 8)}`
    : fighter.slug;
  await apiRequest(baseUrl, token, `/api/admin/arcade/${fighterId}`, {
    method: 'PATCH',
    body: JSON.stringify(arcadePayload(manifest, fighter, 'draft', currentForFighter?.slug ?? temporarySlug)),
  });

  const generation = await apiRequest(baseUrl, token, `/api/admin/arcade/${fighterId}/generate`, {
    method: 'POST',
    body: JSON.stringify({ legal: generationLegal(manifest) }),
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

  state.targets[target] ??= {};
  state.targets[target][fighter.slug] = {
    fighterId,
    photoHash,
    status: activate ? 'active' : 'draft',
    manifestVersion: manifest.version,
    updatedAt: new Date().toISOString(),
  };
  writeState(state);
  console.log(`  ${activate ? 'active' : 'draft'}: ${fighterId}`);
}

async function seedAnimation({ manifest, fighter, baseUrl, token, adminEntries }) {
  const entry = adminEntries.find((candidate) => (
    candidate.slug === fighter.slug && candidate.status !== 'retired'
  ));
  if (!/^[a-f0-9]{32}$/.test(entry?.fighterId ?? '')) {
    throw new Error(`No current Arcade fighter exists for ${fighter.slug}. Seed the fighter before retrying an animation.`);
  }

  console.log(`\n${fighter.rank}. ${fighter.name} [Champion ${animationName}]`);
  const generation = await apiRequest(
    baseUrl,
    token,
    `/api/admin/arcade/${entry.fighterId}/generate/${encodeURIComponent(animationName)}`,
    {
      method: 'POST',
      body: JSON.stringify({ legal: generationLegal(manifest) }),
    },
  );
  if (!generation.job?.id) throw new Error(`${fighter.name} animation generation returned no job.`);
  await waitForJob(baseUrl, token, fighter, generation.job.id);
  console.log(`  archived ${animationName}: ${entry.fighterId}`);
}

async function main() {
  if (!['production', 'sandbox'].includes(target)) throw new Error('--target must be production or sandbox.');
  if (target === 'production' && !dryRun && !args.has('--confirm-production')) {
    throw new Error('Production seeding requires --confirm-production.');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  validateManifest(manifest);
  const selected = selectFighters(manifest);
  mkdirSync(sourceDir, { recursive: true });

  if (dryRun) {
    for (const fighter of selected) {
      const { photoHash } = readApprovedSource(manifest, fighter);
      console.log(
        `ready  ${fighter.slug}  Champion${animationName ? `:${animationName}` : ''}  licensed:${photoHash.slice(0, 12)}`,
      );
    }
    return;
  }

  const env = readEnvValues();
  const defaultBaseUrl = target === 'sandbox'
    ? 'https://insert-player-api-sandbox.shellbot.workers.dev'
    : 'https://api.insertplayer.ai';
  const baseUrl = (
    envValue(env, target === 'sandbox' ? 'ASF_SANDBOX_WORKER_URL' : 'ASF_WORKER_URL')
    || envValue(env, 'VITE_API_BASE_URL')
    || defaultBaseUrl
  ).replace(/\/+$/, '');
  const staticToken = envValue(env, 'ASF_ARCADE_ADMIN_JWT') || envValue(env, 'ASF_CLERK_JWT');
  const clerkSecretKey = envValue(env, 'ASF_ARCADE_CLERK_SECRET_KEY');
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
  const state = readState();
  const failures = [];
  for (const fighter of selected) {
    try {
      await seedFighter({ manifest, fighter, baseUrl, token, adminEntries, state });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      failures.push(`${fighter.name}: ${detail}`);
      console.error(`  failed: ${detail}`);
      if (!continueOnError) break;
    }
  }
  if (failures.length > 0) throw new Error(`Arcade seed failed:\n${failures.join('\n')}`);
  console.log(`\nSeeded ${selected.length} Champion Arcade fighter${selected.length === 1 ? '' : 's'} to ${target}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
