import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');

const assets = [
  {
    label: 'social card',
    input: 'public/assets/social-card.svg',
    output: 'public/assets/social-card.png',
    size: '1200x630!',
    width: 1200,
    height: 630,
  },
  {
    label: '192px app icon',
    input: 'public/assets/app-icon.svg',
    output: 'public/assets/app-icon-192.png',
    size: '192x192!',
    width: 192,
    height: 192,
  },
  {
    label: '512px app icon',
    input: 'public/assets/app-icon.svg',
    output: 'public/assets/app-icon-512.png',
    size: '512x512!',
    width: 512,
    height: 512,
  },
  {
    label: '512px maskable app icon',
    input: 'public/assets/app-maskable.svg',
    output: 'public/assets/app-maskable-512.png',
    size: '512x512!',
    width: 512,
    height: 512,
  },
];

function abs(path) {
  return join(root, path);
}

function findMagickCommand() {
  for (const command of ['magick', 'convert']) {
    const result = spawnSync(command, ['-version'], { encoding: 'utf8' });
    if (result.status === 0) return command;
  }
  throw new Error('ImageMagick is required. Install it, then run npm run brand:rasterize again.');
}

function assertAssetFresh(asset) {
  if (!existsSync(abs(asset.input))) {
    throw new Error(`${asset.input} is missing.`);
  }
  if (!existsSync(abs(asset.output))) {
    throw new Error(`${asset.output} is missing. Run npm run brand:rasterize.`);
  }
  const source = statSync(abs(asset.input));
  const raster = statSync(abs(asset.output));
  if (raster.mtimeMs + 1000 < source.mtimeMs) {
    throw new Error(`${asset.output} is older than ${asset.input}. Run npm run brand:rasterize.`);
  }
  const size = readPngSize(abs(asset.output));
  if (size.width !== asset.width || size.height !== asset.height) {
    throw new Error(`${asset.output} is ${size.width}x${size.height}; expected ${asset.width}x${asset.height}.`);
  }
}

function readPngSize(path) {
  const bytes = readFileSync(path);
  const isPng = bytes.length >= 24
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a;
  if (!isPng) throw new Error(`${path} is not a PNG file.`);
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

function rasterize(command, asset) {
  const result = spawnSync(command, [
    '-background',
    'none',
    abs(asset.input),
    '-resize',
    asset.size,
    `PNG32:${abs(asset.output)}`,
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(`Could not rasterize ${asset.label}: ${stderr || `${command} exited ${result.status}`}`);
  }
}

function main() {
  if (checkOnly) {
    for (const asset of assets) assertAssetFresh(asset);
    console.log('Public PNG assets are fresh relative to their SVG sources.');
    return;
  }

  const command = findMagickCommand();
  for (const asset of assets) rasterize(command, asset);
  console.log(`Rasterized public PNG assets with ${command}:`);
  for (const asset of assets) console.log(`- ${asset.output}`);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
