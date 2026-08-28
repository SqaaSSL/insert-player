import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertDescriptor,
  assertPromotionReceipt,
  assertSourceBinding,
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
    action: 'idle',
    proposalId: '2'.repeat(32),
    worker: {
      expectedSha: expectedWorkerSha,
      versionId: 'worker-version',
      versionTag: `prod-${expectedWorkerSha}-1`,
    },
    from: {
      processedSha256: '3'.repeat(64),
      rawSha256: '4'.repeat(64),
      frameWidth: 192,
      frameHeight: 256,
      frameCount: 8,
      processingVersion: 5,
    },
    to: {
      processedSha256: '5'.repeat(64),
      rawSha256: '6'.repeat(64),
      frameWidth: 192,
      frameHeight: 256,
      frameCount: 8,
      rawFrameWidth: 768,
      rawFrameHeight: 1024,
      rawFrameCount: 8,
      processingVersion: 6,
      technicalOutcome: 'technical_pass',
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
  it('accepts a complete sealed stage descriptor pinned to one Worker', () => {
    const value = descriptor();
    expect(assertDescriptor(value, value.expectedWorkerSha)).toBe(value);
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

    receipt.executingWorkerSha = 'f'.repeat(40);
    expect(() => assertPromotionReceipt(receipt, value, descriptorSha256)).toThrow(/does not bind/i);
  });
});
