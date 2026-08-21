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
const SMOKE_TIMEOUT_MS = 180_000;

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

function run(label, command, commandArgs, cwd = root, timeout = undefined) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH || wranglerLogPath,
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

function main() {
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
    isSandbox ? 'frontend sandbox smoke' : 'frontend live smoke',
    npm,
    ['run', isSandbox ? 'smoke:frontend-sandbox' : 'smoke:frontend-live'],
    root,
    SMOKE_TIMEOUT_MS,
  );
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
