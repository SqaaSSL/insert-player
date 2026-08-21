import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STRIPE_LIVE_ORIGIN,
  STRIPE_SANDBOX_ORIGIN,
  stripeBusinessProfileIssues,
} from './stripe-business-profile.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const STRIPE_API_VERSION = '2026-02-25.clover';
const PRODUCT_TAX_CODE = 'txcd_10201000';
const environments = {
  live: {
    envFiles: ['.env.production.local', '.env.production'],
    outputFile: '.env.production.local',
    webhookUrl: 'https://api.insertplayer.ai/api/billing/stripe-webhook',
  },
  sandbox: {
    envFiles: ['.env.sandbox.local', '.env.sandbox'],
    outputFile: '.env.sandbox.local',
    webhookUrl: 'https://insert-player-api-sandbox.shellbot.workers.dev/api/billing/stripe-webhook',
  },
};

const packs = [
  {
    id: 'starter',
    label: 'Starter Pack',
    description: '11 Insert Player credits. Enough for one Contender fighter.',
    credits: 11,
    amountCents: 1499,
    envKey: 'STRIPE_PRICE_STARTER',
  },
  {
    id: 'versus',
    label: 'Versus Pack',
    description: '20 Insert Player credits. Enough for one Champion fighter plus one Rookie.',
    credits: 20,
    amountCents: 2499,
    envKey: 'STRIPE_PRICE_VERSUS',
  },
  {
    id: 'arcade',
    label: 'Arcade Pack',
    description: '47 Insert Player credits. Enough for two Champion fighters plus one Contender.',
    credits: 47,
    amountCents: 5699,
    envKey: 'STRIPE_PRICE_ARCADE',
  },
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

function readEnvValues(files) {
  const values = new Map();
  for (const file of files) {
    const path = join(root, file);
    if (existsSync(path)) parseEnvText(readFileSync(path, 'utf8'), values);
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value) values.set(key, value);
  }
  return values;
}

function upsertEnvValue(text, key, value) {
  const replacement = `${key}=${value}`;
  const active = new RegExp(`^${key}=.*$`, 'm');
  if (active.test(text)) return text.replace(active, replacement);
  return `${text.replace(/\s*$/, '')}\n${replacement}\n`;
}

function encodeParams(values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) params.append(key, String(value));
  }
  return params;
}

async function stripeRequest(secretKey, path, options = {}) {
  const method = options.method ?? 'GET';
  const params = options.params ? encodeParams(options.params) : null;
  const query = method === 'GET' && params ? `?${params.toString()}` : '';
  const response = await fetch(`https://api.stripe.com${path}${query}`, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Stripe-Version': STRIPE_API_VERSION,
      ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: method === 'POST' ? params : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof body?.error?.message === 'string' ? body.error.message : `HTTP ${response.status}`;
    throw new Error(`Stripe ${method} ${path} failed: ${detail}`);
  }
  return body;
}

async function ensureProduct(secretKey, brandName, pack, environment) {
  const listed = await stripeRequest(secretKey, '/v1/products', {
    params: { limit: 100, active: true },
  });
  let product = listed.data?.find((entry) =>
    entry.metadata?.insert_player_pack_id === pack.id &&
    entry.metadata?.insert_player_environment === environment
  ) ?? null;
  const productParams = {
    name: `${brandName} ${pack.label}`,
    description: pack.description,
    tax_code: PRODUCT_TAX_CODE,
    'metadata[insert_player_project]': 'insert-player',
    'metadata[insert_player_pack_id]': pack.id,
    'metadata[insert_player_environment]': environment,
    'metadata[credits]': pack.credits,
  };

  if (!product) {
    product = await stripeRequest(secretKey, '/v1/products', {
      method: 'POST',
      params: productParams,
    });
  } else {
    product = await stripeRequest(secretKey, `/v1/products/${encodeURIComponent(product.id)}`, {
      method: 'POST',
      params: productParams,
    });
  }
  return product;
}

async function ensurePrice(secretKey, productId, pack, environment) {
  const listed = await stripeRequest(secretKey, '/v1/prices', {
    params: { product: productId, active: true, limit: 100 },
  });
  let price = listed.data?.find((entry) =>
    entry.type === 'one_time' &&
    entry.currency === 'eur' &&
    entry.unit_amount === pack.amountCents &&
    entry.tax_behavior === 'inclusive',
  ) ?? null;

  if (!price) {
    price = await stripeRequest(secretKey, '/v1/prices', {
      method: 'POST',
      params: {
        product: productId,
        currency: 'eur',
        unit_amount: pack.amountCents,
        tax_behavior: 'inclusive',
        nickname: `${pack.credits} credits`,
        'metadata[insert_player_project]': 'insert-player',
        'metadata[insert_player_pack_id]': pack.id,
        'metadata[insert_player_environment]': environment,
        'metadata[credits]': pack.credits,
      },
    });
  }

  for (const stale of listed.data ?? []) {
    if (stale.id === price.id) continue;
    await stripeRequest(secretKey, `/v1/prices/${encodeURIComponent(stale.id)}`, {
      method: 'POST',
      params: { active: false },
    });
  }
  return price;
}

function reviewBusinessProfile(account, brandName, target) {
  const allowedOrigins = target === 'sandbox'
    ? [STRIPE_LIVE_ORIGIN, STRIPE_SANDBOX_ORIGIN]
    : [STRIPE_LIVE_ORIGIN];
  const missing = stripeBusinessProfileIssues(account, { brandName, allowedOrigins });

  if (missing.length === 0) {
    console.log(`Stripe ${target} account profile is configured.`);
    return;
  }

  const message = [
    `Stripe ${target} account profile needs Dashboard setup: ${missing.join(', ')}.`,
    'Stripe only permits updating the platform account itself in Dashboard.',
  ].join(' ');
  if (target === 'live') throw new Error(message);
  console.warn(message);
}

async function ensureWebhook(secretKey, values, environment) {
  if (!args.has('--create-webhook')) return null;
  const url = (
    values.get('ASF_STRIPE_WEBHOOK_URL') ||
    environment.webhookUrl
  ).trim();
  if (!/^https:\/\//i.test(url)) throw new Error('ASF_STRIPE_WEBHOOK_URL must be HTTPS.');
  if (new URL(url).origin !== new URL(environment.webhookUrl).origin) {
    throw new Error(`Stripe webhook origin must remain isolated at ${new URL(environment.webhookUrl).origin}.`);
  }

  const listed = await stripeRequest(secretKey, '/v1/webhook_endpoints', { params: { limit: 100 } });
  const existing = listed.data?.find((entry) => entry.url === url) ?? null;
  const params = {
    url,
    description: 'Insert Player billing audit, fulfillment, and adjustments',
    // Keep the Dashboard's all-events decision explicit. The Worker verifies
    // every event and records unsupported types as ignored audit entries.
    'enabled_events[0]': '*',
  };
  if (existing) {
    await stripeRequest(secretKey, `/v1/webhook_endpoints/${encodeURIComponent(existing.id)}`, {
      method: 'POST',
      params,
    });
    return { created: false, secret: values.get('STRIPE_WEBHOOK_SECRET') ?? '' };
  }
  const created = await stripeRequest(secretKey, '/v1/webhook_endpoints', { method: 'POST', params });
  return { created: true, secret: typeof created.secret === 'string' ? created.secret : '' };
}

async function main() {
  const targetArg = rawArgs.find((arg) => arg.startsWith('--target='));
  const target = targetArg?.slice('--target='.length) || 'live';
  const environment = environments[target];
  if (!environment) {
    throw new Error('Stripe bootstrap target must be --target=sandbox or --target=live.');
  }

  const outputPath = join(root, environment.outputFile);
  const values = readEnvValues(environment.envFiles);
  const secretKey = values.get('STRIPE_SECRET_KEY')?.trim() ?? '';
  const expectedAccountId = values.get('STRIPE_ACCOUNT_ID')?.trim() ?? '';
  const forbiddenAccountIds = (values.get('ASF_FORBIDDEN_STRIPE_ACCOUNT_IDS') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const brandName = values.get('VITE_PUBLIC_APP_NAME')?.trim() || 'Insert Player';

  if (target === 'sandbox' && !/^sk_test_[A-Za-z0-9_]+$/i.test(secretKey)) {
    throw new Error('Sandbox Stripe bootstrap requires a dedicated sk_test_ key in .env.sandbox.local.');
  }
  if (target === 'live' && !/^sk_live_[A-Za-z0-9_]+$/i.test(secretKey)) {
    throw new Error('Live Stripe bootstrap requires a dedicated sk_live_ key in .env.production.local.');
  }
  if (target === 'live' && !args.has('--allow-live')) {
    throw new Error('Live Stripe mutation requires the explicit --allow-live flag.');
  }
  if (target === 'sandbox' && args.has('--allow-live')) {
    throw new Error('The sandbox bootstrap does not accept --allow-live.');
  }
  if (!/^acct_[A-Za-z0-9]+$/.test(expectedAccountId)) {
    throw new Error('Set STRIPE_ACCOUNT_ID to the dedicated Insert Player account id first.');
  }
  if (forbiddenAccountIds.includes(expectedAccountId)) {
    throw new Error('Refusing to bootstrap Stripe inside a forbidden shared account.');
  }

  const account = await stripeRequest(secretKey, '/v1/account');
  if (account.id !== expectedAccountId) {
    throw new Error('STRIPE_SECRET_KEY does not belong to STRIPE_ACCOUNT_ID.');
  }

  reviewBusinessProfile(account, brandName, target);

  const resolved = new Map();
  for (const pack of packs) {
    const product = await ensureProduct(secretKey, brandName, pack, target);
    const price = await ensurePrice(secretKey, product.id, pack, target);
    resolved.set(pack.envKey, price.id);
    console.log(`${pack.label}: catalog ready (${pack.credits} credits / EUR ${(pack.amountCents / 100).toFixed(2)})`);
  }

  const webhook = await ensureWebhook(secretKey, values, environment);
  let output = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '';
  output = upsertEnvValue(output, 'STRIPE_ACCOUNT_ID', expectedAccountId);
  for (const [key, value] of resolved) output = upsertEnvValue(output, key, value);
  if (webhook?.created && webhook.secret) {
    output = upsertEnvValue(output, 'STRIPE_WEBHOOK_SECRET', webhook.secret);
  }
  writeFileSync(outputPath, output.endsWith('\n') ? output : `${output}\n`, { mode: 0o600 });
  chmodSync(outputPath, 0o600);

  if (webhook && !webhook.secret) {
    console.log(`Webhook endpoint updated; its existing signing secret must be present in ${environment.outputFile}.`);
  } else if (webhook?.created) {
    console.log(`Webhook endpoint created and its signing secret stored in ignored ${environment.outputFile}.`);
  }
  console.log(`Stripe ${target} account and catalog IDs stored in ignored ${environment.outputFile}.`);
}

try {
  await main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
