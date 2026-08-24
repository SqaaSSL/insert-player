import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  INSERT_PLAYER_CLERK_FRONTEND_API_HOST,
  clerkPublishableKeyIssues,
  decodeClerkPublishableKey,
} from './clerk-publishable-key.mjs';
import { wranglerAuthIssue } from './wrangler-auth-status.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workerDir = join(root, 'worker');
const wranglerTomlPath = join(workerDir, 'wrangler.toml');
const wranglerLogPath = join(root, '.wrangler-logs');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const CURL_TIMEOUT_ARGS = ['--connect-timeout', '10', '--max-time', '30'];
const DEFAULT_FRONTEND_READY_TIMEOUT_MS = 240_000;
const DEFAULT_FRONTEND_RETRY_DELAY_MS = 2_500;

const requiredSecrets = [
  'METERKEY_API_KEY',
  'GEMINI_API_KEY',
  'FAL_API_KEY',
  'RUNWAY_API_KEY',
  'FREEPIK_API_KEY',
  'LUDO_API_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'CLERK_WEBHOOK_SIGNING_SECRET',
  'TURNSTILE_SECRET_KEY',
  'ANONYMIZATION_SECRET',
  'GENERATION_JOB_SIGNING_SECRET',
  'CLERK_BACKEND_AUTH_BRIDGE_SECRET',
];

const sampleFragments = [
  'PLACEHOLDER',
  'replace_me',
  'your-',
  'example',
  'pk_test_replace_me',
  'pk_live_...',
  'sk_test_replace_me',
  'acct_replace_me',
  'price_replace_me',
  'whsec_replace_me',
  '127.0.0.1',
  'localhost',
];

const errors = [];

function fail(message) {
  errors.push(message);
}

function assertNodeVersion() {
  const [major, minor] = process.versions.node.split('.').map((part) => Number(part));
  if (major < 22 || (major === 22 && minor < 12)) {
    fail(`Node ${process.versions.node} is too old for live Wrangler checks; use Node >=22.12.0.`);
    return false;
  }
  return true;
}

function run(command, args, cwd = root) {
  mkdirSync(wranglerLogPath, { recursive: true });
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH || wranglerLogPath,
    },
    timeout: DEFAULT_COMMAND_TIMEOUT_MS,
  });
}

function curl(args) {
  return run('curl', [...CURL_TIMEOUT_ARGS, ...args]);
}

function isPublicIpv4(value) {
  if (isIP(value) !== 4) return false;
  const [a, b, c] = value.split('.').map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

async function curlHttpsWithPublicDnsFallback(args, target) {
  const initial = curl([...args, target]);
  const initialOutput = `${initial.stdout ?? ''}${initial.stderr ?? ''}`;
  if (initial.status === 0 || !/Could not resolve host/i.test(initialOutput)) return initial;

  let url;
  try {
    url = new URL(target);
  } catch {
    return initial;
  }
  if (url.protocol !== 'https:') return initial;

  const resolver = new Resolver();
  resolver.setServers(['1.1.1.1', '8.8.8.8']);
  let addresses;
  try {
    addresses = (await resolver.resolve4(url.hostname)).filter(isPublicIpv4);
  } catch {
    return initial;
  }

  let last = initial;
  for (const address of addresses) {
    last = curl(['--resolve', `${url.hostname}:443:${address}`, ...args, target]);
    if (last.status === 0) return last;
  }
  return last;
}

function parseTomlString(text, key) {
  const match = text.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'));
  return match?.[1]?.trim() ?? '';
}

function hasSampleValue(value) {
  return sampleFragments.some((fragment) => value.toLowerCase().includes(fragment.toLowerCase()));
}

function hasInternalBrandRisk(value) {
  return /(^|[^a-z0-9])(?:ai[\s_-]*)?street[\s_-]*fighter([^a-z0-9]|$)/i.test(value) || /\bcapcom\b/i.test(value);
}

function readEnvFiles() {
  const files = ['.env.production.local', '.env.production', '.env.local', '.env'];
  const values = new Map();
  for (const file of files) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!values.has(key)) values.set(key, value);
    }
  }
  return values;
}

function resolveEnv(key, envFiles) {
  return process.env[key] || envFiles.get(key) || '';
}

function resolveNumberEnv(key, envFiles, fallback) {
  const value = Number(resolveEnv(key, envFiles) || fallback);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function firstConfiguredCorsOrigin() {
  const text = readFileSync(wranglerTomlPath, 'utf8');
  return parseTomlString(text, 'CORS_ORIGIN')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .find(Boolean) ?? '';
}

function configuredOrigins(value) {
  return value
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function curlFrontendRoute(target, envFiles, waitForReady) {
  if (!waitForReady) {
    return { res: curl(['-fsSL', target]), waitedMs: 0 };
  }

  const readyTimeoutMs = resolveNumberEnv('ASF_FRONTEND_READY_TIMEOUT_MS', envFiles, DEFAULT_FRONTEND_READY_TIMEOUT_MS);
  const retryDelayMs = resolveNumberEnv('ASF_FRONTEND_RETRY_DELAY_MS', envFiles, DEFAULT_FRONTEND_RETRY_DELAY_MS);
  const started = Date.now();
  let res;

  do {
    res = curl(['-fsSL', target]);
    if (res.status === 0) break;
    const elapsed = Date.now() - started;
    const remaining = readyTimeoutMs - elapsed;
    if (remaining <= 0) break;
    sleepSync(Math.min(retryDelayMs, remaining));
  } while (Date.now() - started <= readyTimeoutMs);

  return { res, waitedMs: Date.now() - started };
}

function assertWranglerConfig() {
  const text = readFileSync(wranglerTomlPath, 'utf8');
  const databaseId = parseTomlString(text, 'database_id');
  const bucketName = parseTomlString(text, 'bucket_name');
  const corsOrigin = parseTomlString(text, 'CORS_ORIGIN');
  const clerkIssuer = parseTomlString(text, 'CLERK_ISSUER');
  const clerkJwksUrl = parseTomlString(text, 'CLERK_JWKS_URL');
  const clerkAuthorizedParties = parseTomlString(text, 'CLERK_AUTHORIZED_PARTIES') || corsOrigin;
  const stripeAccountId = parseTomlString(text, 'STRIPE_ACCOUNT_ID');
  const stripePriceIds = [
    parseTomlString(text, 'STRIPE_PRICE_STARTER'),
    parseTomlString(text, 'STRIPE_PRICE_VERSUS'),
    parseTomlString(text, 'STRIPE_PRICE_ARCADE'),
  ];
  const turnstileRequired = parseTomlString(text, 'TURNSTILE_REQUIRED');
  const turnstileAction = parseTomlString(text, 'TURNSTILE_ACTION');
  const turnstileHostnames = parseTomlString(text, 'TURNSTILE_HOSTNAMES')
    .split(',')
    .map((hostname) => hostname.trim())
    .filter(Boolean);
  const corsOrigins = configuredOrigins(corsOrigin);
  const authorizedParties = configuredOrigins(clerkAuthorizedParties);
  const expectedFrontendOrigins = ['https://insertplayer.ai', 'https://www.insertplayer.ai'];
  const expectedTurnstileHostnames = ['insertplayer.ai', 'www.insertplayer.ai'];

  if (!databaseId || hasSampleValue(databaseId)) {
    fail('worker/wrangler.toml still needs the real D1 database_id.');
  }
  if (!bucketName || hasSampleValue(bucketName)) {
    fail('worker/wrangler.toml still needs the real R2 bucket_name.');
  }
  if (!corsOrigin || hasSampleValue(corsOrigin)) {
    fail('worker/wrangler.toml needs production CORS_ORIGIN, not a placeholder/local origin.');
  } else if (!corsOrigins.every((origin) => /^https:\/\//i.test(origin))) {
    fail('worker/wrangler.toml CORS_ORIGIN must contain production HTTPS origins only.');
  } else if (corsOrigins.some(hasInternalBrandRisk)) {
    fail('worker/wrangler.toml CORS_ORIGIN must use the cleared public brand domain, not the internal project domain.');
  } else if (
    corsOrigins.length !== expectedFrontendOrigins.length
    || expectedFrontendOrigins.some((origin) => !corsOrigins.includes(origin))
  ) {
    fail('worker/wrangler.toml CORS_ORIGIN must contain only the Insert Player apex and www origins.');
  }
  if (!clerkIssuer || hasSampleValue(clerkIssuer)) {
    fail('worker/wrangler.toml needs production CLERK_ISSUER so Clerk JWT issuer validation is enforced.');
  }
  if (clerkJwksUrl && (hasSampleValue(clerkJwksUrl) || !/^https:\/\//i.test(clerkJwksUrl))) {
    fail('CLERK_JWKS_URL must be an HTTPS JWKS override when set.');
  }
  if (!clerkAuthorizedParties || hasSampleValue(clerkAuthorizedParties)) {
    fail('worker/wrangler.toml needs CLERK_AUTHORIZED_PARTIES or CORS_ORIGIN for Clerk azp validation.');
  } else if (!authorizedParties.every((origin) => /^https:\/\//i.test(origin))) {
    fail('CLERK_AUTHORIZED_PARTIES must contain production HTTPS origins only.');
  } else {
    const missing = corsOrigins.filter((origin) => !authorizedParties.includes(origin));
    if (missing.length > 0) {
      fail(`CLERK_AUTHORIZED_PARTIES must include every CORS_ORIGIN: ${missing.join(', ')}`);
    }
    if (
      authorizedParties.length !== expectedFrontendOrigins.length
      || expectedFrontendOrigins.some((origin) => !authorizedParties.includes(origin))
    ) {
      fail('CLERK_AUTHORIZED_PARTIES must contain only the Insert Player apex and www origins.');
    }
  }
  if (!stripeAccountId || hasSampleValue(stripeAccountId) || !/^acct_[A-Za-z0-9]+$/.test(stripeAccountId)) {
    fail('worker/wrangler.toml must pin billing to the dedicated Insert Player STRIPE_ACCOUNT_ID.');
  }
  if (stripePriceIds.some((priceId) => !priceId || hasSampleValue(priceId) || !/^price_[A-Za-z0-9]+$/.test(priceId))) {
    fail('worker/wrangler.toml must pin all three Insert Player Stripe Price ids.');
  }
  for (const obsoleteGlobalCap of [
    'PROVIDER_MONTHLY_BUDGET_USD_CENTS',
    'GEMINI_SPEND_RATE_LIMIT_USD_CENTS',
  ]) {
    if (parseTomlString(text, obsoleteGlobalCap)) {
      fail(`worker/wrangler.toml must not impose the obsolete ${obsoleteGlobalCap} global spend cap.`);
    }
  }
  if (turnstileRequired !== 'true') {
    fail('worker/wrangler.toml must set TURNSTILE_REQUIRED="true" in production.');
  }
  if (turnstileAction !== 'anonymous_rookie') {
    fail('worker/wrangler.toml must scope Turnstile to the anonymous_rookie action.');
  }
  if (
    turnstileHostnames.length === 0 ||
    turnstileHostnames.some((hostname) => /^(?:localhost|127\.0\.0\.1)$/i.test(hostname))
  ) {
    fail('TURNSTILE_HOSTNAMES must contain production hostnames and no local development hosts.');
  } else if (
    turnstileHostnames.length !== expectedTurnstileHostnames.length
    || expectedTurnstileHostnames.some((hostname) => !turnstileHostnames.includes(hostname))
  ) {
    fail('TURNSTILE_HOSTNAMES must contain only insertplayer.ai and www.insertplayer.ai.');
  }
}

function assertFrontendDeployment() {
  const envFiles = readEnvFiles();
  const frontendUrl = (
    process.env.ASF_FRONTEND_URL ||
    process.env.ASF_FRONTEND_ORIGIN ||
    resolveEnv('ASF_FRONTEND_URL', envFiles) ||
    resolveEnv('ASF_FRONTEND_ORIGIN', envFiles) ||
    firstConfiguredCorsOrigin()
  ).trim().replace(/\/+$/, '');

  if (!frontendUrl || hasSampleValue(frontendUrl) || !/^https:\/\//i.test(frontendUrl)) {
    fail('Production frontend needs an HTTPS ASF_FRONTEND_URL/ASF_FRONTEND_ORIGIN or CORS_ORIGIN.');
    return;
  }
  if (hasInternalBrandRisk(frontendUrl)) {
    fail('Production frontend URL must use the cleared public brand domain, not the internal project domain.');
    return;
  }

  for (const path of [
    '/',
    '/menu',
    '/menu?checkout=success&session_id=readiness',
    '/menu?checkout=cancelled',
    '/community?fighter=readiness',
  ]) {
    const { res, waitedMs } = curlFrontendRoute(`${frontendUrl}${path}`, envFiles, path === '/');
    if (res.status !== 0) {
      const output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
      const message = path === '/'
        ? `Production frontend route ${frontendUrl}${path} did not become ready after ${Math.round(waitedMs / 1000)}s.`
        : `Production frontend route ${frontendUrl}${path} is not reachable.`;
      fail(`${message}\n${output}`);
      continue;
    }
    const html = res.stdout ?? '';
    if (!html.includes('<div id="app"></div>')) {
      fail(`Production frontend route ${frontendUrl}${path} did not serve the app shell.`);
    }
    if (/Nano Banana 2|test-gemini/i.test(html)) {
      fail(`Production frontend route ${frontendUrl}${path} appears to expose a dev/test page.`);
    }
  }
}

function resolveClerkJwksUrl() {
  const text = readFileSync(wranglerTomlPath, 'utf8');
  const clerkIssuer = parseTomlString(text, 'CLERK_ISSUER');
  const explicitJwksUrl = parseTomlString(text, 'CLERK_JWKS_URL');
  if (explicitJwksUrl && !hasSampleValue(explicitJwksUrl)) return explicitJwksUrl;
  if (clerkIssuer && !hasSampleValue(clerkIssuer)) {
    return `${clerkIssuer.replace(/\/+$/, '')}/.well-known/jwks.json`;
  }
  return '';
}

function assertFrontendEnv() {
  const envFiles = readEnvFiles();
  const apiBase = resolveEnv('VITE_API_BASE_URL', envFiles);
  const clerkKey = resolveEnv('VITE_CLERK_PUBLISHABLE_KEY', envFiles);
  const turnstileSiteKey = resolveEnv('VITE_TURNSTILE_SITE_KEY', envFiles);
  const sourceModels = [
    resolveEnv('VITE_GEMINI_IMAGE_MODEL_REPOSE', envFiles),
    resolveEnv('VITE_GEMINI_IMAGE_MODEL_UPRIGHT', envFiles),
    resolveEnv('VITE_GEMINI_IMAGE_MODEL_CROUCH', envFiles),
  ];

  if (!apiBase || hasSampleValue(apiBase) || !/^https:\/\//i.test(apiBase)) {
    fail('Production frontend needs VITE_API_BASE_URL set to the deployed HTTPS Worker URL.');
  } else if (hasInternalBrandRisk(apiBase)) {
    fail('Production frontend VITE_API_BASE_URL must use the cleared public brand Worker/API URL, not the internal Worker URL.');
  }
  if (!clerkKey || hasSampleValue(clerkKey) || !/^pk_live_/i.test(clerkKey)) {
    fail('Production frontend needs VITE_CLERK_PUBLISHABLE_KEY set to a live Clerk publishable key.');
  } else {
    for (const issue of clerkPublishableKeyIssues(clerkKey, {
      expectedEnvironment: 'live',
      expectedFrontendApiHost: INSERT_PLAYER_CLERK_FRONTEND_API_HOST,
    })) {
      fail(`Production VITE_CLERK_PUBLISHABLE_KEY ${issue}.`);
    }
    const decodedClerkKey = decodeClerkPublishableKey(clerkKey);
    const clerkIssuer = parseTomlString(readFileSync(wranglerTomlPath, 'utf8'), 'CLERK_ISSUER');
    if (
      decodedClerkKey
      && clerkIssuer
      && !hasSampleValue(clerkIssuer)
      && clerkIssuer.replace(/\/+$/, '') !== decodedClerkKey.frontendApiOrigin
    ) {
      fail(`Production CLERK_ISSUER must match ${decodedClerkKey.frontendApiOrigin} from the publishable key.`);
    }
  }
  if (!turnstileSiteKey || hasSampleValue(turnstileSiteKey) || !/^0x[A-Za-z0-9_-]{20,}$/.test(turnstileSiteKey)) {
    fail('Production frontend needs VITE_TURNSTILE_SITE_KEY set to the live Insert Player widget.');
  }
  for (const [index, model] of sourceModels.entries()) {
    if (!model || !/pro/i.test(model)) {
      const names = ['VITE_GEMINI_IMAGE_MODEL_REPOSE', 'VITE_GEMINI_IMAGE_MODEL_UPRIGHT', 'VITE_GEMINI_IMAGE_MODEL_CROUCH'];
      fail(`${names[index]} must be set to a Pro source-view model for production.`);
    }
  }
}

function assertClerkJwksReachable() {
  const jwksUrl = resolveClerkJwksUrl();
  if (!jwksUrl) return;
  if (!/^https:\/\//i.test(jwksUrl)) {
    fail('CLERK_JWKS_URL must resolve to an HTTPS URL.');
    return;
  }

  const res = curl(['-fsS', jwksUrl]);
  if (res.status !== 0) {
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
    fail(`Clerk JWKS check failed for ${jwksUrl}.\n${output}`);
    return;
  }

  let jwks;
  try {
    jwks = JSON.parse(res.stdout ?? '{}');
  } catch {
    fail(`Clerk JWKS check did not return JSON for ${jwksUrl}.`);
    return;
  }

  if (!Array.isArray(jwks?.keys) || jwks.keys.length === 0) {
    fail(`Clerk JWKS check returned no keys for ${jwksUrl}.`);
  }
}

function assertWranglerAuth() {
  const whoami = run(npx, ['wrangler', 'whoami'], workerDir);
  const output = `${whoami.stdout ?? ''}${whoami.stderr ?? ''}`.trim();
  const issue = wranglerAuthIssue({
    status: whoami.status,
    output,
    expectedAccountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
  });
  if (issue) {
    fail(`Wrangler is not authenticated for the expected account: ${issue}.\n${output}`);
    return false;
  }
  return true;
}

function assertWorkerSecrets() {
  const secretList = run(npx, ['wrangler', 'secret', 'list'], workerDir);
  if (secretList.status !== 0) {
    const output = `${secretList.stdout ?? ''}${secretList.stderr ?? ''}`.trim();
    fail(`Could not list Worker secrets.\n${output}`);
    return;
  }
  const output = secretList.stdout ?? '';
  const missing = requiredSecrets.filter((secret) => !output.includes(secret));
  if (missing.length > 0) {
    fail(`Missing Worker secrets: ${missing.join(', ')}`);
  }
}

function assertR2TempLifecycle() {
  const text = readFileSync(wranglerTomlPath, 'utf8');
  const bucketName = parseTomlString(text, 'bucket_name');
  if (!bucketName || hasSampleValue(bucketName)) return;

  const jurisdiction = parseTomlString(text, 'jurisdiction');
  const lifecycleArgs = ['wrangler', 'r2', 'bucket', 'lifecycle', 'list', bucketName];
  if (jurisdiction) lifecycleArgs.push('--jurisdiction', jurisdiction);
  const lifecycle = run(npx, lifecycleArgs, workerDir);
  if (lifecycle.status !== 0) {
    const output = `${lifecycle.stdout ?? ''}${lifecycle.stderr ?? ''}`.trim();
    fail(`Could not list R2 lifecycle rules for ${bucketName}.\n${output}`);
    return;
  }

  const output = lifecycle.stdout ?? '';
  if (!/prefix:\s*temp\//i.test(output) || !/Expire objects after 1 days/i.test(output)) {
    fail(`R2 bucket ${bucketName} needs a lifecycle rule expiring temp/ objects after 1 day.`);
  }
}

function assertRemoteD1Schema() {
  const text = readFileSync(wranglerTomlPath, 'utf8');
  const databaseName = parseTomlString(text, 'database_name');
  if (!databaseName || hasSampleValue(databaseName)) return;

  const schema = run(npx, [
    'wrangler',
    'd1',
    'execute',
    databaseName,
    '--remote',
    '--command',
    'SELECT name FROM sqlite_master WHERE type = "table" ORDER BY name;',
  ], workerDir);
  if (schema.status !== 0) {
    const output = `${schema.stdout ?? ''}${schema.stderr ?? ''}`.trim();
    fail(`Could not query remote D1 schema for ${databaseName}.\n${output}`);
    return;
  }

  const output = schema.stdout ?? '';
  const requiredTables = [
    'users',
    'fighters',
    'sprites',
    'sprite_versions',
    'source_versions',
    'generation_charges',
    'provider_sessions',
    'checkout_sessions',
    'stripe_events',
    'clerk_webhook_events',
    'clerk_user_tombstones',
    'rate_limits',
    'matches',
    'legal_acceptances',
    'stripe_credit_adjustments',
    'community_reports',
    'provider_spend_months',
    'provider_spend_reservations',
    'provider_meterkey_capacity_windows',
    'provider_cost_events',
    'generation_jobs',
    'generation_job_events',
    'provider_request_cache',
    'arcade_fighters',
  ];
  const missing = requiredTables.filter((table) => !output.includes(`"name": "${table}"`));
  if (missing.length > 0) {
    fail(`Remote D1 database ${databaseName} is missing tables: ${missing.join(', ')}`);
  }

  const stripeEventColumns = run(npx, [
    'wrangler',
    'd1',
    'execute',
    databaseName,
    '--remote',
    '--command',
    'SELECT user_id FROM stripe_events LIMIT 0;',
  ], workerDir);
  if (stripeEventColumns.status !== 0) {
    const columnOutput = `${stripeEventColumns.stdout ?? ''}${stripeEventColumns.stderr ?? ''}`.trim();
    fail(`Remote D1 database ${databaseName} is missing migration 0010 stripe event minimization.\n${columnOutput}`);
  }

  const legalColumns = run(npx, [
    'wrangler',
    'd1',
    'execute',
    databaseName,
    '--remote',
    '--command',
    'SELECT legal_version, withdrawal_loss_acknowledged FROM provider_sessions LIMIT 0;',
  ], workerDir);
  if (legalColumns.status !== 0) {
    const columnOutput = `${legalColumns.stdout ?? ''}${legalColumns.stderr ?? ''}`.trim();
    fail(`Remote D1 database ${databaseName} is missing migration 0011 legal consent fields.\n${columnOutput}`);
  }

  const refundColumns = run(npx, [
    'wrangler',
    'd1',
    'execute',
    databaseName,
    '--remote',
    '--command',
    'SELECT stripe_payment_intent_id, refunded_credits, disputed_credits, reversed_credits FROM checkout_sessions LIMIT 0;',
  ], workerDir);
  if (refundColumns.status !== 0) {
    const columnOutput = `${refundColumns.stdout ?? ''}${refundColumns.stderr ?? ''}`.trim();
    fail(`Remote D1 database ${databaseName} is missing migration 0012 Stripe adjustment fields.\n${columnOutput}`);
  }

  const moderationColumns = run(npx, [
    'wrangler',
    'd1',
    'execute',
    databaseName,
    '--remote',
    '--command',
    'SELECT reason, status, submission_count, reviewed_by_user_id FROM community_reports LIMIT 0;',
  ], workerDir);
  if (moderationColumns.status !== 0) {
    const columnOutput = `${moderationColumns.stdout ?? ''}${moderationColumns.stderr ?? ''}`.trim();
    fail(`Remote D1 database ${databaseName} is missing migration 0013 community moderation fields.\n${columnOutput}`);
  }

  const providerSpendColumns = run(npx, [
    'wrangler',
    'd1',
    'execute',
    databaseName,
    '--remote',
    '--command',
    'SELECT provider_cost_used_cents, provider_cost_limit_cents FROM provider_sessions LIMIT 0;',
  ], workerDir);
  if (providerSpendColumns.status !== 0) {
    const columnOutput = `${providerSpendColumns.stdout ?? ''}${providerSpendColumns.stderr ?? ''}`.trim();
    fail(`Remote D1 database ${databaseName} is missing migration 0014 provider spend fields.\n${columnOutput}`);
  }

  const assetIndexes = run(npx, [
    'wrangler',
    'd1',
    'execute',
    databaseName,
    '--remote',
    '--command',
    'SELECT name FROM sqlite_master WHERE type = "index" AND name IN ("idx_fighters_side_view_blob", "idx_fighters_upright_view_blob", "idx_fighters_crouch_view_blob", "idx_sprites_blob", "idx_stages_blob") ORDER BY name;',
  ], workerDir);
  if (assetIndexes.status !== 0) {
    const indexOutput = `${assetIndexes.stdout ?? ''}${assetIndexes.stderr ?? ''}`.trim();
    fail(`Could not verify migration 0015 asset lookup indexes for ${databaseName}.\n${indexOutput}`);
  } else {
    const indexOutput = assetIndexes.stdout ?? '';
    const requiredIndexes = [
      'idx_fighters_side_view_blob',
      'idx_fighters_upright_view_blob',
      'idx_fighters_crouch_view_blob',
      'idx_sprites_blob',
      'idx_stages_blob',
    ];
    const missingIndexes = requiredIndexes.filter((index) => !indexOutput.includes(`"name": "${index}"`));
    if (missingIndexes.length > 0) {
      fail(`Remote D1 database ${databaseName} is missing migration 0015 indexes: ${missingIndexes.join(', ')}`);
    }
  }

  const spendRateWindow = run(npx, [
    'wrangler',
    'd1',
    'execute',
    databaseName,
    '--remote',
    '--command',
    'SELECT id, provider, model_path, estimated_cost_cents, created_at_epoch FROM provider_spend_reservations LIMIT 0;',
  ], workerDir);
  if (spendRateWindow.status !== 0) {
    const windowOutput = `${spendRateWindow.stdout ?? ''}${spendRateWindow.stderr ?? ''}`.trim();
    fail(`Remote D1 database ${databaseName} is missing migration 0016 provider spend-rate window.\n${windowOutput}`);
  }

  const providerCostEvents = run(npx, [
    'wrangler',
    'd1',
    'execute',
    databaseName,
    '--remote',
    '--command',
    'SELECT id, billing_operation, provider, estimated_cost_cents, outcome FROM provider_cost_events LIMIT 0;',
  ], workerDir);
  if (providerCostEvents.status !== 0) {
    const costOutput = `${providerCostEvents.stdout ?? ''}${providerCostEvents.stderr ?? ''}`.trim();
    fail(`Remote D1 database ${databaseName} is missing migration 0017 provider cost events.\n${costOutput}`);
  }

  const zeroCostEvents = run(npx, [
    'wrangler',
    'd1',
    'execute',
    databaseName,
    '--remote',
    '--command',
    `SELECT CASE WHEN instr(sql, 'estimated_cost_cents INTEGER NOT NULL CHECK (estimated_cost_cents >= 0)') > 0
      THEN 1 ELSE 0 END AS zero_cost_enabled
     FROM sqlite_master WHERE type = 'table' AND name = 'provider_cost_events';`,
  ], workerDir);
  const zeroCostOutput = `${zeroCostEvents.stdout ?? ''}${zeroCostEvents.stderr ?? ''}`.trim();
  if (zeroCostEvents.status !== 0 || !zeroCostOutput.includes('"zero_cost_enabled": 1')) {
    fail(`Remote D1 database ${databaseName} is missing migration 0026 zero-cost not-dispatched events.\n${zeroCostOutput}`);
  }

  const meterkeyCapacity = run(npx, [
    'wrangler',
    'd1',
    'execute',
    databaseName,
    '--remote',
    '--command',
    'SELECT provider, model, reason, retry_at_epoch FROM provider_meterkey_capacity_windows LIMIT 0;',
  ], workerDir);
  if (meterkeyCapacity.status !== 0) {
    const capacityOutput = `${meterkeyCapacity.stdout ?? ''}${meterkeyCapacity.stderr ?? ''}`.trim();
    fail(`Remote D1 database ${databaseName} is missing migration 0025 Meterkey capacity windows.\n${capacityOutput}`);
  }

  const durableGeneration = run(npx, [
    'wrangler',
    'd1',
    'execute',
    databaseName,
    '--remote',
    '--command',
    'SELECT id, workflow_instance_id, provider_session_id, progress_total FROM generation_jobs LIMIT 0;',
  ], workerDir);
  if (durableGeneration.status !== 0) {
    const generationOutput = `${durableGeneration.stdout ?? ''}${durableGeneration.stderr ?? ''}`.trim();
    fail(`Remote D1 database ${databaseName} is missing migration 0018 durable generation jobs.\n${generationOutput}`);
  }

  const generationIndexes = run(npx, [
    'wrangler',
    'd1',
    'execute',
    databaseName,
    '--remote',
    '--command',
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_generation_jobs_active_fighter', 'idx_provider_request_cache_job');",
  ], workerDir);
  const indexOutput = generationIndexes.stdout ?? '';
  if (
    generationIndexes.status !== 0
    || !indexOutput.includes('idx_generation_jobs_active_fighter')
    || !indexOutput.includes('idx_provider_request_cache_job')
  ) {
    fail(`Remote D1 database ${databaseName} is missing durable-generation indexes.\n${`${generationIndexes.stdout ?? ''}${generationIndexes.stderr ?? ''}`.trim()}`);
  }

  const arcadeColumns = run(npx, [
    'wrangler',
    'd1',
    'execute',
    databaseName,
    '--remote',
    '--command',
    'SELECT fighter_id, slug, sort_order, challenger_line, default_personality, reference_kind, generation_prompt, status FROM arcade_fighters LIMIT 0;',
  ], workerDir);
  if (arcadeColumns.status !== 0) {
    const arcadeOutput = `${arcadeColumns.stdout ?? ''}${arcadeColumns.stderr ?? ''}`.trim();
    fail(`Remote D1 database ${databaseName} is missing migrations 0020-0021 official Arcade fields.\n${arcadeOutput}`);
  }
}

function resolveWorkerHealthUrl() {
  const envFiles = readEnvFiles();
  const explicit = (
    process.env.ASF_WORKER_HEALTH_URL ||
    resolveEnv('ASF_WORKER_HEALTH_URL', envFiles)
  ).trim();
  if (explicit) return explicit;

  const workerBase = (
    process.env.ASF_WORKER_URL ||
    process.env.VITE_API_BASE_URL ||
    resolveEnv('ASF_WORKER_URL', envFiles) ||
    resolveEnv('VITE_API_BASE_URL', envFiles)
  ).trim().replace(/\/+$/, '');
  return workerBase ? `${workerBase}/health` : '';
}

async function assertLiveHealth() {
  const healthUrl = resolveWorkerHealthUrl();
  if (!healthUrl || hasSampleValue(healthUrl)) {
    fail('Live readiness needs ASF_WORKER_HEALTH_URL, ASF_WORKER_URL, or VITE_API_BASE_URL so Worker /health can verify auth and billing mode.');
    return;
  }
  if (!/^https:\/\//i.test(healthUrl)) {
    fail('ASF_WORKER_HEALTH_URL must be an HTTPS URL.');
    return;
  }
  if (hasInternalBrandRisk(healthUrl)) {
    fail('ASF_WORKER_HEALTH_URL/ASF_WORKER_URL/VITE_API_BASE_URL must use the cleared public brand Worker/API URL, not the internal Worker URL.');
    return;
  }
  const res = await curlHttpsWithPublicDnsFallback(['-fsS'], healthUrl);
  if (res.status !== 0) {
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
    fail(`Live health check failed for ${healthUrl}.\n${output}`);
    return;
  }

  let health;
  try {
    health = JSON.parse(res.stdout ?? '{}');
  } catch {
    fail(`Live health check did not return JSON for ${healthUrl}.`);
    return;
  }

  const expected = [
    ['status', 'ok'],
    ['environment', 'production'],
    ['cors', 'configured'],
    ['auth', 'clerk'],
    ['accountLifecycle', 'clerk_webhook'],
    ['billing', 'stripe'],
    ['turnstile', 'configured'],
    ['anonymousRookie', 'enabled'],
    ['providerAccounting', 'durable'],
    ['providerSessionLimits', 'configured'],
    ['providerGlobalCaps', 'disabled'],
    ['geminiTransport', 'meterkey'],
    ['providers', 'configured'],
    ['durableGeneration', 'configured'],
    ['privacy', 'pseudonymized'],
  ];
  for (const [key, value] of expected) {
    if (health?.[key] !== value) {
      fail(`Live health ${key} should be ${value}; got ${String(health?.[key] ?? 'missing')}.`);
    }
  }
  if (health?.storage?.d1 !== 'bound' || health?.storage?.r2 !== 'bound') {
    fail('Live health must report D1 and R2 bindings as bound.');
  }
}

const nodeVersionOk = assertNodeVersion();
assertWranglerConfig();
assertFrontendEnv();
assertFrontendDeployment();
assertClerkJwksReachable();
if (nodeVersionOk && assertWranglerAuth()) {
  assertWorkerSecrets();
  assertR2TempLifecycle();
  assertRemoteD1Schema();
}
await assertLiveHealth();

if (errors.length > 0) {
  console.error(`Live readiness checks failed:\n- ${errors.join('\n- ')}`);
  process.exit(1);
}

console.log('Live readiness checks passed.');
