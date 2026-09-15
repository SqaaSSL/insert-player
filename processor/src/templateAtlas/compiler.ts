import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { PNG } from 'pngjs';
import type { TemplateAtlasAnimationName } from '../../../src/services/TemplateAtlasContract.ts';
import { assertTrustedTemplatePlan, pngSha256, readTemplateMaster, TEMPLATE_REGISTRATION,
  type PixelRect, type TemplateAtlasCell, type TemplateAtlasPlan } from './templates.ts';
import { priorAgreement, refineWhite, whiteKey } from './whiteKey.ts';

export const TEMPLATE_ATLAS_QA_POLICY = Object.freeze({
  version: 'template-atlas-geometric-qa-v1', alphaVisible: 16, minimumAreaRatio: .005,
  maximumAreaRatio: .75, minimumSilhouetteIou: .70, minimumLargestComponentRatio: .70,
  blankForegroundWarningRatio: .001, trailingBlankPolicy: 'ignore-by-declared-index-with-warning',
  maximumBorderPixels: 0, maximumPaddingPixels: 0,
  semanticApprovalClaimed: false, automaticRepair: false,
});
export interface TemplateAtlasMapping { scale: number; translateX: number; translateY: number }
export interface TemplateCellQa {
  masterId: string; areaRatio: number; silhouetteIou: number; largestComponentRatio: number;
  borderPixels: number; outsideCanonicalPixels: number; rgbChannelChanges: 0;
  ambiguousWhiteComponents: number; removedWhiteComponents: number; failures: string[];
}
export interface TemplateAtlasQa {
  passed: boolean; policy: typeof TEMPLATE_ATLAS_QA_POLICY; cells: TemplateCellQa[];
  blankCells: Array<{ index: number; foregroundRatio: number; unexpectedForeground: boolean; ignored: true }>;
  warnings: string[]; failures: string[];
}
export class TemplateAtlasCompileError extends Error {
  readonly code = 'template_atlas_qa_failed';
  constructor(message: string, readonly qa?: TemplateAtlasQa) { super(message); this.name = 'TemplateAtlasCompileError'; }
}
export interface CompiledTemplateFrame {
  masterId: string; width: number; height: number; png: Buffer; rawPng: Buffer;
  pngSha256: string; rawPngSha256: string; rgbaSha256: string; rawRgbaSha256: string;
  mapping: TemplateAtlasMapping; qa: TemplateCellQa;
}
export interface CompiledTemplateAtlas {
  planId: string; planFingerprint: string; geometryFingerprint: string; rawSha256: string;
  templateImageSha256: string; rawWidth: number; rawHeight: number; frames: CompiledTemplateFrame[]; qa: TemplateAtlasQa;
}
export interface CompiledTemplateAnimation {
  animationName: TemplateAtlasAnimationName; family: 'fight' | 'aura';
  runtimePng: Buffer; hqPng: Buffer; rawHqPng: Buffer;
  frameWidth: 384; frameHeight: 512; hqFrameWidth: 768; hqFrameHeight: 1024;
  frameCount: number; columns: number; rows: number; fps: number; loop: boolean;
  originX: .5; originY: number; animationFormat: 'template-atlas-v1'; processingVersion: 6;
  sequence: string[]; runtimeSha256: string; hqSha256: string; rawHqSha256: string;
  provenance: { rendererVersion: string; templateVersion: string; templateManifestSha256: string;
    sources: Array<{ planId: string; rawSha256: string; templateImageSha256: string; geometryFingerprint: string }>; fullCanvasRegistration: typeof TEMPLATE_REGISTRATION };
  qa: { passed: true; semanticApprovalClaimed: false; warnings: string[]; perFrameFit: false; repeatsAreExact: true };
}
export type CompiledTemplateHqAnimation = Omit<CompiledTemplateAnimation, 'runtimePng' | 'runtimeSha256'>;

function geometryFingerprint(plan: TemplateAtlasPlan) {
  return pngSha256(JSON.stringify({ rendererVersion: plan.rendererVersion, planId: plan.planId,
    templateImageSha256: plan.templateImageSha256, cells: plan.cells, blankCells: plan.blankCells, grid: plan.grid }));
}
function png(bytes: Uint8Array, width: number, height: number) {
  if (bytes.byteLength < 24 || bytes.byteLength > 64 * 1024 * 1024) throw new TemplateAtlasCompileError('RAW PNG size is outside the accepted range');
  const buffer = Buffer.from(bytes);
  if (buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
    || buffer.readUInt32BE(16) !== width || buffer.readUInt32BE(20) !== height) {
    throw new TemplateAtlasCompileError(`Expected an unmodified ${width}×${height} PNG atlas`);
  }
  try {
    const decoded = PNG.sync.read(buffer);
    assert.equal(decoded.width, width); assert.equal(decoded.height, height);
    return decoded;
  } catch {
    // An intact header does not establish valid PNG chunks/CRC/deflate data.
    // This is a deterministic RAW failure, never a retryable provider error.
    throw new TemplateAtlasCompileError('Preserved RAW atlas is not a decodable PNG; no regeneration attempted');
  }
}
export function cropNative(raw: { width: number; height: number; data: Uint8Array }, rect: PixelRect) {
  assert([rect.x, rect.y, rect.width, rect.height].every(Number.isSafeInteger));
  assert(rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0
    && rect.x + rect.width <= raw.width && rect.y + rect.height <= raw.height);
  const data = Buffer.alloc(rect.width * rect.height * 4), bytes = Buffer.from(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength);
  for (let y = 0; y < rect.height; y++) bytes.copy(data, y * rect.width * 4,
    ((rect.y + y) * raw.width + rect.x) * 4, ((rect.y + y) * raw.width + rect.x + rect.width) * 4);
  return { width: rect.width, height: rect.height, data };
}
export function inverseTemplatePlacement(cell: TemplateAtlasCell): TemplateAtlasMapping {
  const scale = 1 / cell.placement.uniformScale;
  return { scale, translateX: (cell.rect.x - cell.placement.x) * scale, translateY: (cell.rect.y - cell.placement.y) * scale };
}
/** Samples the prior only. Known packing margins stay transparent, including epsilon boundaries. */
export function projectTemplatePrior(template: { width: number; height: number; data: Uint8Array }, width: number, height: number, mapping: TemplateAtlasMapping) {
  assert.equal(template.width, 1536); assert.equal(template.height, 2048); assert.equal(template.data.length, 1536 * 2048 * 4);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const tx = Math.floor((x + .5) * mapping.scale + mapping.translateX), ty = Math.floor((y + .5) * mapping.scale + mapping.translateY);
    if (tx >= 0 && tx < 1536 && ty >= 0 && ty < 2048) out[y * width + x] = template.data[(ty * 1536 + tx) * 4 + 3];
  }
  return out;
}
function largestComponentRatio(data: Uint8Array, width: number, height: number, visible: number) {
  if (!visible) return 0;
  const visited = new Uint8Array(width * height), queue = new Uint32Array(width * height);
  let largest = 0;
  for (let start = 0; start < visited.length; start++) {
    if (visited[start] || data[start * 4 + 3] < 16) continue;
    let head = 0, tail = 0;
    const seed = (p: number) => { if (!visited[p] && data[p * 4 + 3] >= 16) { visited[p] = 1; queue[tail++] = p; } };
    seed(start);
    while (head < tail) {
      const p = queue[head++], x = p % width;
      if (x) seed(p - 1); if (x + 1 < width) seed(p + 1);
      if (p >= width) seed(p - width); if (p + width < visited.length) seed(p + width);
    }
    largest = Math.max(largest, tail);
  }
  return largest / visible;
}
export function inspectCompiledCell(masterId: string, data: Uint8Array, prior: Uint8Array, width: number, height: number,
  mapping: TemplateAtlasMapping, whiteMetrics: { ambiguousWhiteComponents: number; removedWhiteComponents: number }): TemplateCellQa {
  let visible = 0, borderPixels = 0, outsideCanonicalPixels = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (data[(y * width + x) * 4 + 3] >= 16) {
    visible++;
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1) borderPixels++;
    const tx = (x + .5) * mapping.scale + mapping.translateX, ty = (y + .5) * mapping.scale + mapping.translateY;
    if (tx < 0 || ty < 0 || tx >= 1536 || ty >= 2048) outsideCanonicalPixels++;
  }
  const areaRatio = visible / (width * height), silhouetteIou = priorAgreement(data, prior).iou;
  const componentRatio = largestComponentRatio(data, width, height, visible), failures: string[] = [];
  if (areaRatio < TEMPLATE_ATLAS_QA_POLICY.minimumAreaRatio) failures.push('empty_or_missing_subject');
  if (areaRatio > TEMPLATE_ATLAS_QA_POLICY.maximumAreaRatio) failures.push('background_or_oversized_subject');
  if (silhouetteIou < TEMPLATE_ATLAS_QA_POLICY.minimumSilhouetteIou) failures.push('pose_registration_mismatch');
  if (componentRatio < TEMPLATE_ATLAS_QA_POLICY.minimumLargestComponentRatio) failures.push('fragmented_or_multiple_subjects');
  if (borderPixels > TEMPLATE_ATLAS_QA_POLICY.maximumBorderPixels) failures.push('foreground_touches_cell_border');
  if (outsideCanonicalPixels > TEMPLATE_ATLAS_QA_POLICY.maximumPaddingPixels) failures.push('foreground_in_packing_margin');
  return { masterId, areaRatio, silhouetteIou, largestComponentRatio: componentRatio, borderPixels,
    outsideCanonicalPixels, rgbChannelChanges: 0, ...whiteMetrics, failures };
}

// Bounded private in-memory cache: no disk, owner IDs, provider calls or URL inputs.
// Per-animation endpoint requests reuse both Rookie mattes instead of keying 131 poses 20 times.
// Store lossless native PNGs, not 251 MiB of duplicate RAW/clean RGBA. The encode
// is exact; source RGB, dimensions and native RGBA hashes remain auditable.
const CACHE_LIMIT_BYTES = 256 * 1024 * 1024, CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { value: CompiledTemplateAtlas; bytes: number; usedAt: number }>();
const inflight = new Map<string, Promise<CompiledTemplateAtlas>>();
const compiledObjects = new WeakSet<CompiledTemplateAtlas>();
export function clearTemplateAtlasCompilerCache() { cache.clear(); }
export function templateAtlasCompilerCacheInfo() {
  return { entries: cache.size, bytes: [...cache.values()].reduce((sum, entry) => sum + entry.bytes, 0), limitBytes: CACHE_LIMIT_BYTES, inflight: inflight.size };
}
function remember(key: string, value: CompiledTemplateAtlas) {
  const bytes = value.frames.reduce((sum, frame) => sum + frame.png.byteLength + frame.rawPng.byteLength, 0);
  if (bytes > CACHE_LIMIT_BYTES) return;
  cache.set(key, { value, bytes, usedAt: Date.now() });
  while ([...cache.values()].reduce((sum, entry) => sum + entry.bytes, 0) > CACHE_LIMIT_BYTES) cache.delete(cache.keys().next().value!);
}
export async function compileTemplateAtlas(rawPng: Uint8Array, plan: TemplateAtlasPlan): Promise<CompiledTemplateAtlas> {
  assertTrustedTemplatePlan(plan);
  const rawSha256 = pngSha256(rawPng), geometry = geometryFingerprint(plan), key = `${geometry}:${rawSha256}`;
  for (const [entryKey, entry] of cache) if (Date.now() - entry.usedAt > CACHE_TTL_MS) cache.delete(entryKey);
  const previous = cache.get(key);
  if (previous) { previous.usedAt = Date.now(); cache.delete(key); cache.set(key, previous); return previous.value; }
  if (inflight.has(key)) return inflight.get(key)!;
  const pending = (async () => {
    const raw = png(rawPng, plan.width, plan.height);
    const qa: TemplateAtlasQa = { passed: false, policy: TEMPLATE_ATLAS_QA_POLICY, cells: [], blankCells: [], warnings: [], failures: [] };
    // Trailing cells are outside the exact frame contract. Warn about artwork in
    // them, but never import it. Required-cell border/padding gates still reject
    // anything crossing into a real frame. This policy is subject-independent.
    for (const blank of plan.blankCells) {
      const crop = cropNative(raw, blank.rect), alpha = whiteKey(crop.data, crop.width, crop.height).mask;
      const foregroundRatio = alpha.reduce((count, value) => count + Number(value >= 16), 0) / alpha.length;
      const unexpectedForeground = foregroundRatio > TEMPLATE_ATLAS_QA_POLICY.blankForegroundWarningRatio;
      qa.blankCells.push({ index: blank.index, foregroundRatio, unexpectedForeground, ignored: true });
      if (unexpectedForeground) qa.warnings.push(`Trailing blank cell ${blank.index} contains artwork; excluded by its declared index, never mapped to animation frames.`);
    }
    const frames: CompiledTemplateFrame[] = [];
    for (const cell of plan.cells) {
      const crop = cropNative(raw, cell.rect), mapping = inverseTemplatePlacement(cell);
      const prior = projectTemplatePrior(readTemplateMaster(cell.masterId), crop.width, crop.height, mapping);
      const v1 = whiteKey(crop.data, crop.width, crop.height), v2 = refineWhite(crop.data, v1.pixels, prior, crop.width, crop.height);
      const data = Buffer.from(v2.pixels);
      for (let i = 0; i < data.length; i += 4) {
        assert.equal(data[i], crop.data[i]); assert.equal(data[i + 1], crop.data[i + 1]); assert.equal(data[i + 2], crop.data[i + 2]);
        assert(data[i + 3] <= crop.data[i + 3]);
      }
      const cellQa = inspectCompiledCell(cell.masterId, data, prior, crop.width, crop.height, mapping, {
        ambiguousWhiteComponents: v2.metrics.components.filter(component => component.status === 'retained_ambiguous').length,
        removedWhiteComponents: v2.metrics.acceptedComponents,
      });
      qa.cells.push(cellQa);
      qa.failures.push(...cellQa.failures.map(failure => `${cell.masterId}:${failure}`));
      const cleanPng = PNG.sync.write({ width: crop.width, height: crop.height, data } as PNG);
      const rawFramePng = PNG.sync.write(crop as PNG);
      frames.push({ masterId: cell.masterId, width: crop.width, height: crop.height, png: cleanPng, rawPng: rawFramePng,
        pngSha256: pngSha256(cleanPng), rawPngSha256: pngSha256(rawFramePng),
        rgbaSha256: pngSha256(data), rawRgbaSha256: pngSha256(crop.data), mapping, qa: cellQa });
    }
    if (qa.cells.some(cell => cell.ambiguousWhiteComponents > 0)) qa.warnings.push('Ambiguous enclosed whites retained; geometry QA does not certify faces, identity or choreography.');
    if (qa.failures.length) throw new TemplateAtlasCompileError('Atlas failed automatic geometry/foreground validation', qa);
    qa.passed = true;
    const result: CompiledTemplateAtlas = { planId: plan.planId, planFingerprint: plan.planFingerprint,
      geometryFingerprint: geometry, rawSha256, templateImageSha256: plan.templateImageSha256,
      rawWidth: raw.width, rawHeight: raw.height, frames, qa };
    compiledObjects.add(result); remember(key, result); return result;
  })();
  inflight.set(key, pending);
  try { return await pending; } finally { inflight.delete(key); }
}

export function packPlaybackFrames(frames: readonly Buffer[], width: number, height: number) {
  assert(frames.length > 0 && frames.length <= 32);
  const columns = Math.min(4, frames.length), rows = Math.ceil(frames.length / columns);
  const atlasWidth = columns * width, atlasHeight = rows * height, data = Buffer.alloc(atlasWidth * atlasHeight * 4);
  frames.forEach((frame, index) => {
    assert.equal(frame.length, width * height * 4);
    const x = index % columns * width, y = Math.floor(index / columns) * height;
    for (let yy = 0; yy < height; yy++) frame.copy(data, ((y + yy) * atlasWidth + x) * 4, yy * width * 4, (yy + 1) * width * 4);
  });
  return { png: PNG.sync.write({ width: atlasWidth, height: atlasHeight, data } as PNG), columns, rows };
}

/** One output sheet and one frame surface at a time. Raster settings, source
 * pixels and repeated frame copies are identical to the original compiler.
 * Never retain three raster buffers for every unique pose alongside both HQs. */
async function packMappedPlayback(sequence: readonly string[], lookup: ReadonlyMap<string, CompiledTemplateFrame>,
  width: number, height: number, raw: boolean) {
  assert(sequence.length > 0 && sequence.length <= 32);
  const columns = Math.min(4, sequence.length), rows = Math.ceil(sequence.length / columns);
  const atlasWidth = columns * width, atlasHeight = rows * height;
  const data = Buffer.alloc(atlasWidth * atlasHeight * 4);
  const canvas = createCanvas(width, height), divisor = 1536 / width;
  try {
    for (const id of new Set(sequence)) {
      const frame = lookup.get(id); assert(frame, `Missing exact pose ${id}`);
      const encoded = raw ? frame.rawPng : frame.png;
      assert.equal(pngSha256(encoded), raw ? frame.rawPngSha256 : frame.pngSha256, 'Cached native PNG changed');
      const image = await loadImage(encoded);
      // Resizing resets the context to a fresh transparent backing surface;
      // this also relinquishes the previous native allocation immediately.
      canvas.width = width;
      const context = canvas.getContext('2d');
      context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
      context.drawImage(image, frame.mapping.translateX / divisor, frame.mapping.translateY / divisor,
        frame.width * frame.mapping.scale / divisor, frame.height * frame.mapping.scale / divisor);
      const raster = context.getImageData(0, 0, width, height).data;
      const bytes = Buffer.from(raster.buffer, raster.byteOffset, raster.byteLength);
      // Every authored hold is copied from this exact same raster, not redrawn.
      sequence.forEach((masterId, index) => {
        if (masterId !== id) return;
        const x = index % columns * width, y = Math.floor(index / columns) * height;
        for (let yy = 0; yy < height; yy++) bytes.copy(data, ((y + yy) * atlasWidth + x) * 4, yy * width * 4, (yy + 1) * width * 4);
      });
    }
  } finally { canvas.width = 1; canvas.height = 1; }
  return { png: PNG.sync.write({ width: atlasWidth, height: atlasHeight, data } as PNG), columns, rows };
}

async function assemble(plans: readonly TemplateAtlasPlan[], compiled: readonly CompiledTemplateAtlas[],
  name: TemplateAtlasAnimationName, includeRuntime: boolean) {
  assert(plans.length > 0 && plans.every(plan => plan.rendererVersion === plans[0].rendererVersion), 'Cannot mix renderer variants');
  plans.forEach(assertTrustedTemplatePlan);
  const animation = plans.flatMap(plan => plan.animations).find(candidate => candidate.name === name);
  assert(animation, 'Animation was not selected in these trusted plans');
  const required = plans.filter(plan => plan.animations.some(candidate => candidate.name === name)
    && plan.cells.some(cell => animation.sequence.includes(cell.masterId)));
  const sources = required.map(plan => {
    const matches = compiled.filter(atlas => atlas.planId === plan.planId && atlas.geometryFingerprint === geometryFingerprint(plan));
    assert.equal(matches.length, 1, `Missing/duplicate compiled atlas ${plan.planId}`);
    assert(compiledObjects.has(matches[0]) && matches[0].qa.passed, 'Only validated internal compiler results may be assembled');
    return matches[0];
  });
  const lookup = new Map(sources.flatMap(source => source.frames.map(frame => [frame.masterId, frame] as const)));
  // Physically repeated cells come from the SAME raster buffer: no second model
  // call, interpolation, timing reinterpretation or perceptual deduplication.
  const hq = await packMappedPlayback(animation.sequence, lookup, 768, 1024, false);
  const rawHq = await packMappedPlayback(animation.sequence, lookup, 768, 1024, true);
  const runtime = includeRuntime ? await packMappedPlayback(animation.sequence, lookup, 384, 512, false) : null;
  const result: CompiledTemplateHqAnimation = { animationName: name, family: animation.family, hqPng: hq.png, rawHqPng: rawHq.png,
    frameWidth: 384, frameHeight: 512, hqFrameWidth: 768, hqFrameHeight: 1024,
    frameCount: animation.sequence.length, columns: hq.columns, rows: hq.rows,
    fps: animation.fps, loop: animation.loop, originX: .5, originY: TEMPLATE_REGISTRATION.originY,
    animationFormat: 'template-atlas-v1', processingVersion: 6, sequence: [...animation.sequence],
    hqSha256: pngSha256(hq.png), rawHqSha256: pngSha256(rawHq.png),
    provenance: { rendererVersion: plans[0].rendererVersion, templateVersion: plans[0].templateVersion,
      templateManifestSha256: plans[0].templateManifestSha256,
      sources: sources.map(source => ({ planId: source.planId, rawSha256: source.rawSha256,
        templateImageSha256: source.templateImageSha256, geometryFingerprint: source.geometryFingerprint })),
      fullCanvasRegistration: TEMPLATE_REGISTRATION },
    qa: { passed: true, semanticApprovalClaimed: false, warnings: [...new Set(sources.flatMap(source => source.qa.warnings))],
      perFrameFit: false, repeatsAreExact: true } };
  return { result, runtime };
}
/** Production RPC persists only clean and original HQ; no unused runtime PNG. */
export async function assembleTemplateAtlasHqAnimation(plans: readonly TemplateAtlasPlan[], compiled: readonly CompiledTemplateAtlas[], name: TemplateAtlasAnimationName): Promise<CompiledTemplateHqAnimation> {
  return (await assemble(plans, compiled, name, false)).result;
}
export async function assembleTemplateAtlasAnimation(plans: readonly TemplateAtlasPlan[], compiled: readonly CompiledTemplateAtlas[], name: TemplateAtlasAnimationName): Promise<CompiledTemplateAnimation> {
  const { result, runtime } = await assemble(plans, compiled, name, true);
  assert(runtime);
  return { ...result, runtimePng: runtime.png, runtimeSha256: pngSha256(runtime.png) };
}
export async function assembleTemplateAtlasAnimations(plans: readonly TemplateAtlasPlan[], compiled: readonly CompiledTemplateAtlas[]) {
  const names = [...new Set(plans.flatMap(plan => plan.animations.map(animation => animation.name)))];
  const results: CompiledTemplateAnimation[] = [];
  for (const name of names) results.push(await assembleTemplateAtlasAnimation(plans, compiled, name));
  return results;
}
