/** Offline only: assemble reviewed KO native frames with the ordinary product finalizer, then optionally apply a visually reviewed sheet. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquireLock, immutable, installCasualWindow, sha256 } from './casual-generation-transport.mjs';
import { CASUAL_KO_COMPLETION_ID as ID, collectCasualKoCompletionFiles } from './casual-ko-completion-provenance.mjs';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..'), DIRECTORY = join(ROOT, '.artifacts/casual-generation-v1');
const PREPARATION = join(ROOT, '.artifacts/casual-selective-repair/ko-native-c4fcc7ae5c52594d/preparation-7fd4ab7e6fc7481f862e0dd516d600f8e86eb1bb9f38a6e5452bbc88031baa90.json');
const SHA = /^[a-f0-9]{64}$/;
const spriteFields = ['animationName', 'qualityTier', 'frameWidth', 'frameHeight', 'frameCount', 'processingVersion', 'path', 'sha256', 'bytes', 'mime', 'rawPath', 'rawSha256', 'rawBytes', 'rawWidth', 'rawHeight', 'rawMime', 'animationFormat', 'gridCols', 'gridRows', 'derivativeId', 'uniqueFrameCount'];
const pick = (value, fields) => Object.fromEntries(fields.filter(field => value[field] !== undefined).map(field => [field, value[field]]));
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
function verified(root, entry) {
  const path = resolve(root, entry.path); assert.ok(path.startsWith(`${resolve(root)}/`)); const bytes = readFileSync(path);
  assert.equal(sha256(bytes), entry.sha256); if (entry.bytes !== undefined) assert.equal(bytes.length, entry.bytes); return bytes;
}
export function koCompositionOptions(args) {
  assert.ok(args.every(arg => arg === '--apply' || /^(--review=|--review-sha256=|--processed-reviewed=|--raw-reviewed=|--confirm=)/.test(arg)));
  const get = name => { const items = args.filter(arg => arg.startsWith(`--${name}=`)); assert.ok(items.length <= 1); return items[0]?.slice(name.length + 3); };
  assert.ok(get('review')); assert.ok(SHA.test(get('review-sha256') ?? ''), 'Exact reviewed native selection SHA is required');
  const apply = args.includes('--apply');
  if (apply) { assert.equal(get('confirm'), ID); assert.ok(SHA.test(get('processed-reviewed') ?? '') && SHA.test(get('raw-reviewed') ?? ''), 'Review the assembled raw and processed sheets before apply'); }
  return { review: resolve(get('review')), reviewSha256: get('review-sha256'), apply, processedReviewed: get('processed-reviewed'), rawReviewed: get('raw-reviewed') };
}
export async function composeCasualKo(args = process.argv.slice(2)) {
  const options = koCompositionOptions(args), reviewBytes = readFileSync(options.review); assert.equal(sha256(reviewBytes), options.reviewSha256);
  const review = JSON.parse(reviewBytes.toString()); assert.equal(review.schemaVersion, 1); assert.equal(review.id, ID);
  assert.deepEqual(review.frames.map(frame => frame.uniqueFrame), [1, 2, 3, 4, 5, 6, 7, 8]);
  const manifestPath = join(DIRECTORY, 'manifest.json'), manifestBytes = readFileSync(manifestPath), manifest = JSON.parse(manifestBytes.toString());
  const prepBytes = readFileSync(PREPARATION), prep = JSON.parse(prepBytes.toString()); assert.deepEqual(prep.identity, manifest.identity);
  assert.equal(manifest.sprites.some(sprite => sprite.animationName === 'ko' && sprite.qualityTier === 'contender'), false, 'KO already complete; no replacement');
  for (const file of manifest.productFiles) assert.equal(sha256(readFileSync(join(ROOT, file.path))), file.sha256, 'Product files changed after fingerprint review');
  const { installCanvasRuntime } = await import('../processor/src/canvasRuntime.ts'); installCanvasRuntime();
  const { loadImage } = await import('../processor/node_modules/@napi-rs/canvas/index.js');
  const { composeGeminiRefinedSprite } = await import('../src/services/GeminiApi.ts');
  const processingVersion = Number(readFileSync(join(ROOT, 'src/services/CharacterPipeline.ts'), 'utf8').match(/export const SPRITE_PROCESSING_VERSION = (\d+)/)?.[1]); assert.ok(Number.isSafeInteger(processingVersion) && processingVersion > 0);
  const base = `derivatives/${ID}`, write = (path, bytes, mime) => { immutable(join(DIRECTORY, path), bytes); return { path, sha256: sha256(bytes), bytes: bytes.length, mime }; };
  const media = async bytes => { const image = await loadImage(bytes); return { ...write(`${base}/frames/${sha256(bytes)}.png`, bytes, 'image/png'), width: image.width, height: image.height }; };
  const originalManifest = write(`${base}/original-manifest.json`, verified(dirname(PREPARATION), prep.originalManifest), 'application/json');
  const originals = [];
  for (const item of prep.records) originals.push({ uniqueFrame: item.uniqueFrame, attempt: item.attempt, parent: item.parent, poseSha256: item.pose.sha256, raw: await media(verified(dirname(PREPARATION), item.raw)) });
  const frames = [], raw = [], clean = [];
  for (const selected of review.frames) {
    const number = selected.uniqueFrame, resultDirectory = resolve(DIRECTORY, selected.resultDirectory); assert.ok(resultDirectory.startsWith(`${DIRECTORY}/review/selective-repair-v1/ko-${number}/`));
    const plan = JSON.parse(readFileSync(join(resultDirectory, 'plan.json'), 'utf8')); assert.equal(sha256(JSON.stringify(plan)), selected.planSha256); assert.ok(SHA.test(plan.fingerprint));
    assert.equal(plan.identity.sha256, manifest.sources.find(source => source.kind === 'side')?.sha256);
    for (const file of plan.productFiles) assert.ok(SHA.test(file.sha256));
    const renderResult = JSON.parse(readFileSync(join(resultDirectory, 'render.result.json'), 'utf8')), cleanResult = JSON.parse(readFileSync(join(resultDirectory, 'clean.result.json'), 'utf8'));
    assert.equal(renderResult.planSha256, selected.planSha256); assert.equal(cleanResult.planSha256, selected.planSha256);
    assert.equal(renderResult.image.sha256, selected.rawReviewedSha256); assert.equal(cleanResult.image.sha256, selected.cleanReviewedSha256);
    if (![2, 5].includes(number)) assert.equal(renderResult.requests.find(request => request.status === 'complete')?.requestSha256, plan.request.sha256);
    const rawBytes = verified(DIRECTORY, renderResult.image), cleanBytes = verified(DIRECTORY, cleanResult.image);
    const pose = await media(verified(dirname(PREPARATION), prep.poses[number - 1])); assert.equal(pose.sha256, plan.pose.sha256);
    frames.push({ uniqueFrame: number, generationFingerprint: plan.fingerprint, generationProductFiles: plan.productFiles, pose, raw: await media(rawBytes), clean: await media(cleanBytes), renderResult, cleanResult,
      rawReviewedSha256: selected.rawReviewedSha256, cleanReviewedSha256: selected.cleanReviewedSha256 });
    raw.push(rawBytes.toString('base64')); clean.push(cleanBytes.toString('base64'));
  }
  const diagnostics = [], restore = installCasualWindow(diagnostics), nativeFetch = globalThis.fetch;
  let result;
  try { globalThis.fetch = async () => { throw new Error('KO finalizer forbids provider/network operations'); }; result = await composeGeminiRefinedSprite({ rawUniqueCells: raw, cleanedUniqueCells: clean, animName: 'ko', frames: 8 }); }
  finally { globalThis.fetch = nativeFetch; restore(); }
  assert.equal(result.frameCount, 8); assert.equal(result.gridCols, 4); assert.equal(result.gridRows, 2);
  const processedBytes = Buffer.from(result.imageBase64, 'base64'), rawBytes = Buffer.from(result.rawBase64, 'base64'), rawImage = await loadImage(rawBytes);
  const processed = write(`${base}/outputs/ko-${sha256(processedBytes)}.png`, processedBytes, 'image/png');
  const native = write(`${base}/outputs/ko-raw-${sha256(rawBytes)}.png`, rawBytes, 'image/png');
  const outputEntry = { ...processed, animationName: 'ko', qualityTier: 'contender', frameWidth: 768, frameHeight: 1024, frameCount: 8, processingVersion,
    rawPath: native.path, rawSha256: native.sha256, rawBytes: native.bytes, rawWidth: rawImage.width, rawHeight: rawImage.height, rawMime: 'image/png', animationFormat: 'legacy', gridCols: 4, gridRows: 2, derivativeId: ID, uniqueFrameCount: 8 };
  const compositionPaths = ['src/services/GeminiApi.ts', 'src/services/SpritePostProcess.ts', 'src/services/AnimationProfiles.ts', 'src/services/FrameSequence.ts', 'src/services/AlphaMask.ts', 'processor/src/canvasRuntime.ts'];
  const proof = { schemaVersion: 1, id: ID, identity: manifest.identity, originalManifest, originalProductFingerprint: JSON.parse(verified(DIRECTORY, originalManifest)).fingerprint,
    reusedOriginalFrames: [2, 5], originalAttempts: originals, frames, outputEntry,
    compositionProductFiles: compositionPaths.map(path => ({ path, sha256: sha256(readFileSync(join(ROOT, path))) })),
    composition: { function: 'composeGeminiRefinedSprite', animationName: 'ko', frameCount: 8, maxScale: null, normalizationReference: null, official: false },
    preparationSha256: sha256(prepBytes), nativeReviewSha256: options.reviewSha256, providerCallsDuringComposition: 0 };
  const derivative = { id: ID, ...write(`${base}/provenance.json`, jsonBytes(proof), 'application/json') };
  const next = { ...manifest, sprites: [...manifest.sprites, outputEntry], derivatives: [...(manifest.derivatives ?? []), derivative] };
  const sealedNext = { ...next, sprites: next.sprites.map(sprite => pick(sprite, spriteFields)) };
  collectCasualKoCompletionFiles({ manifest: sealedNext, derivative, checkedJson: entry => JSON.parse(verified(DIRECTORY, entry)), includeMedia: entry => verified(DIRECTORY, entry), spriteFields, pick });
  if (options.apply) {
    assert.equal(processed.sha256, options.processedReviewed); assert.equal(native.sha256, options.rawReviewed);
    const release = acquireLock(DIRECTORY);
    try { assert.equal(sha256(readFileSync(manifestPath)), sha256(manifestBytes), 'Manifest changed during KO review/apply');
      immutable(join(DIRECTORY, 'archive', ID, `manifest-before-${sha256(manifestBytes)}.json`), manifestBytes);
      next.updatedAt = new Date().toISOString(); const temporary = `${manifestPath}.ko-apply-${process.pid}`; writeFileSync(temporary, jsonBytes(next), { flag: 'wx', mode: 0o600 }); renameSync(temporary, manifestPath);
    } finally { release(); }
  }
  console.log(JSON.stringify({ status: options.apply ? 'applied' : 'awaiting-composed-sheet-review', derivative, outputEntry, providerCalls: 0 }, null, 2));
  return { derivative, outputEntry, proof };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) composeCasualKo().catch(error => { console.error(error.message); process.exitCode = 1; });
