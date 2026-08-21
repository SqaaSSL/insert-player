import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const node = process.execPath;

function run(label, command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${label} exited with signal ${result.signal}`);
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status ?? 'unknown'}`);
}

function prelaunchBuildEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('VITE_')) delete env[key];
  }
  return env;
}

function textFiles(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      textFiles(path, files);
    } else if (['.html', '.js', '.css', '.json', '.txt', '.xml', '.webmanifest'].includes(extname(path))) {
      files.push(path);
    }
  }
  return files;
}

function assertPrelaunchBundleIsIsolated() {
  const dist = join(root, 'dist');
  const files = textFiles(dist);
  const forbidden = [
    /pk_(?:test|live)_/i,
    /sk_(?:test|live)_/i,
    /whsec_/i,
    /https:\/\/api\.insertplayer\.ai/i,
    /insert-player-api-sandbox/i,
    /ai-street-fighter-api\.shellbot\.workers\.dev/i,
    /clerk\.insertplayer\.ai/i,
    /clerk\.accounts\.dev/i,
    /generativelanguage\.googleapis\.com/i,
    /queue\.fal\.run/i,
    /api\.dev\.runwayml\.com/i,
    /api\.freepik\.com/i,
    /api\.ludo\.ai/i,
    /\/proxy\/(?:gemini|fal|runway|freepik|ludo)/i,
  ];
  const offenders = [];
  let hasStatusCopy = false;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (text.includes('Production access is opening shortly.')) hasStatusCopy = true;
    for (const pattern of forbidden) {
      if (pattern.test(text)) offenders.push(`${relative(root, file)}: ${pattern}`);
    }
  }
  if (!hasStatusCopy) throw new Error('Prelaunch bundle is missing its visible status copy.');
  if (offenders.length > 0) {
    throw new Error(`Prelaunch bundle contains runtime credentials or application endpoints:\n${offenders.join('\n')}`);
  }
}

try {
  const env = prelaunchBuildEnv();
  if (!process.argv.includes('--skip-checks')) {
    run('frontend style guard', npm, ['run', 'check:frontend']);
    run('frontend typecheck', npx, ['tsc']);
  }
  run('prelaunch Vite build', npx, ['vite', 'build', '--mode', 'prelaunch'], env);
  run('prelaunch dist configuration', node, ['scripts/configure-frontend-dist.mjs', '--target=prelaunch'], env);
  assertPrelaunchBundleIsIsolated();
  console.log('Prelaunch build checks passed.');
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
