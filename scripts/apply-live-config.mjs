import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stripeBusinessProfileIssues } from './stripe-business-profile.mjs';
import {
  INSERT_PLAYER_CLERK_FRONTEND_API_HOST,
  clerkPublishableKeyIssues,
  decodeClerkPublishableKey,
} from './clerk-publishable-key.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workerDir = join(root, 'worker');
const wranglerTomlPath = join(workerDir, 'wrangler.toml');
const envProductionPath = join(root, '.env.production');
const wranglerLogPath = join(root, '.wrangler-logs');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const args = new Set(process.argv.slice(2));
const SECRET_PUT_TIMEOUT_MS = 120_000;
const DEPLOY_TIMEOUT_MS = 300_000;
const PRODUCTION_CHECK_TIMEOUT_MS = 300_000;

const defaultWorkerUrl = 'https://api.insertplayer.ai';
const defaultFrontendOrigin = 'https://insertplayer.ai';
const defaultCorsOrigins = 'https://insertplayer.ai,https://www.insertplayer.ai';
const defaultSourceModel = 'gemini-3-pro-image';
const defaultTurnstileHostnames = 'insertplayer.ai,www.insertplayer.ai';

const secretKeys = [
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

const requiredKeys = [
  'VITE_CLERK_PUBLISHABLE_KEY',
  'VITE_TURNSTILE_SITE_KEY',
  'STRIPE_ACCOUNT_ID',
  'STRIPE_PRICE_STARTER',
  'STRIPE_PRICE_VERSUS',
  'STRIPE_PRICE_ARCADE',
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
  'Fighter Lab',
  'pk_test_',
  'sk_test_',
  'pk_live_replace_me',
  'pk_live_...',
  'sk_live_...',
  'sk_test_replace_me',
  'acct_replace_me',
  'price_replace_me',
  'whsec_replace_me',
  '127.0.0.1',
  'localhost',
];

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
  for (const file of ['.env.production.local', '.env.production', '.env.local', '.env', 'worker/.prod.vars']) {
    const path = join(root, file);
    if (existsSync(path)) parseEnvText(readFileSync(path, 'utf8'), values);
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value) values.set(key, value);
  }
  return values;
}

function hasSampleValue(value) {
  return sampleFragments.some((fragment) => value.toLowerCase().includes(fragment.toLowerCase()));
}

function hasInternalBrandRisk(value) {
  return /(^|[^a-z0-9])(?:ai[\s_-]*)?street[\s_-]*fighter([^a-z0-9]|$)/i.test(value) || /\bcapcom\b/i.test(value);
}

function readValue(values, key) {
  const value = values.get(key)?.trim() ?? '';
  return value && !hasSampleValue(value) ? value : '';
}

function configuredOrigins(value) {
  return value
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function assertLiveShape(errors, label, value, predicate, message) {
  if (!value || !predicate(value)) {
    errors.push(`${label}: ${message}`);
  }
}

function resolveLocalPath(value, fallback) {
  const path = String(value || fallback).trim();
  return path.startsWith('/') ? path : join(root, path);
}

function assertBrandClearance(errors, values, publicAppName, publicShortName, frontendOrigin) {
  const path = resolveLocalPath(readValue(values, 'ASF_BRAND_CLEARANCE_FILE'), '.brand-clearance.json');
  if (!existsSync(path)) {
    errors.push(`ASF_BRAND_CLEARANCE_FILE: required at ${path} before live config.`);
    return;
  }
  let clearance;
  try {
    clearance = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    errors.push(`ASF_BRAND_CLEARANCE_FILE: could not parse ${path}: ${detail}`);
    return;
  }
  if (clearance.clearanceStatus !== 'cleared_for_launch') {
    errors.push('Brand clearance clearanceStatus must be "cleared_for_launch".');
  }
  if (String(clearance.publicBrandName ?? '').trim() !== publicAppName) {
    errors.push('PUBLIC_APP_NAME/ASF_PUBLIC_APP_NAME/VITE_PUBLIC_APP_NAME must match brand clearance publicBrandName.');
  }
  if (String(clearance.publicShortName ?? '').trim() !== publicShortName) {
    errors.push('PUBLIC_APP_SHORT_NAME/ASF_PUBLIC_APP_SHORT_NAME/VITE_PUBLIC_APP_SHORT_NAME must match brand clearance publicShortName.');
  }
  if (String(clearance.productionOrigin ?? '').replace(/\/+$/, '') !== frontendOrigin) {
    errors.push('Brand clearance productionOrigin must match the primary ASF_FRONTEND_ORIGIN.');
  }
}

function escapeTomlString(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function upsertTomlVars(vars) {
  let text = readFileSync(wranglerTomlPath, 'utf8');
  const varsHeader = text.match(/^\[vars]\s*$/m);
  if (!varsHeader) {
    text = `[vars]\n${text}`;
  }

  for (const [key, value] of Object.entries(vars)) {
    if (!value) continue;
    const replacement = `${key} = "${escapeTomlString(value)}"`;
    const active = new RegExp(`^\\s*${key}\\s*=\\s*"[^"]*"`, 'm');
    const commented = new RegExp(`^\\s*#\\s*${key}\\s*=\\s*"[^"]*"`, 'm');
    if (active.test(text)) {
      text = text.replace(active, replacement);
    } else if (commented.test(text)) {
      text = text.replace(commented, replacement);
    } else {
      const header = text.match(/^\[vars]\s*$/m);
      if (!header) throw new Error('Unable to locate [vars] in worker/wrangler.toml');
      const insertAt = header.index + header[0].length;
      text = `${text.slice(0, insertAt)}\n${replacement}${text.slice(insertAt)}`;
    }
  }

  writeFileSync(wranglerTomlPath, text);
}

function ensureEnvFile() {
  if (existsSync(envProductionPath)) return readFileSync(envProductionPath, 'utf8');
  return '# Production frontend env. Do not commit real values.\n';
}

function upsertEnvValue(text, key, value) {
  if (!value) return text;
  const replacement = `${key}=${value}`;
  const active = new RegExp(`^${key}=.*$`, 'm');
  const commented = new RegExp(`^#\\s*${key}=.*$`, 'm');
  if (active.test(text)) return text.replace(active, replacement);
  if (commented.test(text)) return text.replace(commented, replacement);
  return `${text.replace(/\s*$/, '')}\n${replacement}\n`;
}

function writeFrontendEnv(values) {
  const workerUrl = readValue(values, 'VITE_API_BASE_URL') || readValue(values, 'ASF_WORKER_URL') || defaultWorkerUrl;
  let text = ensureEnvFile();
  text = upsertEnvValue(text, 'VITE_API_BASE_URL', workerUrl);
  text = upsertEnvValue(text, 'VITE_CLERK_PUBLISHABLE_KEY', readValue(values, 'VITE_CLERK_PUBLISHABLE_KEY'));
  text = upsertEnvValue(text, 'VITE_PUBLIC_APP_NAME', readValue(values, 'VITE_PUBLIC_APP_NAME') || readValue(values, 'ASF_PUBLIC_APP_NAME'));
  text = upsertEnvValue(text, 'VITE_PUBLIC_APP_SHORT_NAME', readValue(values, 'VITE_PUBLIC_APP_SHORT_NAME') || readValue(values, 'ASF_PUBLIC_APP_SHORT_NAME'));
  text = upsertEnvValue(text, 'VITE_TURNSTILE_SITE_KEY', readValue(values, 'VITE_TURNSTILE_SITE_KEY'));
  text = upsertEnvValue(text, 'VITE_INTRO_VIDEO_PROVIDER', readValue(values, 'VITE_INTRO_VIDEO_PROVIDER') || 'fal-ltx-v2-3-fast');
  text = upsertEnvValue(text, 'VITE_BG_REMOVAL_PROVIDER', readValue(values, 'VITE_BG_REMOVAL_PROVIDER') || 'fal');
  text = upsertEnvValue(text, 'VITE_GEMINI_IMAGE_MODEL_REPOSE', readValue(values, 'VITE_GEMINI_IMAGE_MODEL_REPOSE') || defaultSourceModel);
  text = upsertEnvValue(text, 'VITE_GEMINI_IMAGE_MODEL_UPRIGHT', readValue(values, 'VITE_GEMINI_IMAGE_MODEL_UPRIGHT') || defaultSourceModel);
  text = upsertEnvValue(text, 'VITE_GEMINI_IMAGE_MODEL_CROUCH', readValue(values, 'VITE_GEMINI_IMAGE_MODEL_CROUCH') || defaultSourceModel);
  writeFileSync(envProductionPath, text.endsWith('\n') ? text : `${text}\n`);
}

function wranglerEnv() {
  mkdirSync(wranglerLogPath, { recursive: true });
  return {
    ...process.env,
    WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH || wranglerLogPath,
  };
}

function putSecret(key, value) {
  const result = spawnSync(npx, ['wrangler', 'secret', 'put', key], {
    cwd: workerDir,
    input: value,
    encoding: 'utf8',
    env: wranglerEnv(),
    timeout: SECRET_PUT_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.replaceAll(value, '<redacted>').trim();
    throw new Error(`${key}: failed to set Worker secret${output ? `\n${output}` : ''}`);
  }
}

function runWranglerDeploy() {
  const result = spawnSync(npx, ['wrangler', 'deploy', '--keep-vars'], {
    cwd: workerDir,
    encoding: 'utf8',
    stdio: 'inherit',
    env: wranglerEnv(),
    timeout: DEPLOY_TIMEOUT_MS,
  });
  if (result.status !== 0) throw new Error('Worker deploy failed');
}

function runProductionCheck() {
  const result = spawnSync(npm, ['run', 'check:production'], {
    cwd: root,
    encoding: 'utf8',
    stdio: 'inherit',
    env: process.env,
    timeout: PRODUCTION_CHECK_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    throw new Error('Production checks failed; live config was not applied.');
  }
}

async function fetchStripeAccount(secretKey) {
  const response = await fetch('https://api.stripe.com/v1/account', {
    headers: { Authorization: `Bearer ${secretKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body?.id !== 'string') {
    throw new Error(`Stripe account lookup failed (${response.status}).`);
  }
  return body;
}

async function fetchStripePrice(secretKey, priceId) {
  const response = await fetch(`https://api.stripe.com/v1/prices/${encodeURIComponent(priceId)}?expand[]=product`, {
    headers: { Authorization: `Bearer ${secretKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body?.id !== 'string') {
    throw new Error(`Stripe price lookup failed for ${priceId} (${response.status}).`);
  }
  return body;
}

async function validateRequired(values) {
  const errors = [];
  const missing = requiredKeys.filter((key) => !readValue(values, key));
  const workerUrl = readValue(values, 'VITE_API_BASE_URL') || readValue(values, 'ASF_WORKER_URL');
  const clerkIssuer = readValue(values, 'CLERK_ISSUER');
  const clerkJwksUrl = readValue(values, 'CLERK_JWKS_URL');
  const explicitFrontendOrigin = readValue(values, 'ASF_FRONTEND_ORIGIN');
  const frontendOrigin = explicitFrontendOrigin || defaultFrontendOrigin;
  const corsOriginValue = readValue(values, 'CORS_ORIGIN') || defaultCorsOrigins;
  const corsOrigins = configuredOrigins(corsOriginValue);
  const authorizedParties = configuredOrigins(readValue(values, 'CLERK_AUTHORIZED_PARTIES') || corsOriginValue);
  const publicAppName = readValue(values, 'PUBLIC_APP_NAME') || readValue(values, 'ASF_PUBLIC_APP_NAME') || readValue(values, 'VITE_PUBLIC_APP_NAME');
  const publicShortName = readValue(values, 'PUBLIC_APP_SHORT_NAME') || readValue(values, 'ASF_PUBLIC_APP_SHORT_NAME') || readValue(values, 'VITE_PUBLIC_APP_SHORT_NAME');
  const turnstileSiteKey = readValue(values, 'VITE_TURNSTILE_SITE_KEY');
  const clerkPublishableKey = readValue(values, 'VITE_CLERK_PUBLISHABLE_KEY');
  const turnstileSecret = readValue(values, 'TURNSTILE_SECRET_KEY');
  const anonymizationSecret = readValue(values, 'ANONYMIZATION_SECRET');
  const generationJobSigningSecret = readValue(values, 'GENERATION_JOB_SIGNING_SECRET');
  const clerkBackendAuthBridgeSecret = readValue(values, 'CLERK_BACKEND_AUTH_BRIDGE_SECRET');
  const turnstileHostnames = readValue(values, 'TURNSTILE_HOSTNAMES') || defaultTurnstileHostnames;
  const stripeSecret = readValue(values, 'STRIPE_SECRET_KEY');
  const stripeAccountId = readValue(values, 'STRIPE_ACCOUNT_ID');
  const stripePrices = [
    ['STRIPE_PRICE_STARTER', 'starter', 1499],
    ['STRIPE_PRICE_VERSUS', 'versus', 2499],
    ['STRIPE_PRICE_ARCADE', 'arcade', 5699],
  ].map(([key, packId, amountCents]) => ({
    key,
    packId,
    amountCents,
    priceId: readValue(values, key),
  }));
  const forbiddenStripeAccountIds = readValue(values, 'ASF_FORBIDDEN_STRIPE_ACCOUNT_IDS')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (!clerkIssuer) {
    missing.unshift('CLERK_ISSUER');
  }
  if (!workerUrl) {
    missing.unshift('VITE_API_BASE_URL or ASF_WORKER_URL');
  }
  if (!explicitFrontendOrigin) {
    missing.unshift('ASF_FRONTEND_ORIGIN');
  }
  if (missing.length > 0) {
    errors.push(`Missing live config: ${missing.join(', ')}`);
  }

  assertLiveShape(
    errors,
    'VITE_API_BASE_URL/ASF_WORKER_URL',
    workerUrl,
    (value) => isHttpsUrl(value) && !hasInternalBrandRisk(value),
    'must be the deployed HTTPS Worker/API URL for the cleared public brand, not the internal Worker URL.',
  );
  assertLiveShape(
    errors,
    'VITE_CLERK_PUBLISHABLE_KEY',
    clerkPublishableKey,
    (value) => /^pk_live_/i.test(value),
    'must be a live Clerk publishable key starting with pk_live_.',
  );
  if (clerkPublishableKey) {
    for (const issue of clerkPublishableKeyIssues(clerkPublishableKey, {
      expectedEnvironment: 'live',
      expectedFrontendApiHost: INSERT_PLAYER_CLERK_FRONTEND_API_HOST,
    })) {
      errors.push(`VITE_CLERK_PUBLISHABLE_KEY ${issue}.`);
    }
    const decodedClerkKey = decodeClerkPublishableKey(clerkPublishableKey);
    if (
      decodedClerkKey
      && clerkIssuer
      && clerkIssuer.replace(/\/+$/, '') !== decodedClerkKey.frontendApiOrigin
    ) {
      errors.push(`CLERK_ISSUER must match the publishable key Frontend API origin ${decodedClerkKey.frontendApiOrigin}.`);
    }
  }
  assertLiveShape(errors, 'CLERK_ISSUER', clerkIssuer, isHttpsUrl, 'must be an HTTPS Clerk issuer URL.');
  if (clerkJwksUrl) {
    assertLiveShape(errors, 'CLERK_JWKS_URL', clerkJwksUrl, isHttpsUrl, 'must be an HTTPS Clerk JWKS URL.');
  }
  assertLiveShape(
    errors,
    'CLERK_WEBHOOK_SIGNING_SECRET',
    readValue(values, 'CLERK_WEBHOOK_SIGNING_SECRET'),
    (value) => /^whsec_[A-Za-z0-9+/=_-]+$/i.test(value),
    'must be the signing secret for the isolated Insert Player Clerk webhook.',
  );
  assertLiveShape(
    errors,
    'STRIPE_ACCOUNT_ID',
    stripeAccountId,
    (value) => /^acct_[A-Za-z0-9]+$/.test(value),
    'must be the dedicated Insert Player Stripe account id starting with acct_.',
  );
  for (const price of stripePrices) {
    assertLiveShape(
      errors,
      price.key,
      price.priceId,
      (value) => /^price_[A-Za-z0-9]+$/.test(value),
      `must be the dedicated Insert Player ${price.packId} Price id.`,
    );
  }
  assertLiveShape(
    errors,
    'STRIPE_SECRET_KEY',
    stripeSecret,
    (value) => /^sk_live_/i.test(value),
    'must be a live Stripe secret key starting with sk_live_. Use a non-live helper run only for prelaunch test-mode checkout.',
  );
  assertLiveShape(
    errors,
    'STRIPE_WEBHOOK_SECRET',
    readValue(values, 'STRIPE_WEBHOOK_SECRET'),
    (value) => /^whsec_/i.test(value),
    'must be a Stripe webhook signing secret starting with whsec_.',
  );
  if (stripeAccountId && forbiddenStripeAccountIds.includes(stripeAccountId)) {
    errors.push('STRIPE_ACCOUNT_ID points at a forbidden shared account; use the dedicated Insert Player Stripe account.');
  }
  if (/^acct_[A-Za-z0-9]+$/.test(stripeAccountId) && /^sk_live_/i.test(stripeSecret)) {
    try {
      const stripeAccount = await fetchStripeAccount(stripeSecret);
      if (stripeAccount.id !== stripeAccountId) {
        errors.push('STRIPE_SECRET_KEY does not belong to STRIPE_ACCOUNT_ID. Refusing to mix billing accounts.');
      } else {
        const profileIssues = stripeBusinessProfileIssues(stripeAccount);
        if (profileIssues.length > 0) {
          errors.push(`Stripe live business profile is incomplete: ${profileIssues.join(', ')}.`);
        }
        for (const expected of stripePrices) {
          if (!/^price_[A-Za-z0-9]+$/.test(expected.priceId)) continue;
          const price = await fetchStripePrice(stripeSecret, expected.priceId);
          const productTaxCode = typeof price.product?.tax_code === 'string'
            ? price.product.tax_code
            : price.product?.tax_code?.id;
          if (
            price.active !== true || String(price.currency ?? '').toLowerCase() !== 'eur' ||
            price.unit_amount !== expected.amountCents ||
            price.tax_behavior !== 'inclusive' || productTaxCode !== 'txcd_10201000' ||
            price.product?.metadata?.insert_player_pack_id !== expected.packId
          ) {
            errors.push(`${expected.key} does not match the locked Insert Player ${expected.packId} catalog definition.`);
          }
        }
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : 'Stripe account lookup failed.');
    }
  }
  assertLiveShape(
    errors,
    'VITE_TURNSTILE_SITE_KEY',
    turnstileSiteKey,
    (value) => /^0x[A-Za-z0-9_-]{20,}$/.test(value),
    'must be the production Insert Player Turnstile site key.',
  );
  assertLiveShape(
    errors,
    'TURNSTILE_SECRET_KEY',
    turnstileSecret,
    (value) => /^0x[A-Za-z0-9_-]{20,}$/.test(value),
    'must be the matching Turnstile Worker secret.',
  );
  assertLiveShape(
    errors,
    'ANONYMIZATION_SECRET',
    anonymizationSecret,
    (value) => value.length >= 32,
    'must be a random Worker secret of at least 32 characters.',
  );
  assertLiveShape(
    errors,
    'GENERATION_JOB_SIGNING_SECRET',
    generationJobSigningSecret,
    (value) => value.length >= 32,
    'must be a random Worker secret of at least 32 characters.',
  );
  assertLiveShape(
    errors,
    'CLERK_BACKEND_AUTH_BRIDGE_SECRET',
    clerkBackendAuthBridgeSecret,
    (value) => value.length >= 32,
    'must be a distinct random Worker secret of at least 32 characters.',
  );
  if (
    clerkBackendAuthBridgeSecret
    && [anonymizationSecret, generationJobSigningSecret].includes(clerkBackendAuthBridgeSecret)
  ) {
    errors.push('CLERK_BACKEND_AUTH_BRIDGE_SECRET must not reuse another Worker secret.');
  }
  const turnstileHosts = turnstileHostnames.split(',').map((host) => host.trim()).filter(Boolean);
  const requiredFrontendOrigins = configuredOrigins(defaultCorsOrigins);
  const requiredTurnstileHosts = defaultTurnstileHostnames.split(',');
  if (
    turnstileHosts.length === 0 ||
    turnstileHosts.some((host) => !/^(?:[a-z0-9-]+\.)+[a-z0-9-]+$/i.test(host) || /^(?:localhost|127\.0\.0\.1)$/i.test(host))
  ) {
    errors.push('TURNSTILE_HOSTNAMES must contain production hostnames only.');
  }
  if (corsOrigins.length === 0 || !corsOrigins.every(isHttpsUrl)) {
    errors.push('ASF_FRONTEND_ORIGIN/CORS_ORIGIN must contain production HTTPS origins only.');
  } else if (corsOrigins.some(hasInternalBrandRisk)) {
    errors.push('ASF_FRONTEND_ORIGIN/CORS_ORIGIN must use the cleared public brand domain, not the internal project domain.');
  } else if (
    corsOrigins.length !== requiredFrontendOrigins.length
    || requiredFrontendOrigins.some((origin) => !corsOrigins.includes(origin))
  ) {
    errors.push(`CORS_ORIGIN must contain exactly ${defaultCorsOrigins}; production Clerk keys do not support the Pages preview domain.`);
  }
  if (authorizedParties.length === 0 || !authorizedParties.every(isHttpsUrl)) {
    errors.push('CLERK_AUTHORIZED_PARTIES must contain production HTTPS origins only.');
  } else {
    const missingParties = corsOrigins.filter((origin) => !authorizedParties.includes(origin));
    if (missingParties.length > 0) {
      errors.push(`CLERK_AUTHORIZED_PARTIES must include every frontend origin: ${missingParties.join(', ')}`);
    }
    if (
      authorizedParties.length !== requiredFrontendOrigins.length
      || requiredFrontendOrigins.some((origin) => !authorizedParties.includes(origin))
    ) {
      errors.push(`CLERK_AUTHORIZED_PARTIES must contain exactly ${defaultCorsOrigins}.`);
    }
  }
  if (
    turnstileHosts.length !== requiredTurnstileHosts.length
    || requiredTurnstileHosts.some((host) => !turnstileHosts.includes(host))
  ) {
    errors.push(`TURNSTILE_HOSTNAMES must contain exactly ${defaultTurnstileHostnames}.`);
  }
  assertLiveShape(
    errors,
    'PUBLIC_APP_NAME/ASF_PUBLIC_APP_NAME/VITE_PUBLIC_APP_NAME',
    publicAppName,
    (value) => value.length >= 3 && !hasInternalBrandRisk(value),
    'must be the cleared public brand, not the internal name or placeholder.',
  );
  assertLiveShape(
    errors,
    'PUBLIC_APP_SHORT_NAME/ASF_PUBLIC_APP_SHORT_NAME/VITE_PUBLIC_APP_SHORT_NAME',
    publicShortName,
    (value) => value.length >= 2 && !/^(asf|sf)$/i.test(value),
    'must be the cleared public short name, not ASF/SF or a placeholder.',
  );
  if (publicAppName && publicShortName && explicitFrontendOrigin) {
    assertBrandClearance(errors, values, publicAppName, publicShortName, frontendOrigin);
  }

  if (errors.length > 0) {
    throw new Error(`Live config validation failed:\n- ${errors.join('\n- ')}`);
  }
}

async function main() {
  const values = readEnvValues();
  const frontendOrigin = readValue(values, 'ASF_FRONTEND_ORIGIN') || defaultFrontendOrigin;
  const corsOrigins = readValue(values, 'CORS_ORIGIN') || defaultCorsOrigins;

  if (args.has('--require-complete')) await validateRequired(values);
  if (!args.has('--skip-production-check')) runProductionCheck();

  upsertTomlVars({
    ENVIRONMENT: 'production',
    CORS_ORIGIN: corsOrigins,
    PUBLIC_APP_NAME: readValue(values, 'PUBLIC_APP_NAME') || readValue(values, 'ASF_PUBLIC_APP_NAME') || readValue(values, 'VITE_PUBLIC_APP_NAME'),
    PUBLIC_APP_SHORT_NAME: readValue(values, 'PUBLIC_APP_SHORT_NAME') || readValue(values, 'ASF_PUBLIC_APP_SHORT_NAME') || readValue(values, 'VITE_PUBLIC_APP_SHORT_NAME'),
    PUBLIC_SOCIAL_CARD_PATH: readValue(values, 'PUBLIC_SOCIAL_CARD_PATH') || readValue(values, 'ASF_SOCIAL_CARD_PATH'),
    CLERK_ISSUER: readValue(values, 'CLERK_ISSUER'),
    CLERK_JWKS_URL: readValue(values, 'CLERK_JWKS_URL'),
    CLERK_AUTHORIZED_PARTIES: readValue(values, 'CLERK_AUTHORIZED_PARTIES') || corsOrigins,
    STRIPE_ACCOUNT_ID: readValue(values, 'STRIPE_ACCOUNT_ID'),
    STRIPE_PRICE_STARTER: readValue(values, 'STRIPE_PRICE_STARTER'),
    STRIPE_PRICE_VERSUS: readValue(values, 'STRIPE_PRICE_VERSUS'),
    STRIPE_PRICE_ARCADE: readValue(values, 'STRIPE_PRICE_ARCADE'),
    TURNSTILE_REQUIRED: 'true',
    TURNSTILE_ACTION: 'anonymous_rookie',
    TURNSTILE_HOSTNAMES: readValue(values, 'TURNSTILE_HOSTNAMES') || defaultTurnstileHostnames,
  });
  console.log('Updated Worker production vars in worker/wrangler.toml.');

  writeFrontendEnv(values);
  console.log('Updated .env.production frontend values.');

  if (!args.has('--skip-secrets')) {
    for (const key of secretKeys) {
      const value = readValue(values, key);
      if (!value) {
        console.log(`${key}: missing locally`);
        continue;
      }
      putSecret(key, value);
      console.log(`${key}: set`);
    }
  }

  if (args.has('--deploy-worker')) {
    runWranglerDeploy();
  }
}

try {
  await main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
