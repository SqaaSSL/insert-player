// Offline authored playback derivative. No provider calls, retouching, quality relabeling, or source deletion.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquireLock, atomicJson, immutable } from './casual-generation-transport.mjs';
import { verifiedFile } from './render-casual-qa.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireProcessor = createRequire(join(ROOT, 'processor/package.json'));
const { createCanvas, loadImage } = requireProcessor('@napi-rs/canvas');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
export const CURATION_ID = 'casual-idle-closed-loop-v1';
export const FRAME_ORDER = Object.freeze([2, 3, 4, 5, 6, 7, 8, 2]);
const SOURCE_HASH = 'e29f551726c5e80941bcf63618401bbf00429d56df52f6cbb20d8da57435c210';
const TIERS = ['rookie', 'contender'];

/** Matches GeminiApi.splitSheetIntoCells: integer rounded cells, no rescaling, transparent outside source. */
export async function reorderNativeSheet(bytes, { columns = 4, rows = 2, roundedCells = false } = {}) {
  const image = await loadImage(bytes);
  assert.equal(columns * rows, 8, 'Idle curation requires exactly eight source cells');
  if (!roundedCells) {
    assert.equal(image.width % columns, 0, 'Sheet width is not divisible by its native grid');
    assert.equal(image.height % rows, 0, 'Sheet height is not divisible by its native grid');
  }
  const cellWidth = Math.round(image.width / columns), cellHeight = Math.round(image.height / rows);
  assert.ok(cellWidth > 0 && cellHeight > 0);
  const output = createCanvas(cellWidth * columns, cellHeight * rows);
  const target = output.getContext('2d'); target.imageSmoothingEnabled = false;
  // Copy through the same cell-sized intermediate canvas as the product. This also preserves
  // the product's transparent uncovered pixel when an odd source dimension rounds upwards.
  const cell = createCanvas(cellWidth, cellHeight), context = cell.getContext('2d');
  context.imageSmoothingEnabled = false;
  for (const [index, frame] of FRAME_ORDER.entries()) {
    const sourceIndex = frame - 1;
    context.clearRect(0, 0, cellWidth, cellHeight);
    context.drawImage(image, sourceIndex % columns * cellWidth, Math.floor(sourceIndex / columns) * cellHeight,
      cellWidth, cellHeight, 0, 0, cellWidth, cellHeight);
    target.drawImage(cell, index % columns * cellWidth, Math.floor(index / columns) * cellHeight);
  }
  return { bytes: output.toBuffer('image/png'), geometry: {
    sourceWidth: image.width, sourceHeight: image.height, columns, rows, cellWidth, cellHeight,
    width: output.width, height: output.height, roundedCells,
    sourceGridWidthDelta: output.width - image.width, sourceGridHeightDelta: output.height - image.height,
    sampling: 'Integer crop and copy through native-size cell canvas; no rescaling or enhancement',
  } };
}

function descriptor(path, bytes) { return { path, sha256: hash(bytes), bytes: bytes.length, mime: 'image/png' }; }
async function prepareEntry(directory, entry) {
  assert.equal(entry.animationName, 'idle'); assert.ok(TIERS.includes(entry.qualityTier));
  assert.equal(entry.animationFormat, 'legacy'); assert.equal(entry.frameCount, 8);
  assert.equal(entry.gridCols, 4); assert.equal(entry.gridRows, 2);
  assert.equal(entry.frameWidth, 768); assert.equal(entry.frameHeight, 1024);
  assert.equal(entry.mime, 'image/png'); assert.equal(entry.rawMime, 'image/png');
  const processed = verifiedFile(directory, entry.path, entry.sha256);
  const raw = verifiedFile(directory, entry.rawPath, entry.rawSha256);
  assert.equal(processed.length, entry.bytes); assert.equal(raw.length, entry.rawBytes);
  const decoded = await loadImage(processed), rawDecoded = await loadImage(raw);
  assert.equal(decoded.width, entry.gridCols * entry.frameWidth); assert.equal(decoded.height, entry.gridRows * entry.frameHeight);
  assert.equal(rawDecoded.width, entry.rawWidth); assert.equal(rawDecoded.height, entry.rawHeight);
  const output = await reorderNativeSheet(processed);
  const rawOutput = await reorderNativeSheet(raw, { roundedCells: entry.qualityTier === 'rookie' });
  return { entry, output, rawOutput };
}

function verifyExisting(directory, manifest, derivative) {
  const proof = JSON.parse(verifiedFile(directory, derivative.path, derivative.sha256));
  assert.equal(proof.id, CURATION_ID); assert.deepEqual(proof.frameOrderOneBased, FRAME_ORDER);
  assert.equal(proof.uniqueFrameCount, 7); assert.equal(proof.playbackFrameCount, 8);
  assert.equal(proof.identity.sourceSha256, SOURCE_HASH);
  verifiedFile(directory, proof.originalManifest.path, proof.originalManifest.sha256);
  assert.deepEqual(proof.pairs.map(pair => pair.qualityTier).sort(), [...TIERS].sort());
  for (const pair of proof.pairs) {
    const current = manifest.sprites.find(entry => entry.animationName === 'idle' && entry.qualityTier === pair.qualityTier);
    assert.ok(current); assert.equal(current.derivativeId, CURATION_ID);
    for (const key of ['path', 'sha256', 'bytes', 'rawPath', 'rawSha256', 'rawBytes', 'rawWidth', 'rawHeight']) {
      assert.equal(current[key], pair.outputEntry[key], `Curated manifest entry changed: ${key}`);
    }
    for (const entry of [pair.originalEntry, current]) {
      verifiedFile(directory, entry.path, entry.sha256); verifiedFile(directory, entry.rawPath, entry.rawSha256);
    }
  }
  return { status: 'already-applied', id: CURATION_ID, provenance: derivative, frameOrderOneBased: FRAME_ORDER, paidCalls: 0 };
}

export async function curateCasualIdle(directory, { apply = false } = {}) {
  directory = resolve(directory);
  // Applying shares the provider runner lock so the manifest cannot race a live generation.
  const release = apply ? acquireLock(directory) : () => {};
  try {
    if (!apply) assert.ok(!existsSync(join(directory, 'execution.lock')), 'Generation is active; wait before inspecting curation');
    const path = join(directory, 'manifest.json'), originalBytes = readFileSync(path);
    const manifest = JSON.parse(originalBytes);
    assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.identity.slug, 'casual');
    assert.equal(manifest.identity.sourceSha256, SOURCE_HASH);
    const existing = (manifest.derivatives ?? []).find(item => item.id === CURATION_ID);
    if (existing) return verifyExisting(directory, manifest, existing);
    assert.equal(manifest.phaseStatus?.canary, 'awaiting_visual_review', 'Both canary sprites must be fully persisted first');
    const selected = manifest.sprites.filter(entry => entry.animationName === 'idle');
    assert.deepEqual(selected.map(entry => entry.qualityTier).sort(), [...TIERS].sort(), 'Exactly one idle in each quality is required');
    for (const entry of selected) assert.ok(!entry.derivativeId, 'Existing idle derivative requires a separate review');
    const pairs = [];
    for (const tier of TIERS) pairs.push(await prepareEntry(directory, selected.find(entry => entry.qualityTier === tier)));
    assert.equal(hash(readFileSync(path)), hash(originalBytes), 'Manifest changed while preparing curation');
    const outputDirectory = `derivatives/${CURATION_ID}`;
    const originalManifest = { path: `${outputDirectory}/original-manifest.json`, sha256: hash(originalBytes), bytes: originalBytes.length };
    const writes = [{ path: originalManifest.path, bytes: originalBytes }];
    const proof = { schemaVersion: 1, id: CURATION_ID, identity: manifest.identity, productFingerprint: manifest.fingerprint,
      operation: 'Authored closed idle loop from the same ordered source frames in both qualities',
      frameOrderOneBased: FRAME_ORDER, uniqueFrameCount: 7, playbackFrameCount: 8,
      closingHold: { playbackFrame: 8, repeatsSourceFrame: 2, matchesPlaybackFrame: 1 },
      reason: 'Source frame 1 has inadequate real background margin at the cell boundary; omit it in both qualities.',
      noImageGeneration: true, noRetouchingOrEnhancement: true, paidCalls: 0,
      originalManifest, pairs: [] };
    for (const pair of pairs) {
      const output = descriptor(`${outputDirectory}/${pair.entry.qualityTier}-${hash(pair.output.bytes)}.png`, pair.output.bytes);
      const raw = descriptor(`${outputDirectory}/${pair.entry.qualityTier}-raw-${hash(pair.rawOutput.bytes)}.png`, pair.rawOutput.bytes);
      const outputEntry = { ...pair.entry, ...output, rawPath: raw.path, rawSha256: raw.sha256, rawBytes: raw.bytes,
        rawWidth: pair.rawOutput.geometry.width, rawHeight: pair.rawOutput.geometry.height,
        derivativeId: CURATION_ID, uniqueFrameCount: 7 };
      proof.pairs.push({ qualityTier: pair.entry.qualityTier, originalEntry: pair.entry, outputEntry,
        processedGeometry: pair.output.geometry, rawGeometry: pair.rawOutput.geometry });
      writes.push({ path: output.path, bytes: pair.output.bytes }, { path: raw.path, bytes: pair.rawOutput.bytes });
    }
    const proofBytes = jsonBytes(proof), provenance = { id: CURATION_ID, path: `${outputDirectory}/provenance.json`, sha256: hash(proofBytes), bytes: proofBytes.length, mime: 'application/json' };
    const plan = { status: apply ? 'applied' : 'dry-run', id: CURATION_ID, frameOrderOneBased: FRAME_ORDER,
      uniqueFrameCount: 7, playbackFrameCount: 8, paidCalls: 0, originalManifest, provenance,
      pairs: proof.pairs.map(pair => ({ qualityTier: pair.qualityTier, processedGeometry: pair.processedGeometry,
        rawGeometry: pair.rawGeometry, outputEntry: pair.outputEntry })) };
    if (!apply) return plan;
    // All four sheets and the original manifest become durable before a single atomic pointer update.
    for (const file of writes) immutable(join(directory, file.path), file.bytes);
    immutable(join(directory, provenance.path), proofBytes);
    manifest.sprites = manifest.sprites.map(entry => proof.pairs.find(pair => pair.qualityTier === entry.qualityTier && entry.animationName === 'idle')?.outputEntry ?? entry);
    manifest.derivatives = [...(manifest.derivatives ?? []), provenance];
    manifest.updatedAt = new Date().toISOString();
    atomicJson(path, manifest);
    return plan;
  } finally { release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), option = name => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const apply = args.includes('--apply');
  if (apply && option('confirm') !== CURATION_ID) { console.error(`Applying requires --confirm=${CURATION_ID}`); process.exitCode = 1; }
  else curateCasualIdle(option('directory') ?? join(ROOT, '.artifacts/casual-generation-v1'), { apply })
    .then(value => console.log(JSON.stringify(value, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
