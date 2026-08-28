import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertDescriptor,
  assertPromoteTransitionLookup,
  assertPromotionReceipt,
  assertReceiptMatchesPromoteTransition,
  assertSourceBinding,
  persistTransitionReceiptWithSmoke,
  sha256,
} from './imported-global-video-recuration.mjs';

const sourcePath = new URL(
  '../arcade/imported-video-recurations/donald-trump-idle-2026-08-28.json',
  import.meta.url,
);

function sourceBinding() {
  return JSON.parse(readFileSync(sourcePath, 'utf8'));
}

function fakeAsset(filename, contentType, marker) {
  return {
    filename,
    sha256: marker.repeat(64),
    contentType,
    byteLength: 123,
  };
}

const HIGH_KICK_PLAYBACK = Object.freeze([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
  10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0,
]);

function descriptor() {
  const expectedWorkerSha = 'a'.repeat(40);
  return {
    schemaVersion: 1,
    kind: 'imported-global-video-recuration-v1',
    target: 'production',
    expectedWorkerSha,
    sourceBindingSha256: 'b'.repeat(64),
    fighter: {
      slug: 'donald-trump',
      fighterId: '1'.repeat(32),
    },
    action: 'high_kick',
    proposalId: '2'.repeat(32),
    worker: {
      expectedSha: expectedWorkerSha,
      versionId: 'worker-version',
      versionTag: `prod-${expectedWorkerSha}-1`,
    },
    from: {
      spriteId: 'legacy-high-kick',
      spriteVersionId: '3'.repeat(32),
      processedSha256: '3'.repeat(64),
      rawSha256: '4'.repeat(64),
      frameWidth: 192,
      frameHeight: 256,
      frameCount: 7,
      animationFormat: 'video-dense-v1',
      processingVersion: 5,
    },
    to: {
      spriteVersionId: '4'.repeat(32),
      processedSha256: '5'.repeat(64),
      rawSha256: '6'.repeat(64),
      frameWidth: 192,
      frameHeight: 256,
      frameCount: HIGH_KICK_PLAYBACK.length,
      rawFrameWidth: 768,
      rawFrameHeight: 1024,
      rawFrameCount: 12,
      animationFormat: 'video-dense-v1',
      processingVersion: 6,
      technicalOutcome: 'technical_pass',
      reportSha256: 'a'.repeat(64),
      reportContentSha256: 'b'.repeat(64),
      selectedVideoIndices: [2, 6, 10, 14, 18, 22, 26, 30, 34, 38, 42, 46],
      playback: [...HIGH_KICK_PLAYBACK],
    },
    source: {},
    evidenceSha256: '7'.repeat(64),
    assetRoutes: {
      runtime: '/runtime',
      raw: '/raw',
      contactSheet: '/contact',
      uniqueSheet: '/unique',
      report: '/report',
      video: '/video',
      canonical: '/canonical',
      evidence: '/evidence',
    },
    assets: {
      runtime: fakeAsset('runtime.png', 'image/png', '8'),
      raw: fakeAsset('raw.png', 'image/png', '9'),
      contactSheet: fakeAsset('contact-sheet.png', 'image/png', 'a'),
      uniqueSheet: fakeAsset('unique-sheet.png', 'image/png', 'b'),
      report: fakeAsset('report.json', 'application/json', 'c'),
      video: fakeAsset('video.mp4', 'video/mp4', 'd'),
      canonical: fakeAsset('canonical.png', 'image/png', 'e'),
      evidence: fakeAsset('evidence.json', 'application/json', 'f'),
    },
  };
}

function promoteTransitionLookup(value) {
  return {
    transition: {
      transitionId: '1'.repeat(64),
      proposalId: value.proposalId,
      fighterId: value.fighter.fighterId,
      action: value.action,
      operation: 'promote',
      actorUserId: 'arcade-admin',
      from: {
        spriteVersionId: value.from.spriteVersionId,
        processedSha256: value.from.processedSha256,
        rawSha256: value.from.rawSha256,
      },
      to: {
        spriteVersionId: value.to.spriteVersionId,
        processedSha256: value.to.processedSha256,
        rawSha256: value.to.rawSha256,
      },
      expectedWorkerSha: value.expectedWorkerSha,
      visualReviewAccepted: true,
      needsReviewAccepted: value.to.technicalOutcome === 'needs_review',
      createdAt: '2026-08-28 08:00:00',
    },
    proposal: {
      proposalId: value.proposalId,
      fighterId: value.fighter.fighterId,
      action: value.action,
      worker: value.worker,
      from: value.from,
      to: value.to,
      source: value.source,
      evidenceSha256: value.evidenceSha256,
      createdAt: '2026-08-28 07:00:00',
      assets: value.assetRoutes,
    },
  };
}

describe('imported global Video recuration source binding', () => {
  it('accepts the exact reviewed Trump idle source and keeps its stable digest', () => {
    const bytes = readFileSync(sourcePath);
    expect(assertSourceBinding(sourceBinding()).action).toBe('idle');
    expect(sha256(bytes)).toBe('f0756a44f3c55e7d6dc8b7f439e6b3c624172a098172c6e0a930592d3cbfc831');
  });

  it('rejects a non-fal source, reordered frames, or incomplete current binding', () => {
    const wrongHost = sourceBinding();
    wrongHost.source.url = 'https://example.com/source.mp4';
    expect(() => assertSourceBinding(wrongHost)).toThrow(/allowlist/i);

    const queriedUrl = sourceBinding();
    queriedUrl.source.url += '?mutable=1';
    expect(() => assertSourceBinding(queriedUrl)).toThrow(/allowlist/i);

    const reordered = sourceBinding();
    reordered.selectedVideoIndices = [40, 42, 41];
    expect(() => assertSourceBinding(reordered)).toThrow(/invalid exact identities/i);

    const incomplete = sourceBinding();
    delete incomplete.current.rawSha256;
    expect(() => assertSourceBinding(incomplete)).toThrow(/invalid exact identities/i);
  });
});

describe('imported global Video recuration descriptor', () => {
  it('accepts sealed high_kick forward-ping-pong geometry without assuming idle counts', () => {
    const value = descriptor();
    expect(assertDescriptor(value, value.expectedWorkerSha)).toBe(value);
    expect(value.action).toBe('high_kick');
    expect(value.to.frameCount).toBe(23);
    expect(value.to.rawFrameCount).toBe(12);
  });

  it('binds runtime count to playback and raw count to its highest unique-frame index', () => {
    const runtimeCountDrift = descriptor();
    runtimeCountDrift.to.frameCount = 12;
    expect(() => assertDescriptor(runtimeCountDrift, runtimeCountDrift.expectedWorkerSha)).toThrow(/invalid/i);

    const rawCountDrift = descriptor();
    rawCountDrift.to.rawFrameCount = rawCountDrift.to.frameCount;
    expect(() => assertDescriptor(rawCountDrift, rawCountDrift.expectedWorkerSha)).toThrow(/invalid/i);

    const oversizedUniqueSet = descriptor();
    oversizedUniqueSet.to.playback[11] = 12;
    oversizedUniqueSet.to.rawFrameCount = 13;
    expect(() => assertDescriptor(oversizedUniqueSet, oversizedUniqueSet.expectedWorkerSha)).toThrow(/invalid/i);
  });

  it('rejects a different Worker or asset metadata drift', () => {
    const value = descriptor();
    expect(() => assertDescriptor(value, '0'.repeat(40))).toThrow(/invalid/i);

    value.assets.runtime.filename = 'other.png';
    expect(() => assertDescriptor(value, value.expectedWorkerSha)).toThrow(/runtime metadata/i);
  });

  it('keeps a promotion receipt bound to the stage deploy for later cross-deploy rollback', () => {
    const value = descriptor();
    const descriptorSha256 = '0'.repeat(64);
    const receipt = {
      schemaVersion: 1,
      kind: 'imported-global-video-recuration-transition-v1',
      target: 'production',
      operation: 'promote',
      stageWorkerSha: value.expectedWorkerSha,
      executingWorkerSha: value.expectedWorkerSha,
      descriptorSha256,
      fighter: value.fighter,
      action: value.action,
      proposalId: value.proposalId,
      transitionId: '1'.repeat(64),
      from: value.from,
      to: value.to,
      localArcadeCachePurgeAttempted: true,
      localArcadeCacheEntryDeleted: false,
      providerCalls: 0,
    };
    expect(assertPromotionReceipt(receipt, value, descriptorSha256)).toBe(receipt);

    const rawDrift = { ...receipt, from: { ...receipt.from, rawSha256: 'f'.repeat(64) } };
    expect(() => assertPromotionReceipt(rawDrift, value, descriptorSha256)).toThrow(/does not bind/i);

    receipt.executingWorkerSha = 'f'.repeat(40);
    expect(() => assertPromotionReceipt(receipt, value, descriptorSha256)).toThrow(/does not bind/i);
  });

  it('accepts only the authoritative proposal-bound promote transition', () => {
    const value = descriptor();
    const authoritative = promoteTransitionLookup(value);
    expect(assertPromoteTransitionLookup(authoritative, value)).toBe(authoritative);

    const drift = promoteTransitionLookup(value);
    drift.transition.to.rawSha256 = '0'.repeat(64);
    expect(() => assertPromoteTransitionLookup(drift, value)).toThrow(/exact descriptor/i);
  });

  it('requires an optional local receipt to match the authoritative transition id', () => {
    const value = descriptor();
    const authoritative = promoteTransitionLookup(value);
    const receipt = { transitionId: authoritative.transition.transitionId };
    expect(assertReceiptMatchesPromoteTransition(receipt, authoritative)).toBe(receipt);

    receipt.transitionId = 'f'.repeat(64);
    expect(() => assertReceiptMatchesPromoteTransition(receipt, authoritative)).toThrow(/authoritative/i);
  });

  it('persists transition proof before smoke and retains it when smoke fails', async () => {
    const events = [];
    let persisted = false;
    await expect(persistTransitionReceiptWithSmoke(
      () => {
        events.push('receipt');
        persisted = true;
        return { digest: '1'.repeat(64) };
      },
      async () => {
        events.push('smoke');
        throw new Error('public roster is stale');
      },
    )).rejects.toThrow(/stale/i);
    expect(events).toEqual(['receipt', 'smoke']);
    expect(persisted).toBe(true);
  });
});
