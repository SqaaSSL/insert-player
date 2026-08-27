import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');

const assets = [
  {
    label: 'social card',
    renderer: 'browser',
    input: 'scripts/assets/social-card.html',
    dependencies: [
      'scripts/assets/social-card.css',
      'public/assets/social-card-visual-v3.png',
    ],
    output: 'public/assets/social-card-v6.png',
    width: 1200,
    height: 630,
  },
  {
    label: '192px app icon',
    renderer: 'imagemagick',
    input: 'public/assets/app-icon.svg',
    output: 'public/assets/app-icon-192.png',
    size: '192x192!',
    width: 192,
    height: 192,
  },
  {
    label: '512px app icon',
    renderer: 'imagemagick',
    input: 'public/assets/app-icon.svg',
    output: 'public/assets/app-icon-512.png',
    size: '512x512!',
    width: 512,
    height: 512,
  },
  {
    label: '512px maskable app icon',
    renderer: 'imagemagick',
    input: 'public/assets/app-icon.svg',
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
  const sources = [asset.input, ...(asset.dependencies ?? [])];
  for (const sourcePath of sources) {
    if (!existsSync(abs(sourcePath))) {
      throw new Error(`${sourcePath} is missing.`);
    }
  }
  if (!existsSync(abs(asset.output))) {
    throw new Error(`${asset.output} is missing. Run npm run brand:rasterize.`);
  }
  const raster = statSync(abs(asset.output));
  for (const sourcePath of sources) {
    const source = statSync(abs(sourcePath));
    if (raster.mtimeMs + 1000 < source.mtimeMs) {
      throw new Error(`${asset.output} is older than ${sourcePath}. Run npm run brand:rasterize.`);
    }
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

function rasterizeWithImageMagick(command, asset) {
  const commandArgs = [
    '-background',
    'none',
    abs(asset.input),
    '-resize',
    asset.size,
    `PNG32:${abs(asset.output)}`,
  ];
  const result = spawnSync(command, commandArgs, {
    cwd: dirname(abs(asset.input)),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(`Could not rasterize ${asset.label}: ${stderr || `${command} exited ${result.status}`}`);
  }
}

async function rasterizeWithBrowser(asset) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: asset.width, height: asset.height },
      deviceScaleFactor: 1,
    });
    await page.goto(pathToFileURL(abs(asset.input)).href, { waitUntil: 'load' });
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    await page.screenshot({
      path: abs(asset.output),
      type: 'png',
    });
  } finally {
    await browser.close();
  }
}

async function main() {
  if (checkOnly) {
    for (const asset of assets) assertAssetFresh(asset);
    console.log('Public PNG assets are fresh relative to their sources.');
    return;
  }

  const command = findMagickCommand();
  for (const asset of assets) {
    if (asset.renderer === 'browser') {
      await rasterizeWithBrowser(asset);
    } else {
      rasterizeWithImageMagick(command, asset);
    }
  }
  console.log(`Rasterized public PNG assets with Playwright and ${command}:`);
  for (const asset of assets) console.log(`- ${asset.output}`);
}

try {
  await main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
