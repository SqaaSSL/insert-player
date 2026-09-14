// Dedicated Meterkey-only wrapper. No local provider env files, direct keys, or provider fallback.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateMeterkeyApiKeyFingerprint } from './meterkey-auth-context.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEDICATED_FINGERPRINT = '08d594f84f67aa9c6f2e5b571fcf61f275e32d03d9fb77418777af71482c5502';
function readDedicatedCredential() {
  const result = spawnSync('/usr/bin/security', ['find-generic-password', '-s', 'hilo-meterkey', '-a', 'insert-player-platform', '-w'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, maxBuffer: 16384 });
  assert.ok(!result.error && result.status === 0, 'Dedicated Insert Player Meterkey credential unavailable; no fallback');
  const key = result.stdout.trim(); result.stdout = ''; return key;
}
export function casualRuntimeEnvironment(args, { environment = process.env, readCredential = readDedicatedCredential,
  validateCredential = validateMeterkeyApiKeyFingerprint } = {}) {
  assert.ok(!args.some(arg => arg.startsWith('--credentials-file') || arg.startsWith('--google-direct')),
    'Direct provider credentials are disabled; Casual uses only the dedicated Insert Player Meterkey keychain credential');
  const result = Object.fromEntries(['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ'].filter(name => environment[name]).map(name => [name, environment[name]]));
  if (args.includes('--execute')) {
    const key = readCredential(); validateCredential(key, { keyFingerprint: DEDICATED_FINGERPRINT });
    Object.assign(result, { CASUAL_GENERATION_CREDENTIALS_READY: '1', CASUAL_GEMINI_TRANSPORT: 'meterkey',
      CASUAL_GEMINI_KEY: key, CASUAL_FAL_METERKEY_KEY: key });
  }
  return result;
}
function main() {
  const args = process.argv.slice(2);
  try {
    const environment = casualRuntimeEnvironment(args);
    const child = spawn(process.execPath, ['--import', resolve(root, 'processor/node_modules/tsx/dist/loader.mjs'),
      resolve(root, 'processor/src/casualGenerationCli.ts'), ...args], { cwd: root, stdio: 'inherit', env: environment });
    environment.CASUAL_GEMINI_KEY = ''; environment.CASUAL_FAL_METERKEY_KEY = '';
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
    child.on('error', () => { console.error('Casual artifact runner could not start'); process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code ?? 1; });
  } catch (error) { console.error(error instanceof Error ? error.message : 'Casual credential preflight failed'); process.exitCode = 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
