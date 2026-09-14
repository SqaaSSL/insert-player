import assert from 'node:assert/strict';

export const CASUAL_KO_COMPLETION_ID = 'casual-ko-completion-v1';
const SHA = /^[a-f0-9]{64}$/;
const paths = ['src/services/GeminiApi.ts', 'src/services/SpritePostProcess.ts', 'src/services/AnimationProfiles.ts', 'src/services/FrameSequence.ts', 'src/services/AlphaMask.ts', 'processor/src/canvasRuntime.ts'];
const same = (a, b) => a.sha256 === b.sha256 && a.bytes === b.bytes && a.mime === b.mime && a.width === b.width && a.height === b.height;

/** Complete the one previously interrupted KO without rerendering its two approved native frames. */
export function collectCasualKoCompletionFiles({ manifest, derivative, checkedJson, includeMedia, spriteFields, pick }) {
  const base = `derivatives/${CASUAL_KO_COMPLETION_ID}`;
  assert.equal(derivative.path, `${base}/provenance.json`);
  const proof = checkedJson(derivative); assert.equal(proof.schemaVersion, 1); assert.equal(proof.id, CASUAL_KO_COMPLETION_ID);
  assert.deepEqual(proof.identity, manifest.identity); assert.deepEqual(proof.reusedOriginalFrames, [2, 5]);
  assert.equal(proof.originalManifest.path, `${base}/original-manifest.json`);
  const original = checkedJson(proof.originalManifest); assert.deepEqual(original.identity, manifest.identity);
  assert.ok(SHA.test(proof.originalProductFingerprint)); assert.equal(original.fingerprint, proof.originalProductFingerprint);
  assert.equal(original.sprites.some(sprite => sprite.animationName === 'ko' && sprite.qualityTier === 'contender'), false, 'A completed original KO must never be overwritten');
  const rookie = original.sprites.find(sprite => sprite.animationName === 'ko' && sprite.qualityTier === 'rookie'); assert.ok(rookie); assert.equal(rookie.frameCount, 8); assert.equal(rookie.frameWidth, 768); assert.equal(rookie.frameHeight, 1024);
  assert.deepEqual(pick(rookie, spriteFields), manifest.sprites.find(sprite => sprite.animationName === 'ko' && sprite.qualityTier === 'rookie'));
  includeMedia(rookie); includeMedia({ path: rookie.rawPath, sha256: rookie.rawSha256, bytes: rookie.rawBytes, mime: rookie.rawMime });
  assert.deepEqual(proof.compositionProductFiles.map(file => file.path).sort(), [...paths].sort());
  for (const file of proof.compositionProductFiles) assert.ok(SHA.test(file.sha256));
  assert.deepEqual(proof.composition, { function: 'composeGeminiRefinedSprite', animationName: 'ko', frameCount: 8, maxScale: null, normalizationReference: null, official: false });
  const images = entry => {
    assert.equal(entry.mime, 'image/png'); assert.ok(entry.path.startsWith(`${base}/frames/`));
    const bytes = includeMedia(entry); assert.equal(bytes.toString('ascii', 12, 16), 'IHDR');
    assert.equal(bytes.readUInt32BE(16), entry.width); assert.equal(bytes.readUInt32BE(20), entry.height);
    return bytes;
  };
  assert.deepEqual(proof.originalAttempts.map(item => `${item.uniqueFrame}:${item.attempt}`).sort(), ['1:1', '2:1', '3:1', '4:1', '5:1', '6:1', '6:2']);
  for (const item of proof.originalAttempts) {
    for (const hash of [item.parent.id, item.parent.requestSha256, item.parent.responseSha256, item.poseSha256]) assert.ok(SHA.test(hash));
    images(item.raw);
  }
  assert.deepEqual(proof.frames.map(frame => frame.uniqueFrame), [1, 2, 3, 4, 5, 6, 7, 8]);
  for (const frame of proof.frames) {
    const number = frame.uniqueFrame; assert.ok(SHA.test(frame.generationFingerprint));
    assert.ok(Array.isArray(frame.generationProductFiles) && frame.generationProductFiles.length > 0);
    for (const file of frame.generationProductFiles) assert.ok(SHA.test(file.sha256));
    images(frame.pose); images(frame.raw); images(frame.clean);
    assert.equal(frame.pose.width, 768); assert.equal(frame.pose.height, 1024);
    assert.equal(frame.raw.width, frame.clean.width); assert.equal(frame.raw.height, frame.clean.height);
    assert.equal(frame.rawReviewedSha256, frame.raw.sha256); assert.equal(frame.cleanReviewedSha256, frame.clean.sha256);
    const originals = proof.originalAttempts.filter(item => item.uniqueFrame === number);
    for (const item of originals) assert.equal(item.poseSha256, frame.pose.sha256);
    if ([2, 5].includes(number)) assert.ok(same(frame.raw, originals[0].raw), 'Approved original KO native bytes must be reused exactly');
    else for (const item of originals) assert.notEqual(frame.raw.sha256, item.raw.sha256, 'A rejected original KO pose may not be reused');
    for (const [result, step, image] of [[frame.renderResult, 'render', frame.raw], [frame.cleanResult, 'clean', frame.clean]]) {
      assert.equal(result.schemaVersion, 1); assert.equal(result.step, step); assert.ok(SHA.test(result.planSha256));
      assert.deepEqual(result.target, { animationName: 'ko', qualityTier: 'contender', uniqueFrame: number, playbackFrames: [number] });
      assert.deepEqual(result.parent, originals[0]?.parent ?? null);
      assert.ok(same(result.image, image)); assert.equal(result.requests.length, 1);
      const request = result.requests[0]; assert.equal(request.status, 'complete'); assert.equal(request.provider, step === 'render' ? 'gemini' : 'fal');
      for (const hash of [request.id, request.requestSha256, request.responseSha256]) assert.ok(SHA.test(hash));
      if (step === 'render' && [2, 5].includes(number)) { assert.equal(request.id, originals[0].parent.id); assert.equal(result.reusedOriginalNative, true); assert.equal(result.newProviderCalls, 0); }
    }
    assert.equal(frame.renderResult.planSha256, frame.cleanResult.planSha256);
  }
  const current = manifest.sprites.filter(sprite => sprite.derivativeId === CASUAL_KO_COMPLETION_ID); assert.equal(current.length, 1);
  const output = current[0]; assert.deepEqual(pick(proof.outputEntry, spriteFields), output);
  assert.equal(output.animationName, 'ko'); assert.equal(output.qualityTier, 'contender'); assert.equal(output.animationFormat, 'legacy');
  assert.equal(output.frameWidth, 768); assert.equal(output.frameHeight, 1024); assert.equal(output.frameCount, 8); assert.equal(output.uniqueFrameCount, 8); assert.equal(output.gridCols, 4); assert.equal(output.gridRows, 2);
  assert.ok(output.path.startsWith(`${base}/outputs/`) && output.rawPath.startsWith(`${base}/outputs/`));
  includeMedia(output); includeMedia({ path: output.rawPath, sha256: output.rawSha256, bytes: output.rawBytes, mime: output.rawMime });
  return proof;
}
