import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const wranglerLogPath = join(root, '.wrangler-logs');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

mkdirSync(wranglerLogPath, { recursive: true });

const result = spawnSync(npx, ['wrangler', ...process.argv.slice(2)], {
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
