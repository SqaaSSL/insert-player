import assert from 'node:assert/strict';

export const CASUAL_POSTPROCESS_REPAIR_ID = 'casual-postprocess-repair-v1';
const SHA = /^[a-f0-9]{64}$/;
const paths = ['src/services/SpritePostProcess.ts', 'src/services/AnimationProfiles.ts', 'src/services/AlphaMask.ts', 'src/services/FrameSequence.ts', 'src/services/SpriteGrid.ts', 'processor/src/canvasRuntime.ts'];

/** Exact Rookie crouch cleanup correction. The input generation and its raw pixels remain untouched. */
export function collectCasualPostprocessRepairFiles({ manifest, derivative, checkedJson, includeMedia, spriteFields, pick }) {
  const base = `derivatives/${CASUAL_POSTPROCESS_REPAIR_ID}`;
  assert.equal(derivative.path, `${base}/provenance.json`);
  const proof = checkedJson(derivative);
  assert.equal(proof.schemaVersion, 1); assert.equal(proof.id, CASUAL_POSTPROCESS_REPAIR_ID);
  assert.deepEqual(proof.identity, manifest.identity);
  assert.equal(proof.operation, 'reprocess-original-raw'); assert.equal(proof.providerCalls, 0);
  assert.deepEqual(proof.arguments, { animationName: 'crouch', expectedFrameCount: 4, expectedGridCols: 2, expectedGridRows: 2, normalizationReference: { baselineRatio: 0.98 } });
  assert.equal(proof.originalManifest.path, `${base}/original-manifest.json`);
  const original = checkedJson(proof.originalManifest);
  assert.equal(original.schemaVersion, 1); assert.deepEqual(original.identity, manifest.identity);
  assert.ok(SHA.test(proof.originalProductFingerprint)); assert.equal(original.fingerprint, proof.originalProductFingerprint);
  assert.deepEqual(proof.productFiles.map(file => file.path).sort(), [...paths].sort());
  for (const file of proof.productFiles) assert.ok(SHA.test(file.sha256));
  assert.equal(proof.codeChange.path, `${base}/postprocess-change.json`);
  const code = checkedJson(proof.codeChange);
  assert.equal(code.path, 'src/services/SpritePostProcess.ts');
  assert.ok(SHA.test(code.beforeSha256) && SHA.test(code.afterSha256)); assert.notEqual(code.beforeSha256, code.afterSha256);
  assert.equal(code.beforeSha256, original.productFiles.find(file => file.path === code.path)?.sha256);
  assert.equal(code.afterSha256, proof.productFiles.find(file => file.path === code.path)?.sha256);
  assert.equal(code.operation, 'preserve-already-cleaned-components-after-alpha-erosion');
  assert.ok(typeof code.patch === 'string' && code.patch.length > 0 && code.patch.length < 16000, 'A bounded reviewed code patch is required');
  const old = original.sprites.filter(sprite => sprite.animationName === 'crouch' && sprite.qualityTier === 'rookie');
  const current = manifest.sprites.filter(sprite => sprite.derivativeId === CASUAL_POSTPROCESS_REPAIR_ID);
  assert.equal(old.length, 1); assert.equal(current.length, 1);
  assert.deepEqual(pick(proof.originalEntry, spriteFields), pick(old[0], spriteFields));
  assert.deepEqual(pick(proof.outputEntry, spriteFields), current[0]);
  assert.equal(old[0].derivativeId, undefined);
  const output = current[0];
  for (const field of ['animationName', 'qualityTier', 'animationFormat', 'frameWidth', 'frameHeight', 'frameCount', 'gridCols', 'gridRows', 'rawPath', 'rawSha256', 'rawBytes', 'rawWidth', 'rawHeight', 'rawMime', 'uniqueFrameCount']) {
    assert.equal(output[field], old[0][field], `Original ${field} must remain unchanged`);
  }
  assert.equal(output.animationName, 'crouch'); assert.equal(output.qualityTier, 'rookie'); assert.equal(output.animationFormat, 'legacy');
  assert.equal(output.frameWidth, 768); assert.equal(output.frameHeight, 1024); assert.equal(output.frameCount, 4); assert.equal(output.gridCols, 2); assert.equal(output.gridRows, 2);
  assert.equal(output.processingVersion, 5); assert.equal(proof.processingVersion, 5);
  assert.notEqual(output.sha256, old[0].sha256, 'A cleanup correction must change the processed result');
  assert.ok(output.path.startsWith(`${base}/outputs/`));
  assert.deepEqual(proof.sourceRaw, { path: old[0].rawPath, sha256: old[0].rawSha256, bytes: old[0].rawBytes, mime: old[0].rawMime });
  includeMedia(proof.sourceRaw); includeMedia(old[0]);
  const bytes = includeMedia(output);
  assert.equal(bytes.toString('ascii', 12, 16), 'IHDR'); assert.equal(bytes.readUInt32BE(16), 1536); assert.equal(bytes.readUInt32BE(20), 2048);
  return proof;
}
