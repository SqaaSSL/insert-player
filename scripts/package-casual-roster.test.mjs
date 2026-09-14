import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { CASUAL_BUNDLE_ROOT, extractCasualRoster, inspectCasualArchive, packageCasualRoster, sealedCasualManifest, validateCasualDescriptor } from './package-casual-roster.mjs';
import { CASUAL_SELECTIVE_REPAIR_ID, CASUAL_REPAIR_TARGETS, casualRepairPlayback } from './casual-selective-repair-provenance.mjs';
import { CASUAL_AURA_GRID_RESCUE_ID } from './casual-aura-grid-rescue-provenance.mjs';
import { CASUAL_KO_COMPLETION_ID } from './casual-ko-completion-provenance.mjs';
import { CASUAL_POSTPROCESS_REPAIR_ID } from './casual-postprocess-repair-provenance.mjs';
import { CASUAL_ANIMATIONS } from './import-casual-roster.mjs';

const directories = [];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const source = readFileSync(new URL('../public/assets/landing-panel-photo2-2de4f7af.webp', import.meta.url));
const composite = readFileSync(new URL('../public/assets/landing-panel-fighter2-e9c8ad75.webp', import.meta.url));
const identity = { slug: 'casual', name: 'Casual', sourceSha256: digest(source) };

afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function temporary() {
  const directory = mkdtempSync(join(tmpdir(), 'casual-package-test-'));
  directories.push(directory);
  return directory;
}
function write(path, bytes) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); }
function fixture() {
  const root = temporary(); const inputs = join(root, 'generation');
  const media = (path, bytes) => { write(join(inputs, path), bytes); return { path, sha256: digest(bytes), bytes: bytes.length, mime: path.endsWith('.webp') ? 'image/webp' : 'image/png' }; };
  const png = label => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from(label)]);
  const sources = ['original', 'side', 'side_raw', 'upright', 'upright_raw', 'crouch', 'crouch_raw'].map(kind =>
    ({ kind, ...media(`sources/${kind}.${kind === 'original' ? 'webp' : 'png'}`, kind === 'original' ? source : png(kind)) }));
  const sprites = ['rookie', 'contender'].flatMap(qualityTier => CASUAL_ANIMATIONS.map(animationName => {
    const raw = media(`outputs/${animationName}-${qualityTier}-raw.png`, png(`${animationName}-${qualityTier}-raw`));
    return { animationName, qualityTier, ...media(`outputs/${animationName}-${qualityTier}.png`, png(`${animationName}-${qualityTier}`)),
      frameWidth: 768, frameHeight: 1024, frameCount: 6, processingVersion: 31, gridCols: 3, gridRows: 2,
      animationFormat: 'legacy', rawPath: raw.path, rawSha256: raw.sha256, rawBytes: raw.bytes, rawWidth: 1536, rawHeight: 1024,
      rawMime: 'image/png', debugPath: 'outputs/provider-debug.json' };
  }));
  const manifest = { schemaVersion: 1, identity, sources, sprites, fingerprint: 'a'.repeat(64), productRevision: 'b'.repeat(40),
    productFiles: [{ path: 'src/services/GeminiApi.ts', sha256: 'c'.repeat(64) }], phaseStatus: { full: 'awaiting_visual_review' },
    sourcePrompt: 'Preserve the grey hoodie, charcoal trousers and brown boots.', createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z',
    conversions: [], providerLedger: { privateData: 'must never be packaged' } };
  write(join(inputs, 'manifest.json'), JSON.stringify(manifest));
  write(join(inputs, 'inputs/casual-approved-marketing-composite.webp'), composite);
  write(join(inputs, 'inputs/casual-published-source-photo.webp'), source);
  write(join(inputs, 'inputs/source-provenance.json'), JSON.stringify({ schemaVersion: 1, syntheticOrigin: { commit: 'a8e0f09fa146331dba4a0c5ba21a5b6db8cb0171' }, preservation: { sourceAssetsModified: false } }));
  write(join(inputs, 'provider-ledger.json'), 'sensitive provider trace');
  write(join(inputs, 'credentials.env'), 'secret');
  return { root, inputs, manifest, manifestPath: join(inputs, 'manifest.json') };
}

function tarEntry(path, { type = '0', data = Buffer.from('x'), checksumError = false } = {}) {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, 'utf8');
  header.write('0000600\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124); header.write('00000000000\0', 136);
  header.fill(32, 148, 156); header.write(type, 156); header.write('ustar\0', 257); header.write('00', 263);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${(sum + Number(checksumError)).toString(8).padStart(6, '0')}\0 `, 148);
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)]);
}
function archive(entries, ending = Buffer.alloc(1024)) {
  const path = join(temporary(), 'fixture.tar.gz');
  write(path, gzipSync(Buffer.concat([...entries, ending]))); return path;
}

function addIdleDerivative(value) {
  delete value.manifest.providerLedger;
  for (const entry of value.manifest.sprites.filter(sprite => sprite.animationName === 'idle')) {
    entry.frameCount = 8; entry.gridCols = 4; entry.gridRows = 2;
  }
  const id = 'casual-idle-closed-loop-v1', base = `derivatives/${id}`;
  const originalBytes = Buffer.from(JSON.stringify(value.manifest));
  const originalManifest = { path: `${base}/original-manifest.json`, sha256: digest(originalBytes), bytes: originalBytes.length };
  write(join(value.inputs, originalManifest.path), originalBytes);
  const proof = { schemaVersion: 1, id, identity, productFingerprint: value.manifest.fingerprint,
    frameOrderOneBased: [2, 3, 4, 5, 6, 7, 8, 2], uniqueFrameCount: 7, playbackFrameCount: 8,
    closingHold: { playbackFrame: 8, repeatsSourceFrame: 2, matchesPlaybackFrame: 1 },
    noImageGeneration: true, noRetouchingOrEnhancement: true, paidCalls: 0, originalManifest, pairs: [] };
  for (const originalEntry of value.manifest.sprites.filter(sprite => sprite.animationName === 'idle')) {
    const outputEntry = { ...originalEntry, path: `${base}/${originalEntry.qualityTier}.png`, rawPath: `${base}/${originalEntry.qualityTier}-raw.png`, derivativeId: id, uniqueFrameCount: 7 };
    write(join(value.inputs, outputEntry.path), readFileSync(join(value.inputs, originalEntry.path)));
    write(join(value.inputs, outputEntry.rawPath), readFileSync(join(value.inputs, originalEntry.rawPath)));
    const geometry = (width, height) => ({ sourceWidth: width, sourceHeight: height, width, height, columns: 4, rows: 2, cellWidth: width / 4, cellHeight: height / 2 });
    proof.pairs.push({ qualityTier: originalEntry.qualityTier, originalEntry: { ...originalEntry }, outputEntry,
      processedGeometry: geometry(3072, 2048), rawGeometry: geometry(originalEntry.rawWidth, originalEntry.rawHeight) });
  }
  const proofBytes = Buffer.from(JSON.stringify(proof));
  const derivative = { id, path: `${base}/provenance.json`, sha256: digest(proofBytes), bytes: proofBytes.length, mime: 'application/json' };
  write(join(value.inputs, derivative.path), proofBytes);
  value.manifest.sprites = value.manifest.sprites.map(entry => entry.animationName === 'idle' ? proof.pairs.find(pair => pair.qualityTier === entry.qualityTier).outputEntry : entry);
  value.manifest.derivatives = [derivative];
  write(value.manifestPath, JSON.stringify(value.manifest));
  return { proof, derivative, originalBytes, proofBytes };
}


function addSelectiveDerivative(value) {
  delete value.manifest.providerLedger;
  const id = CASUAL_SELECTIVE_REPAIR_ID, base = `derivatives/${id}`;
  const originalBytes = Buffer.from(JSON.stringify(value.manifest));
  const json = (path, object) => { const bytes = Buffer.from(JSON.stringify(object)); write(join(value.inputs, path), bytes); return { path, sha256: digest(bytes), bytes: bytes.length, mime: 'application/json' }; };
  const native = label => {
    const header = Buffer.alloc(24); Buffer.from('89504e470d0a1a0a', 'hex').copy(header); header.write('IHDR', 12); header.writeUInt32BE(768, 16); header.writeUInt32BE(1024, 20);
    const bytes = Buffer.concat([header, Buffer.from(label)]), path = `${base}/frames/${digest(bytes)}.png`;
    write(join(value.inputs, path), bytes); return { path, sha256: digest(bytes), bytes: bytes.length, mime: 'image/png', width: 768, height: 1024 };
  };
  const originalManifest = json(`${base}/original-manifest.json`, value.manifest);
  const preparation = { completed: true, identity, noPaidCalls: true, noNetwork: true, originalManifest, sourceFingerprint: value.manifest.fingerprint, groups: [] };
  const targetMap = { schemaVersion: 1, fingerprint: value.manifest.fingerprint, targets: [] };
  const proof = { schemaVersion: 1, id, identity, originalManifest, originalProductFingerprint: value.manifest.fingerprint,
    compositionProductFiles: ['src/services/GeminiApi.ts', 'src/services/SpritePostProcess.ts', 'src/services/AnimationProfiles.ts', 'src/services/FrameSequence.ts', 'src/services/AlphaMask.ts', 'processor/src/canvasRuntime.ts'].map(path => ({ path, sha256: 'c'.repeat(64) })),
    walk9Review: { animationName: 'walk', uniqueFrame: 9, approved: true, originalPoseSha256: 'd'.repeat(64), reason: 'Preserve the lifted rear heel and passing step from Rookie; the previous Champion frame substituted a planted guard.' }, changes: [] };
  for (const [animationName, replacements] of Object.entries(CASUAL_REPAIR_TARGETS)) {
    const order = casualRepairPlayback(animationName), count = Math.max(...order);
    const old = value.manifest.sprites.find(sprite => sprite.animationName === animationName && sprite.qualityTier === 'contender');
    const output = { ...old, path: `${base}/outputs/${animationName}.png`, rawPath: `${base}/outputs/${animationName}-raw.png`, derivativeId: id,
      frameCount: order.length, uniqueFrameCount: count, gridCols: order.length <= 4 ? 2 : 4, gridRows: Math.ceil(order.length / (order.length <= 4 ? 2 : 4)) };
    write(join(value.inputs, output.path), readFileSync(join(value.inputs, old.path)));
    write(join(value.inputs, output.rawPath), readFileSync(join(value.inputs, old.rawPath)));
    const group = { animationName, championOriginal: { ...old }, frames: [] };
    const change = { animationName, qualityTier: 'contender', originalEntry: { ...old }, outputEntry: output, uniqueFrameCount: count, playbackFrameOrderOneBased: order, frames: [] };
    for (let uniqueFrame = 1; uniqueFrame <= count; uniqueFrame++) {
      const playbackFrames = order.flatMap((v, i) => v === uniqueFrame ? [i + 1] : []), raw = native(`${animationName}-${uniqueFrame}-raw`), cleaned = native(`${animationName}-${uniqueFrame}-clean`);
      const parent = { id: digest(`${animationName}-${uniqueFrame}`), requestSha256: 'a'.repeat(64), responseSha256: 'b'.repeat(64) };
      const pose = { sha256: 'd'.repeat(64) };
      group.frames.push({ uniqueFrame, playbackFrames, raw, cleaned, pose, render: parent, rawPixelsMatchOriginalPlaybackCells: true });
      const frame = { uniqueFrame, playbackFrames, originalRaw: raw, originalClean: cleaned, outputRaw: raw, outputClean: cleaned };
      if (replacements.includes(uniqueFrame)) {
        targetMap.targets.push({ animationName, tier: 'contender', uniqueFrame, playbackFrames, poseSha256: pose.sha256, requestId: parent.id, requestSha256: parent.requestSha256, responseSha256: parent.responseSha256 });
        frame.outputRaw = native(`${animationName}-${uniqueFrame}-repaired-raw`); frame.outputClean = native(`${animationName}-${uniqueFrame}-repaired-clean`);
        const result = (step, image) => ({ schemaVersion: 1, step, planSha256: 'e'.repeat(64), parent, target: { animationName, qualityTier: 'contender', uniqueFrame, playbackFrames }, image,
          requests: [{ id: 'f'.repeat(64), provider: step === 'render' ? 'gemini' : 'fal', requestSha256: '1'.repeat(64), responseSha256: '2'.repeat(64), status: 'complete' }] });
        frame.replacementReceipt = { successfulRenderRequestId: 'f'.repeat(64), renderResult: result('render', frame.outputRaw), cleanResult: result('clean', frame.outputClean), rawReviewedSha256: frame.outputRaw.sha256, cleanReviewedSha256: frame.outputClean.sha256 };
      }
      change.frames.push(frame);
    }
    preparation.groups.push(group); proof.changes.push(change);
  }
  proof.targetMap = json(`${base}/repair-target-map.json`, targetMap); preparation.targetMap = proof.targetMap;
  proof.preparation = json(`${base}/preparation.json`, preparation);
  const derivative = json(`${base}/provenance.json`, proof); derivative.id = id;
  value.manifest.sprites = value.manifest.sprites.map(entry => proof.changes.find(change => change.animationName === entry.animationName && entry.qualityTier === 'contender')?.outputEntry ?? entry);
  value.manifest.derivatives = [...(value.manifest.derivatives ?? []), derivative];
  write(value.manifestPath, JSON.stringify(value.manifest));
  const rewrite = () => { const bytes = Buffer.from(JSON.stringify(proof)); write(join(value.inputs, derivative.path), bytes); derivative.sha256 = digest(bytes); derivative.bytes = bytes.length; write(value.manifestPath, JSON.stringify(value.manifest)); };
  return { proof, derivative, originalBytes, rewrite };
}

function preparePostprocessFixture(value) {
  const original = value.manifest.sprites.find(sprite => sprite.animationName === 'crouch' && sprite.qualityTier === 'rookie');
  Object.assign(original, { frameCount: 4, gridCols: 2, gridRows: 2, processingVersion: 5 });
  value.manifest.productFiles.push({ path: 'src/services/SpritePostProcess.ts', sha256: '1'.repeat(64) });
}
function addPostprocessDerivative(value) {
  delete value.manifest.providerLedger;
  const id = CASUAL_POSTPROCESS_REPAIR_ID, base = `derivatives/${id}`;
  const json = (path, object) => { const bytes = Buffer.from(JSON.stringify(object)); write(join(value.inputs, path), bytes); return { path, sha256: digest(bytes), bytes: bytes.length, mime: 'application/json' }; };
  const originalManifest = json(`${base}/original-manifest.json`, value.manifest);
  const originalEntry = { ...value.manifest.sprites.find(sprite => sprite.animationName === 'crouch' && sprite.qualityTier === 'rookie') };
  const header = Buffer.alloc(24); Buffer.from('89504e470d0a1a0a', 'hex').copy(header); header.write('IHDR', 12); header.writeUInt32BE(1536, 16); header.writeUInt32BE(2048, 20);
  const bytes = Buffer.concat([header, Buffer.from('same raw, restored detached fist')]);
  const outputEntry = { ...originalEntry, path: `${base}/outputs/crouch-rookie.png`, sha256: digest(bytes), bytes: bytes.length, derivativeId: id };
  write(join(value.inputs, outputEntry.path), bytes);
  const productFiles = ['src/services/SpritePostProcess.ts', 'src/services/AnimationProfiles.ts', 'src/services/AlphaMask.ts', 'src/services/FrameSequence.ts', 'src/services/SpriteGrid.ts', 'processor/src/canvasRuntime.ts'].map(path => ({ path, sha256: '2'.repeat(64) }));
  const codeChange = json(`${base}/postprocess-change.json`, { path: 'src/services/SpritePostProcess.ts', beforeSha256: '1'.repeat(64), afterSha256: '2'.repeat(64), operation: 'preserve-already-cleaned-components-after-alpha-erosion', patch: '@@ cleanup after erosion @@\n-removeDetachedComponents(...);\n' });
  const proof = { schemaVersion: 1, id, identity, originalManifest, originalProductFingerprint: value.manifest.fingerprint,
    originalEntry, outputEntry, operation: 'reprocess-original-raw', providerCalls: 0, productFiles, codeChange, processingVersion: 5,
    arguments: { animationName: 'crouch', expectedFrameCount: 4, expectedGridCols: 2, expectedGridRows: 2, normalizationReference: { baselineRatio: 0.98 } },
    sourceRaw: { path: originalEntry.rawPath, sha256: originalEntry.rawSha256, bytes: originalEntry.rawBytes, mime: originalEntry.rawMime } };
  const derivative = { id, ...json(`${base}/provenance.json`, proof) };
  value.manifest.sprites = value.manifest.sprites.map(sprite => sprite.animationName === 'crouch' && sprite.qualityTier === 'rookie' ? outputEntry : sprite);
  value.manifest.derivatives = [...(value.manifest.derivatives ?? []), derivative];
  const rewrite = () => { Object.assign(derivative, json(derivative.path, proof)); write(value.manifestPath, JSON.stringify(value.manifest)); }; rewrite();
  return { proof, derivative, rewrite };
}

function prepareKoFixture(value) {
  value.manifest.sprites = value.manifest.sprites.filter(sprite => !(sprite.animationName === 'ko' && sprite.qualityTier === 'contender'));
  Object.assign(value.manifest.sprites.find(sprite => sprite.animationName === 'ko'), { frameCount: 8, gridCols: 4, gridRows: 2 });
}
function addKoCompletion(value) {
  delete value.manifest.providerLedger;
  const id = CASUAL_KO_COMPLETION_ID, base = `derivatives/${id}`;
  const json = (path, object) => { const bytes = Buffer.from(JSON.stringify(object)); write(join(value.inputs, path), bytes); return { path, sha256: digest(bytes), bytes: bytes.length, mime: 'application/json' }; };
  const image = label => {
    const header = Buffer.alloc(24); Buffer.from('89504e470d0a1a0a', 'hex').copy(header); header.write('IHDR', 12); header.writeUInt32BE(768, 16); header.writeUInt32BE(1024, 20);
    const bytes = Buffer.concat([header, Buffer.from(label)]), path = `${base}/frames/${digest(bytes)}.png`;
    write(join(value.inputs, path), bytes); return { path, sha256: digest(bytes), bytes: bytes.length, mime: 'image/png', width: 768, height: 1024 };
  };
  const originalManifest = json(`${base}/original-manifest.json`, value.manifest), poses = Array.from({ length: 8 }, (_, i) => image(`pose-${i + 1}`));
  const originalAttempts = [1, 2, 3, 4, 5, 6, 6].map((uniqueFrame, i) => ({ uniqueFrame, attempt: i === 6 ? 2 : 1, poseSha256: poses[uniqueFrame - 1].sha256,
    parent: { id: digest(`old-ko-${i}`), requestSha256: 'a'.repeat(64), responseSha256: 'b'.repeat(64) }, raw: image(`original-ko-${i}`) }));
  const frames = Array.from({ length: 8 }, (_, index) => {
    const number = index + 1, previous = originalAttempts.find(item => item.uniqueFrame === number), raw = [2, 5].includes(number) ? previous.raw : image(`new-ko-${number}`), clean = image(`clean-ko-${number}`);
    const result = (step, entry) => ({ schemaVersion: 1, step, planSha256: 'c'.repeat(64), parent: previous?.parent ?? null,
      target: { animationName: 'ko', qualityTier: 'contender', uniqueFrame: number, playbackFrames: [number] }, image: entry,
      requests: [{ id: step === 'render' && [2, 5].includes(number) ? previous.parent.id : digest(`${number}-${step}`), provider: step === 'render' ? 'gemini' : 'fal', status: 'complete', requestSha256: 'a'.repeat(64), responseSha256: 'b'.repeat(64) }],
      ...(step === 'render' && [2, 5].includes(number) ? { reusedOriginalNative: true, newProviderCalls: 0 } : {}) });
    return { uniqueFrame: number, generationFingerprint: 'e'.repeat(64), generationProductFiles: [{ path: 'src/services/GeminiApi.ts', sha256: 'f'.repeat(64) }], pose: poses[index], raw, clean, rawReviewedSha256: raw.sha256, cleanReviewedSha256: clean.sha256, renderResult: result('render', raw), cleanResult: result('clean', clean) };
  });
  const raw = image('final-raw'), processed = image('final-processed');
  const outputEntry = { ...processed, animationName: 'ko', qualityTier: 'contender', frameWidth: 768, frameHeight: 1024, frameCount: 8, uniqueFrameCount: 8,
    gridCols: 4, gridRows: 2, animationFormat: 'legacy', processingVersion: 5, derivativeId: id, rawPath: `${base}/outputs/ko-raw.png`, rawSha256: raw.sha256, rawBytes: raw.bytes, rawWidth: 3072, rawHeight: 2048, rawMime: raw.mime, path: `${base}/outputs/ko.png` };
  delete outputEntry.width; delete outputEntry.height;
  write(join(value.inputs, outputEntry.path), readFileSync(join(value.inputs, processed.path))); write(join(value.inputs, outputEntry.rawPath), readFileSync(join(value.inputs, raw.path)));
  const proof = { schemaVersion: 1, id, identity, originalManifest, originalProductFingerprint: value.manifest.fingerprint, reusedOriginalFrames: [2, 5], originalAttempts, frames, outputEntry,
    compositionProductFiles: ['src/services/GeminiApi.ts', 'src/services/SpritePostProcess.ts', 'src/services/AnimationProfiles.ts', 'src/services/FrameSequence.ts', 'src/services/AlphaMask.ts', 'processor/src/canvasRuntime.ts'].map(path => ({ path, sha256: 'd'.repeat(64) })),
    composition: { function: 'composeGeminiRefinedSprite', animationName: 'ko', frameCount: 8, maxScale: null, normalizationReference: null, official: false } };
  const derivative = { id, ...json(`${base}/provenance.json`, proof) };
  value.manifest.sprites.push(outputEntry); value.manifest.derivatives = [...(value.manifest.derivatives ?? []), derivative];
  const rewrite = () => { Object.assign(derivative, json(derivative.path, proof)); write(value.manifestPath, JSON.stringify(value.manifest)); }; rewrite();
  return { proof, derivative, rewrite };
}

describe('Casual sealed transport', () => {

  it('retains both original preparation snapshots and rejects changing an earlier original', async () => {
    const value = fixture(); const evidence = addSelectiveDerivative(value), base = `derivatives/${CASUAL_SELECTIVE_REPAIR_ID}`;
    const original = JSON.parse(evidence.originalBytes), earlier = { ...original, fingerprint: '8'.repeat(64), sprites: original.sprites.slice(0, 19) };
    const json = (path, object) => { const bytes = Buffer.from(JSON.stringify(object)); write(join(value.inputs, path), bytes); return { path, sha256: digest(bytes), bytes: bytes.length, mime: 'application/json' }; };
    const preparation = JSON.parse(readFileSync(join(value.inputs, evidence.proof.preparation.path)));
    preparation.priorManifests = [json(`${base}/history/earlier.json`, earlier), json(`${base}/history/later.json`, original)];
    const rewrite = () => { Object.assign(evidence.proof.preparation, json(evidence.proof.preparation.path, preparation)); evidence.rewrite(); }; rewrite();
    const bundle = await packageCasualRoster({ manifestPath: value.manifestPath, outputDirectory: join(value.root, 'bundle') });
    const names = [...(await inspectCasualArchive(bundle.archivePath)).keys()];
    for (const entry of preparation.priorManifests) expect(names).toContain(`${CASUAL_BUNDLE_ROOT}/${entry.path}`);
    earlier.sprites[0].sha256 = '0'.repeat(64); preparation.priorManifests[0] = json(preparation.priorManifests[0].path, earlier); rewrite();
    await expect(packageCasualRoster({ manifestPath: value.manifestPath, outputDirectory: join(value.root, 'lost-history') })).rejects.toThrow(/earlier original/);
  });

  it('retains incomplete KO originals and exact reviewed native2/5 together with the other repair histories', async () => {
    const value = fixture(); preparePostprocessFixture(value); prepareKoFixture(value); addIdleDerivative(value); addSelectiveDerivative(value); addPostprocessDerivative(value); const evidence = addKoCompletion(value);
    const bundle = await packageCasualRoster({ manifestPath: value.manifestPath, outputDirectory: join(value.root, 'bundle') });
    const names = [...(await inspectCasualArchive(bundle.archivePath)).keys()]; expect(names.length).toBe(241); expect(names.length).toBeLessThan(256);
    const extracted = await extractCasualRoster({ archivePath: bundle.archivePath, descriptorPath: bundle.descriptorPath, outputDirectory: join(value.root, 'extracted') });
    expect(JSON.parse(readFileSync(extracted.manifestPath)).derivatives).toHaveLength(4);
    expect(evidence.proof.frames[1].raw.sha256).toBe(evidence.proof.originalAttempts[1].raw.sha256);
    for (const item of evidence.proof.originalAttempts) expect(names).toContain(`${CASUAL_BUNDLE_ROOT}/${item.raw.path}`);
    evidence.proof.frames[1].raw = evidence.proof.frames[0].raw; evidence.rewrite();
    await expect(packageCasualRoster({ manifestPath: value.manifestPath, outputDirectory: join(value.root, 'bad-reuse') })).rejects.toThrow(/strictly equal|reused exactly/);
  });

  it('rejects an incomplete or unreviewed KO completion', async () => {
    const value = fixture(); prepareKoFixture(value); const evidence = addKoCompletion(value);
    evidence.proof.frames.pop(); evidence.rewrite();
    await expect(packageCasualRoster({ manifestPath: value.manifestPath, outputDirectory: join(value.root, 'incomplete') })).rejects.toThrow(/deep-equal/);
    const wrong = fixture(); prepareKoFixture(wrong); const bad = addKoCompletion(wrong); bad.proof.frames[0].cleanReviewedSha256 = '0'.repeat(64); bad.rewrite();
    await expect(packageCasualRoster({ manifestPath: wrong.manifestPath, outputDirectory: join(wrong.root, 'not-reviewed') })).rejects.toThrow(/strictly equal/);
  });

  it('preserves all three independent histories while correcting only Rookie crouch processed bytes', async () => {
    const value = fixture(); preparePostprocessFixture(value); addIdleDerivative(value); addSelectiveDerivative(value); const evidence = addPostprocessDerivative(value);
    const bundle = await packageCasualRoster({ manifestPath: value.manifestPath, outputDirectory: join(value.root, 'bundle') });
    const names = [...(await inspectCasualArchive(bundle.archivePath)).keys()];
    expect(names.length).toBe(210); expect(names.length).toBeLessThan(256);
    const extracted = await extractCasualRoster({ archivePath: bundle.archivePath, descriptorPath: bundle.descriptorPath, outputDirectory: join(value.root, 'extracted') });
    const manifest = JSON.parse(readFileSync(extracted.manifestPath)); expect(manifest.derivatives).toHaveLength(3);
    const after = manifest.sprites.find(sprite => sprite.derivativeId === CASUAL_POSTPROCESS_REPAIR_ID);
    expect(after.rawSha256).toBe(evidence.proof.originalEntry.rawSha256);
    expect(readFileSync(join(dirname(extracted.manifestPath), evidence.proof.originalEntry.path))).toEqual(readFileSync(join(value.inputs, evidence.proof.originalEntry.path)));
  });

  it.each([
    ['changed raw', proof => { proof.outputEntry.rawSha256 = '0'.repeat(64); }, /Asset SHA mismatch/],
    ['extra paid step', proof => { proof.providerCalls = 1; }, /strictly equal/],
    ['changed playback count', proof => { proof.outputEntry.frameCount = 3; }, /frameCount must remain unchanged/],
    ['wrong input proof', proof => { proof.sourceRaw.sha256 = '0'.repeat(64); }, /deep-equal/],
    ['wrong quality', proof => { proof.outputEntry.qualityTier = 'contender'; }, /Missing or duplicate quality/],
  ])('rejects a postprocess repair with %s', async (_name, mutate, error) => {
    const value = fixture(); preparePostprocessFixture(value); const evidence = addPostprocessDerivative(value); mutate(evidence.proof); evidence.rewrite();
    await expect(packageCasualRoster({ manifestPath: value.manifestPath, outputDirectory: join(value.root, 'bundle') })).rejects.toThrow(error);
  });

  it('seals both known derivatives and all native/history evidence below the existing file limit', async () => {
    const value = fixture(); addIdleDerivative(value); const evidence = addSelectiveDerivative(value);
    value.manifest.fingerprint = '9'.repeat(64); write(value.manifestPath, JSON.stringify(value.manifest));
    const bundle = await packageCasualRoster({ manifestPath: value.manifestPath, outputDirectory: join(value.root, 'bundle') });
    const names = [...(await inspectCasualArchive(bundle.archivePath)).keys()];
    expect(names.length).toBeLessThan(256); expect(names.length).toBe(206);
    const extracted = await extractCasualRoster({ archivePath: bundle.archivePath, descriptorPath: bundle.descriptorPath, outputDirectory: join(value.root, 'extracted') });
    const manifest = JSON.parse(readFileSync(extracted.manifestPath));
    expect(manifest.derivatives).toHaveLength(2); expect(manifest.sprites).toHaveLength(34);
    expect(manifest.sprites.filter(s => s.derivativeId === CASUAL_SELECTIVE_REPAIR_ID)).toHaveLength(7);
    expect(readFileSync(join(dirname(extracted.manifestPath), evidence.proof.originalManifest.path))).toEqual(evidence.originalBytes);
    expect(names.some(path => /provider|ledger|debug/.test(path))).toBe(false);
    for (const change of evidence.proof.changes) for (const frame of change.frames) {
      expect(readFileSync(join(dirname(extracted.manifestPath), frame.originalRaw.path))).toEqual(readFileSync(join(value.inputs, frame.originalRaw.path)));
      expect(readFileSync(join(dirname(extracted.manifestPath), frame.outputClean.path))).toEqual(readFileSync(join(value.inputs, frame.outputClean.path)));
    }
  });

  it.each([
    ['unapproved preserved frame', proof => { proof.changes[0].frames[0].outputRaw = proof.changes[0].frames[7].outputRaw; }, /Unchanged native/],
    ['swapped replacement parent', proof => { proof.changes[0].frames[7].replacementReceipt.renderResult.parent = proof.changes[0].frames[8].replacementReceipt.renderResult.parent; }, /exact original/],
    ['incorrect mirrored repeat', proof => { proof.changes[1].frames[1].playbackFrames = [2, 5]; }, /deep-equal/],
    ['unreviewed output', proof => { proof.changes[0].frames[7].replacementReceipt.rawReviewedSha256 = '0'.repeat(64); }, /strictly equal/],
    ['missing defect receipt', proof => { delete proof.changes[0].frames[8].replacementReceipt; }, /needs a replacement/],
    ['wrong original fingerprint', proof => { proof.originalProductFingerprint = '0'.repeat(64); }, /fingerprint differs/],
    ['wrong native geometry', proof => { proof.changes[0].frames[7].outputRaw.width = 10; }, /strictly equal/],
  ])('rejects selective proof %s even if its outer hash is updated', async (_name, mutate, error) => {
    const value = fixture(); addIdleDerivative(value); const evidence = addSelectiveDerivative(value); mutate(evidence.proof); evidence.rewrite();
    await expect(packageCasualRoster({ manifestPath: value.manifestPath, outputDirectory: join(value.root, 'bundle') })).rejects.toThrow(error);
  });

  it('retains the exact unknown pilot parent and explicitly successful recovery child without packaging account traces', async () => {
    const value = fixture(); addIdleDerivative(value); const evidence = addSelectiveDerivative(value);
    const frame = evidence.proof.changes.find(change => change.animationName === 'low_kick').frames[3];
    const parentId = '4ece0c30ea84fb974500282ddcead5996d92d24f7d3766a001253cb1a48e3dbc', childId = '87d6892525d2587f511810aa0cdba61e93ceb9d5d1847f4da0c3db852bc9626c';
    const requestSha256 = '5d4922ce5dec504ae7076febf0cfd88a786eb242cbc8386680010ab1bd29c3df';
    frame.replacementReceipt.renderResult.requests = [{ id: parentId, provider: 'gemini', requestSha256, status: 'unknown' }, { id: childId, provider: 'gemini', requestSha256, responseSha256: '3'.repeat(64), status: 'complete' }];
    frame.replacementReceipt.successfulRenderRequestId = childId;
    frame.replacementReceipt.reconciliation = { id: 'casual-pilot-unknown-recovery-v1', parentId, childId, requestSha256, parentOutcome: 'unknown', maximumChildrenPerParent: 1, exactBodyReplay: true, sourceSha256: '4'.repeat(64) }; evidence.rewrite();
    const bundle = await packageCasualRoster({ manifestPath: value.manifestPath, outputDirectory: join(value.root, 'bundle') });
    expect([...(await inspectCasualArchive(bundle.archivePath)).keys()].some(path => /wallet|ledger/.test(path))).toBe(false);
    frame.replacementReceipt.successfulRenderRequestId = parentId; evidence.rewrite();
    await expect(packageCasualRoster({ manifestPath: value.manifestPath, outputDirectory: join(value.root, 'bad-parent') })).rejects.toThrow(/successful render/);
  });

  it('rejects native tampering, unrelated Rookie replacement, duplicate and unknown proofs', async () => {
    const value = fixture(); const evidence = addSelectiveDerivative(value);
    write(join(value.inputs, evidence.proof.changes[0].frames[0].originalRaw.path), 'corrupt');
    await expect(packageCasualRoster({ manifestPath: value.manifestPath, outputDirectory: join(value.root, 'bundle') })).rejects.toThrow(/mismatch/);
    const rookie = fixture(); addSelectiveDerivative(rookie); rookie.manifest.sprites.find(s => s.qualityTier === 'rookie').processingVersion += 1; write(rookie.manifestPath, JSON.stringify(rookie.manifest));
    await expect(packageCasualRoster({ manifestPath: rookie.manifestPath, outputDirectory: join(rookie.root, 'bundle') })).rejects.toThrow(/unrelated prior sprite/);
    expect(() => sealedCasualManifest({ ...rookie.manifest, derivatives: [rookie.manifest.derivatives[0], rookie.manifest.derivatives[0]] })).toThrow(/Duplicate/);
    expect(() => sealedCasualManifest({ ...rookie.manifest, derivatives: [{ id: 'unreviewed' }] })).toThrow(/Unknown/);
  });

  it('binds an idle proof to its original fingerprint after the remaining generation contract advances', async () => {
    const value = fixture(); const evidence = addIdleDerivative(value);
    value.manifest.fingerprint = 'd'.repeat(64);
    write(value.manifestPath, JSON.stringify(value.manifest));
    const bundle = await packageCasualRoster({ manifestPath: value.manifestPath, outputDirectory: join(value.root, 'bundle') });
    const extracted = await extractCasualRoster({ archivePath: bundle.archivePath, descriptorPath: bundle.descriptorPath, outputDirectory: join(value.root, 'extracted') });
    expect(JSON.parse(readFileSync(extracted.manifestPath)).fingerprint).toBe('d'.repeat(64));
    expect(JSON.parse(readFileSync(join(dirname(extracted.manifestPath), evidence.derivative.path))).productFingerprint).toBe('a'.repeat(64));
    evidence.proof.productFingerprint = 'e'.repeat(64);
    const bytes = Buffer.from(JSON.stringify(evidence.proof));
    write(join(value.inputs, evidence.derivative.path), bytes);
    value.manifest.derivatives[0].sha256 = digest(bytes); value.manifest.derivatives[0].bytes = bytes.length;
    write(value.manifestPath, JSON.stringify(value.manifest));
    await expect(packageCasualRoster({ manifestPath: value.manifestPath, outputDirectory: join(value.root, 'wrong-proof') })).rejects.toThrow(/fingerprint differs from preserved original/);
  });

  it('preserves the paired idle proof, original manifest and both original sheets, and rejects tampering', async () => {
    const value = fixture(); const evidence = addIdleDerivative(value);
    const bundle = await packageCasualRoster({ manifestPath: value.manifestPath, outputDirectory: join(value.root, 'bundle') });
    const extracted = await extractCasualRoster({ archivePath: bundle.archivePath, descriptorPath: bundle.descriptorPath, outputDirectory: join(value.root, 'extracted') });
    const root = dirname(extracted.manifestPath), manifest = JSON.parse(readFileSync(extracted.manifestPath));
    expect(manifest.derivatives).toEqual([evidence.derivative]);
    expect(manifest.sprites.filter(sprite => sprite.derivativeId).map(sprite => sprite.uniqueFrameCount)).toEqual([7, 7]);
    expect(readFileSync(join(root, evidence.proof.originalManifest.path))).toEqual(evidence.originalBytes);
    expect(readFileSync(join(root, evidence.derivative.path))).toEqual(evidence.proofBytes);
    for (const pair of evidence.proof.pairs) {
      expect(readFileSync(join(root, pair.originalEntry.path))).toEqual(readFileSync(join(value.inputs, pair.originalEntry.path)));
      expect(readFileSync(join(root, pair.originalEntry.rawPath))).toEqual(readFileSync(join(value.inputs, pair.originalEntry.rawPath)));
    }
    const archiveNames = [...(await inspectCasualArchive(bundle.archivePath)).keys()];
    expect(archiveNames.some(path => /provider|ledger|debug/.test(path))).toBe(false);
    write(join(value.inputs, evidence.proof.pairs[0].originalEntry.rawPath), Buffer.from('tampered-original'));
    await expect(packageCasualRoster({ manifestPath: value.manifestPath, outputDirectory: join(value.root, 'tampered') })).rejects.toThrow(/mismatch/);
    const wrongOrder = fixture(); const wrongEvidence = addIdleDerivative(wrongOrder);
    wrongEvidence.proof.frameOrderOneBased[7] = 1;
    const bytes = Buffer.from(JSON.stringify(wrongEvidence.proof));
    write(join(wrongOrder.inputs, wrongEvidence.derivative.path), bytes);
    wrongOrder.manifest.derivatives[0].sha256 = digest(bytes); wrongOrder.manifest.derivatives[0].bytes = bytes.length;
    write(wrongOrder.manifestPath, JSON.stringify(wrongOrder.manifest));
    await expect(packageCasualRoster({ manifestPath: wrongOrder.manifestPath, outputDirectory: join(wrongOrder.root, 'bad-order') })).rejects.toThrow(/frame order/);
  });

  it('preserves both quality sets and references, excludes traces, packages deterministically and extracts the reviewed bytes', async () => {
    const value = fixture();
    const first = await packageCasualRoster({ manifestPath: value.manifestPath, outputDirectory: join(value.root, 'first') });
    const second = await packageCasualRoster({ manifestPath: value.manifestPath, outputDirectory: join(value.root, 'second') });
    expect(second.bundle.archiveSha256).toBe(first.bundle.archiveSha256);
    const entries = await inspectCasualArchive(first.archivePath);
    expect([...entries.keys()].some(path => /ledger|credentials|debug/.test(path))).toBe(false);
    expect(entries.has(`${CASUAL_BUNDLE_ROOT}/inputs/casual-approved-marketing-composite.webp`)).toBe(true);
    const extracted = await extractCasualRoster({ archivePath: first.archivePath, descriptorPath: first.descriptorPath, outputDirectory: join(value.root, 'extracted'), assetName: first.bundle.assetName, archiveSha256: first.bundle.archiveSha256 });
    expect(extracted.manifestSha256).toBe(first.bundle.manifestSha256);
    const manifest = JSON.parse(readFileSync(extracted.manifestPath));
    expect(manifest.sprites).toHaveLength(34);
    expect(manifest.sprites.every(sprite => !('debugPath' in sprite))).toBe(true);
    expect(manifest.providerLedger).toBeUndefined();
    expect(manifest.sources.find(item => item.kind === 'original').sha256).toBe(identity.sourceSha256);
    expect(readFileSync(value.manifestPath, 'utf8')).toBe(JSON.stringify(value.manifest));
  });

  it('refuses a partial generation, changed asset, traversal path and symlink before packaging', async () => {
    expect(() => sealedCasualManifest({ ...fixture().manifest, sprites: [] })).toThrow(/complete quality/);
    const duplicate = fixture(); duplicate.manifest.sprites[1] = duplicate.manifest.sprites[0];
    expect(() => sealedCasualManifest(duplicate.manifest)).toThrow(/duplicate quality/);
    const changed = fixture(); write(join(changed.inputs, changed.manifest.sources[1].path), 'changed');
    await expect(packageCasualRoster({ manifestPath: changed.manifestPath, outputDirectory: join(changed.root, 'output') })).rejects.toThrow(/size mismatch|SHA mismatch/);
    const traversal = fixture(); traversal.manifest.sources[1].path = '../outside.png'; write(traversal.manifestPath, JSON.stringify(traversal.manifest));
    await expect(packageCasualRoster({ manifestPath: traversal.manifestPath, outputDirectory: join(traversal.root, 'output') })).rejects.toThrow(/Unsafe bundle path/);
    const symlink = fixture(); const target = join(symlink.inputs, symlink.manifest.sources[1].path);
    rmSync(target); symlinkSync(join(symlink.inputs, symlink.manifest.sources[2].path), target);
    await expect(packageCasualRoster({ manifestPath: symlink.manifestPath, outputDirectory: join(symlink.root, 'output') })).rejects.toThrow(/symlink/);
  });

  it('will not include credentials in otherwise allowed metadata or overwrite an existing package', async () => {
    const value = fixture();
    write(join(value.inputs, 'inputs/source-provenance.json'), JSON.stringify({ apiKey: 'private' }));
    await expect(packageCasualRoster({ manifestPath: value.manifestPath, outputDirectory: join(value.root, 'output') })).rejects.toThrow(/Credential/);
    const existing = fixture(); mkdirSync(join(existing.root, 'output'));
    await expect(packageCasualRoster({ manifestPath: existing.manifestPath, outputDirectory: join(existing.root, 'output') })).rejects.toThrow(/must not exist/);
  });

  it('requires the dispatch asset, archive hash and contained manifest hash to match the committed descriptor', async () => {
    const value = fixture(); const bundle = await packageCasualRoster({ manifestPath: value.manifestPath, outputDirectory: join(value.root, 'bundle') });
    const descriptor = JSON.parse(readFileSync(bundle.descriptorPath));
    expect(() => validateCasualDescriptor(descriptor, { assetName: 'other.tar.gz' })).toThrow(/committed review/);
    expect(() => validateCasualDescriptor(descriptor, { archiveSha256: '0'.repeat(64) })).toThrow(/committed review/);
    descriptor.bundle.manifestSha256 = '0'.repeat(64); write(bundle.descriptorPath, JSON.stringify(descriptor));
    await expect(extractCasualRoster({ archivePath: bundle.archivePath, descriptorPath: bundle.descriptorPath, outputDirectory: join(value.root, 'extracted') })).rejects.toThrow(/manifest differs from committed review/);
  });

  it.each([
    ['traversal', [tarEntry(`${CASUAL_BUNDLE_ROOT}/../escape.png`)], /Unsafe bundle path/],
    ['absolute path', [tarEntry('/escape.png')], /Unsafe bundle path/],
    ['outside root', [tarEntry('another-root/file.png')], /fixed root/],
    ['symlink', [tarEntry(`${CASUAL_BUNDLE_ROOT}/link.png`, { type: '2' })], /Links/],
    ['hardlink', [tarEntry(`${CASUAL_BUNDLE_ROOT}/link.png`, { type: '1' })], /Links/],
    ['PAX header', [tarEntry(`${CASUAL_BUNDLE_ROOT}/pax`, { type: 'x' })], /Links/],
    ['device', [tarEntry(`${CASUAL_BUNDLE_ROOT}/device`, { type: '3' })], /Links/],
    ['bad checksum', [tarEntry(`${CASUAL_BUNDLE_ROOT}/file.png`, { checksumError: true })], /checksum/],
    ['duplicate', [tarEntry(`${CASUAL_BUNDLE_ROOT}/same.png`), tarEntry(`${CASUAL_BUNDLE_ROOT}/same.png`)], /Duplicate/],
    ['provider trace', [tarEntry(`${CASUAL_BUNDLE_ROOT}/provider-ledger.json`)], /Provider traces/],
  ])('rejects unsafe tar %s before extraction', async (_name, entries, error) => {
    await expect(inspectCasualArchive(archive(entries))).rejects.toThrow(error);
  });

  it('rejects truncated tar and concatenated content hidden after end markers', async () => {
    await expect(inspectCasualArchive(archive([tarEntry(`${CASUAL_BUNDLE_ROOT}/file.png`)], Buffer.alloc(0)))).rejects.toThrow(/Truncated/);
    await expect(inspectCasualArchive(archive([tarEntry(`${CASUAL_BUNDLE_ROOT}/file.png`), Buffer.alloc(1024), tarEntry(`${CASUAL_BUNDLE_ROOT}/later.png`) ]))).rejects.toThrow(/after tar end/);
  });

  it('keeps production import bound to main, the reviewed descriptor, draft release, dry run and shared mutation lock', () => {
    const workflow = readFileSync(new URL('../.github/workflows/import-casual-roster-production.yml', import.meta.url), 'utf8');
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
    expect(workflow).toContain('environment: production');
    expect(workflow).toContain('group: production-worker-mutations');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('contents: read');
    expect(workflow).toContain('GH_TOKEN: ${{ github.token }}');
    expect(workflow).toContain('--verify-descriptor=arcade/casual-generated-v1.json');
    expect(workflow).toContain('.isDraft == true');
    expect(workflow).toContain('gh release download casual-generation-v1');
    expect(workflow).toContain('--expected-deployed-sha="$GITHUB_SHA"');
    expect(workflow).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');
    expect(workflow).toContain('ASF_CLOUDFLARE_ZONE_ID: ${{ vars.ASF_CLOUDFLARE_ZONE_ID }}');
    expect(workflow).not.toMatch(/FAL_API_KEY|GEMINI_API_KEY|wrangler/);
    expect(workflow.indexOf('node scripts/production-deploy-guard.mjs')).toBeLessThan(workflow.indexOf('gh release download'));
    expect(workflow.indexOf('casual-roster-plan.json')).toBeLessThan(workflow.indexOf('--execute --confirm='));
  });
});

function configureGridOriginals(value) {
  delete value.manifest.providerLedger;
  value.manifest.sprites = value.manifest.sprites.filter(sprite => !(sprite.animationName === 'aura_floor_worm' && sprite.qualityTier === 'contender'));
  for (const entry of value.manifest.sprites.filter(sprite => ['aura_unbothered', 'aura_floor_worm'].includes(sprite.animationName))) {
    entry.frameCount = 6; entry.gridCols = 4; entry.gridRows = 2;
    if (entry.qualityTier === 'rookie') { entry.rawWidth = 1152; entry.rawHeight = 928; }
  }
  write(value.manifestPath, JSON.stringify(value.manifest));
}
function addGridDerivative(value) {
  const id = CASUAL_AURA_GRID_RESCUE_ID, base = `derivatives/${id}`;
  const media = (label, width = 768, height = 1024, folder = 'frames') => {
    const header = Buffer.alloc(24); Buffer.from('89504e470d0a1a0a', 'hex').copy(header); header.write('IHDR', 12); header.writeUInt32BE(width, 16); header.writeUInt32BE(height, 20);
    const bytes = Buffer.concat([header, Buffer.from(label)]), path = `${base}/${folder}/${digest(bytes)}.png`; write(join(value.inputs, path), bytes);
    return { path, sha256: digest(bytes), bytes: bytes.length, mime: 'image/png', width, height };
  };
  const json = (path, object) => { const bytes = Buffer.from(JSON.stringify(object)); write(join(value.inputs, path), bytes); return { path, sha256: digest(bytes), bytes: bytes.length, mime: 'application/json' }; };
  const proof = { schemaVersion: 1, id, identity, originalManifest: json(`${base}/original-manifest.json`, value.manifest), originalProductFingerprint: value.manifest.fingerprint,
    compositionProductFiles: ['src/services/GeminiApi.ts', 'src/services/SpritePostProcess.ts', 'src/services/AnimationProfiles.ts', 'src/services/FrameSequence.ts', 'src/services/AlphaMask.ts', 'src/services/SpriteGrid.ts', 'processor/src/canvasRuntime.ts'].map(path => ({ path, sha256: digest(path) })), groups: [] };
  for (const animationName of ['aura_unbothered', 'aura_floor_worm']) {
    const isWorm = animationName === 'aura_floor_worm', order = isWorm ? [1, 2, 3, 5, 6, 7] : [1, 2, 4, 5, 6, 7], reuse = isWorm ? [] : [1, 3, 4, 5, 6];
    const originalRookie = structuredClone(value.manifest.sprites.find(sprite => sprite.animationName === animationName && sprite.qualityTier === 'rookie'));
    const originalChampion = structuredClone(value.manifest.sprites.find(sprite => sprite.animationName === animationName && sprite.qualityTier === 'contender') ?? null);
    const group = { animationName, originalRookie, originalChampion, selectedOriginalFrames: order, reusedOriginalFrames: reuse, sourceFrames: [], originalAttempts: [], frames: [],
      rookieProcessing: { function: 'cleanSpriteSheet', expectedFrameCount: 6, expectedGridCols: 4, expectedGridRows: 2, animationName, maxScale: null, normalizationReference: null, paidCalls: 0 },
      championComposition: { function: 'composeGeminiRefinedSprite', animationName, frameCount: 6, maxScale: null, normalizationReference: null, official: false } };
    for (let i = 0; i < 7; i++) {
      const rect = isWorm ? i < 3 ? { x: i * 384, y: 0, width: 384, height: 310 } : i < 5 ? { x: (i - 3) * 576, y: 310, width: 576, height: 310 } : { x: (i - 5) * 576, y: 620, width: 576, height: 308 } : i < 4 ? { x: i * 288, y: 0, width: 288, height: 464 } : { x: (i - 4) * 384, y: 464, width: 384, height: 464 };
      const scale = isWorm && i < 3 ? 1.5 : 1, drawWidth = rect.width * scale, drawHeight = rect.height * scale;
      group.sourceFrames.push({ sourceFrame: i + 1, rect, native: media(`${animationName}-native-crop-${i}`, rect.width, rect.height), rgbaSha256: digest(`${animationName}-crop-${i}`), layoutNormalization: { scale, drawWidth, drawHeight, paddingLeft: Math.round(((isWorm ? 576 : 384) - drawWidth) / 2), paddingTop: Math.round(((isWorm ? 465 : 464) - drawHeight) / 2) } });
    }
    for (const tier of ['rookie', 'contender']) {
      const rawWidth = tier === 'rookie' ? isWorm ? 2304 : 1536 : 3584, rawHeight = tier === 'rookie' ? isWorm ? 930 : 928 : 2400;
      const raw = media(`${animationName}-${tier}-raw`, rawWidth, rawHeight, 'outputs'), processed = media(`${animationName}-${tier}-processed`, 3072, 2048, 'outputs');
      const output = { ...originalRookie, ...processed, animationName, qualityTier: tier, rawPath: raw.path, rawSha256: raw.sha256, rawBytes: raw.bytes, rawWidth, rawHeight, rawMime: 'image/png', derivativeId: id, uniqueFrameCount: 6 };
      delete output.width; delete output.height; group[tier === 'rookie' ? 'rookieOutputEntry' : 'championOutputEntry'] = output;
      value.manifest.sprites = value.manifest.sprites.filter(sprite => !(sprite.animationName === animationName && sprite.qualityTier === tier)); value.manifest.sprites.push(output);
    }
    for (let n = 1; n <= 6; n++) {
      const pose = media(`${animationName}-pose-${n}`), attempts = isWorm && n >= 4 ? 2 : 1;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const label = `${animationName}-${n}-${attempt}`, record = { playbackFrame: n, poseSha256: pose.sha256, parent: { id: digest(label), requestSha256: digest(label + 'request'), responseSha256: digest(label + 'response') }, raw: media(label + '-old-raw') };
        if (reuse.includes(n)) { record.clean = media(label + '-old-clean'); record.cleanupReceipt = { id: digest(label + 'fal'), requestSha256: digest(label + 'fal-request'), responseSha256: digest(label + 'fal-response'), resultSha256: digest(label + 'fal-result') }; }
        group.originalAttempts.push(record);
      }
      const old = group.originalAttempts.filter(item => item.playbackFrame === n).at(-1), reused = reuse.includes(n), raw = reused ? old.raw : media(`${animationName}-${n}-new-raw`), clean = reused ? old.clean : media(`${animationName}-${n}-new-clean`);
      const frame = { playbackFrame: n, sourceFrame: order[n - 1], pose, raw, clean, rawReviewedSha256: raw.sha256, cleanReviewedSha256: clean.sha256, disposition: reused ? 'reuse-approved-native' : 'replace-broken-grid-pose' };
      if (reused) frame.cleanupReceipt = old.cleanupReceipt;
      else {
        frame.generationFingerprint = value.manifest.fingerprint; frame.generationProductFiles = proof.compositionProductFiles;
        for (const [step, image] of [['render', raw], ['clean', clean]]) frame[`${step}Result`] = { schemaVersion: 1, step, planSha256: digest(`${animationName}-${n}-plan`), target: { animationName, qualityTier: 'contender', uniqueFrame: n, playbackFrames: [n] }, parent: old.parent, image, requests: [{ id: digest(`${animationName}-${n}-${step}`), provider: step === 'render' ? 'gemini' : 'fal', status: 'complete', requestSha256: digest(`${animationName}-${n}-${step}-request`), responseSha256: digest(`${animationName}-${n}-${step}-response`) }] };
      }
      group.frames.push(frame);
    }
    proof.groups.push(group);
  }
  const derivative = { id, ...json(`${base}/provenance.json`, proof) }; value.manifest.derivatives ??= []; value.manifest.derivatives.push(derivative); write(value.manifestPath, JSON.stringify(value.manifest));
  return { proof, derivative, rewrite() { Object.assign(derivative, json(derivative.path, proof)); write(value.manifestPath, JSON.stringify(value.manifest)); } };
}

describe('paired irregular Aura grid rescue', () => {
  it('preserves the full measured histories beyond 256 files without widening byte limits', async () => {
    const value = fixture(); configureGridOriginals(value); preparePostprocessFixture(value); prepareKoFixture(value); addIdleDerivative(value); addSelectiveDerivative(value); addPostprocessDerivative(value); addKoCompletion(value); const grid = addGridDerivative(value);
    const result = await packageCasualRoster({ manifestPath: value.manifestPath, outputDirectory: join(value.root, 'sealed') });
    const names = [...(await inspectCasualArchive(result.archivePath)).keys()]; expect(names.length).toBe(309); expect(names.length).toBeLessThanOrEqual(384);
    expect(names).toContain(`${CASUAL_BUNDLE_ROOT}/${grid.proof.originalManifest.path}`);
  });
  it.each(['selection', 'scale', 'reused-native', 'parent', 'native-bytes'])('rejects %s tampering in the grid proof', async kind => {
    const value = fixture(); configureGridOriginals(value); const grid = addGridDerivative(value), un = grid.proof.groups[0], worm = grid.proof.groups[1];
    if (kind === 'selection') worm.selectedOriginalFrames = [1, 2, 3, 4, 5, 6];
    if (kind === 'scale') worm.sourceFrames[0].layoutNormalization.scale = 1;
    if (kind === 'reused-native') un.frames[0].raw = un.frames[1].raw;
    if (kind === 'parent') worm.frames[0].renderResult.parent = worm.originalAttempts[1].parent;
    if (kind === 'native-bytes') write(join(value.inputs, un.originalAttempts[0].raw.path), Buffer.from('changed'));
    grid.rewrite();
    await expect(packageCasualRoster({ manifestPath: value.manifestPath, outputDirectory: join(value.root, 'sealed') })).rejects.toThrow();
  });
});

it('refuses an archive with 385 files', async () => {
  const entries = Array.from({ length: 385 }, (_, i) => tarEntry(`${CASUAL_BUNDLE_ROOT}/asset-${i}.png`));
  await expect(inspectCasualArchive(archive(entries))).rejects.toThrow(/file count or size limit/);
});
