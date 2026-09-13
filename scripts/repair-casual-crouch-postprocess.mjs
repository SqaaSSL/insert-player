// Offline RAW reprocessing only. Preparation writes immutable derivative evidence;
// only --apply changes the manifest, under the normal artifact execution lock.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquireLock, atomicJson, immutable, sha256 } from './casual-generation-transport.mjs';
import { CASUAL_POSTPROCESS_REPAIR_ID as ID, collectCasualPostprocessRepairFiles } from './casual-postprocess-repair-provenance.mjs';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIRECTORY = join(ROOT, '.artifacts/casual-generation-v1');
const BASE = `derivatives/${ID}`;
const RAW_SHA = '9704f735302036c38a764634dfec02b13e24d8b2b9eaa6cdc9e078086f53dc13';
const BEFORE_SHA = '411f0a4aab1144a5c3400f1beda887cacebd64c0388ae59810aa558567a11aa2';
const AFTER_SHA = '68d5d83e44fe5e09fe3ddf1456e3f9606a5e86be99f1939665c18530e644ce57';
const BEFORE_CODE = '24127e90ab0d48c39bd459e0298c41d4141c38484f3c145c7f67927bfa08dea1';
const AFTER_CODE = '1947416e021b18ef074f1f9f88d512d83e27747bd30a18da66cf5c6421308d9e';
const fields = ['animationName', 'qualityTier', 'animationFormat', 'frameWidth', 'frameHeight', 'frameCount', 'gridCols', 'gridRows', 'rawPath', 'rawSha256', 'rawBytes', 'rawWidth', 'rawHeight', 'rawMime', 'uniqueFrameCount', 'processingVersion'];
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const descriptor = (path, bytes, mime = 'application/json') => ({ path, sha256: sha256(bytes), bytes: bytes.length, mime });

export function replaceOnlyCrouchPostprocess(manifest, originalEntry, outputEntry, derivative) {
  assert.equal(originalEntry.animationName, 'crouch'); assert.equal(originalEntry.qualityTier, 'rookie');
  assert.equal(originalEntry.derivativeId, undefined); assert.equal(outputEntry.derivativeId, ID);
  for (const field of fields) assert.equal(outputEntry[field], originalEntry[field], `Original ${field} must remain unchanged`);
  assert.equal(outputEntry.processingVersion, 5); assert.equal(outputEntry.frameCount, 4);
  assert.notEqual(outputEntry.sha256, originalEntry.sha256);
  assert.ok(outputEntry.path.startsWith(`${BASE}/outputs/`));
  const matches = manifest.sprites.filter(sprite => sprite.animationName === 'crouch' && sprite.qualityTier === 'rookie');
  assert.equal(matches.length, 1); assert.deepEqual(matches[0], originalEntry, 'The reviewed source sprite changed');
  assert.ok(!(manifest.derivatives ?? []).some(item => item.id === ID));
  const next = structuredClone(manifest);
  next.sprites = next.sprites.map(sprite => sprite.animationName === 'crouch' && sprite.qualityTier === 'rookie' ? structuredClone(outputEntry) : sprite);
  next.derivatives = [...(next.derivatives ?? []), derivative];
  return next;
}

function checked(directory, item) {
  const path = resolve(directory, item.path); assert.ok(path.startsWith(`${directory}/`));
  const bytes = readFileSync(path); assert.equal(sha256(bytes), item.sha256); assert.equal(bytes.length, item.bytes); return bytes;
}
export async function repairCasualCrouchPostprocess({ apply = false, expectedManifestSha } = {}) {
  const directory = DIRECTORY, manifestPath = join(directory, 'manifest.json');
  const release = apply ? acquireLock(directory) : () => {};
  const originalFetch = globalThis.fetch;
  try {
    if (!apply) assert.ok(!existsSync(join(directory, 'execution.lock')), 'Wait for generation to stop before preparing the derivative');
    globalThis.fetch = async () => { throw new Error('Offline postprocess repair must never use the network'); };
    const manifestBytes = readFileSync(manifestPath), manifest = JSON.parse(manifestBytes);
    assert.equal(manifest.identity.sourceSha256, 'e29f551726c5e80941bcf63618401bbf00429d56df52f6cbb20d8da57435c210');
    const existing = (manifest.derivatives ?? []).find(item => item.id === ID);
    if (existing) {
      const proof = JSON.parse(checked(directory, existing));
      const current = manifest.sprites.find(sprite => sprite.animationName === 'crouch' && sprite.qualityTier === 'rookie');
      assert.deepEqual(current, proof.outputEntry); checked(directory, current); checked(directory, proof.sourceRaw);
      return { status: 'already-applied', provenance: existing, providerCalls: 0 };
    }
    const ledgerBefore = sha256(readFileSync(join(directory, 'provider-ledger.json')));
    const originalBytes = readFileSync(join(directory, 'archive/casual-pose-erosion-v1/manifest.json'));
    const original = JSON.parse(originalBytes); assert.equal(original.fingerprint, 'a2eef4bb310dd7a44c3e3226022a6e8dc0659bf34fd2313e142d705dfea7d6be');
    assert.deepEqual(original.identity, manifest.identity);
    const originalEntry = original.sprites.find(sprite => sprite.animationName === 'crouch' && sprite.qualityTier === 'rookie');
    assert.equal(originalEntry.sha256, BEFORE_SHA); assert.equal(originalEntry.rawSha256, RAW_SHA);
    assert.deepEqual(manifest.sprites.find(sprite => sprite.animationName === 'crouch' && sprite.qualityTier === 'rookie'), originalEntry);
    checked(directory, originalEntry);
    const sourceRaw = { path: originalEntry.rawPath, sha256: originalEntry.rawSha256, bytes: originalEntry.rawBytes, mime: originalEntry.rawMime };
    const raw = checked(directory, sourceRaw);
    const sourcePath = join(ROOT, 'src/services/SpritePostProcess.ts'); assert.equal(sha256(readFileSync(sourcePath)), AFTER_CODE);
    const beforePath = join(directory, 'review/thin-wrist-candidate-v1/SpritePostProcess.before.ts.source'); assert.equal(sha256(readFileSync(beforePath)), BEFORE_CODE);
    let patch;
    try { patch = execFileSync('diff', ['-u', beforePath, sourcePath], { encoding: 'utf8' }); }
    catch (error) { assert.equal(error.status, 1); patch = error.stdout; }
    assert.ok(patch?.length && patch.length < 16000);
    const { installCanvasRuntime } = await import('../processor/src/canvasRuntime.ts'); installCanvasRuntime();
    const { cleanSpriteSheet } = await import('../src/services/SpritePostProcess.ts');
    const result = await cleanSpriteSheet(raw.toString('base64'), 4, 2, 2, 'crouch', undefined, { baselineRatio: 0.98 });
    assert.equal(result.frameCount, 4); assert.equal(result.gridCols, 2); assert.equal(result.gridRows, 2);
    const processed = Buffer.from(result.base64, 'base64'); assert.equal(sha256(processed), AFTER_SHA, 'Exact reviewed hand-restored output required');
    assert.equal(processed.readUInt32BE(16), 1536); assert.equal(processed.readUInt32BE(20), 2048);
    const outputEntry = { ...originalEntry, ...descriptor(`${BASE}/outputs/crouch-rookie-${AFTER_SHA}.png`, processed, 'image/png'), derivativeId: ID };
    const originalManifest = descriptor(`${BASE}/original-manifest.json`, originalBytes);
    const code = { path: 'src/services/SpritePostProcess.ts', beforeSha256: BEFORE_CODE, afterSha256: AFTER_CODE,
      operation: 'preserve-already-cleaned-components-after-alpha-erosion', patch };
    const codeBytes = jsonBytes(code), codeChange = descriptor(`${BASE}/postprocess-change.json`, codeBytes);
    const productFiles = ['src/services/SpritePostProcess.ts', 'src/services/AnimationProfiles.ts', 'src/services/AlphaMask.ts', 'src/services/FrameSequence.ts', 'src/services/SpriteGrid.ts', 'processor/src/canvasRuntime.ts']
      .map(path => ({ path, sha256: sha256(readFileSync(join(ROOT, path))) }));
    for (const file of productFiles) assert.equal(manifest.productFiles.find(item => item.path === file.path)?.sha256, file.sha256, 'Migrate the reviewed product first');
    const proof = { schemaVersion: 1, id: ID, identity: manifest.identity, originalProductFingerprint: original.fingerprint, originalManifest,
      originalEntry, outputEntry, operation: 'reprocess-original-raw', providerCalls: 0, sourceRaw, processingVersion: 5,
      arguments: { animationName: 'crouch', expectedFrameCount: 4, expectedGridCols: 2, expectedGridRows: 2, normalizationReference: { baselineRatio: 0.98 } }, productFiles, codeChange };
    const proofBytes = jsonBytes(proof), derivative = { id: ID, ...descriptor(`${BASE}/provenance.json`, proofBytes) };
    const next = replaceOnlyCrouchPostprocess(manifest, originalEntry, outputEntry, derivative);
    const writes = new Map([[originalManifest.path, originalBytes], [codeChange.path, codeBytes], [outputEntry.path, processed], [derivative.path, proofBytes]]);
    const pick = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
    const packageSource = readFileSync(join(ROOT, 'scripts/package-casual-roster.mjs'), 'utf8');
    const spriteFields = [...packageSource.match(/const spriteFields = \[([^\]]+)\];/)[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
    assert.ok(spriteFields.includes('rawSha256') && spriteFields.includes('derivativeId'));
    const readPlanned = item => {
      const bytes = writes.get(item.path) ?? checked(directory, item); assert.equal(sha256(bytes), item.sha256); assert.equal(bytes.length, item.bytes); return bytes;
    };
    collectCasualPostprocessRepairFiles({ manifest: { ...next, sprites: next.sprites.map(sprite => pick(sprite, spriteFields)) }, derivative,
      checkedJson: item => JSON.parse(readPlanned(item)), includeMedia: readPlanned, spriteFields, pick });
    assert.equal(sha256(readFileSync(manifestPath)), sha256(manifestBytes), 'Manifest changed during preparation');
    assert.equal(sha256(readFileSync(join(directory, 'provider-ledger.json'))), ledgerBefore, 'Provider state changed during preparation');
    if (apply) assert.equal(expectedManifestSha, sha256(manifestBytes), 'Apply requires the exact reviewed current manifest SHA');
    for (const [path, bytes] of writes) immutable(join(directory, path), bytes);
    if (apply) {
      immutable(join(directory, 'archive', ID, `manifest-before-${sha256(manifestBytes)}.json`), manifestBytes);
      atomicJson(manifestPath, next);
      assert.equal(sha256(readFileSync(join(directory, 'provider-ledger.json'))), ledgerBefore);
    }
    return { status: apply ? 'applied' : 'prepared', id: ID, providerCalls: 0, manifestChanged: apply,
      expectedManifestSha256: sha256(manifestBytes), originalProcessedSha256: BEFORE_SHA, outputProcessedSha256: AFTER_SHA,
      rawUnchangedSha256: RAW_SHA, otherSpriteCountUnchanged: manifest.sprites.length - 1, provenance: derivative, sourcePhotoPreserved: true };
  } finally { globalThis.fetch = originalFetch; release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), apply = args.includes('--apply');
  assert.ok(args.every(arg => arg === '--apply' || arg === `--confirm=${ID}` || arg.startsWith('--expected-manifest-sha=')));
  if (apply) assert.ok(args.includes(`--confirm=${ID}`));
  repairCasualCrouchPostprocess({ apply, expectedManifestSha: args.find(arg => arg.startsWith('--expected-manifest-sha='))?.split('=')[1] })
    .then(result => console.log(JSON.stringify(result, null, 2)), error => { console.error(error.message); process.exitCode = 1; });
}
