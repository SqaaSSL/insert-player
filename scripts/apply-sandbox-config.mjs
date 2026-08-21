import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  STRIPE_LIVE_ORIGIN,
  STRIPE_SANDBOX_ORIGIN,
  stripeBusinessProfileIssues,
} from './stripe-business-profile.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workerDir = join(root, 'worker');
const wranglerTomlPath = join(workerDir, 'wrangler.sandbox.toml');
const sandboxEnvPath = join(root, '.env.sandbox.local');
const wranglerLogPath = join(root, '.wrangler-logs');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const args = new Set(process.argv.slice(2));
const COMMAND_TIMEOUT_MS = 300_000;
const STRIPE_API_VERSION = '2026-02-25.clover';
const sandboxWorkerUrl = 'https://insert-player-api-sandbox.shellbot.workers.dev';
const sandboxFrontendUrl = 'https://insert-player-sandbox.pages.dev';
const sandboxAuthorizedParties = `${sandboxFrontendUrl},http://localhost:5173,http://127.0.0.1:5174`;

const providerSecretKeys = [
  'GEMINI_API_KEY',
  'FAL_API_KEY',
  'RUNWAY_API_KEY',
  'FREEPIK_API_KEY',
  'LUDO_API_KEY',
];
const sandboxSecretKeys = [
  ...providerSecretKeys,
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'CLERK_WEBHOOK_SIGNING_SECRET',
  'TURNSTILE_SECRET_KEY',
  'ANONYMIZATION_SECRET',
];
const requiredCompleteKeys = [
  'VITE_CLERK_PUBLISHABLE_KEY',
  'CLERK_ISSUER',
  'CLERK_WEBHOOK_SIGNING_SECRET',
  'STRIPE_ACCOUNT_ID',
  'STRIPE_PRICE_STARTER',
  'STRIPE_PRICE_VERSUS',
  'STRIPE_PRICE_ARCADE',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'ANONYMIZATION_SECRET',
];
const expectedPrices = [
  { key: 'STRIPE_PRICE_STARTER', packId: 'starter', credits: '11', amountCents: 1499 },
  { key: 'STRIPE_PRICE_VERSUS', packId: 'versus', credits: '20', amountCents: 2499 },
  { key: 'STRIPE_PRICE_ARCADE', packId: 'arcade', credits: '47', amountCents: 5699 },
];

function parseEnvText(text, values, overwrite = true) {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && value && (overwrite || !values.has(key))) values.set(key, value);
  }
}

function readEnvValues() {
  const values = new Map();
  for (const file of ['.env.sandbox', '.env.sandbox.local']) {
    const path = join(root, file);
    if (existsSync(path)) parseEnvText(readFileSync(path, 'utf8'), values);
  }

  const localProviderPath = join(root, '.env');
  if (existsSync(localProviderPath)) {
    const providerValues = new Map();
    parseEnvText(readFileSync(localProviderPath, 'utf8'), providerValues);
    for (const key of providerSecretKeys) {
      if (!values.has(key) && providerValues.has(key)) values.set(key, providerValues.get(key));
    }
  }

  for (const [key, value] of Object.entries(process.env)) {
    if (value) values.set(key, value);
  }
  return values;
}

function value(values, key, fallback = '') {
  const resolved = values.get(key)?.trim() || fallback;
  if (/replace_me|placeholder|structuralcheck|your-/i.test(resolved)) return '';
  return resolved;
}

function configuredOrigins(raw) {
  return raw.split(',').map((origin) => origin.trim().replace(/\/+$/, '')).filter(Boolean);
}

function wranglerEnv() {
  mkdirSync(wranglerLogPath, { recursive: true });
  return {
    ...process.env,
    WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH || wranglerLogPath,
  };
}

function run(label, command, commandArgs, cwd = root) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    stdio: 'inherit',
    env: wranglerEnv(),
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (result.error?.code === 'ETIMEDOUT') throw new Error(`${label} timed out.`);
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${label} exited with signal ${result.signal}.`);
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status ?? 'unknown'}.`);
}

function escapeTomlString(input) {
  return input.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function upsertTomlVars(vars) {
  let text = readFileSync(wranglerTomlPath, 'utf8');
  const varsHeader = text.match(/^\[vars]\s*$/m);
  if (!varsHeader) throw new Error('Unable to locate [vars] in worker/wrangler.sandbox.toml.');

  for (const [key, rawValue] of Object.entries(vars)) {
    if (!rawValue) continue;
    const replacement = `${key} = "${escapeTomlString(rawValue)}"`;
    const active = new RegExp(`^\\s*${key}\\s*=\\s*"[^"]*"`, 'm');
    const commented = new RegExp(`^\\s*#\\s*${key}\\s*=\\s*"[^"]*"`, 'm');
    if (active.test(text)) {
      text = text.replace(active, replacement);
    } else if (commented.test(text)) {
      text = text.replace(commented, replacement);
    } else {
      const currentHeader = text.match(/^\[vars]\s*$/m);
      if (!currentHeader) throw new Error('Unable to locate [vars] in worker/wrangler.sandbox.toml.');
      const insertAt = currentHeader.index + currentHeader[0].length;
      text = `${text.slice(0, insertAt)}\n${replacement}${text.slice(insertAt)}`;
    }
  }

  writeFileSync(wranglerTomlPath, text);
}

function putSecrets(values) {
  const secrets = Object.fromEntries(
    sandboxSecretKeys
      .map((key) => [key, value(values, key)])
      .filter(([, secretValue]) => Boolean(secretValue)),
  );
  if (Object.keys(secrets).length === 0) return;

  const input = JSON.stringify(secrets);
  const result = spawnSync(npx, ['wrangler', 'secret', 'bulk', '--config', 'wrangler.sandbox.toml'], {
    cwd: workerDir,
    input,
    encoding: 'utf8',
    env: wranglerEnv(),
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    let output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    for (const secretValue of Object.values(secrets)) output = output.replaceAll(secretValue, '<redacted>');
    throw new Error(`Sandbox Worker secret upload failed${output.trim() ? `:\n${output.trim()}` : '.'}`);
  }
  console.log(`Installed ${Object.keys(secrets).length} isolated sandbox Worker secrets without printing values.`);
}

async function stripeRequest(secretKey, path) {
  const response = await fetch(`https://api.stripe.com${path}`, {
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Stripe-Version': STRIPE_API_VERSION,
    },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Stripe sandbox validation failed for ${path} (HTTP ${response.status}).`);
  return body;
}

async function validateStripe(values, errors) {
  const secretKey = value(values, 'STRIPE_SECRET_KEY');
  const accountId = value(values, 'STRIPE_ACCOUNT_ID');
  if (!secretKey || !accountId) return;

  const account = await stripeRequest(secretKey, '/v1/account');
  if (account.id !== accountId) errors.push('STRIPE_SECRET_KEY does not belong to STRIPE_ACCOUNT_ID.');
  if (args.has('--require-complete')) {
    const profileIssues = stripeBusinessProfileIssues(account, {
      allowedOrigins: [STRIPE_LIVE_ORIGIN, STRIPE_SANDBOX_ORIGIN],
    });
    if (profileIssues.length > 0) {
      errors.push(`Stripe sandbox business profile is incomplete: ${profileIssues.join(', ')}.`);
    }
  }

  for (const expected of expectedPrices) {
    const priceId = value(values, expected.key);
    if (!priceId) continue;
    const price = await stripeRequest(secretKey, `/v1/prices/${encodeURIComponent(priceId)}?expand[]=product`);
    const metadata = price.product?.metadata ?? {};
    if (
      price.active !== true ||
      price.currency !== 'eur' ||
      price.unit_amount !== expected.amountCents ||
      price.tax_behavior !== 'inclusive' ||
      metadata.insert_player_pack_id !== expected.packId ||
      metadata.insert_player_environment !== 'sandbox' ||
      metadata.credits !== expected.credits
    ) {
      errors.push(`${expected.key} is not the expected active inclusive-EUR Insert Player sandbox catalog price.`);
    }
  }
}

async function validateClerk(values, errors) {
  const issuer = value(values, 'CLERK_ISSUER');
  if (!issuer) return;
  const jwksUrl = value(values, 'CLERK_JWKS_URL', `${issuer.replace(/\/+$/, '')}/.well-known/jwks.json`);
  try {
    const response = await fetch(jwksUrl, { signal: AbortSignal.timeout(20_000) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(body.keys) || body.keys.length === 0) {
      errors.push('Clerk sandbox JWKS endpoint did not return signing keys.');
    }
  } catch (error) {
    errors.push(`Clerk sandbox JWKS lookup failed: ${error instanceof Error ? error.message : error}`);
  }
}

async function validate(values) {
  const errors = [];
  const complete = args.has('--require-complete');
  if (complete) {
    const missing = requiredCompleteKeys.filter((key) => !value(values, key));
    const missingProviders = providerSecretKeys.filter((key) => !value(values, key));
    if (missing.length > 0) errors.push(`Missing sandbox config: ${missing.join(', ')}`);
    if (missingProviders.length > 0) errors.push(`Missing sandbox provider secrets: ${missingProviders.join(', ')}`);
  }

  const apiUrl = value(values, 'VITE_API_BASE_URL', sandboxWorkerUrl).replace(/\/+$/, '');
  const frontendUrl = value(values, 'ASF_SANDBOX_FRONTEND_URL', sandboxFrontendUrl).replace(/\/+$/, '');
  const clerkKey = value(values, 'VITE_CLERK_PUBLISHABLE_KEY');
  const clerkIssuer = value(values, 'CLERK_ISSUER');
  const clerkWebhookSecret = value(values, 'CLERK_WEBHOOK_SIGNING_SECRET');
  const stripeSecret = value(values, 'STRIPE_SECRET_KEY');
  const stripeWebhookSecret = value(values, 'STRIPE_WEBHOOK_SECRET');
  const anonymizationSecret = value(values, 'ANONYMIZATION_SECRET');
  const stripeAccountId = value(values, 'STRIPE_ACCOUNT_ID');
  const forbiddenAccounts = value(values, 'ASF_FORBIDDEN_STRIPE_ACCOUNT_IDS')
    .split(',').map((entry) => entry.trim()).filter(Boolean);
  const webhookUrl = value(
    values,
    'ASF_STRIPE_WEBHOOK_URL',
    `${sandboxWorkerUrl}/api/billing/stripe-webhook`,
  );
  const authorizedParties = configuredOrigins(
    value(values, 'CLERK_AUTHORIZED_PARTIES', sandboxAuthorizedParties),
  );

  if (apiUrl !== sandboxWorkerUrl) errors.push(`VITE_API_BASE_URL must be ${sandboxWorkerUrl}.`);
  if (frontendUrl !== sandboxFrontendUrl) errors.push(`ASF_SANDBOX_FRONTEND_URL must be ${sandboxFrontendUrl}.`);
  if (clerkKey && !/^pk_test_[A-Za-z0-9_]+$/i.test(clerkKey)) errors.push('Sandbox Clerk publishable key must start with pk_test_.');
  if (clerkIssuer && !/^https:\/\//i.test(clerkIssuer)) errors.push('CLERK_ISSUER must be HTTPS.');
  if (clerkWebhookSecret && !/^whsec_[A-Za-z0-9+/=_-]+$/i.test(clerkWebhookSecret)) errors.push('CLERK_WEBHOOK_SIGNING_SECRET must be a whsec_ secret.');
  if (stripeSecret && !/^sk_test_[A-Za-z0-9_]+$/i.test(stripeSecret)) errors.push('Sandbox Stripe secret key must start with sk_test_.');
  if (stripeWebhookSecret && !/^whsec_[A-Za-z0-9+/=_-]+$/i.test(stripeWebhookSecret)) errors.push('STRIPE_WEBHOOK_SECRET must be a whsec_ secret.');
  if (anonymizationSecret && anonymizationSecret.length < 32) errors.push('ANONYMIZATION_SECRET must contain at least 32 characters.');
  if (stripeAccountId && !/^acct_[A-Za-z0-9]+$/.test(stripeAccountId)) errors.push('STRIPE_ACCOUNT_ID must be a Stripe acct_ id.');
  if (stripeAccountId && forbiddenAccounts.includes(stripeAccountId)) errors.push('Refusing to configure the sandbox with a forbidden shared Stripe account.');
  if (webhookUrl !== `${sandboxWorkerUrl}/api/billing/stripe-webhook`) errors.push('Sandbox Stripe webhook must target the isolated sandbox Worker.');
  for (const requiredOrigin of configuredOrigins(sandboxAuthorizedParties)) {
    if (!authorizedParties.includes(requiredOrigin)) errors.push(`CLERK_AUTHORIZED_PARTIES must include ${requiredOrigin}.`);
  }
  if (value(values, 'VITE_PUBLIC_APP_NAME') !== 'Insert Player' || value(values, 'VITE_PUBLIC_APP_SHORT_NAME') !== 'P1') {
    errors.push('Sandbox public brand must remain Insert Player / P1.');
  }

  if (stripeSecret && stripeAccountId) await validateStripe(values, errors);
  if (clerkIssuer) await validateClerk(values, errors);
  if (errors.length > 0) throw new Error(`Sandbox config validation failed:\n- ${errors.join('\n- ')}`);
}

async function main() {
  const values = readEnvValues();
  await validate(values);

  if (!args.has('--skip-production-check')) {
    run('production checks', npm, ['run', 'check:production']);
  }
  if (args.has('--require-complete')) {
    run('frontend sandbox env checks', npm, ['run', 'check:frontend-sandbox']);
  }

  upsertTomlVars({
    CLERK_ISSUER: value(values, 'CLERK_ISSUER'),
    CLERK_JWKS_URL: value(values, 'CLERK_JWKS_URL'),
    CLERK_AUTHORIZED_PARTIES: value(values, 'CLERK_AUTHORIZED_PARTIES', sandboxAuthorizedParties),
    STRIPE_ACCOUNT_ID: value(values, 'STRIPE_ACCOUNT_ID'),
    STRIPE_PRICE_STARTER: value(values, 'STRIPE_PRICE_STARTER'),
    STRIPE_PRICE_VERSUS: value(values, 'STRIPE_PRICE_VERSUS'),
    STRIPE_PRICE_ARCADE: value(values, 'STRIPE_PRICE_ARCADE'),
  });
  putSecrets(values);
  if (existsSync(sandboxEnvPath)) chmodSync(sandboxEnvPath, 0o600);

  if (args.has('--deploy-worker')) {
    run('sandbox D1 migrations', npm, ['run', 'db:migrate:sandbox'], root);
    run('sandbox Worker deploy', npm, ['--prefix', 'worker', 'run', 'deploy:sandbox'], root);
    run('sandbox Worker smoke', npm, ['run', 'smoke:sandbox'], root);
  }

  console.log('Isolated sandbox config applied. Production Worker, D1, R2, env, and webhooks were not touched.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
