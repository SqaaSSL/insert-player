import assert from 'node:assert/strict';

export const CASUAL_AURA_GRID_RESCUE_ID = 'casual-aura-grid-rescue-v1';
const SHA = /^[a-f0-9]{64}$/;
const PRODUCT_PATHS = ['src/services/GeminiApi.ts', 'src/services/SpritePostProcess.ts', 'src/services/AnimationProfiles.ts', 'src/services/FrameSequence.ts', 'src/services/AlphaMask.ts', 'src/services/SpriteGrid.ts', 'processor/src/canvasRuntime.ts'];
const CONFIG = {
  aura_unbothered: {
    order: [1, 2, 4, 5, 6, 7], reuse: [1, 3, 4, 5, 6],
    rectangles: Array.from({ length: 7 }, (_, i) => i < 4 ? { x: i * 288, y: 0, width: 288, height: 464 } : { x: (i - 4) * 384, y: 464, width: 384, height: 464 }),
    cellWidth: 384, cellHeight: 464, scales: [1, 1, 1, 1, 1, 1, 1],
  },
  aura_floor_worm: {
    order: [1, 2, 3, 5, 6, 7], reuse: [],
    rectangles: Array.from({ length: 7 }, (_, i) => i < 3 ? { x: i * 384, y: 0, width: 384, height: 310 } : i < 5 ? { x: (i - 3) * 576, y: 310, width: 576, height: 310 } : { x: (i - 5) * 576, y: 620, width: 576, height: 308 }),
    cellWidth: 576, cellHeight: 465, scales: [1.5, 1.5, 1.5, 1, 1, 1, 1],
  },
};
const same = (a, b) => a.sha256 === b.sha256 && a.bytes === b.bytes && a.mime === b.mime && a.width === b.width && a.height === b.height;

/** Only the two reviewed irregular Aura grids, with their original bodies and exact native reuse. */
export function collectCasualAuraGridRescueFiles({ manifest, derivative, checkedJson, includeMedia, spriteFields, pick }) {
  const base = `derivatives/${CASUAL_AURA_GRID_RESCUE_ID}`;
  assert.equal(derivative.path, `${base}/provenance.json`);
  const proof = checkedJson(derivative); assert.equal(proof.schemaVersion, 1); assert.equal(proof.id, CASUAL_AURA_GRID_RESCUE_ID);
  assert.deepEqual(proof.identity, manifest.identity); assert.equal(proof.originalManifest.path, `${base}/original-manifest.json`);
  const original = checkedJson(proof.originalManifest); assert.deepEqual(original.identity, manifest.identity);
  assert.ok(SHA.test(proof.originalProductFingerprint)); assert.equal(original.fingerprint, proof.originalProductFingerprint);
  assert.deepEqual(proof.compositionProductFiles.map(file => file.path).sort(), [...PRODUCT_PATHS].sort());
  for (const file of proof.compositionProductFiles) assert.ok(SHA.test(file.sha256));
  assert.deepEqual(proof.groups.map(group => group.animationName).sort(), Object.keys(CONFIG).sort());
  assert.equal(manifest.sprites.filter(sprite => sprite.derivativeId === CASUAL_AURA_GRID_RESCUE_ID).length, 4);
  const image = entry => {
    assert.equal(entry.mime, 'image/png'); assert.ok(entry.path.startsWith(`${base}/frames/`));
    const bytes = includeMedia(entry); assert.equal(bytes.toString('ascii', 12, 16), 'IHDR');
    assert.equal(bytes.readUInt32BE(16), entry.width); assert.equal(bytes.readUInt32BE(20), entry.height);
    return bytes;
  };
  const sheet = entry => { includeMedia(entry); includeMedia({ path: entry.rawPath, sha256: entry.rawSha256, bytes: entry.rawBytes, mime: entry.rawMime }); };
  for (const group of proof.groups) {
    const config = CONFIG[group.animationName], oldRookie = original.sprites.find(sprite => sprite.animationName === group.animationName && sprite.qualityTier === 'rookie');
    assert.ok(oldRookie); assert.deepEqual(group.originalRookie, oldRookie); assert.ok(SHA.test(oldRookie.rawSha256));
    assert.equal(oldRookie.rawWidth, 1152); assert.equal(oldRookie.rawHeight, 928); sheet(oldRookie);
    const oldChampion = original.sprites.find(sprite => sprite.animationName === group.animationName && sprite.qualityTier === 'contender') ?? null;
    assert.deepEqual(group.originalChampion, oldChampion); assert.equal(Boolean(oldChampion), group.animationName === 'aura_unbothered'); if (oldChampion) sheet(oldChampion);
    assert.deepEqual(group.selectedOriginalFrames, config.order); assert.deepEqual(group.reusedOriginalFrames, config.reuse);
    assert.deepEqual(group.sourceFrames.map(frame => frame.sourceFrame), [1, 2, 3, 4, 5, 6, 7]);
    for (const [i, frame] of group.sourceFrames.entries()) {
      assert.deepEqual(frame.rect, config.rectangles[i]); assert.ok(SHA.test(frame.rgbaSha256)); image(frame.native); assert.equal(frame.native.width, frame.rect.width); assert.equal(frame.native.height, frame.rect.height);
      assert.deepEqual(frame.layoutNormalization, { scale: config.scales[i], drawWidth: Math.round(frame.rect.width * config.scales[i]), drawHeight: Math.round(frame.rect.height * config.scales[i]), paddingLeft: Math.round((config.cellWidth - frame.rect.width * config.scales[i]) / 2), paddingTop: Math.round((config.cellHeight - frame.rect.height * config.scales[i]) / 2) });
    }
    assert.deepEqual(group.rookieProcessing, { function: 'cleanSpriteSheet', expectedFrameCount: 6, expectedGridCols: 4, expectedGridRows: 2, animationName: group.animationName, maxScale: null, normalizationReference: null, paidCalls: 0 });
    assert.deepEqual(group.championComposition, { function: 'composeGeminiRefinedSprite', animationName: group.animationName, frameCount: 6, maxScale: null, normalizationReference: null, official: false });
    for (const tier of ['rookie', 'contender']) {
      const output = tier === 'rookie' ? group.rookieOutputEntry : group.championOutputEntry;
      const current = manifest.sprites.find(sprite => sprite.animationName === group.animationName && sprite.qualityTier === tier);
      assert.deepEqual(pick(output, spriteFields), current); assert.equal(output.derivativeId, CASUAL_AURA_GRID_RESCUE_ID);
      assert.equal(output.frameWidth, 768); assert.equal(output.frameHeight, 1024); assert.equal(output.frameCount, 6); assert.equal(output.uniqueFrameCount, 6); assert.equal(output.gridCols, 4); assert.equal(output.gridRows, 2); assert.equal(output.animationFormat, 'legacy');
      assert.ok(output.path.startsWith(`${base}/outputs/`) && output.rawPath.startsWith(`${base}/outputs/`)); sheet(output);
      if (tier === 'rookie') { assert.equal(output.rawWidth, config.cellWidth * 4); assert.equal(output.rawHeight, config.cellHeight * 2); }
    }
    assert.ok(group.originalAttempts.length >= 6 && group.originalAttempts.length <= 12);
    assert.equal(new Set(group.originalAttempts.map(item => item.parent.id)).size, group.originalAttempts.length);
    for (const attempt of group.originalAttempts) {
      assert.ok(Number.isInteger(attempt.playbackFrame) && attempt.playbackFrame >= 1 && attempt.playbackFrame <= 6);
      for (const hash of [attempt.parent.id, attempt.parent.requestSha256, attempt.parent.responseSha256, attempt.poseSha256]) assert.ok(SHA.test(hash));
      image(attempt.raw);
      if (attempt.clean) image(attempt.clean);
    }
    if (group.animationName === 'aura_unbothered') assert.deepEqual(group.originalAttempts.map(item => item.playbackFrame), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(group.frames.map(frame => frame.playbackFrame), [1, 2, 3, 4, 5, 6]);
    for (const frame of group.frames) {
      const number = frame.playbackFrame; assert.equal(frame.sourceFrame, config.order[number - 1]); image(frame.pose); image(frame.raw); image(frame.clean);
      assert.equal(frame.pose.width, 768); assert.equal(frame.pose.height, 1024); assert.equal(frame.raw.width, frame.clean.width); assert.equal(frame.raw.height, frame.clean.height);
      assert.equal(frame.rawReviewedSha256, frame.raw.sha256); assert.equal(frame.cleanReviewedSha256, frame.clean.sha256);
      const old = group.originalAttempts.filter(item => item.playbackFrame === number);
      if (config.reuse.includes(number)) {
        assert.equal(frame.disposition, 'reuse-approved-native'); assert.equal(old.length, 1); assert.ok(same(frame.raw, old[0].raw)); assert.ok(same(frame.clean, old[0].clean)); assert.equal(frame.pose.sha256, old[0].poseSha256);
        assert.deepEqual(frame.cleanupReceipt, old[0].cleanupReceipt); assert.ok(frame.cleanupReceipt);
        for (const hash of Object.values(frame.cleanupReceipt)) assert.ok(SHA.test(hash));
      } else {
        assert.equal(frame.disposition, 'replace-broken-grid-pose'); for (const attempt of old) assert.notEqual(frame.raw.sha256, attempt.raw.sha256);
        assert.ok(SHA.test(frame.generationFingerprint)); assert.ok(frame.generationProductFiles.length > 0); for (const file of frame.generationProductFiles) assert.ok(SHA.test(file.sha256));
        for (const [result, step, asset] of [[frame.renderResult, 'render', frame.raw], [frame.cleanResult, 'clean', frame.clean]]) {
          assert.equal(result.schemaVersion, 1); assert.equal(result.step, step); assert.ok(SHA.test(result.planSha256)); assert.ok(same(result.image, asset));
          assert.deepEqual(result.target, { animationName: group.animationName, qualityTier: 'contender', uniqueFrame: number, playbackFrames: [number] });
          assert.deepEqual(result.parent, old.length ? old.at(-1).parent : null);
          assert.equal(result.requests.length, 1); const request = result.requests[0]; assert.equal(request.status, 'complete'); assert.equal(request.provider, step === 'render' ? 'gemini' : 'fal');
          for (const hash of [request.id, request.requestSha256, request.responseSha256]) assert.ok(SHA.test(hash));
        }
        assert.equal(frame.renderResult.planSha256, frame.cleanResult.planSha256);
      }
    }
  }
  return proof;
}
