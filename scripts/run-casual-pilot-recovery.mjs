// Explicit task-only SSH route; frozen pilot source and original plan stay unchanged.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { casualRuntimeEnvironment } from './run-casual-generation.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), args = process.argv.slice(2);
try {
  const execute = args.includes('--execute');
  const environment = casualRuntimeEnvironment(args);
  let entry, imports;
  if (execute) {
    assert.ok(args.every(arg => ['--execute', '--step=render', '--step=clean', '--confirm=casual-low-kick-unique4-pose-primary-v1'].includes(arg) || arg.startsWith('--raw-reviewed=')));
    const ssh = resolve(root, '.artifacts/casual-generation-v1/recovery/meterkey-ssh-transport.mjs');
    const bytes = readFileSync(ssh);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), 'c2685d226c6ed7bc0c1ccbd4391e63cc49fd4e6c348e41d2cd62e59a167a03c1');
    imports = ['--import', ssh, '--import', resolve(root, 'processor/node_modules/tsx/dist/loader.mjs')];
    entry = resolve(root, 'processor/src/casualRefinementPilotCli.ts');
  } else { imports = []; entry = resolve(root, 'scripts/casual-pilot-recovery-cli.mjs'); }
  const child = spawn(process.execPath, [...imports, entry, ...args], { cwd: root, stdio: 'inherit', env: environment });
  environment.CASUAL_GEMINI_KEY = ''; environment.CASUAL_FAL_METERKEY_KEY = '';
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', () => { console.error('Pilot recovery wrapper could not start'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} catch (error) { console.error(error instanceof Error ? error.message : 'Pilot recovery preflight failed'); process.exitCode = 1; }
