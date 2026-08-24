import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const processorDir = dirname(dirname(fileURLToPath(import.meta.url)));
const root = dirname(processorDir);
const bundleFlag = process.argv.indexOf('--bundle');
const bundlePath = bundleFlag >= 0 && process.argv[bundleFlag + 1]
  ? resolve(process.cwd(), process.argv[bundleFlag + 1])
  : null;

const forbidden = [
  {
    label: 'fal FLUX.2 model or endpoint',
    pattern: /fal-ai\/flux-2(?:[-/]|$)/i,
  },
  {
    label: 'direct BFL API host',
    pattern: /api(?:\.eu)?\.bfl\.ai/i,
  },
  {
    label: 'BFL FLUX.2 runtime endpoint',
    pattern: /\/v1\/flux-2-(?:klein|pro|max|flex)/i,
  },
  {
    label: 'experimental BFL prompt import',
    pattern: /(?:from\s*['"][^'"]*BflFlux2Prompts|import\s*\(\s*['"][^'"]*BflFlux2Prompts)/,
  },
];

function walk(directory, files = []) {
  if (!existsSync(directory)) return files;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (path === join(root, 'processor/src/benchmark')) continue;
      walk(path, files);
      continue;
    }
    if (!['.ts', '.tsx', '.mjs'].includes(extname(entry.name))) continue;
    if (/\.(?:test|spec)\.[^.]+$/i.test(entry.name)) continue;
    files.push(path);
  }
  return files;
}

const runtimeFiles = [
  ...walk(join(root, 'src')),
  ...walk(join(root, 'worker/src')),
  ...walk(join(root, 'processor/src')),
  ...walk(join(root, 'scripts')),
].filter((path) => path !== fileURLToPath(import.meta.url));

if (bundlePath) {
  if (!existsSync(bundlePath)) throw new Error(`Processor bundle is missing: ${bundlePath}`);
  runtimeFiles.push(bundlePath);
}

const offenders = [];
for (const path of runtimeFiles) {
  const source = readFileSync(path, 'utf8');
  for (const rule of forbidden) {
    if (rule.pattern.test(source)) {
      offenders.push(`${relative(root, path)}: ${rule.label}`);
    }
  }
}

if (offenders.length > 0) {
  throw new Error(
    `Experimental BFL image generation is not approved for runtime:\n- ${offenders.join('\n- ')}`,
  );
}

console.log(`Approved image-provider boundary passed for ${runtimeFiles.length} runtime files.`);
