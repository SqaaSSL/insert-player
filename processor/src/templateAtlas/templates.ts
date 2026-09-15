import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { PNG } from 'pngjs';
import { isTemplateAtlasRendererVersion, normalizeTemplateAtlasAnimationNames,
  type TemplateAtlasAnimationName, type TemplateAtlasRendererVersion } from '../../../src/services/TemplateAtlasContract.ts';
import { TEMPLATE_ATLAS_MANIFEST_SHA256 } from '../../../src/services/TemplateAtlasPlayback.ts';

export const TEMPLATE_ASSET_MANIFEST_SHA256 = 'd352bb3fd4151673a4739ebf6e4cad2211bce6ae1f5b06ddbdccd7bb46ef8de8';
assert.equal(TEMPLATE_ASSET_MANIFEST_SHA256, TEMPLATE_ATLAS_MANIFEST_SHA256, 'Private templates and advertised shared playback manifest differ');
export const TEMPLATE_REGISTRATION = Object.freeze({ width: 1536, height: 2048, groundY: 1884, originX: .5, originY: 1884 / 2048 });
export interface PixelRect { x: number; y: number; width: number; height: number }
export interface TemplatePlacement extends PixelRect { uniformScale: number; sourceWidth: number; sourceHeight: number }
export interface TemplateAtlasCell { index: number; masterId: string; rect: PixelRect; placement: TemplatePlacement }
export interface TemplateAnimation {
  name: TemplateAtlasAnimationName; family: 'fight' | 'aura'; fps: number; loop: boolean;
  sequence: string[]; authoredSequence: string[]; sourceReviewStatus: string;
}
interface Asset { file: string; sha256: string; width: number; height: number }
interface Master extends Asset { id: string; order: number }
interface FrozenAssets {
  schemaVersion: 1; version: 'template-zero-v3'; sourceManifestSha256: string; templateSourceSha256: string;
  canonical: { width: number; height: number; groundY: number }; identityAssetsIncluded: false;
  counts: { masters: number; animations: number; playbackFrames: number };
  masters: Master[]; animations: TemplateAnimation[];
  rookiePacks: Array<{ id: string; grid: { columns: number; rows: number }; cells: TemplateAtlasCell[];
    blankCells: Array<{ index: number; rect: PixelRect }>; image: Asset }>;
}
export interface TemplateAtlasPlan {
  schemaVersion: 1; rendererVersion: TemplateAtlasRendererVersion; planId: string;
  templateVersion: 'template-zero-v3'; templateManifestSha256: string; templateImageSha256: string;
  width: 4096; height: 4096; grid: { columns: number; rows: number };
  cells: TemplateAtlasCell[]; blankCells: Array<{ index: number; rect: PixelRect }>;
  selectedAnimationNames: TemplateAtlasAnimationName[]; animations: TemplateAnimation[];
  planFingerprint: string;
}
export const pngSha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
// Build ships assets beside server.mjs; source/tests use the private source folder.
const assetRoot = existsSync(join(moduleDirectory, 'templateAtlas-assets/manifest.json'))
  ? join(moduleDirectory, 'templateAtlas-assets') : join(moduleDirectory, 'assets');
const manifestBytes = readFileSync(join(assetRoot, 'manifest.json'));
assert.equal(pngSha256(manifestBytes), TEMPLATE_ASSET_MANIFEST_SHA256, 'Frozen generic template manifest changed');
const assets = JSON.parse(manifestBytes.toString('utf8')) as FrozenAssets;
assert.equal(assets.identityAssetsIncluded, false);
assert.deepEqual(assets.canonical, { width: 1536, height: 2048, groundY: 1884 });
assert.equal(assets.masters.length, 131); assert.equal(assets.animations.length, 20);
assert.equal(assets.animations.reduce((sum, animation) => sum + animation.sequence.length, 0), 184);
const trustedPlans = new WeakSet<TemplateAtlasPlan>();
const imageCache = new Map<string, Promise<Buffer>>();
export function templateAtlasImageCacheInfo() { return { entries: imageCache.size, planIds: [...imageCache.keys()] }; }

function readAsset(asset: Asset): Buffer {
  assert.match(asset.file, /^(masters\/master-\d{3}|rookie\/two-0[12])\.png$/);
  const bytes = readFileSync(join(assetRoot, asset.file));
  assert.equal(pngSha256(bytes), asset.sha256, `Frozen generic template changed: ${asset.file}`);
  return bytes;
}
export function readTemplateMaster(masterId: string): { width: number; height: number; data: Buffer; pngSha256: string } {
  const master = assets.masters.find(item => item.id === masterId);
  assert(master, 'Unknown template master');
  const decoded = PNG.sync.read(readAsset(master));
  assert.equal(decoded.width, 1536); assert.equal(decoded.height, 2048);
  return { width: decoded.width, height: decoded.height, data: decoded.data, pngSha256: master.sha256 };
}
export function templateInventory() { return structuredClone(assets); }
export function gridRect(index: number, columns: number, rows: number, width = 4096, height = 4096): PixelRect {
  assert(Number.isSafeInteger(index) && index >= 0 && index < columns * rows);
  const column = index % columns, row = Math.floor(index / columns), x = Math.round(column * width / columns), y = Math.round(row * height / rows);
  return { x, y, width: Math.round((column + 1) * width / columns) - x, height: Math.round((row + 1) * height / rows) - y };
}
export function placeCanonical(rect: PixelRect, columns: number, rows: number): TemplatePlacement {
  const uniformScale = Math.min(Math.floor(4096 / columns) / 1536, Math.floor(4096 / rows) / 2048);
  const width = 1536 * uniformScale, height = 2048 * uniformScale;
  return { x: rect.x + (rect.width - width) / 2, y: rect.y + (rect.height - height) / 2,
    width, height, uniformScale, sourceWidth: 1536, sourceHeight: 2048 };
}
function championPacking(animation: TemplateAnimation) {
  const ids = [...new Set(animation.sequence)];
  const columns = ids.length === 9 ? 3 : ids.length >= 7 ? 4 : ids.length >= 5 ? 3 : ids.length === 4 ? 2 : ids.length;
  const rows = Math.ceil(ids.length / columns);
  const cells = ids.map((masterId, index) => {
    const rect = gridRect(index, columns, rows);
    return { index, masterId, rect, placement: placeCanonical(rect, columns, rows) };
  });
  const blankCells = Array.from({ length: columns * rows - ids.length }, (_, index) => ({
    index: index + ids.length, rect: gridRect(index + ids.length, columns, rows),
  }));
  return { grid: { columns, rows }, cells, blankCells };
}
async function renderChampion(cells: TemplateAtlasCell[]): Promise<Buffer> {
  const canvas = createCanvas(4096, 4096), context = canvas.getContext('2d');
  try {
  context.fillStyle = '#ffffff'; context.fillRect(0, 0, 4096, 4096);
  context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
  for (const cell of cells) {
    const frame = readTemplateMaster(cell.masterId), white = Buffer.alloc(frame.data.length);
    for (let i = 0; i < white.length; i += 4) {
      const alpha = frame.data[i + 3] / 255;
      for (let channel = 0; channel < 3; channel++) white[i + channel] = Math.round(frame.data[i + channel] * alpha + 255 * (1 - alpha));
      white[i + 3] = 255;
    }
    const image = await loadImage(PNG.sync.write({ width: frame.width, height: frame.height, data: white } as PNG));
    const destination = cell.placement;
    context.drawImage(image, destination.x, destination.y, destination.width, destination.height);
  }
    return canvas.toBuffer('image/png');
  } finally { canvas.width = 1; canvas.height = 1; }
}
function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freezeDeep); Object.freeze(value); }
  return value;
}
async function resolvePlans(rendererVersion: TemplateAtlasRendererVersion, animationNames: readonly string[], onlyPlanId?: string): Promise<TemplateAtlasPlan[]> {
  assert(isTemplateAtlasRendererVersion(rendererVersion), 'Unsupported Template Atlas renderer');
  const selected = normalizeTemplateAtlasAnimationNames(animationNames);
  const animations = assets.animations.filter(animation => selected.includes(animation.name));
  const definitions = (rendererVersion === 'rookie-two-atlas-v1'
    ? assets.rookiePacks.map(pack => ({ id: pack.id, grid: pack.grid, cells: pack.cells, blankCells: pack.blankCells, image: pack.image }))
    : animations.map(animation => ({ id: animation.name, ...championPacking(animation), image: null })))
    .filter(definition => !onlyPlanId || `${rendererVersion}:${definition.id}` === onlyPlanId);
  assert(definitions.length > 0, 'Unknown/unselected Template Atlas plan ID');
  const plans: TemplateAtlasPlan[] = [];
  for (const definition of definitions) {
    const planId = `${rendererVersion}:${definition.id}`;
    if (!imageCache.has(planId)) imageCache.set(planId, definition.image ? Promise.resolve(readAsset(definition.image)) : renderChampion(definition.cells));
    const bytes = await imageCache.get(planId)!;
    const data = { schemaVersion: 1 as const, rendererVersion, planId, templateVersion: 'template-zero-v3' as const,
      templateManifestSha256: TEMPLATE_ASSET_MANIFEST_SHA256, templateImageSha256: pngSha256(bytes),
      width: 4096 as const, height: 4096 as const, grid: definition.grid, cells: definition.cells,
      blankCells: definition.blankCells, selectedAnimationNames: selected,
      animations: rendererVersion === 'rookie-two-atlas-v1' ? animations : animations.filter(animation => animation.name === definition.id) };
    const plan = freezeDeep(structuredClone({ ...data, planFingerprint: pngSha256(JSON.stringify(data)) }));
    trustedPlans.add(plan); plans.push(plan);
  }
  return plans;
}
export async function getTemplateAtlasPlans(rendererVersion: TemplateAtlasRendererVersion, animationNames: readonly string[]): Promise<TemplateAtlasPlan[]> {
  return resolvePlans(rendererVersion, animationNames);
}
export function assertTrustedTemplatePlan(plan: TemplateAtlasPlan): void {
  assert(trustedPlans.has(plan), 'Template plans must be resolved from private frozen assets, never supplied by the client');
}
export async function getTemplateAtlasImage(plan: TemplateAtlasPlan): Promise<Buffer> {
  assertTrustedTemplatePlan(plan);
  const bytes = await imageCache.get(plan.planId)!;
  assert.equal(pngSha256(bytes), plan.templateImageSha256);
  return Buffer.from(bytes);
}
export async function resolveTemplateAtlasPlan(rendererVersion: TemplateAtlasRendererVersion, planId: string, animationNames: readonly string[]) {
  // A submit/collect for one Champion plan must not render the other19 inputs.
  // Keep the FULL authorized selection in the plan/fingerprint, only make the
  // image whose exact ID was requested. No template/geometry change.
  const plan = (await resolvePlans(rendererVersion, animationNames, planId)).find(candidate => candidate.planId === planId);
  assert(plan, 'Unknown/unselected Template Atlas plan ID');
  return plan;
}
