import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

async function purgeLiveAssetCache(values, assetPath) {
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

  const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      files: LIVE_FRONTEND_ORIGINS.map((origin) => `${origin}${assetPath}`),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.success !== true) {
    const message = body?.errors?.map((error) => error?.message).filter(Boolean).join('; ');
    throw new Error(`Cloudflare exact asset cache purge failed (${response.status}): ${message || 'unknown error'}`);
  }
  console.log(`Purged live cache entries for ${assetPath}.`);
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

  console.log(`Frontend Pages deploy target: ${projectName} (${branch}, ${deployTarget})`);
  if (args.has('--check-only')) {
    console.log('Frontend Pages deploy config checks passed.');
    return;
  }

  mkdirSync(wranglerLogPath, { recursive: true });
  run('production checks', npm, ['run', 'check:production']);
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
  console.log(`Frontend release asset: ${expectedAssetPath}`);
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
      ASF_FRONTEND_ASSET_PROBE_NONCE: `deploy-${Date.now()}`,
    },
  );
  await purgeLiveAssetCache(values, expectedAssetPath);
  run(
    isSandbox ? 'frontend sandbox canonical smoke' : 'frontend live canonical smoke',
    npm,
    ['run', isSandbox ? 'smoke:frontend-sandbox' : 'smoke:frontend-live'],
    root,
    SMOKE_TIMEOUT_MS,
    {
      ASF_EXPECTED_FRONTEND_ASSET_PATH: expectedAssetPath,
      ASF_FRONTEND_READY_TIMEOUT_MS: '30000',
    },
  );
}

try {
  await main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
