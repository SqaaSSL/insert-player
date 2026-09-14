// Offline evidence only: never edits generated character images or calls a provider.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireProcessor = createRequire(join(ROOT, 'processor/package.json'));
const { createCanvas, loadImage } = requireProcessor('@napi-rs/canvas');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const TIER_NAMES = { rookie: 'Rookie', contender: 'Champion' };
const BACKGROUND = '#181b22';
const CELL_BACKGROUND = '#242933';

export function verifiedFile(directory, path, expectedHash) {
  const target = resolve(directory, path);
  assert.ok(target.startsWith(`${resolve(directory)}${sep}`), 'Artifact path escapes the generation directory');
  const bytes = readFileSync(target);
  assert.equal(hash(bytes), expectedHash, `Artifact hash mismatch: ${path}`);
  return bytes;
}

/** Exact per-cell alpha bounds; no semantic pose or quality score is inferred. */
export function frameBounds(pixels, width, height, alphaThreshold = 15) {
  assert.equal(pixels.length, width * height * 4);
  let minX = width, minY = height, maxX = -1, maxY = -1, count = 0, greenEdgePixels = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      if (pixels[offset + 3] < alphaThreshold) continue;
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); count++;
      if (pixels[offset + 1] > 120 && pixels[offset + 1] > pixels[offset] * 1.5 && pixels[offset + 1] > pixels[offset + 2] * 1.5) greenEdgePixels++;
    }
  }
  if (!count) return { empty: true, opaquePixels: 0, bounds: null, touchesCellEdge: false, greenDominantPixels: 0 };
  return { empty: false, opaquePixels: count,
    bounds: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, right: maxX, bottom: maxY },
    touchesCellEdge: minX === 0 || minY === 0 || maxX === width - 1 || maxY === height - 1,
    greenDominantPixels: greenEdgePixels };
}

async function readSprite(directory, entry) {
  assert.ok(entry.qualityTier in TIER_NAMES, 'QA expects Rookie/contender assets');
  for (const value of [entry.frameWidth, entry.frameHeight, entry.frameCount, entry.gridCols, entry.gridRows]) assert.ok(Number.isInteger(value) && value > 0);
  assert.ok(entry.frameCount <= entry.gridCols * entry.gridRows);
  const processed = await loadImage(verifiedFile(directory, entry.path, entry.sha256));
  assert.equal(processed.width, entry.frameWidth * entry.gridCols);
  assert.equal(processed.height, entry.frameHeight * entry.gridRows);
  const raw = await loadImage(verifiedFile(directory, entry.rawPath, entry.rawSha256));
  if (entry.rawWidth !== undefined) assert.equal(raw.width, entry.rawWidth);
  if (entry.rawHeight !== undefined) assert.equal(raw.height, entry.rawHeight);
  const frameCanvas = createCanvas(entry.frameWidth, entry.frameHeight);
  const context = frameCanvas.getContext('2d');
  const frames = [];
  for (let index = 0; index < entry.frameCount; index++) {
    context.clearRect(0, 0, frameCanvas.width, frameCanvas.height);
    context.drawImage(processed, index % entry.gridCols * entry.frameWidth, Math.floor(index / entry.gridCols) * entry.frameHeight,
      entry.frameWidth, entry.frameHeight, 0, 0, entry.frameWidth, entry.frameHeight);
    frames.push({ frame: index + 1, ...frameBounds(context.getImageData(0, 0, frameCanvas.width, frameCanvas.height).data, frameCanvas.width, frameCanvas.height) });
  }
  return { image: processed, entry, report: { animationName: entry.animationName, qualityTier: entry.qualityTier,
    processed: { path: entry.path, sha256: entry.sha256, width: processed.width, height: processed.height },
    raw: { path: entry.rawPath, sha256: entry.rawSha256, width: raw.width, height: raw.height,
      note: 'Raw geometry is measured independently; Rookie attack raw frames may differ from mirrored playback.' },
    frameWidth: entry.frameWidth, frameHeight: entry.frameHeight, frameCount: entry.frameCount,
    gridCols: entry.gridCols, gridRows: entry.gridRows, alphaThreshold: 15, frames } };
}

function text(context, value, x, y, size = 18, color = '#e9edf5') {
  context.font = `${size}px sans-serif`; context.fillStyle = color; context.fillText(value, x, y);
}
function emptyCanvas(width, height) {
  const canvas = createCanvas(width, height); const context = canvas.getContext('2d');
  context.fillStyle = BACKGROUND; context.fillRect(0, 0, width, height);
  return { canvas, context };
}
function frameImage(context, sprite, index, x, y, width, height) {
  const entry = sprite.entry;
  context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
  context.drawImage(sprite.image, index % entry.gridCols * entry.frameWidth, Math.floor(index / entry.gridCols) * entry.frameHeight,
    entry.frameWidth, entry.frameHeight, x, y, width, height);
}
function saveCanvas(path, canvas) {
  const bytes = canvas.toBuffer('image/png');
  if (existsSync(path)) assert.equal(hash(readFileSync(path)), hash(bytes), 'Same QA snapshot produced different pixels');
  else writeFileSync(path, bytes, { flag: 'wx' });
  return { path, sha256: hash(bytes), bytes: bytes.length, width: canvas.width, height: canvas.height };
}

function contactSheet(animation, sprites, outputDirectory) {
  const columns = 4, cellWidth = 192, cellHeight = 256, gap = 10, margin = 24;
  const panels = ['rookie', 'contender'];
  const rows = Math.ceil(Math.max(...sprites.map(item => item.entry.frameCount)) / columns);
  const panelWidth = columns * (cellWidth + gap) - gap;
  const { canvas, context } = emptyCanvas(2 * panelWidth + margin * 3, 116 + rows * (cellHeight + 34));
  text(context, `Casual · ${animation}`, margin, 30, 24);
  text(context, 'Actual processed frames · 192 × 256 display · neutral background · no frame retouching', margin, 54, 15, '#aeb7c8');
  for (let panel = 0; panel < panels.length; panel++) {
    const tier = panels[panel], sprite = sprites.find(item => item.entry.qualityTier === tier);
    const startX = margin + panel * (panelWidth + margin);
    text(context, TIER_NAMES[tier], startX, 88, 23, tier === 'rookie' ? '#bfccd9' : '#d9c7ff');
    if (!sprite) { text(context, 'Not generated yet', startX, 125, 18, '#aeb7c8'); continue; }
    for (let index = 0; index < sprite.entry.frameCount; index++) {
      const x = startX + index % columns * (cellWidth + gap), y = 104 + Math.floor(index / columns) * (cellHeight + 34);
      context.fillStyle = CELL_BACKGROUND; context.fillRect(x, y, cellWidth, cellHeight);
      frameImage(context, sprite, index, x, y, cellWidth, cellHeight);
      text(context, `Frame ${index + 1}${sprite.report.frames[index].touchesCellEdge ? ' · EDGE' : ''}`, x + 5, y + cellHeight + 20, 14, '#b9c4d5');
    }
  }
  return saveCanvas(join(outputDirectory, `${animation}-contact.png`), canvas);
}

function idleDetail(sprites, outputDirectory) {
  const { canvas, context } = emptyCanvas(1056, 1130);
  text(context, 'Casual · first idle frame · actual generated quality', 28, 32, 25);
  text(context, 'Full body and the same fixed upper-body crop. Display scaling only; original sprites remain untouched.', 28, 59, 15, '#b9c4d5');
  const crops = [];
  for (let panel = 0; panel < 2; panel++) {
    const tier = ['rookie', 'contender'][panel], sprite = sprites.find(item => item.entry.qualityTier === tier);
    const x = 28 + panel * 516;
    text(context, TIER_NAMES[tier], x, 95, 26, tier === 'rookie' ? '#bfccd9' : '#d9c7ff');
    if (!sprite) { text(context, 'Not generated yet', x, 137, 20); continue; }
    context.fillStyle = CELL_BACKGROUND; context.fillRect(x, 112, 480, 640);
    frameImage(context, sprite, 0, x, 112, 480, 640);
    text(context, 'Upper-body detail · fixed crop', x, 786, 20);
    const crop = { x: Math.round(sprite.entry.frameWidth * 0.25), y: Math.round(sprite.entry.frameHeight * 0.035),
      width: Math.round(sprite.entry.frameWidth * 0.5), height: Math.round(sprite.entry.frameWidth * 0.5) };
    context.fillStyle = CELL_BACKGROUND; context.fillRect(x + 85, 802, 310, 310);
    context.drawImage(sprite.image, crop.x, crop.y, crop.width, crop.height, x + 85, 802, 310, 310);
    crops.push({ qualityTier: tier, frame: 1, sourceCrop: crop });
  }
  return { ...saveCanvas(join(outputDirectory, 'idle-quality-detail.png'), canvas), crops };
}

export async function renderCasualQa(directory, requestedAnimation) {
  directory = resolve(directory);
  const manifestBytes = readFileSync(join(directory, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.identity.slug, 'casual');
  const sprites = manifest.sprites.filter(item => !requestedAnimation || item.animationName === requestedAnimation);
  if (!sprites.length) return { availableAnimations: [], note: 'No completed sprites in manifest yet; no generation started.' };
  const snapshot = hash(JSON.stringify(sprites.map(item => ({ animation: item.animationName, tier: item.qualityTier, sha256: item.sha256, rawSha256: item.rawSha256 })))).slice(0, 16);
  const outputDirectory = join(directory, 'review', snapshot); mkdirSync(outputDirectory, { recursive: true });
  const report = { schemaVersion: 1, identity: manifest.identity, fingerprint: manifest.fingerprint,
    manifestSha256: hash(manifestBytes), snapshot, transforms: 'QA composites only; original files verified and never modified',
    qualityWarning: 'Geometry and alpha measurements are descriptive, not an automated identity or artistic-quality verdict.',
    animations: [], visuals: [] };
  for (const animation of [...new Set(sprites.map(item => item.animationName))]) {
    assert.match(animation, /^[a-z_]+$/);
    const pair = [];
    for (const entry of sprites.filter(item => item.animationName === animation)) pair.push(await readSprite(directory, entry));
    report.animations.push(...pair.map(item => item.report));
    report.visuals.push(contactSheet(animation, pair, outputDirectory));
    if (animation === 'idle') report.visuals.push(idleDetail(pair, outputDirectory));
  }
  const outputReport = join(outputDirectory, 'geometry.json');
  writeFileSync(outputReport, `${JSON.stringify(report, null, 2)}\n`);
  const index = { snapshot, report: relative(directory, outputReport), visuals: report.visuals.map(item => ({ ...item, path: relative(directory, item.path) })) };
  writeFileSync(join(directory, 'review/latest.json'), `${JSON.stringify(index, null, 2)}\n`);
  return { ...index, directory: outputDirectory, availableAnimations: [...new Set(sprites.map(item => item.animationName))] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  renderCasualQa(option('directory') ?? join(ROOT, '.artifacts/casual-generation-v1'), option('animation'))
    .then(value => console.log(JSON.stringify(value, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
