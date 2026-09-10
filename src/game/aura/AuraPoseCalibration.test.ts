import { describe, expect, it } from 'vitest';
import { auraIdleReference, calibrateAuraAtlas, type AuraAtlasGeometry } from './AuraPoseCalibration.ts';
import { AURA_POSE_TEMPLATES, type AuraPoseTemplate } from './AuraPoseTemplates.ts';

function atlas(name: keyof typeof AURA_POSE_TEMPLATES, trump = false): AuraAtlasGeometry {
  const template = AURA_POSE_TEMPLATES[name];
  return {
    name, contentHash: trump ? template.trumpSha256 : template.templateSha256,
    frameWidth: template.frameWidth, frameHeight: template.frameHeight, frameCount: template.frames.length,
    bounds: template.frames.map(box => ({ x: box.x, y: box.y, width: box.w, height: box.h })),
  };
}
const idle = auraIdleReference(atlas('aura_unbothered'));

describe('hash-bound Aura pose registration', () => {
  it('projects all 56 target poses relative to the same body height, not cell height', () => {
    for (const name of Object.keys(AURA_POSE_TEMPLATES) as (keyof typeof AURA_POSE_TEMPLATES)[]) {
      const input = atlas(name);
      const template = AURA_POSE_TEMPLATES[name];
      const result = calibrateAuraAtlas(input, idle);
      expect(result.policy).toBe('template-pose-v1');
      expect(result.audit?.verdict).toBe('geometry-match');
      for (const [index, frame] of result.frames.entries()) {
        const worldScale = 200 / result.referenceBodyHeight;
        const source = input.bounds[index]!;
        expect(source.height * frame.scale * worldScale)
          .toBeCloseTo(200 * template.frames[index].h / template.referenceBodyHeight);
        expect(frame.offsetY).toBe(0);
      }
    }
  });

  it('cancels extra per-frame zoom while retaining the expected crouch proportion', () => {
    const input = atlas('aura_floor_worm', true);
    input.bounds = input.bounds.map((box, index) => index !== 3 ? box : {
      x: box!.x, y: box!.y - box!.height * 0.2, width: box!.width * 1.2, height: box!.height * 1.2,
    });
    const result = calibrateAuraAtlas(input, idle);
    expect(result.frames[3].scale).toBeCloseTo(1 / 1.2);
    expect(input.bounds[3]!.height * result.frames[3].scale / result.referenceBodyHeight).toBeCloseTo(0.25);
    expect(result.audit!.before!.maxAbsolutePrimaryAxisErrorRatio).toBeCloseTo(0.2);
    expect(result.audit!.after!.maxAdjacentPrimaryAxisDrift).toBeCloseTo(0);
  });

  it('uses the existing neutral recovery for Trump one-leg entry without a size pulse', () => {
    const result = calibrateAuraAtlas(atlas('aura_one_leg', true), idle);
    expect(result.frames[0]).toEqual(result.frames[7]);
    expect(result.frames[0].sourceFrame).toBe(7);
    expect(calibrateAuraAtlas(atlas('aura_one_leg'), idle).frames[0].sourceFrame).toBe(0);
  });

  it('does not apply a known choreography to an unknown hash, name or cell layout', () => {
    const input = atlas('aura_floor_worm');
    for (const changes of [{ contentHash: 'new-provider-result' }, { name: 'aura_custom' }, { frameCount: 24 }]) {
      const result = calibrateAuraAtlas({ ...input, ...changes }, idle);
      expect(result.policy).toBe('shared-idle-v1');
      expect(result.frames.every(frame => frame.scale === 1)).toBe(true);
    }
  });

  it('keeps legacy pose and root motion under one pack-wide idle reference at any density', () => {
    const standard = { ...atlas('aura_floor_worm'), contentHash: 'legacy' };
    const hq = { ...standard, frameWidth: standard.frameWidth * 4, frameHeight: standard.frameHeight * 4 };
    const a = calibrateAuraAtlas(standard, idle), b = calibrateAuraAtlas(hq, idle);
    expect(b.referenceBodyHeight).toBe(a.referenceBodyHeight * 4);
    expect(a.frames).toEqual(b.frames);
    expect(a.frames[0].originY).toBeCloseTo(239 / 256);
    expect(a.referenceBodyHeight).toBe(219);
  });

  it('rejects broken known source geometry, not silently returning a fit-clamped frame', () => {
    const input = atlas('aura_unbothered');
    input.bounds = [null, ...input.bounds.slice(1)];
    expect(() => calibrateAuraAtlas(input, idle)).toThrow('rejected frames');
  });

  it('records independent shape errors even after matching pose height', () => {
    const input = atlas('aura_unbothered', true);
    input.bounds = input.bounds.map(box => ({ ...box!, width: box!.width * 0.7 }));
    const result = calibrateAuraAtlas(input, idle);
    expect(result.audit?.verdict).toBe('shape-mismatch');
    expect(result.audit?.after?.maxAbsolutePrimaryAxisErrorRatio).toBe(0);
    expect(result.audit?.after?.maxAbsoluteSecondaryAxisErrorRatio).toBeCloseTo(0.3);
  });

  it('has documented neutral references and exact hashes for every reviewed choreography', () => {
    for (const template of Object.values(AURA_POSE_TEMPLATES) as AuraPoseTemplate[]) {
      expect(template.referenceFrameIndices.length).toBeGreaterThan(0);
      expect(template.referenceNotes.length).toBeGreaterThan(50);
      expect(template.templateSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(template.trumpSha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
