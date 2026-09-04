import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeGenerationJobsFromWranglerOutput } from './worker-version-rollout-lib.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workerDir = join(root, 'worker');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const result = spawnSync(npx, [
  '--no-install',
  'wrangler',
  'd1',
  'execute',
  'insert-player-db',
  '--remote',
  '--json',
  '--command',
  "SELECT COUNT(*) AS active_jobs FROM generation_jobs WHERE status IN ('queued', 'running');",
], {
  cwd: workerDir,
  encoding: 'utf8',
  stdio: 'pipe',
  env: process.env,
  timeout: 60_000,
});

if (result.status !== 0) {
  const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  throw new Error(`Could not verify generation quiescence.${detail ? `\n${detail}` : ''}`);
}
const activeJobs = activeGenerationJobsFromWranglerOutput(result.stdout);
if (activeJobs !== 0) {
  throw new Error(`Refusing to deploy while ${activeJobs} generation job(s) are queued or running.`);
}
console.log('Generation pipeline is idle.');
