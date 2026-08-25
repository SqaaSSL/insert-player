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

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_OUTPUT_DIR = join(root, '.arcade-pose-masters');
const MAX_MASTER_BYTES = 12 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const XAI_HIGH_KICK_IMPACT_POSE_MASTER = Object.freeze({
  id: 'xai-high-kick-impact-v1',
  slug: 'pose-master-high-kick-impact-v1',
  bucket: 'insert-player-assets',
  jurisdiction: 'eu',
  objectKey: 'official-pose-masters/high-kick-impact-v1/43086a8d96acd9b153a1c38c3dd622bf0b7140d90d067a4459a0d3b7fd637bed.png',
  contentSha256: '43086a8d96acd9b153a1c38c3dd622bf0b7140d90d067a4459a0d3b7fd637bed',
  width: 768,
  height: 1024,
});

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function verifyXaiMotionMasterBytes(bytes, master = XAI_HIGH_KICK_IMPACT_POSE_MASTER) {
  if (bytes.byteLength < PNG_SIGNATURE.byteLength || bytes.byteLength > MAX_MASTER_BYTES) {
    throw new Error(`XAI motion master has an invalid size: ${master.id}.`);
  }
  if (!bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) {
    throw new Error(`XAI motion master is not PNG: ${master.id}.`);
  }
  const actualHash = sha256(bytes);
  if (actualHash !== master.contentSha256) {
    throw new Error(`XAI motion-master hash mismatch: ${master.id}.`);
  }
  return actualHash;
}

export function fetchXaiMotionMaster(options = {}) {
  const master = options.master ?? XAI_HIGH_KICK_IMPACT_POSE_MASTER;
  if (master.id !== XAI_HIGH_KICK_IMPACT_POSE_MASTER.id) {
    throw new Error(`Unknown XAI motion master: ${master.id}.`);
  }
  const outputPath = options.outputPath ?? join(DEFAULT_OUTPUT_DIR, `${master.id}.png`);
  const objectPath = `${master.bucket}/${master.objectKey}`;
  if (existsSync(outputPath)) {
    verifyXaiMotionMasterBytes(readFileSync(outputPath), master);
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
    'worker/wrangler.toml',
  ], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    rmSync(temporary, { force: true });
    throw new Error(`Could not fetch XAI motion master: ${master.id}.`);
  }
  try {
    verifyXaiMotionMasterBytes(readFileSync(temporary), master);
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
  const masterId = rawArgs.find((arg) => arg.startsWith('--master='))?.slice('--master='.length) ?? '';
  if (masterId !== XAI_HIGH_KICK_IMPACT_POSE_MASTER.id) {
    throw new Error(`--master must be ${XAI_HIGH_KICK_IMPACT_POSE_MASTER.id}.`);
  }
  const result = fetchXaiMotionMaster({ dryRun: rawArgs.includes('--dry-run') });
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
