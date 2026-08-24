import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const MIN_JWT_TTL_SECONDS = 60;
const MANUAL_VALIDATION_MAX_AGE_DAYS = 14;
const BRAND_CLEARANCE_MAX_AGE_DAYS = 90;
const DEFAULT_MANUAL_VALIDATION_FILE = '.launch-validation.json';
const DEFAULT_BRAND_CLEARANCE_FILE = '.brand-clearance.json';
const legalVersionMatch = readFileSync(join(root, 'worker/src/legal.ts'), 'utf8')
  .match(/CURRENT_LEGAL_VERSION\s*=\s*'([^']+)'/);
if (!legalVersionMatch) {
  throw new Error('Could not resolve CURRENT_LEGAL_VERSION from worker/src/legal.ts.');
}
const CURRENT_LEGAL_VERSION = legalVersionMatch[1];
const DEFAULT_LAUNCH_TIMEOUTS_MS = {
  'check:production': 300_000,
  'check:live-readiness': 600_000,
  'smoke:frontend-live': 300_000,
  'smoke:live:launch': 600_000,
};

const REQUIRED_MANUAL_CHECKS = [
  'signed_out_menu',
  'brand_metadata_social_preview',
  'signed_out_rookie_policy',
  'legal_pages_and_generation_consent',
  'support_email_delivery',
  'turnstile_valid_token_and_replay',
  'clerk_sign_in_profile',
  'shared_browser_account_isolation',
  'clerk_account_deletion_purge',
  'stripe_test_checkout_credit',
  'stripe_checkout_consent_tax_customer',
  'stripe_live_checkout_credit',
  'rookie_generation_commit',
  'contender_generation_commit_cloud_sync',
  'champion_generation_commit_cloud_sync',
  'generation_failure_charge_boundary',
  'second_device_import_and_play',
  'cross_device_retry_or_upgrade_refresh',
  'version_preservation_after_upgrade',
  'rename_delete_cloud_sync',
  'duplicate_source_sprite_upload_idempotency',
  'publish_share_clone_full_animation',
  'share_page_metadata_and_deep_link',
  'community_report_moderation',
  'asset_privacy_headers',
  'proxy_rate_limit_retry_after',
  'upload_temp_uses_worker_r2',
  'signed_in_match_stats',
  'source_views_pro_all_tiers',
  'bg_removal_face_integrity',
];

const sampleFragments = [
  'PLACEHOLDER',
  'replace_me',
  'your-',
  'example',
  'pk_test_replace_me',
  'pk_live_...',
  'sk_test_replace_me',
  'whsec_replace_me',
  'cloud_fighter_id_for_',
  'brand_name',
  'short_name',
  'attorney_or_owner',
  'evidence_',
  '127.0.0.1',
  'localhost',
];

const failures = [];

function fail(message) {
  failures.push(message);
}

function hasSampleValue(value) {
  return sampleFragments.some((fragment) => value.toLowerCase().includes(fragment.toLowerCase()));
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
  for (const file of ['.env.production.local', '.env.production', '.env.local', '.env']) {
    const path = join(root, file);
    if (existsSync(path)) parseEnvText(readFileSync(path, 'utf8'), values);
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value) values.set(key, value);
  }
  return values;
}

function resolveEnv(values, key) {
  return values.get(key)?.trim() ?? '';
}

function resolvePath(value, fallback = DEFAULT_MANUAL_VALIDATION_FILE) {
  const path = String(value || fallback).trim();
  return path.startsWith('/') ? path : join(root, path);
}

function resolveNumberEnv(values, key, fallback) {
  const value = Number(resolveEnv(values, key));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function launchTimeoutFor(values, script) {
  const key = `ASF_LAUNCH_${script.replace(/[:\W]+/g, '_').toUpperCase()}_TIMEOUT_MS`;
  return resolveNumberEnv(values, key, DEFAULT_LAUNCH_TIMEOUTS_MS[script] ?? 300_000);
}

function normalizedHttpsUrl(value, label) {
  const normalized = String(value ?? '').trim().replace(/\/+$/, '');
  if (!normalized) {
    fail(`${label} is required.`);
    return '';
  }
  if (hasSampleValue(normalized)) {
    fail(`${label} still looks like a placeholder or local value.`);
    return normalized;
  }
  if (!/^https:\/\//i.test(normalized)) {
    fail(`${label} must be a production HTTPS URL.`);
  }
  return normalized;
}

function requiredJwt(value, label) {
  const token = String(value ?? '').trim();
  if (!token) {
    fail(`${label} is required.`);
    return '';
  }
  if (hasSampleValue(token)) {
    fail(`${label} still looks like a placeholder.`);
  }
  if (token.split('.').length !== 3) {
    fail(`${label} must be a JWT-like Clerk session token.`);
  }
  return token;
}

function decodeJwtPayload(token, label) {
  if (!token) return null;
  const [, payload] = token.split('.');
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    fail(`${label} payload could not be decoded.`);
    return null;
  }
}

function jwtSubject(payload, label) {
  const sub = typeof payload?.sub === 'string' ? payload.sub.trim() : '';
  if (!sub) {
    fail(`${label} must include a Clerk subject claim.`);
  }
  return sub;
}

function assertJwtFresh(payload, label) {
  const exp = typeof payload?.exp === 'number' ? payload.exp : 0;
  if (!exp) {
    fail(`${label} must include a numeric expiration claim.`);
    return;
  }
  const minExp = Math.floor(Date.now() / 1000) + MIN_JWT_TTL_SECONDS;
  if (exp <= minExp) {
    fail(`${label} expires too soon for launch smoke. Generate a fresh Clerk session token.`);
  }
  const nbf = typeof payload?.nbf === 'number' ? payload.nbf : null;
  if (nbf && nbf > Math.floor(Date.now() / 1000)) {
    fail(`${label} is not valid yet.`);
  }
}

function assertConcreteEvidence(value, label) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length < 16 || hasSampleValue(text)) {
    fail(`${label} must describe concrete evidence.`);
  }
}

function assertRecentIsoDate(value, label, maxAgeDays) {
  const timestampMs = Date.parse(String(value ?? ''));
  if (!Number.isFinite(timestampMs)) {
    fail(`${label} must be an ISO timestamp.`);
    return;
  }
  const now = Date.now();
  if (timestampMs > now + 10 * 60 * 1000) {
    fail(`${label} is in the future.`);
  }
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  if (now - timestampMs > maxAgeMs) {
    fail(`${label} is older than ${maxAgeDays} days.`);
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasInternalOrCapcomBrandRisk(value) {
  return /(^|[^a-z0-9])(?:ai[\s_-]*)?street[\s_-]*fighter([^a-z0-9]|$)/i.test(value) || /\bcapcom\b/i.test(value);
}

function assertNoInternalBrandOnPublicSurfaces(publicBrandName) {
  const brandPattern = new RegExp(escapeRegExp(publicBrandName), 'i');
  const staticBrandFiles = [
    'index.html',
    'public/site.webmanifest',
    'public/assets/social-card.svg',
    'public/assets/app-icon.svg',
  ];
  const dynamicBrandFiles = [
    'src/ui/routes/HomePage.tsx',
    'src/ui/shared/communityShare.ts',
    'worker/src/fighters.ts',
    'worker/src/billing.ts',
  ];
  for (const file of [...staticBrandFiles, ...dynamicBrandFiles]) {
    const text = readFileSync(join(root, file), 'utf8');
    if (/\b(ai\s+)?street\s+fighter\b/i.test(text)) {
      fail(`Public brand surface ${file} still contains the internal/Capcom-adjacent "Street Fighter" name.`);
    }
  }
  for (const file of staticBrandFiles) {
    const text = readFileSync(join(root, file), 'utf8');
    if (!brandPattern.test(text)) {
      fail(`Public brand surface ${file} must include the cleared public brand name "${publicBrandName}".`);
    }
  }
  const dynamicBrandChecks = [
    ['src/ui/routes/HomePage.tsx', 'PUBLIC_APP_NAME'],
    ['src/ui/shared/communityShare.ts', 'PUBLIC_APP_NAME'],
    ['worker/src/fighters.ts', 'publicAppName(env)'],
    ['worker/src/billing.ts', 'publicAppName(env)'],
  ];
  for (const [file, snippet] of dynamicBrandChecks) {
    const text = readFileSync(join(root, file), 'utf8');
    if (!text.includes(snippet)) {
      fail(`Dynamic public brand surface ${file} must read the cleared public brand through ${snippet}.`);
    }
  }
}

function assertBrandClearance(values, frontendUrl) {
  const clearancePath = resolvePath(resolveEnv(values, 'ASF_BRAND_CLEARANCE_FILE'), DEFAULT_BRAND_CLEARANCE_FILE);
  if (!existsSync(clearancePath)) {
    fail(`Brand clearance file is required at ${clearancePath}. Copy brand-clearance.example.json to ${DEFAULT_BRAND_CLEARANCE_FILE} after choosing and clearing the external launch name.`);
    return null;
  }

  let clearance;
  try {
    clearance = JSON.parse(readFileSync(clearancePath, 'utf8'));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    fail(`Brand clearance file could not be parsed: ${detail}`);
    return null;
  }

  if (clearance.schemaVersion !== 1) {
    fail('Brand clearance schemaVersion must be 1.');
  }
  assertRecentIsoDate(clearance.validatedAt, 'Brand clearance validatedAt', BRAND_CLEARANCE_MAX_AGE_DAYS);

  const publicBrandName = String(clearance.publicBrandName ?? '').trim();
  const publicShortName = String(clearance.publicShortName ?? '').trim();
  if (publicBrandName.length < 3 || hasSampleValue(publicBrandName)) {
    fail('Brand clearance publicBrandName is required.');
  }
  if (publicShortName.length < 2 || hasSampleValue(publicShortName)) {
    fail('Brand clearance publicShortName is required.');
  }
  if (publicBrandName && hasInternalOrCapcomBrandRisk(publicBrandName)) {
    fail('Brand clearance publicBrandName must not use "AI Street Fighter", "Street Fighter", or Capcom-adjacent wording.');
  }
  if (publicShortName && /^(asf|sf)$/i.test(publicShortName)) {
    fail('Brand clearance publicShortName must not keep the internal ASF/SF abbreviation.');
  }
  if (String(clearance.productionOrigin ?? '').replace(/\/+$/, '') !== frontendUrl) {
    fail('Brand clearance productionOrigin must match ASF_FRONTEND_URL.');
  }
  if (hasInternalOrCapcomBrandRisk(String(clearance.productionOrigin ?? ''))) {
    fail('Brand clearance productionOrigin must use the cleared public brand domain, not the internal project domain.');
  }
  if (clearance.clearanceStatus !== 'cleared_for_launch') {
    fail('Brand clearance clearanceStatus must be "cleared_for_launch".');
  }

  const jurisdictions = Array.isArray(clearance.searchedJurisdictions)
    ? clearance.searchedJurisdictions.map((item) => String(item).trim()).filter(Boolean)
    : [];
  if (jurisdictions.length < 2 || jurisdictions.some(hasSampleValue)) {
    fail('Brand clearance searchedJurisdictions must list at least two concrete trademark search sources.');
  }

  assertConcreteEvidence(clearance.reviewedBy, 'Brand clearance reviewedBy');
  assertConcreteEvidence(clearance.evidence?.trademarkSearch, 'Brand clearance evidence.trademarkSearch');
  assertConcreteEvidence(clearance.evidence?.domainAndHandles, 'Brand clearance evidence.domainAndHandles');
  assertConcreteEvidence(clearance.evidence?.publicSurfaces, 'Brand clearance evidence.publicSurfaces');

  if (publicBrandName && !hasInternalOrCapcomBrandRisk(publicBrandName)) {
    assertNoInternalBrandOnPublicSurfaces(publicBrandName);
  }

  return { publicBrandName, publicShortName };
}

function assertEvidenceCheck(validation, checkId) {
  const check = validation?.checks?.[checkId];
  if (!check || typeof check !== 'object') {
    fail(`Manual launch validation is missing checks.${checkId}.`);
    return;
  }
  if (check.passed !== true) {
    fail(`Manual launch validation checks.${checkId}.passed must be true.`);
  }
  const evidence = typeof check.evidence === 'string' ? check.evidence.trim() : '';
  if (evidence.length < 12 || hasSampleValue(evidence)) {
    fail(`Manual launch validation checks.${checkId}.evidence must describe concrete evidence.`);
  }
}

function assertManualLaunchValidation(values, workerUrl, frontendUrl, primaryJwtSubject, secondaryJwtSubject, brandClearance) {
  const validationPath = resolvePath(resolveEnv(values, 'ASF_LAUNCH_VALIDATION_FILE'));
  if (!existsSync(validationPath)) {
    fail(`Manual launch validation file is required at ${validationPath}. Copy launch-validation.example.json to ${DEFAULT_MANUAL_VALIDATION_FILE} after completing the browser/provider/two-device smoke checklist.`);
    return;
  }

  let validation;
  try {
    validation = JSON.parse(readFileSync(validationPath, 'utf8'));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    fail(`Manual launch validation file could not be parsed: ${detail}`);
    return;
  }

  if (validation.schemaVersion !== 5) {
    fail('Manual launch validation schemaVersion must be 5.');
  }
  if (String(validation.legalVersion ?? '').trim() !== CURRENT_LEGAL_VERSION) {
    fail(`Manual launch validation legalVersion must match ${CURRENT_LEGAL_VERSION}.`);
  }
  if (String(validation.workerUrl ?? '').replace(/\/+$/, '') !== workerUrl) {
    fail('Manual launch validation workerUrl must match ASF_WORKER_URL.');
  }
  if (String(validation.frontendUrl ?? '').replace(/\/+$/, '') !== frontendUrl) {
    fail('Manual launch validation frontendUrl must match ASF_FRONTEND_URL.');
  }
  const validationBrandName = String(validation.publicBrandName ?? '').trim();
  const validationShortName = String(validation.publicShortName ?? '').trim();
  if (!validationBrandName || hasSampleValue(validationBrandName)) {
    fail('Manual launch validation publicBrandName is required.');
  }
  if (!validationShortName || hasSampleValue(validationShortName)) {
    fail('Manual launch validation publicShortName is required.');
  }
  if (brandClearance?.publicBrandName && validationBrandName !== brandClearance.publicBrandName) {
    fail('Manual launch validation publicBrandName must match brand clearance publicBrandName.');
  }
  if (brandClearance?.publicShortName && validationShortName !== brandClearance.publicShortName) {
    fail('Manual launch validation publicShortName must match brand clearance publicShortName.');
  }

  const validatedAtMs = Date.parse(String(validation.validatedAt ?? ''));
  if (!Number.isFinite(validatedAtMs)) {
    fail('Manual launch validation validatedAt must be an ISO timestamp.');
  } else {
    const now = Date.now();
    if (validatedAtMs > now + 10 * 60 * 1000) {
      fail('Manual launch validation validatedAt is in the future.');
    }
    const maxAgeMs = MANUAL_VALIDATION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    if (now - validatedAtMs > maxAgeMs) {
      fail(`Manual launch validation is older than ${MANUAL_VALIDATION_MAX_AGE_DAYS} days.`);
    }
  }

  const primaryUserId = String(validation.primaryClerkUserId ?? '').trim();
  const secondaryUserId = String(validation.secondaryClerkUserId ?? '').trim();
  if (!primaryUserId || hasSampleValue(primaryUserId)) {
    fail('Manual launch validation primaryClerkUserId is required.');
  }
  if (!secondaryUserId || hasSampleValue(secondaryUserId)) {
    fail('Manual launch validation secondaryClerkUserId is required.');
  }
  if (primaryUserId && secondaryUserId && primaryUserId === secondaryUserId) {
    fail('Manual launch validation must use two different Clerk users.');
  }
  if (primaryUserId && primaryJwtSubject && primaryUserId !== primaryJwtSubject) {
    fail('Manual launch validation primaryClerkUserId must match ASF_CLERK_JWT subject.');
  }
  if (secondaryUserId && secondaryJwtSubject && secondaryUserId !== secondaryJwtSubject) {
    fail('Manual launch validation secondaryClerkUserId must match ASF_CLERK_JWT_CLONE subject.');
  }

  for (const tier of ['rookie', 'contender', 'champion']) {
    const value = String(validation?.tierFighterIds?.[tier] ?? '').trim();
    if (!value || hasSampleValue(value)) {
      fail(`Manual launch validation tierFighterIds.${tier} is required.`);
    }
  }

  for (const checkId of REQUIRED_MANUAL_CHECKS) {
    assertEvidenceCheck(validation, checkId);
  }
  const brandEvidence = String(validation?.checks?.brand_metadata_social_preview?.evidence ?? '');
  if (validationBrandName && !brandEvidence.includes(validationBrandName)) {
    fail('Manual launch validation checks.brand_metadata_social_preview.evidence must mention the cleared public brand name.');
  }
}

function run(script, env, timeoutMs) {
  console.log(`\n==> npm run ${script}`);
  const result = spawnSync(npm, ['run', script], {
    stdio: 'inherit',
    env,
    cwd: root,
    timeout: timeoutMs,
  });
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      throw new Error(`npm run ${script} timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw result.error;
  }
  if (result.signal) {
    throw new Error(`npm run ${script} exited with signal ${result.signal}`);
  }
  if (result.status !== 0) {
    throw new Error(`npm run ${script} failed with exit code ${result.status ?? 'unknown'}`);
  }
}

const envValues = readEnvValues();
const workerUrl = normalizedHttpsUrl(
  resolveEnv(envValues, 'ASF_WORKER_URL') || resolveEnv(envValues, 'VITE_API_BASE_URL'),
  'ASF_WORKER_URL',
);
if (workerUrl && hasInternalOrCapcomBrandRisk(workerUrl)) {
  fail('ASF_WORKER_URL/VITE_API_BASE_URL must use the cleared public brand Worker/API URL, not the internal project Worker URL.');
}
const frontendUrl = normalizedHttpsUrl(
  resolveEnv(envValues, 'ASF_FRONTEND_URL') || resolveEnv(envValues, 'ASF_FRONTEND_ORIGIN'),
  'ASF_FRONTEND_URL or ASF_FRONTEND_ORIGIN',
);
let brandClearance = null;
if (frontendUrl && /^https:\/\//i.test(frontendUrl) && !hasSampleValue(frontendUrl)) {
  brandClearance = assertBrandClearance(envValues, frontendUrl);
}
const clerkJwt = requiredJwt(resolveEnv(envValues, 'ASF_CLERK_JWT'), 'ASF_CLERK_JWT');
const cloneClerkJwt = requiredJwt(
  resolveEnv(envValues, 'ASF_CLERK_JWT_CLONE') || resolveEnv(envValues, 'ASF_CLERK_JWT_ALT'),
  'ASF_CLERK_JWT_CLONE',
);

if (clerkJwt && cloneClerkJwt && clerkJwt === cloneClerkJwt) {
  fail('ASF_CLERK_JWT_CLONE must come from a second Clerk user, not the primary smoke user.');
}
const clerkPayload = decodeJwtPayload(clerkJwt, 'ASF_CLERK_JWT');
const cloneClerkPayload = decodeJwtPayload(cloneClerkJwt, 'ASF_CLERK_JWT_CLONE');
const clerkSub = clerkPayload ? jwtSubject(clerkPayload, 'ASF_CLERK_JWT') : '';
const cloneClerkSub = cloneClerkPayload ? jwtSubject(cloneClerkPayload, 'ASF_CLERK_JWT_CLONE') : '';
if (clerkPayload) assertJwtFresh(clerkPayload, 'ASF_CLERK_JWT');
if (cloneClerkPayload) assertJwtFresh(cloneClerkPayload, 'ASF_CLERK_JWT_CLONE');
if (clerkSub && cloneClerkSub && clerkSub === cloneClerkSub) {
  fail('ASF_CLERK_JWT_CLONE must use a different Clerk user subject than ASF_CLERK_JWT.');
}

if (failures.length === 0) {
  assertManualLaunchValidation(envValues, workerUrl, frontendUrl, clerkSub, cloneClerkSub, brandClearance);
}

if (failures.length > 0) {
  console.error(`Launch gate configuration failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

const launchEnv = {
  ...Object.fromEntries(envValues),
  ...process.env,
  ASF_WORKER_URL: workerUrl,
  VITE_API_BASE_URL: resolveEnv(envValues, 'VITE_API_BASE_URL') || workerUrl,
  ASF_WORKER_HEALTH_URL: resolveEnv(envValues, 'ASF_WORKER_HEALTH_URL') || `${workerUrl}/health`,
  ASF_FRONTEND_URL: frontendUrl,
  ASF_FRONTEND_ORIGIN: frontendUrl,
  ASF_PUBLIC_APP_NAME: brandClearance?.publicBrandName ?? resolveEnv(envValues, 'ASF_PUBLIC_APP_NAME'),
  ASF_PUBLIC_APP_SHORT_NAME: brandClearance?.publicShortName ?? resolveEnv(envValues, 'ASF_PUBLIC_APP_SHORT_NAME'),
  ASF_CLERK_JWT: clerkJwt,
  ASF_CLERK_JWT_CLONE: cloneClerkJwt,
  ASF_SMOKE_REQUIRE_AUTH: '1',
  ASF_SMOKE_REQUIRE_CLONE: '1',
};

run('check:production', launchEnv, launchTimeoutFor(envValues, 'check:production'));
run('check:live-readiness', launchEnv, launchTimeoutFor(envValues, 'check:live-readiness'));
run('smoke:frontend-live', launchEnv, launchTimeoutFor(envValues, 'smoke:frontend-live'));
run('smoke:live:launch', launchEnv, launchTimeoutFor(envValues, 'smoke:live:launch'));

console.log('\nLaunch gate passed: brand clearance, manual validation evidence, production checks, live readiness, Pages smoke, and authenticated Worker smoke all succeeded.');
