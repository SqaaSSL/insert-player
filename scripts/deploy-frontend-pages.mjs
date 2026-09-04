import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { purgeExactCloudflareFiles } from './cloudflare-cache.mjs';
import { assertDevelopmentDeployAllowed } from './development-deploy-guard.mjs';
import {
  chunkFrontendReleaseAssets,
  collectFrontendReleaseAssetPaths,
  expectedMediaContentType,
  waitForLiveMediaAsset,
} from './frontend-release-assets.mjs';
import { assertProductionDeployAllowed } from './production-deploy-guard.mjs';
import { writeFrontendReleaseManifest } from './release-provenance.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workerDir = join(root, 'worker');
const wranglerLogPath = join(root, '.wrangler-logs');
const node = process.execPath;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const targetArg = rawArgs.find((arg) => arg.startsWith('--target='));
const deployTarget = targetArg?.slice('--target='.length) || 'live';
const isSandbox = deployTarget === 'sandbox';
const DEPLOY_TIMEOUT_MS = 300_000;
const SMOKE_TIMEOUT_MS = 360_000;
const CANONICAL_SMOKE_READY_TIMEOUT_MS = 240_000;
const LIVE_FRONTEND_ORIGINS = ['https://insertplayer.ai', 'https://www.insertplayer.ai'];

const sampleFragments = [
  'PLACEHOLDER',
  'replace_me',
  'your-',
  'example',
  'fighter-lab',
  'ai-street-fighter',
  'street-fighter',
  'capcom',
  'asf',
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
  const files = isSandbox
    ? ['.env.sandbox.local', '.env.sandbox']
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

function envValue(values, ...keys) {
  for (const key of keys) {
    const value = values.get(key)?.trim() ?? '';
    if (value) return value;
  }
  return '';
}

function hasSampleOrInternalValue(value) {
  const normalized = value.toLowerCase();
  return sampleFragments.some((fragment) => normalized.includes(fragment));
}

function cleanPagesProjectName(values) {
  const projectName = envValue(
    values,
    isSandbox ? 'ASF_SANDBOX_PAGES_PROJECT_NAME' : 'ASF_PAGES_PROJECT_NAME',
    'CF_PAGES_PROJECT_NAME',
    'CLOUDFLARE_PAGES_PROJECT_NAME',
  );
  if (!projectName) {
    throw new Error(`${isSandbox ? 'ASF_SANDBOX_PAGES_PROJECT_NAME' : 'ASF_PAGES_PROJECT_NAME'} is required before frontend deploy.`);
  }
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(projectName)) {
    throw new Error('ASF_PAGES_PROJECT_NAME must be a Cloudflare Pages project slug: lowercase letters, numbers, and hyphens.');
  }
  if (isSandbox && projectName !== 'insert-player-sandbox') {
    throw new Error('Sandbox frontend deploy is pinned to the insert-player-sandbox Pages project.');
  }
  if (!isSandbox && hasSampleOrInternalValue(projectName)) {
    throw new Error('ASF_PAGES_PROJECT_NAME must use the cleared public brand, not the internal project name or a placeholder.');
  }
  return projectName;
}

function run(label, command, commandArgs, cwd = root, timeout = undefined, extraEnv = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH || wranglerLogPath,
      ...extraEnv,
    },
    timeout,
  });
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      throw new Error(`${label} timed out after ${Math.round((timeout ?? 0) / 1000)}s`);
    }
    throw result.error;
  }
  if (result.signal) throw new Error(`${label} exited with signal ${result.signal}`);
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status ?? 'unknown'}`);
}

function builtFrontendAssetPath() {
  const html = readFileSync(join(root, 'dist', 'index.html'), 'utf8');
  const paths = [...html.matchAll(/<script\b[^>]*\bsrc="(\/assets\/[A-Za-z0-9._-]+\.js)"/g)]
    .map((match) => match[1]);
  if (paths.length !== 1) {
    throw new Error(`Expected exactly one frontend entry asset in dist/index.html, found ${paths.length}.`);
  }
  return paths[0];
}

function builtFrontendReleaseAssetPaths(entryAssetPath) {
  const distDir = join(root, 'dist');
  const assetsDir = join(distDir, 'assets');
  const sourcePaths = [join(distDir, 'index.html')];
  for (const name of readdirSync(assetsDir)) {
    if (/\.(?:css|js)$/.test(name)) sourcePaths.push(join(assetsDir, name));
  }
  return collectFrontendReleaseAssetPaths({
    entryAssetPath,
    sourceTexts: sourcePaths.map((path) => readFileSync(path, 'utf8')),
  });
}

async function purgeLiveAssetCache(values, assetPaths) {
  if (isSandbox) return;
  const token = envValue(values, 'CLOUDFLARE_API_TOKEN');
  const zoneId = envValue(values, 'ASF_CLOUDFLARE_ZONE_ID', 'CLOUDFLARE_ZONE_ID');
  if (!token || !zoneId) {
    console.warn('Skipping exact asset cache purge: Cloudflare API token or zone id is unavailable.');
    return;
  }
  if (!/^[a-f0-9]{32}$/i.test(zoneId)) {
    throw new Error('ASF_CLOUDFLARE_ZONE_ID must be a 32-character Cloudflare zone id.');
  }

  const chunks = chunkFrontendReleaseAssets(assetPaths, LIVE_FRONTEND_ORIGINS);
  for (const files of chunks) {
    const result = await purgeExactCloudflareFiles({ token, zoneId, files });
    if (!result.purged) {
      console.warn(`${result.warning}; continuing to the authoritative canonical smoke.`);
      return;
    }
  }
  console.log(`Purged live cache entries for ${assetPaths.length} release assets.`);
}

async function verifyLiveMediaAssets(assetPaths) {
  if (isSandbox) return;
  const mediaAssets = assetPaths
    .map((path) => ({ path, expectedType: expectedMediaContentType(path) }))
    .filter(({ expectedType }) => expectedType);
  for (const { path, expectedType } of mediaAssets) {
    const { actualType, contentLength, attempt } = await waitForLiveMediaAsset({
      url: `${LIVE_FRONTEND_ORIGINS[0]}${path}`,
      expectedType,
      onRetry: ({ status, actualType: retryType, contentLength: retryLength, attempt: retryAttempt, maxAttempts }) => {
        console.warn(
          `Live media ${path} is not ready after attempt ${retryAttempt}/${maxAttempts}: status=${status ?? 'unavailable'} type=${retryType || 'missing'} bytes=${retryLength ?? 'unspecified'}; retrying after Pages propagation.`,
        );
      },
    });
    if (attempt > 1) console.log(`Live media ${path} became ready on attempt ${attempt}.`);
    console.log(`Verified live media ${path} (${actualType}, ${contentLength ?? 'unspecified'} bytes).`);
  }
}

async function main() {
  if (!['live', 'sandbox'].includes(deployTarget)) {
    throw new Error('Frontend deploy target must be --target=live or --target=sandbox.');
  }
  const values = readEnvValues();
  const projectName = cleanPagesProjectName(values);
  const branch = envValue(
    values,
    isSandbox ? 'ASF_SANDBOX_PAGES_BRANCH' : 'ASF_PAGES_BRANCH',
    'CF_PAGES_BRANCH',
  ) || 'main';

  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) {
    throw new Error('ASF_PAGES_BRANCH contains unsupported characters.');
  }
  const expectedBranch = isSandbox ? 'develop' : 'main';
  if (branch !== expectedBranch) {
    throw new Error(`Frontend ${deployTarget} deploy branch must be ${expectedBranch}.`);
  }

  console.log(`Frontend Pages deploy target: ${projectName} (${branch}, ${deployTarget})`);
  if (args.has('--check-only')) {
    console.log('Frontend Pages deploy config checks passed.');
    return;
  }

  const releaseContext = isSandbox
    ? assertDevelopmentDeployAllowed({ root })
    : assertProductionDeployAllowed({ root });
  console.log(
    `Frontend ${isSandbox ? 'sandbox' : 'production'} release authorized: ${releaseContext.channel} ${releaseContext.gitSha}.`,
  );

  mkdirSync(wranglerLogPath, { recursive: true });
  if (!args.has('--skip-production-check')) {
    run('production checks', npm, ['run', 'check:production']);
  }
  run(
    isSandbox ? 'frontend sandbox env checks' : 'frontend live env checks',
    npm,
    ['run', isSandbox ? 'check:frontend-sandbox' : 'check:frontend-live'],
  );
  run('frontend build', npm, ['run', isSandbox ? 'build:sandbox' : 'build']);
  run(
    'frontend environment CSP',
    node,
    ['scripts/configure-frontend-dist.mjs', `--target=${isSandbox ? 'sandbox' : 'live'}`],
  );
  const expectedAssetPath = builtFrontendAssetPath();
  if (!isSandbox) {
    writeFrontendReleaseManifest({
      distDir: join(root, 'dist'),
      context: releaseContext,
      entryAssetPath: expectedAssetPath,
    });
  }
  const releaseAssetPaths = builtFrontendReleaseAssetPaths(expectedAssetPath);
  console.log(`Frontend release asset: ${expectedAssetPath}`);
  console.log(`Frontend referenced release assets: ${releaseAssetPaths.length}`);
  run(
    'Cloudflare Pages deploy',
    node,
    [
      '../scripts/wrangler-workspace-log.mjs',
      'pages',
      'deploy',
      '../dist',
      '--project-name',
      projectName,
      '--branch',
      branch,
    ],
    workerDir,
    DEPLOY_TIMEOUT_MS,
  );
  run(
    isSandbox ? 'frontend sandbox propagation smoke' : 'frontend live propagation smoke',
    npm,
    ['run', isSandbox ? 'smoke:frontend-sandbox' : 'smoke:frontend-live'],
    root,
    SMOKE_TIMEOUT_MS,
    {
      ASF_EXPECTED_FRONTEND_ASSET_PATH: expectedAssetPath,
      ...(!isSandbox ? { ASF_EXPECTED_FRONTEND_GIT_SHA: releaseContext.gitSha } : {}),
      ASF_FRONTEND_ASSET_PROBE_NONCE: `deploy-${Date.now()}`,
    },
  );
  await purgeLiveAssetCache(values, releaseAssetPaths);
  await verifyLiveMediaAssets(releaseAssetPaths);
  run(
    isSandbox ? 'frontend sandbox canonical smoke' : 'frontend live canonical smoke',
    npm,
    ['run', isSandbox ? 'smoke:frontend-sandbox' : 'smoke:frontend-live'],
    root,
    SMOKE_TIMEOUT_MS,
    {
      ASF_EXPECTED_FRONTEND_ASSET_PATH: expectedAssetPath,
      ...(!isSandbox ? { ASF_EXPECTED_FRONTEND_GIT_SHA: releaseContext.gitSha } : {}),
      ASF_FRONTEND_READY_TIMEOUT_MS: String(CANONICAL_SMOKE_READY_TIMEOUT_MS),
    },
  );
}

try {
  await main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
