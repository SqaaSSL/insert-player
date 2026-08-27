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
import { XAI_SIDE_CANARY_POSE_MASTER } from './arcade-side-xai-canary.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_OUTPUT_DIR = join(root, '.arcade-pose-masters');
const MAX_MASTER_BYTES = 12 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TARGETS = Object.freeze({
  production: Object.freeze({ config: 'worker/wrangler.toml' }),
});

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function xaiPoseMasterObjectPath(master = XAI_SIDE_CANARY_POSE_MASTER) {
  if (!/^[a-z0-9-]+$/.test(master?.id ?? '')) throw new Error('Invalid XAI pose-master id.');
  if (!/^[a-f0-9]{64}$/.test(master?.contentSha256 ?? '')) {
    throw new Error(`Invalid XAI pose-master hash for ${master?.id ?? 'unknown master'}.`);
  }
  if (master.jurisdiction !== 'eu' || master.bucket !== 'insert-player-assets') {
    throw new Error(`Unsupported XAI pose-master storage for ${master.id}.`);
  }
  return `${master.bucket}/${master.objectKey}`;
}

export function verifyXaiPoseMasterBytes(bytes, master = XAI_SIDE_CANARY_POSE_MASTER) {
  if (bytes.byteLength < PNG_SIGNATURE.byteLength || bytes.byteLength > MAX_MASTER_BYTES) {
    throw new Error(`XAI pose master has an invalid size: ${master.id}.`);
  }
  if (!bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) {
    throw new Error(`XAI pose master is not PNG: ${master.id}.`);
  }
  const actualHash = sha256(bytes);
  if (actualHash !== master.contentSha256) {
    throw new Error(`XAI pose-master hash mismatch: ${master.id}.`);
  }
  return actualHash;
}

export function fetchXaiPoseMaster(options = {}) {
  const target = options.target ?? 'production';
  const targetConfig = TARGETS[target];
  if (!targetConfig) throw new Error('XAI pose master is available only from production.');
  const master = options.master ?? XAI_SIDE_CANARY_POSE_MASTER;
  if (master.id !== XAI_SIDE_CANARY_POSE_MASTER.id) {
    throw new Error(`Unknown XAI pose master: ${master.id}.`);
  }
  const outputPath = options.outputPath ?? join(DEFAULT_OUTPUT_DIR, `${master.id}.png`);
  const objectPath = xaiPoseMasterObjectPath(master);
  if (existsSync(outputPath)) {
    verifyXaiPoseMasterBytes(readFileSync(outputPath), master);
    return { action: 'verified', outputPath, objectPath };
  }
  if (options.dryRun === true) return { action: 'remote', outputPath, objectPath };

  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  const temporary = `${outputPath}.download-${process.pid}`;
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
    master.jurisdiction,
    '--config',
    targetConfig.config,
  ], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    rmSync(temporary, { force: true });
    throw new Error(`Could not fetch XAI pose master: ${master.id}.`);
  }
  try {
    verifyXaiPoseMasterBytes(readFileSync(temporary), master);
    chmodSync(temporary, 0o600);
    renameSync(temporary, outputPath);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return { action: 'fetched', outputPath, objectPath };
}

function main() {
  const rawArgs = process.argv.slice(2);
  const target = rawArgs.find((arg) => arg.startsWith('--target='))?.slice('--target='.length) ?? 'production';
  const masterId = rawArgs.find((arg) => arg.startsWith('--master='))?.slice('--master='.length) ?? '';
  if (masterId !== XAI_SIDE_CANARY_POSE_MASTER.id) {
    throw new Error(`--master must be ${XAI_SIDE_CANARY_POSE_MASTER.id}.`);
  }
  const result = fetchXaiPoseMaster({
    target,
    dryRun: rawArgs.includes('--dry-run'),
  });
  console.log(`${result.action.padEnd(8)} ${masterId}  ${result.objectPath}`);
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
