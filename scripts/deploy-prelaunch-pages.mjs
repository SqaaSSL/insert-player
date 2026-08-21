import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workerDir = join(root, 'worker');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const node = process.execPath;

function run(label, command, args, cwd = root, timeout = undefined) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: process.env,
    timeout,
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${label} exited with signal ${result.signal}`);
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status ?? 'unknown'}`);
}

try {
  if (!process.argv.includes('--confirm-production')) {
    throw new Error('Prelaunch Pages deploy requires --confirm-production.');
  }
  run('production checks', npm, ['run', 'check:production']);
  run('prelaunch build', npm, ['run', 'build:prelaunch']);
  run(
    'Cloudflare Pages prelaunch deploy',
    node,
    [
      '../scripts/wrangler-workspace-log.mjs',
      'pages',
      'deploy',
      '../dist',
      '--project-name',
      'insert-player',
      '--branch',
      'main',
    ],
    workerDir,
    300_000,
  );
  run('prelaunch frontend smoke', npm, ['run', 'smoke:frontend:prelaunch'], root, 180_000);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
