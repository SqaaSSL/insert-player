import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest } from './seed-arcade-roster.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(root, 'arcade/roster-2026.json');
const sourceDir = join(root, '.arcade-sources');
const MAX_SOURCE_UPLOAD_BYTES = 12 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TARGETS = {
  production: {
    bucket: 'insert-player-assets',
    config: 'worker/wrangler.toml',
  },
  sandbox: {
    bucket: 'insert-player-sandbox-assets',
    config: 'worker/wrangler.sandbox.toml',
  },
};

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function selectArcadeSourceFighters(manifest, options = {}) {
  const slug = String(options.slug ?? '').trim();
  const selectAll = options.all === true;
  if (selectAll === Boolean(slug)) {
    throw new Error('Choose exactly one of --all or --slug=<fighter>.');
  }
  if (selectAll) return manifest.fighters;
  const fighter = manifest.fighters.find((entry) => entry.slug === slug);
  if (!fighter) throw new Error(`Unknown Arcade fighter: ${slug}`);
  return [fighter];
}

export function arcadeSourceObjectPath(target, fighter) {
  const config = TARGETS[target];
  if (!config) throw new Error('--target must be production or sandbox.');
  const hash = fighter?.reference?.sourceSha256;
  if (!/^[a-f0-9]{64}$/.test(hash ?? '')) {
    throw new Error(`Invalid licensed source hash for ${fighter?.slug ?? 'unknown fighter'}.`);
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fighter?.slug ?? '')) {
    throw new Error(`Invalid Arcade slug: ${String(fighter?.slug)}`);
  }
  return `${config.bucket}/official-roster-inputs/${fighter.slug}/${hash}.png`;
}

export function verifyArcadeSourceBytes(fighter, bytes) {
  if (bytes.byteLength > MAX_SOURCE_UPLOAD_BYTES) {
    throw new Error(`Licensed source photo exceeds the 12 MiB upload limit: ${fighter.slug}`);
  }
  if (!bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) {
    throw new Error(`Licensed source photo is not a valid PNG input: ${fighter.slug}`);
  }
  const actualHash = sha256(bytes);
  const expectedHash = fighter.reference.sourceSha256;
  if (actualHash !== expectedHash) {
    throw new Error(`Licensed source hash mismatch for ${fighter.slug}.`);
  }
  return actualHash;
}

function fetchSource(target, fighter, dryRun) {
  const targetConfig = TARGETS[target];
  const objectPath = arcadeSourceObjectPath(target, fighter);
  const destination = join(sourceDir, `${fighter.slug}.png`);
  if (existsSync(destination)) {
    verifyArcadeSourceBytes(fighter, readFileSync(destination));
    console.log(`verified  ${fighter.slug}  ${objectPath}`);
    return;
  }
  if (dryRun) {
    console.log(`remote    ${fighter.slug}  ${objectPath}`);
    return;
  }

  const temporary = `${destination}.download-${process.pid}`;
  const wranglerCli = join(root, 'worker/node_modules/wrangler/bin/wrangler.js');
  if (!existsSync(wranglerCli)) {
    throw new Error('Pinned Worker dependencies are missing. Run npm --prefix worker ci first.');
  }
  const result = spawnSync(process.execPath, [
    wranglerCli,
    'r2',
    'object',
    'get',
    objectPath,
    '--file',
    temporary,
    '--remote',
    '--jurisdiction',
    'eu',
    '--config',
    targetConfig.config,
  ], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    rmSync(temporary, { force: true });
    throw new Error(`Could not fetch the private licensed source for ${fighter.slug}.`);
  }
  try {
    verifyArcadeSourceBytes(fighter, readFileSync(temporary));
    chmodSync(temporary, 0o600);
    renameSync(temporary, destination);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  console.log(`fetched   ${fighter.slug}  ${objectPath}`);
}

function main() {
  const rawArgs = process.argv.slice(2);
  const args = new Set(rawArgs);
  const target = rawArgs.find((arg) => arg.startsWith('--target='))?.slice('--target='.length) ?? 'production';
  const slug = rawArgs.find((arg) => arg.startsWith('--slug='))?.slice('--slug='.length) ?? '';
  if (!TARGETS[target]) throw new Error('--target must be production or sandbox.');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  validateManifest(manifest);
  const fighters = selectArcadeSourceFighters(manifest, { all: args.has('--all'), slug });
  mkdirSync(sourceDir, { recursive: true, mode: 0o700 });
  for (const fighter of fighters) fetchSource(target, fighter, args.has('--dry-run'));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
