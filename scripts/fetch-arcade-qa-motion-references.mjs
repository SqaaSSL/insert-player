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
import { QA_MOTION_CANARY } from './arcade-qa-motion-candidate.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_OUTPUT_DIR = join(root, '.arcade-pose-masters');
const MAX_REFERENCE_BYTES = 12 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function referenceForRole(candidate, role) {
  if (role === 'pose') return candidate.motion.asset;
  if (role === 'canonical') return candidate.canonical;
  throw new Error(`Unsupported QA motion reference role: ${String(role)}.`);
}

export function qaMotionReferenceObjectPath(reference) {
  if (reference?.bucket !== 'insert-player-assets' || reference?.jurisdiction !== 'eu') {
    throw new Error('QA motion reference must use the private EU production bucket.');
  }
  if (typeof reference.objectKey !== 'string' || reference.objectKey.startsWith('/') || reference.objectKey.includes('..')) {
    throw new Error('QA motion reference object key is invalid.');
  }
  return `${reference.bucket}/${reference.objectKey}`;
}

export function verifyQaMotionReferenceBytes(bytes, reference) {
  if (bytes.byteLength < PNG_SIGNATURE.byteLength || bytes.byteLength > MAX_REFERENCE_BYTES) {
    throw new Error(`QA motion reference has an invalid size: ${reference.id}.`);
  }
  if (!bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) {
    throw new Error(`QA motion reference is not PNG: ${reference.id}.`);
  }
  const actualHash = createHash('sha256').update(bytes).digest('hex');
  if (actualHash !== reference.contentSha256) {
    throw new Error(`QA motion reference hash mismatch: ${reference.id}.`);
  }
  return actualHash;
}

export function fetchQaMotionReference(options = {}) {
  const candidate = options.candidate ?? QA_MOTION_CANARY;
  const role = options.role;
  const reference = referenceForRole(candidate, role);
  const outputPath = options.outputPath ?? join(DEFAULT_OUTPUT_DIR, `${reference.id}.png`);
  const objectPath = qaMotionReferenceObjectPath(reference);
  if (existsSync(outputPath)) {
    verifyQaMotionReferenceBytes(readFileSync(outputPath), reference);
    return { action: 'verified', role, outputPath, objectPath };
  }
  if (options.dryRun === true) return { action: 'remote', role, outputPath, objectPath };

  const wranglerCli = options.wranglerCli ?? join(root, 'worker/node_modules/wrangler/bin/wrangler.js');
  if (!existsSync(wranglerCli)) {
    throw new Error('Pinned Worker dependencies are missing. Run npm --prefix worker ci first.');
  }
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  const temporary = `${outputPath}.download-${process.pid}`;
  const result = (options.spawnImpl ?? spawnSync)(process.execPath, [
    wranglerCli,
    'r2',
    'object',
    'get',
    objectPath,
    '--file',
    temporary,
    '--remote',
    '--jurisdiction',
    reference.jurisdiction,
    '--config',
    'worker/wrangler.toml',
  ], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    rmSync(temporary, { force: true });
    throw new Error(`Could not fetch QA motion reference: ${reference.id}.`);
  }
  try {
    verifyQaMotionReferenceBytes(readFileSync(temporary), reference);
    chmodSync(temporary, 0o600);
    renameSync(temporary, outputPath);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return { action: 'fetched', role, outputPath, objectPath };
}

export function fetchQaMotionReferences(options = {}) {
  return ['pose', 'canonical'].map((role) => fetchQaMotionReference({ ...options, role }));
}

function main() {
  const rawArgs = process.argv.slice(2);
  const candidateId = rawArgs.find((arg) => arg.startsWith('--candidate='))?.slice('--candidate='.length) ?? '';
  if (candidateId !== QA_MOTION_CANARY.candidateId) {
    throw new Error(`--candidate must be ${QA_MOTION_CANARY.candidateId}.`);
  }
  const results = fetchQaMotionReferences({ dryRun: rawArgs.includes('--dry-run') });
  for (const result of results) {
    console.log(`${result.action.padEnd(8)} ${result.role.padEnd(9)} ${result.objectPath}`);
  }
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
