/** Offline composition of the two reviewed irregular Aura grids; never invokes providers. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquireLock, immutable, installCasualWindow, sha256 } from './casual-generation-transport.mjs';
import { CASUAL_AURA_GRID_RESCUE_ID as ID, collectCasualAuraGridRescueFiles } from './casual-aura-grid-rescue-provenance.mjs';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..'), DIRECTORY = join(ROOT, '.artifacts/casual-generation-v1');
const INPUTS_PATH = join(ROOT, '.artifacts/casual-aura-grid-rescue-v1/inputs.json'), INPUTS_SHA = '410f51d1f5c0e84e8e58e79f8f698fe22c418c2f2e5557d21c16e719fabc3a8a';
const SHA = /^[a-f0-9]{64}$/;
const spriteFields = ['animationName', 'qualityTier', 'frameWidth', 'frameHeight', 'frameCount', 'processingVersion', 'path', 'sha256', 'bytes', 'mime', 'rawPath', 'rawSha256', 'rawBytes', 'rawWidth', 'rawHeight', 'rawMime', 'animationFormat', 'gridCols', 'gridRows', 'derivativeId', 'uniqueFrameCount'];
const pick = (value, fields) => Object.fromEntries(fields.filter(field => value[field] !== undefined).map(field => [field, value[field]]));
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
function verified(root, entry) {
  const path = resolve(root, entry.path); assert.ok(path.startsWith(`${resolve(root)}/`)); const bytes = readFileSync(path);
  assert.equal(sha256(bytes), entry.sha256); if (entry.bytes !== undefined) assert.equal(bytes.length, entry.bytes); return bytes;
}
export function auraGridCompositionOptions(args) {
  assert.ok(args.every(arg => arg === '--apply' || /^(--review=|--review-sha256=|--sheets-reviewed=|--confirm=)/.test(arg)));
  const get = name => { const items = args.filter(arg => arg.startsWith(`--${name}=`)); assert.ok(items.length <= 1); return items[0]?.slice(name.length + 3); };
  assert.ok(get('review')); assert.ok(SHA.test(get('review-sha256') ?? ''), 'Exact reviewed seven-pair selection SHA is required');
  const apply = args.includes('--apply'); if (apply) { assert.equal(get('confirm'), ID); assert.ok(SHA.test(get('sheets-reviewed') ?? ''), 'Review all four assembled sheets before apply'); }
  return { review: resolve(get('review')), reviewSha256: get('review-sha256'), apply, sheetsReviewed: get('sheets-reviewed') };
}
export async function composeCasualAuraGridRescue(args = process.argv.slice(2)) {
  const options = auraGridCompositionOptions(args), reviewBytes = readFileSync(options.review); assert.equal(sha256(reviewBytes), options.reviewSha256);
  const review = JSON.parse(reviewBytes.toString()); assert.equal(review.schemaVersion, 1); assert.equal(review.id, ID);
  const inputsBytes = readFileSync(INPUTS_PATH); assert.equal(sha256(inputsBytes), INPUTS_SHA); const inputs = JSON.parse(inputsBytes.toString());
  const targetKey = frame => `${frame.animationName ?? frame.target?.animationName}:${frame.uniqueFrame ?? frame.target?.uniqueFrame}`;
  assert.deepEqual(review.frames.map(targetKey).sort(), inputs.frames.map(targetKey).sort());
  const manifestPath = join(DIRECTORY, 'manifest.json'), manifestBytes = readFileSync(manifestPath), manifest = JSON.parse(manifestBytes.toString());
  assert.deepEqual(inputs.identity, manifest.identity); assert.equal(inputs.fingerprint, manifest.fingerprint);
  assert.equal(manifest.derivatives?.some(item => item.id === ID), false, 'Aura grid rescue is already applied');
  for (const file of manifest.productFiles) assert.equal(sha256(readFileSync(join(ROOT, file.path))), file.sha256, 'Product files changed after fingerprint review');
  const { installCanvasRuntime } = await import('../processor/src/canvasRuntime.ts'); installCanvasRuntime();
  const { loadImage, createCanvas } = await import('../processor/node_modules/@napi-rs/canvas/index.js');
  const { composeGeminiRefinedSprite } = await import('../src/services/GeminiApi.ts'); const { cleanSpriteSheet } = await import('../src/services/SpritePostProcess.ts');
  const processingVersion = Number(readFileSync(join(ROOT, 'src/services/CharacterPipeline.ts'), 'utf8').match(/export const SPRITE_PROCESSING_VERSION = (\d+)/)?.[1]); assert.ok(Number.isSafeInteger(processingVersion));
  const base = `derivatives/${ID}`, write = (path, bytes, mime) => { immutable(join(DIRECTORY, path), bytes); return { path, sha256: sha256(bytes), bytes: bytes.length, mime }; };
  const media = async bytes => { const image = await loadImage(bytes); return { ...write(`${base}/frames/${sha256(bytes)}.png`, bytes, 'image/png'), width: image.width, height: image.height }; };
  const originalBytes = verified(ROOT, inputs.originalManifest), original = JSON.parse(originalBytes.toString());
  const proof = { schemaVersion: 1, id: ID, identity: manifest.identity, originalManifest: write(`${base}/original-manifest.json`, originalBytes, 'application/json'), originalProductFingerprint: original.fingerprint,
    compositionProductFiles: ['src/services/GeminiApi.ts', 'src/services/SpritePostProcess.ts', 'src/services/AnimationProfiles.ts', 'src/services/FrameSequence.ts', 'src/services/AlphaMask.ts', 'src/services/SpriteGrid.ts', 'processor/src/canvasRuntime.ts'].map(path => ({ path, sha256: sha256(readFileSync(join(ROOT, path))) })), groups: [], inputsSha256: INPUTS_SHA, nativeReviewSha256: options.reviewSha256, providerCallsDuringComposition: 0 };
  const diagnostics = [], restore = installCasualWindow(diagnostics), nativeFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Aura grid finalizer forbids provider/network operations'); };
  try {
    for (const animationName of ['aura_unbothered', 'aura_floor_worm']) {
      const worm = animationName === 'aura_floor_worm', preparationEntry = inputs.preparations[worm ? 'floorWormRookie' : 'unbotheredRookie'], preparationRoot = dirname(resolve(ROOT, preparationEntry.path));
      const prep = JSON.parse(verified(ROOT, preparationEntry).toString());
      const oldRookie = original.sprites.find(sprite => sprite.animationName === animationName && sprite.qualityTier === 'rookie'), oldChampion = original.sprites.find(sprite => sprite.animationName === animationName && sprite.qualityTier === 'contender') ?? null;
      assert.deepEqual(prep.originalRookie, oldRookie);
      assert.deepEqual(manifest.sprites.find(sprite => sprite.animationName === animationName && sprite.qualityTier === 'rookie'), oldRookie);
      assert.deepEqual(manifest.sprites.find(sprite => sprite.animationName === animationName && sprite.qualityTier === 'contender') ?? null, oldChampion);
      const originalSheet = await loadImage(verified(DIRECTORY, { path: oldRookie.rawPath, sha256: oldRookie.rawSha256, bytes: oldRookie.rawBytes }));
      const regular = createCanvas(prep.regularRaw.width, prep.regularRaw.height), regularContext = regular.getContext('2d'); regularContext.fillStyle = '#00ff00'; regularContext.fillRect(0, 0, regular.width, regular.height);
      const sourceFrames = [];
      for (const item of prep.originals) {
        const { rect } = item, crop = createCanvas(rect.width, rect.height), ctx = crop.getContext('2d'); ctx.drawImage(originalSheet, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
        assert.equal(sha256(Buffer.from(ctx.getImageData(0, 0, rect.width, rect.height).data)), item.rgbaSha256);
        const cropBytes = crop.toBuffer('image/png'); assert.equal(sha256(cropBytes), item.native.sha256);
        const scale = worm ? 576 / rect.width : 1, drawWidth = Math.round(rect.width * scale), drawHeight = Math.round(rect.height * scale), paddingLeft = Math.round((prep.regularRaw.cellWidth - drawWidth) / 2), paddingTop = Math.round((prep.regularRaw.cellHeight - drawHeight) / 2);
        const frame = prep.selectedOriginalFrames.indexOf(item.sourceFrame); if (frame >= 0) regularContext.drawImage(crop, frame % 4 * prep.regularRaw.cellWidth + paddingLeft, Math.floor(frame / 4) * prep.regularRaw.cellHeight + paddingTop, drawWidth, drawHeight);
        sourceFrames.push({ sourceFrame: item.sourceFrame, rect, rgbaSha256: item.rgbaSha256, native: await media(cropBytes), layoutNormalization: { scale, drawWidth, drawHeight, paddingLeft, paddingTop } });
      }
      const regularBytes = regular.toBuffer('image/png'); assert.equal(sha256(regularBytes), prep.regularRaw.sha256, 'Recorded crop/scale layout must reproduce the reviewed regular RAW exactly');
      const normal = await cleanSpriteSheet(regularBytes.toString('base64'), 6, 4, 2, animationName); assert.equal(normal.frameCount, 6);
      const rookieBytes = Buffer.from(normal.base64, 'base64'); assert.equal(sha256(rookieBytes), prep.processed.sha256); assert.equal(sha256(rookieBytes), inputs.reviewedRookieProcessed[animationName]);
      const entry = async (tier, processedBytes, rawBytes) => {
        const rawImage = await loadImage(rawBytes), raw = write(`${base}/outputs/${animationName}-${tier}-raw-${sha256(rawBytes)}.png`, rawBytes, 'image/png');
        return { ...write(`${base}/outputs/${animationName}-${tier}-${sha256(processedBytes)}.png`, processedBytes, 'image/png'), animationName, qualityTier: tier, frameWidth: 768, frameHeight: 1024, frameCount: 6, processingVersion, rawPath: raw.path, rawSha256: raw.sha256, rawBytes: raw.bytes, rawWidth: rawImage.width, rawHeight: rawImage.height, rawMime: 'image/png', animationFormat: 'legacy', gridCols: 4, gridRows: 2, derivativeId: ID, uniqueFrameCount: 6 };
      };
      const group = { animationName, originalRookie: oldRookie, originalChampion: oldChampion, selectedOriginalFrames: prep.selectedOriginalFrames, reusedOriginalFrames: worm ? [] : [1, 3, 4, 5, 6], sourceFrames,
        rookieOutputEntry: await entry('rookie', rookieBytes, regularBytes), originalAttempts: [], frames: [],
        rookieProcessing: { function: 'cleanSpriteSheet', expectedFrameCount: 6, expectedGridCols: 4, expectedGridRows: 2, animationName, maxScale: null, normalizationReference: null, paidCalls: 0 },
        championComposition: { function: 'composeGeminiRefinedSprite', animationName, frameCount: 6, maxScale: null, normalizationReference: null, official: false } };
      const nativePreparationPath = join(preparationRoot, 'champion-preparation.json'), nativePrep = JSON.parse(readFileSync(nativePreparationPath, 'utf8'));
      if (worm) {
        assert.equal(sha256(readFileSync(nativePreparationPath)), '3c7e0eb39732ef08fbe71a8009ea68963cf6235b9541dc37adcf2d449458afe8');
        for (const item of nativePrep.frames) group.originalAttempts.push({ playbackFrame: item.playbackFrame, poseSha256: item.poseSha256, parent: item.parent, raw: await media(verified(preparationRoot, item.raw)) });
      } else {
        assert.equal(sha256(readFileSync(nativePreparationPath)), inputs.preparations.unbotheredChampion.sha256);
        for (const item of nativePrep.frames) group.originalAttempts.push({ playbackFrame: item.playbackFrame, poseSha256: item.poseSha256, parent: { id: item.requestId, requestSha256: item.requestSha256, responseSha256: item.responseSha256 }, raw: await media(verified(preparationRoot, item.raw)), ...(item.clean ? { clean: await media(verified(preparationRoot, item.clean)), cleanupReceipt: item.cleanup } : {}) });
      }
      const oldProcessed = await loadImage(verified(DIRECTORY, oldRookie)), rawCells = [], cleanCells = [];
      for (let number = 1; number <= 6; number++) {
        let frame;
        if (group.reusedOriginalFrames.includes(number)) {
          const item = group.originalAttempts.find(attempt => attempt.playbackFrame === number), poseCanvas = createCanvas(768, 1024); poseCanvas.getContext('2d').drawImage(oldProcessed, (number - 1) % 4 * 768, Math.floor((number - 1) / 4) * 1024, 768, 1024, 0, 0, 768, 1024);
          const pose = await media(poseCanvas.toBuffer('image/png')); assert.equal(pose.sha256, item.poseSha256);
          frame = { playbackFrame: number, sourceFrame: prep.selectedOriginalFrames[number - 1], disposition: 'reuse-approved-native', pose, raw: item.raw, clean: item.clean, rawReviewedSha256: item.raw.sha256, cleanReviewedSha256: item.clean.sha256, cleanupReceipt: item.cleanupReceipt };
        } else {
          const selected = review.frames.find(item => item.animationName === animationName && item.uniqueFrame === number), input = inputs.frames.find(item => item.target.animationName === animationName && item.target.uniqueFrame === number);
          const resultDirectory = resolve(DIRECTORY, selected.resultDirectory); assert.ok(resultDirectory.startsWith(`${DIRECTORY}/review/aura-grid-rescue-v1/${animationName}-${number}/`));
          const plan = JSON.parse(readFileSync(join(resultDirectory, 'plan.json'), 'utf8')); assert.equal(sha256(JSON.stringify(plan)), selected.planSha256); assert.equal(plan.inputs.sha256, INPUTS_SHA); assert.equal(plan.pose.sha256, input.pose.sha256); assert.deepEqual(plan.parent, input.parent); assert.equal(plan.fingerprint, inputs.fingerprint);
          const renderResult = JSON.parse(readFileSync(join(resultDirectory, 'render.result.json'), 'utf8')), cleanResult = JSON.parse(readFileSync(join(resultDirectory, 'clean.result.json'), 'utf8'));
          assert.equal(renderResult.planSha256, selected.planSha256); assert.equal(cleanResult.planSha256, selected.planSha256); assert.equal(renderResult.image.sha256, selected.rawReviewedSha256); assert.equal(cleanResult.image.sha256, selected.cleanReviewedSha256);
          assert.equal(renderResult.requests.find(request => request.status === 'complete')?.requestSha256, plan.request.sha256);
          frame = { playbackFrame: number, sourceFrame: input.sourceFrame, disposition: 'replace-broken-grid-pose', pose: await media(verified(ROOT, input.pose)), raw: await media(verified(DIRECTORY, renderResult.image)), clean: await media(verified(DIRECTORY, cleanResult.image)), generationFingerprint: plan.fingerprint, generationProductFiles: plan.productFiles, renderResult, cleanResult, rawReviewedSha256: selected.rawReviewedSha256, cleanReviewedSha256: selected.cleanReviewedSha256 };
        }
        group.frames.push(frame); rawCells.push(verified(DIRECTORY, frame.raw).toString('base64')); cleanCells.push(verified(DIRECTORY, frame.clean).toString('base64'));
      }
      const composed = await composeGeminiRefinedSprite({ rawUniqueCells: rawCells, cleanedUniqueCells: cleanCells, animName: animationName, frames: 6 }); assert.equal(composed.frameCount, 6); assert.equal(composed.gridCols, 4); assert.equal(composed.gridRows, 2);
      group.championOutputEntry = await entry('contender', Buffer.from(composed.imageBase64, 'base64'), Buffer.from(composed.rawBase64, 'base64')); proof.groups.push(group);
    }
  } finally { globalThis.fetch = nativeFetch; restore(); }
  const derivative = { id: ID, ...write(`${base}/provenance.json`, json(proof), 'application/json') }, outputs = proof.groups.flatMap(group => [group.rookieOutputEntry, group.championOutputEntry]);
  const next = { ...manifest, sprites: [...manifest.sprites.filter(sprite => !outputs.some(output => output.animationName === sprite.animationName && output.qualityTier === sprite.qualityTier)), ...outputs], derivatives: [...(manifest.derivatives ?? []), derivative] };
  collectCasualAuraGridRescueFiles({ manifest: { ...next, sprites: next.sprites.map(sprite => pick(sprite, spriteFields)) }, derivative, checkedJson: entry => JSON.parse(verified(DIRECTORY, entry)), includeMedia: entry => verified(DIRECTORY, entry), spriteFields, pick });
  const sheets = outputs.map(entry => ({ animationName: entry.animationName, qualityTier: entry.qualityTier, processedSha256: entry.sha256, rawSha256: entry.rawSha256 })), sheetsSha256 = sha256(JSON.stringify(sheets));
  if (options.apply) {
    assert.equal(sheetsSha256, options.sheetsReviewed); const release = acquireLock(DIRECTORY);
    try { assert.equal(sha256(readFileSync(manifestPath)), sha256(manifestBytes), 'Manifest changed during grid review/apply'); immutable(join(DIRECTORY, 'archive', ID, `manifest-before-${sha256(manifestBytes)}.json`), manifestBytes);
      next.updatedAt = new Date().toISOString(); const temporary = `${manifestPath}.grid-apply-${process.pid}`; writeFileSync(temporary, json(next), { flag: 'wx', mode: 0o600 }); renameSync(temporary, manifestPath);
    } finally { release(); }
  }
  const result = { status: options.apply ? 'applied' : 'awaiting-composed-sheet-review', derivative, outputs, sheets, sheetsSha256, providerCalls: 0 }; console.log(JSON.stringify(result, null, 2)); return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) composeCasualAuraGridRescue().catch(error => { console.error(error.stack); process.exitCode = 1; });
