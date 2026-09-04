import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeClerkPublishableKey } from './clerk-publishable-key.mjs';
import { frontendHeadersForTarget } from './frontend-security-headers.mjs';
import { textReferencesOrigin } from './url-reference.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const expectedWorkerUrl = 'https://insert-player-api-sandbox.shellbot.workers.dev';
const expectedFrontendUrl = 'https://insert-player-sandbox.pages.dev';
const expectedTurnstileSiteKey = '1x00000000000000000000AA';
const providerSecretKeys = [
  'VITE_GEMINI_API_KEY',
  'VITE_FAL_API_KEY',
  'VITE_RUNWAY_API_KEY',
  'VITE_FREEPIK_API_KEY',
  'VITE_LUDO_API_KEY',
  'VITE_STRIPE_SECRET_KEY',
  'VITE_STRIPE_WEBHOOK_SECRET',
  'VITE_TURNSTILE_SECRET_KEY',
  'VITE_GOOGLE_MAPS_SERVER_KEY',
];

function parseEnvText(text, values) {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && value) values.set(key, value);
  }
}

function readEnvValues() {
  const values = new Map();
  for (const file of ['.env.sandbox', '.env.sandbox.local']) {
    const path = join(root, file);
    if (existsSync(path)) parseEnvText(readFileSync(path, 'utf8'), values);
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value) values.set(key, value);
  }
  return values;
}

const env = readEnvValues();
const errors = [];
const value = (key) => env.get(key)?.trim() ?? '';

if (value('VITE_API_BASE_URL').replace(/\/+$/, '') !== expectedWorkerUrl) {
  errors.push(`VITE_API_BASE_URL must be ${expectedWorkerUrl}.`);
}
if (!/^pk_test_[A-Za-z0-9_]+$/i.test(value('VITE_CLERK_PUBLISHABLE_KEY')) || /replace_me/i.test(value('VITE_CLERK_PUBLISHABLE_KEY'))) {
  errors.push('VITE_CLERK_PUBLISHABLE_KEY must be the isolated Clerk development pk_test_ key.');
}
const decodedClerkKey = decodeClerkPublishableKey(value('VITE_CLERK_PUBLISHABLE_KEY'));
if (!decodedClerkKey || decodedClerkKey.environment !== 'test') {
  errors.push('VITE_CLERK_PUBLISHABLE_KEY must encode an exact Clerk Development Frontend API host.');
} else {
  const headers = frontendHeadersForTarget({
    target: 'sandbox',
    apiOrigin: expectedWorkerUrl,
    clerkFrontendApiOrigin: decodedClerkKey.frontendApiOrigin,
  });
  if (
    textReferencesOrigin(headers, 'https://api.insertplayer.ai')
    || textReferencesOrigin(headers, 'https://clerk.insertplayer.ai')
  ) {
    errors.push('Sandbox frontend CSP must not trust production API or Clerk origins.');
  }
}
if (value('VITE_PUBLIC_APP_NAME') !== 'Insert Player' || value('VITE_PUBLIC_APP_SHORT_NAME') !== 'P1') {
  errors.push('Sandbox public brand must remain Insert Player / P1.');
}
if (value('VITE_TURNSTILE_SITE_KEY') !== expectedTurnstileSiteKey) {
  errors.push('VITE_TURNSTILE_SITE_KEY must use Cloudflare\'s always-pass sandbox widget.');
}
if (!/^AIza[A-Za-z0-9_-]{30,}$/.test(value('VITE_GOOGLE_MAPS_BROWSER_KEY')) || /replace_me/i.test(value('VITE_GOOGLE_MAPS_BROWSER_KEY'))) {
  errors.push('VITE_GOOGLE_MAPS_BROWSER_KEY must be the sandbox browser-restricted Google Maps key.');
}
if ((value('ASF_SANDBOX_FRONTEND_URL') || expectedFrontendUrl).replace(/\/+$/, '') !== expectedFrontendUrl) {
  errors.push(`ASF_SANDBOX_FRONTEND_URL must be ${expectedFrontendUrl}.`);
}
for (const key of [
  'VITE_GEMINI_IMAGE_MODEL_REPOSE',
  'VITE_GEMINI_IMAGE_MODEL_UPRIGHT',
  'VITE_GEMINI_IMAGE_MODEL_CROUCH',
]) {
  if (!/pro/i.test(value(key))) errors.push(`${key} must stay on a Pro source-view model.`);
}
for (const key of providerSecretKeys) {
  if (env.has(key)) errors.push(`${key} must not be exposed to the browser.`);
}

if (errors.length > 0) {
  console.error(`Frontend sandbox env checks failed:\n- ${errors.join('\n- ')}`);
  process.exit(1);
}

console.log('Frontend sandbox env checks passed.');
