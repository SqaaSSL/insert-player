import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertProductionDeployAllowed } from './production-deploy-guard.mjs';
import { isProductionWranglerMutation } from './production-deploy-guard-lib.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const wranglerLogPath = join(root, '.wrangler-logs');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const wranglerArgs = process.argv.slice(2);

if (isProductionWranglerMutation(wranglerArgs)) {
  const context = assertProductionDeployAllowed({ root });
  console.log(`Production Wrangler mutation authorized: ${context.channel} ${context.gitSha}.`);
}

mkdirSync(wranglerLogPath, { recursive: true });

const result = spawnSync(npx, ['wrangler', ...wranglerArgs], {
  cwd: process.cwd(),
  stdio: 'inherit',
  env: {
    ...process.env,
    WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH || wranglerLogPath,
  },
});

if (result.signal) {
  console.error(`wrangler exited with signal ${result.signal}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
