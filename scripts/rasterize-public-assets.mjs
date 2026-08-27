import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { readImageSize } from './image-dimensions.mjs';

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
    outputs: [
      {
        path: 'public/assets/social-card-v7.jpg',
        format: 'jpeg',
        quality: 88,
        maxBytes: 300_000,
      },
      {
        path: 'public/assets/social-card-v7.webp',
        format: 'webp',
        quality: 82,
        maxBytes: 150_000,
      },
    ],
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
  const outputs = asset.outputs ?? [{ path: asset.output }];
  for (const output of outputs) {
    if (!existsSync(abs(output.path))) {
      throw new Error(`${output.path} is missing. Run npm run brand:rasterize.`);
    }
    const raster = statSync(abs(output.path));
    for (const sourcePath of sources) {
      const source = statSync(abs(sourcePath));
      if (raster.mtimeMs + 1000 < source.mtimeMs) {
        throw new Error(`${output.path} is older than ${sourcePath}. Run npm run brand:rasterize.`);
      }
    }
    const size = readImageSize(abs(output.path));
    if (size.width !== asset.width || size.height !== asset.height) {
      throw new Error(`${output.path} is ${size.width}x${size.height}; expected ${asset.width}x${asset.height}.`);
    }
    if (output.maxBytes && raster.size > output.maxBytes) {
      throw new Error(`${output.path} is ${raster.size} bytes; expected no more than ${output.maxBytes}.`);
    }
  }
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

function encodeSocialCard(command, input, output) {
  const commonArgs = [input, '-strip', '-colorspace', 'sRGB'];
  const formatArgs = output.format === 'jpeg'
    ? ['-sampling-factor', '4:2:0', '-interlace', 'Plane', '-quality', String(output.quality)]
    : ['-quality', String(output.quality), '-define', 'webp:method=6'];
  const result = spawnSync(command, [...commonArgs, ...formatArgs, abs(output.path)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(`Could not encode ${output.path}: ${stderr || `${command} exited ${result.status}`}`);
  }
}

async function rasterizeWithBrowser(command, asset) {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'insert-player-social-card-'));
  const sourcePng = join(tempDirectory, 'source.png');
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
      path: sourcePng,
      type: 'png',
    });
    for (const output of asset.outputs) encodeSocialCard(command, sourcePng, output);
  } finally {
    await browser.close();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

async function main() {
  if (checkOnly) {
    for (const asset of assets) assertAssetFresh(asset);
    console.log('Public raster assets are fresh relative to their sources.');
    return;
  }

  const command = findMagickCommand();
  for (const asset of assets) {
    if (asset.renderer === 'browser') {
      await rasterizeWithBrowser(command, asset);
    } else {
      rasterizeWithImageMagick(command, asset);
    }
  }
  console.log(`Rasterized public assets with Playwright and ${command}:`);
  for (const asset of assets) {
    for (const output of asset.outputs ?? [{ path: asset.output }]) console.log(`- ${output.path}`);
  }
}

try {
  await main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
