// Same dedicated Meterkey credential boundary as ordinary Casual generation.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { casualRuntimeEnvironment } from './run-casual-generation.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
try {
  const environment = casualRuntimeEnvironment(args);
  const child = spawn(process.execPath, ['--import', resolve(root, 'processor/node_modules/tsx/dist/loader.mjs'), resolve(root, 'scripts/casual-selective-repair-cli.mjs'), ...args], { cwd: root, stdio: 'inherit', env: environment });
  environment.CASUAL_GEMINI_KEY = ''; environment.CASUAL_FAL_METERKEY_KEY = '';
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', () => { console.error('Casual selective repair could not start'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} catch (error) { console.error(error instanceof Error ? error.message : 'Selective repair preflight failed'); process.exitCode = 1; }
