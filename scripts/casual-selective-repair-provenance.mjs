import assert from 'node:assert/strict';

export const CASUAL_SELECTIVE_REPAIR_ID = 'casual-selective-frame-repair-v1';
export const CASUAL_REPAIR_TARGETS = Object.freeze({ walk: [8, 9], high_punch: [2], high_kick: [2], low_kick: [2, 3, 4], jump: [4], crouch: [1], hit: [1, 2] });
const UNIQUE_COUNTS = { walk: 16, high_punch: 4, high_kick: 4, low_kick: 4, jump: 4, crouch: 4, hit: 4 };
const SHA = /^[a-f0-9]{64}$/;
const compositionPaths = ['src/services/GeminiApi.ts', 'src/services/SpritePostProcess.ts', 'src/services/AnimationProfiles.ts', 'src/services/FrameSequence.ts', 'src/services/AlphaMask.ts', 'processor/src/canvasRuntime.ts'];
const sameAsset = (a, b) => a.sha256 === b.sha256 && a.bytes === b.bytes && a.mime === b.mime;
export const casualRepairPlayback = name => name.endsWith('punch') || name.endsWith('kick') ? [1, 2, 3, 4, 3, 2, 1] : Array.from({ length: UNIQUE_COUNTS[name] }, (_, i) => i + 1);

const PILOT_PARENT = '4ece0c30ea84fb974500282ddcead5996d92d24f7d3766a001253cb1a48e3dbc';
const PILOT_CHILD = '87d6892525d2587f511810aa0cdba61e93ceb9d5d1847f4da0c3db852bc9626c';
const PILOT_BODY = '5d4922ce5dec504ae7076febf0cfd88a786eb242cbc8386680010ab1bd29c3df';

function validateProviderHistory(result, step, receipt, name, uniqueFrame) {
  assert.ok(Array.isArray(result.requests) && result.requests.length >= 1 && result.requests.length <= 2);
  const complete = result.requests.filter(request => request.status === 'complete');
  assert.equal(complete.length, 1, 'Exactly one successful provider result is required');
  const successful = complete[0];
  assert.equal(successful.provider, step === 'render' ? 'gemini' : 'fal');
  for (const hash of [successful.id, successful.requestSha256, successful.responseSha256]) assert.ok(SHA.test(hash));
  if (step === 'render') assert.equal(receipt.successfulRenderRequestId, successful.id, 'The successful render must be explicitly identified');
  if (result.requests.length === 1) return;
  assert.equal(step, 'render'); assert.equal(name, 'low_kick'); assert.equal(uniqueFrame, 4);
  const unknown = result.requests.find(request => request.status === 'unknown'); assert.ok(unknown);
  assert.equal(unknown.id, PILOT_PARENT); assert.equal(unknown.provider, 'gemini'); assert.equal(unknown.requestSha256, PILOT_BODY); assert.equal(unknown.responseSha256, undefined);
  assert.equal(successful.id, PILOT_CHILD); assert.equal(successful.requestSha256, PILOT_BODY);
  const recovery = receipt.reconciliation;
  assert.equal(recovery.id, 'casual-pilot-unknown-recovery-v1'); assert.equal(recovery.parentId, PILOT_PARENT); assert.equal(recovery.childId, PILOT_CHILD);
  assert.equal(recovery.requestSha256, PILOT_BODY); assert.equal(recovery.parentOutcome, 'unknown');
  assert.equal(recovery.maximumChildrenPerParent, 1); assert.equal(recovery.exactBodyReplay, true); assert.ok(SHA.test(recovery.sourceSha256));
}

/** Only the exact eleven reviewed Casual repairs. File access/credential rejection remain owned by the sealed packager. */
export function collectCasualSelectiveRepairFiles({ manifest, derivative, checkedJson, includeMedia, spriteFields, pick }) {
  const base = `derivatives/${CASUAL_SELECTIVE_REPAIR_ID}`;
  assert.equal(derivative.path, `${base}/provenance.json`);
  const proof = checkedJson(derivative);
  assert.equal(proof.schemaVersion, 1); assert.equal(proof.id, CASUAL_SELECTIVE_REPAIR_ID);
  assert.deepEqual(proof.identity, manifest.identity);
  assert.equal(proof.originalManifest.path, `${base}/original-manifest.json`);
  const original = checkedJson(proof.originalManifest);
  assert.equal(original.schemaVersion, 1); assert.deepEqual(original.identity, manifest.identity);
  assert.ok(SHA.test(proof.originalProductFingerprint));
  assert.equal(original.fingerprint, proof.originalProductFingerprint, 'Repair fingerprint differs from preserved original manifest');
  assert.deepEqual(proof.compositionProductFiles.map(file => file.path).sort(), [...compositionPaths].sort(), 'Exact shared product composition files are required');
  for (const file of proof.compositionProductFiles) assert.ok(SHA.test(file.sha256), 'Composition source hash is required');
  assert.equal(proof.preparation.path, `${base}/preparation.json`);
  const preparation = checkedJson(proof.preparation);
  assert.equal(preparation.completed, true); assert.equal(preparation.noPaidCalls, true); assert.equal(preparation.noNetwork, true);
  assert.equal(preparation.originalManifest.sha256, proof.originalManifest.sha256);
  assert.equal(preparation.sourceFingerprint, original.fingerprint);
  assert.deepEqual(preparation.identity, manifest.identity);
  if (preparation.priorManifests !== undefined) {
    assert.equal(preparation.priorManifests.length, 2, 'Both preparation snapshots must be retained');
    const history = preparation.priorManifests.map(entry => {
      assert.ok(entry.path.startsWith(`${base}/history/`)); return checkedJson(entry);
    });
    assert.deepEqual(history[1], original, 'The later preparation snapshot must equal the preserved original');
    assert.deepEqual(history[0].identity, original.identity); assert.deepEqual(history[0].sources, original.sources);
    for (const old of history[0].sprites) assert.deepEqual(pick(old, spriteFields), pick(original.sprites.find(sprite => sprite.animationName === old.animationName && sprite.qualityTier === old.qualityTier), spriteFields), 'An earlier original was changed or lost');
  }
  assert.equal(proof.targetMap.path, `${base}/repair-target-map.json`);
  const targetMap = checkedJson(proof.targetMap);
  assert.equal(targetMap.schemaVersion, 1); assert.equal(targetMap.fingerprint, original.fingerprint);
  assert.equal(preparation.targetMap.sha256, proof.targetMap.sha256);
  assert.equal(proof.walk9Review.uniqueFrame, 9); assert.equal(proof.walk9Review.animationName, 'walk');
  assert.equal(proof.walk9Review.approved, true);
  assert.equal(proof.walk9Review.reason, 'Preserve the lifted rear heel and passing step from Rookie; the previous Champion frame substituted a planted guard.');
  assert.deepEqual(proof.changes.map(change => change.animationName).sort(), Object.keys(CASUAL_REPAIR_TARGETS).sort(), 'Exactly the seven reviewed Champion animations must change');
  const changed = new Set();
  const includeSprite = entry => {
    includeMedia(entry); includeMedia({ path: entry.rawPath, sha256: entry.rawSha256, bytes: entry.rawBytes, mime: entry.rawMime });
  };
  const image = entry => {
    assert.equal(entry.mime, 'image/png'); assert.ok(entry.path.startsWith(`${base}/frames/`), 'Native evidence must stay inside the repair frames directory');
    assert.ok(Number.isSafeInteger(entry.width) && entry.width > 0 && Number.isSafeInteger(entry.height) && entry.height > 0, 'Native frame geometry is required');
    const bytes = includeMedia(entry);
    assert.ok(bytes.length >= 24 && bytes.toString('ascii', 12, 16) === 'IHDR', 'Native evidence must contain a PNG header');
    assert.equal(bytes.readUInt32BE(16), entry.width); assert.equal(bytes.readUInt32BE(20), entry.height);
  };
  for (const change of proof.changes) {
    const name = change.animationName, count = UNIQUE_COUNTS[name], order = casualRepairPlayback(name);
    assert.equal(change.qualityTier, 'contender');
    assert.equal(change.uniqueFrameCount, count); assert.deepEqual(change.playbackFrameOrderOneBased, order);
    const old = original.sprites.filter(sprite => sprite.animationName === name && sprite.qualityTier === 'contender');
    const current = manifest.sprites.filter(sprite => sprite.animationName === name && sprite.qualityTier === 'contender');
    assert.equal(old.length, 1); assert.equal(current.length, 1);
    assert.deepEqual(pick(change.originalEntry, spriteFields), pick(old[0], spriteFields), 'Repair original differs from preserved manifest');
    assert.deepEqual(pick(change.outputEntry, spriteFields), current[0], 'Repair output differs from current manifest');
    assert.equal(old[0].derivativeId, undefined, 'Only original Champion sheets may enter this repair');
    assert.equal(current[0].derivativeId, CASUAL_SELECTIVE_REPAIR_ID);
    assert.equal(current[0].frameCount, order.length); assert.equal(current[0].animationFormat, 'legacy');
    assert.equal(current[0].frameWidth, 768); assert.equal(current[0].frameHeight, 1024);
    assert.equal(current[0].uniqueFrameCount, count);
    assert.equal(current[0].gridCols, order.length <= 4 ? 2 : 4);
    assert.equal(current[0].gridRows, Math.ceil(order.length / current[0].gridCols));
    assert.ok(current[0].path.startsWith(`${base}/outputs/`) && current[0].rawPath.startsWith(`${base}/outputs/`));
    const key = `contender:${name}`; changed.add(key);
    assert.deepEqual(change.frames.map(frame => frame.uniqueFrame), Array.from({ length: count }, (_, i) => i + 1), 'Every unique native frame must remain in exact order');
    const prepared = preparation.groups.filter(group => group.animationName === name);
    assert.equal(prepared.length, 1);
    assert.deepEqual(pick(prepared[0].championOriginal, spriteFields), pick(old[0], spriteFields));
    const replacements = [];
    for (const frame of change.frames) {
      const prior = prepared[0].frames.filter(item => item.uniqueFrame === frame.uniqueFrame); assert.equal(prior.length, 1);
      const positions = order.flatMap((value, index) => value === frame.uniqueFrame ? [index + 1] : []);
      assert.deepEqual(frame.playbackFrames, positions); assert.deepEqual(prior[0].playbackFrames, positions);
      assert.equal(prior[0].rawPixelsMatchOriginalPlaybackCells, true);
      for (const [entry, expected] of [[frame.originalRaw, prior[0].raw], [frame.originalClean, prior[0].cleaned]]) {
        assert.ok(sameAsset(entry, expected), 'Original native frame differs from verified preparation'); image(entry);
      }
      image(frame.outputRaw); image(frame.outputClean);
      if (CASUAL_REPAIR_TARGETS[name].includes(frame.uniqueFrame)) {
        replacements.push(frame.uniqueFrame);
        const receipt = frame.replacementReceipt; assert.ok(receipt, 'Reviewed defective frame needs a replacement receipt');
        const targets = targetMap.targets.filter(target => target.animationName === name && target.uniqueFrame === frame.uniqueFrame);
        assert.equal(targets.length, 1); const target = targets[0];
        assert.equal(target.tier, 'contender'); assert.deepEqual(target.playbackFrames, positions);
        assert.equal(target.poseSha256, prior[0].pose.sha256);
        assert.equal(target.requestId, prior[0].render.id); assert.equal(target.requestSha256, prior[0].render.requestSha256); assert.equal(target.responseSha256, prior[0].render.responseSha256);
        if (name === 'walk' && frame.uniqueFrame === 9) assert.equal(proof.walk9Review.originalPoseSha256, target.poseSha256);
        for (const [result, step, output] of [[receipt.renderResult, 'render', frame.outputRaw], [receipt.cleanResult, 'clean', frame.outputClean]]) {
          assert.equal(result.schemaVersion, 1); assert.equal(result.step, step); assert.ok(SHA.test(result.planSha256));
          assert.deepEqual(result.parent, prior[0].render, 'Replacement parent is not the exact original request');
          assert.deepEqual(result.target, { animationName: name, qualityTier: 'contender', uniqueFrame: frame.uniqueFrame, playbackFrames: positions });
          assert.ok(sameAsset(result.image, output), 'Replacement output differs from reviewed receipt');
          assert.equal(result.image.width, output.width); assert.equal(result.image.height, output.height);
          validateProviderHistory(result, step, receipt, name, frame.uniqueFrame);
        }
        assert.equal(receipt.renderResult.planSha256, receipt.cleanResult.planSha256);
        assert.equal(receipt.rawReviewedSha256, frame.outputRaw.sha256); assert.equal(receipt.cleanReviewedSha256, frame.outputClean.sha256);
        assert.notEqual(frame.originalRaw.sha256, frame.outputRaw.sha256, 'A replacement must replace the original defective render');
        assert.equal(frame.outputRaw.width, frame.outputClean.width); assert.equal(frame.outputRaw.height, frame.outputClean.height);
      } else {
        assert.equal(frame.replacementReceipt, undefined, 'Unreviewed native frame replacement is forbidden');
        assert.ok(sameAsset(frame.originalRaw, frame.outputRaw) && sameAsset(frame.originalClean, frame.outputClean), 'Unchanged native frame bytes must be preserved');
      }
    }
    assert.deepEqual(replacements, CASUAL_REPAIR_TARGETS[name]);
    includeSprite(old[0]); includeSprite(current[0]);
  }
  // Preserve every prior sprite and source, including Rookie and already-curated paired idle.
  const originalKeys = original.sprites.map(sprite => `${sprite.qualityTier}:${sprite.animationName}`);
  assert.equal(new Set(originalKeys).size, originalKeys.length);
  for (const old of original.sprites) {
    const current = manifest.sprites.find(sprite => sprite.animationName === old.animationName && sprite.qualityTier === old.qualityTier); assert.ok(current, 'A prior character animation was lost');
    if (!changed.has(`${old.qualityTier}:${old.animationName}`)) assert.deepEqual(pick(old, spriteFields), current, 'An unrelated prior sprite changed during repair');
    includeSprite(old);
  }
  for (const old of original.sources) {
    assert.deepEqual(manifest.sources.find(source => source.kind === old.kind), old, 'A shared source changed during repair'); includeMedia(old);
  }
  assert.deepEqual(manifest.sprites.filter(sprite => sprite.derivativeId === CASUAL_SELECTIVE_REPAIR_ID).map(sprite => sprite.animationName).sort(), [...Object.keys(CASUAL_REPAIR_TARGETS)].sort());
  return proof;
}
