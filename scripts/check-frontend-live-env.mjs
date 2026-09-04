import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INSERT_PLAYER_CLERK_FRONTEND_API_HOST,
  clerkPublishableKeyIssues,
  decodeClerkPublishableKey,
} from './clerk-publishable-key.mjs';
import { frontendHeadersForTarget } from './frontend-security-headers.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const sampleFragments = [
  'PLACEHOLDER',
  'replace_me',
  'your-',
  'example',
  'Fighter Lab',
  'pk_test_',
  'pk_live_...',
  '127.0.0.1',
  'localhost',
];

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
  for (const file of ['.env', '.env.local', '.env.production', '.env.production.local']) {
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

function assertLiveValue(errors, key, predicate, message) {
  const value = env.get(key)?.trim() ?? '';
  if (!value || hasSampleValue(value) || !predicate(value)) {
    errors.push(message);
  }
}

function brandClearancePath() {
  const path = env.get('ASF_BRAND_CLEARANCE_FILE')?.trim() || '.brand-clearance.json';
  return path.startsWith('/') ? path : join(root, path);
}

function assertBrandClearanceMatches(errors) {
  const path = brandClearancePath();
  if (!existsSync(path)) {
    errors.push(`Brand clearance file is required at ${path} before deploying the production frontend.`);
    return;
  }

  let clearance;
  try {
    clearance = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    errors.push(`Brand clearance file could not be parsed: ${detail}`);
    return;
  }

  const publicAppName = env.get('VITE_PUBLIC_APP_NAME')?.trim() ?? '';
  const publicShortName = env.get('VITE_PUBLIC_APP_SHORT_NAME')?.trim() ?? '';
  if (clearance.clearanceStatus !== 'cleared_for_launch') {
    errors.push('Brand clearance clearanceStatus must be "cleared_for_launch" before frontend deploy.');
  }
  if (String(clearance.publicBrandName ?? '').trim() !== publicAppName) {
    errors.push('VITE_PUBLIC_APP_NAME must match brand clearance publicBrandName.');
  }
  if (String(clearance.publicShortName ?? '').trim() !== publicShortName) {
    errors.push('VITE_PUBLIC_APP_SHORT_NAME must match brand clearance publicShortName.');
  }

  const frontendOrigin = (env.get('ASF_FRONTEND_URL') || env.get('ASF_FRONTEND_ORIGIN') || '').trim().replace(/\/+$/, '');
  if (frontendOrigin && String(clearance.productionOrigin ?? '').replace(/\/+$/, '') !== frontendOrigin) {
    errors.push('Brand clearance productionOrigin must match ASF_FRONTEND_URL/ASF_FRONTEND_ORIGIN.');
  }
}

const env = readEnvValues();
const errors = [];

assertLiveValue(
  errors,
  'VITE_API_BASE_URL',
  (value) => /^https:\/\//i.test(value) && !hasInternalBrandRisk(value),
  'VITE_API_BASE_URL must be the deployed HTTPS Worker/API URL for the cleared public brand, not the internal Worker URL.',
);

assertLiveValue(
  errors,
  'VITE_CLERK_PUBLISHABLE_KEY',
  (value) => /^pk_live_/i.test(value),
  'VITE_CLERK_PUBLISHABLE_KEY must be a live Clerk publishable key.',
);

const clerkKey = env.get('VITE_CLERK_PUBLISHABLE_KEY')?.trim() ?? '';
if (clerkKey && !hasSampleValue(clerkKey)) {
  for (const issue of clerkPublishableKeyIssues(clerkKey, {
    expectedEnvironment: 'live',
    expectedFrontendApiHost: INSERT_PLAYER_CLERK_FRONTEND_API_HOST,
  })) {
    errors.push(`VITE_CLERK_PUBLISHABLE_KEY ${issue}.`);
  }
  const decodedClerkKey = decodeClerkPublishableKey(clerkKey);
  if (decodedClerkKey) {
    const headers = frontendHeadersForTarget({
      target: 'live',
      apiOrigin: 'https://api.insertplayer.ai',
      clerkFrontendApiOrigin: decodedClerkKey.frontendApiOrigin,
    });
    if (!headers.includes(decodedClerkKey.frontendApiOrigin)) {
      errors.push(`Frontend CSP must allow Clerk Frontend API ${decodedClerkKey.frontendApiOrigin}.`);
    }
    if (headers.includes('clerk.accounts.dev') || headers.includes('insert-player-api-sandbox')) {
      errors.push('Production frontend CSP must not trust Clerk Development or the sandbox Worker.');
    }
  }
}

assertLiveValue(
  errors,
  'VITE_PUBLIC_APP_NAME',
  (value) => value.length >= 3 && !hasInternalBrandRisk(value),
  'VITE_PUBLIC_APP_NAME must be the cleared public brand, not the internal name or placeholder.',
);

assertLiveValue(
  errors,
  'VITE_PUBLIC_APP_SHORT_NAME',
  (value) => value.length >= 2 && !/^(asf|sf)$/i.test(value),
  'VITE_PUBLIC_APP_SHORT_NAME must be the cleared public short name, not ASF/SF or a placeholder.',
);

assertLiveValue(
  errors,
  'VITE_TURNSTILE_SITE_KEY',
  (value) => /^0x[A-Za-z0-9_-]{20,}$/.test(value),
  'VITE_TURNSTILE_SITE_KEY must be the production Insert Player widget site key.',
);

assertLiveValue(
  errors,
  'VITE_GOOGLE_MAPS_BROWSER_KEY',
  (value) => /^AIza[A-Za-z0-9_-]{30,}$/.test(value),
  'VITE_GOOGLE_MAPS_BROWSER_KEY must be a browser-restricted Google Maps key.',
);

assertBrandClearanceMatches(errors);

for (const key of [
  'VITE_GEMINI_IMAGE_MODEL_REPOSE',
  'VITE_GEMINI_IMAGE_MODEL_UPRIGHT',
  'VITE_GEMINI_IMAGE_MODEL_CROUCH',
]) {
  assertLiveValue(
    errors,
    key,
    (value) => /pro/i.test(value),
    `${key} must stay on a Pro source-view model.`,
  );
}

for (const key of providerSecretKeys) {
  if (env.has(key)) {
    errors.push(`${key} must not be exposed to the browser.`);
  }
}

if (errors.length > 0) {
  console.error(`Frontend live env checks failed:\n- ${errors.join('\n- ')}`);
  process.exit(1);
}

console.log('Frontend live env checks passed.');
