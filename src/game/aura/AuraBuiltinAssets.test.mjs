// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ADDITIONAL_AURA_BUILTIN_ASSETS } from './AuraBuiltinAssets.ts';
import { AURA_ANIMATION_NAMES } from '../../services/FighterAssetPacks.ts';
import { AURA_POSE_TEMPLATES } from './AuraPoseTemplates.ts';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

describe('reviewed official Aura atlas artifacts', () => {
  it('ships six independent genuine performances per public subject with matching source provenance', () => {
    const allHashes = new Set();
    for (const [subject, assets] of Object.entries(ADDITIONAL_AURA_BUILTIN_ASSETS)) {
      const provenance = JSON.parse(readFileSync(resolve(`artifacts/aura-animation-canary/official-roster-v1/${subject}/manifest.json`), 'utf8'));
      expect(provenance.subject).toBe(subject);
      expect(provenance.uniqueGeneratedPoses).toBe(46);
      expect(provenance.optionalShrugIncluded).toBe(false);
      expect(assets.map(asset => asset.name).sort()).toEqual([...AURA_ANIMATION_NAMES].sort());
      for (const asset of assets) {
        const bytes = readFileSync(resolve(`public${asset.path}`));
        expect(sha(bytes)).toBe(asset.contentHash);
        expect(bytes.subarray(1, 4).toString()).toBe('PNG');
        expect(bytes.readUInt32BE(16)).toBe(asset.frameWidth * 4);
        expect(bytes.readUInt32BE(20)).toBe(asset.frameHeight * 2);
        expect(asset.frameCount).toBe(8);
        expect(allHashes.has(asset.contentHash)).toBe(false);
        allHashes.add(asset.contentHash);
        expect(asset.contentHash).not.toBe(AURA_POSE_TEMPLATES[asset.name].templateSha256);
        expect(asset.contentHash).not.toBe(AURA_POSE_TEMPLATES[asset.name].trumpSha256);
        const record = provenance.animations.find((entry) => entry.animationName === asset.name);
        expect(record.runtime.sha256).toBe(asset.contentHash);
        expect(record.visualReview.verdict).toBe('pass');
        expect(record.visualReview.runtimeSha256).toBe(asset.contentHash);
        expect(record.policy.templatePixelsInFinal).toBe(false);
        expect(record.policy.generatedIndividually).toBe(true);
        expect(record.policy.authoredScale).toBe(4);
        expect(record.registration.alphaThreshold).toBe(32);
        expect(record.registration.referenceBodyHeight).toBe(asset.referenceBodyHeight);
        expect(record.registration.referenceRootY).toBe(asset.referenceRootY);
        expect(new Set(record.frames.map((frame) => frame.rawSha256)).size).toBe(record.frames.length);
        expect(sha(readFileSync(resolve(record.contactSheet.path)))).toBe(record.contactSheet.sha256);
      }
    }
    expect(allHashes.size).toBe(12);
  });
});
