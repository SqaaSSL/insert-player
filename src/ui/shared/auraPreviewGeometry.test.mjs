import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { auraPreviewExpectedHash, auraPreviewFrameGeometry } from './auraPreviewGeometry.ts';

const subjects = ['donald-trump', 'template-zero'];
const animations = ['aura_unbothered', 'aura_one_leg', 'aura_six_seven', 'aura_floor_worm', 'aura_shrug'];
const layout = { canvasWidth: 480, canvasHeight: 512, bodyHeight: 420, rootX: 240, rootY: 480 };

describe('reviewed landing Aura preview geometry', () => {
  it('binds every crop to the current real PNG and retains isotropic scaling for every pose', () => {
    for (const subject of subjects) {
      for (const animation of animations) {
        const bytes = readFileSync(new URL(`../../../public/assets/aura/${subject}/${animation}.png`, import.meta.url));
        const contentHash = createHash('sha256').update(bytes).digest('hex');
        expect(contentHash).toBe(auraPreviewExpectedHash(subject, animation));
        const atlasWidth = bytes.readUInt32BE(16), atlasHeight = bytes.readUInt32BE(20);
        for (let frameIndex = 0; frameIndex < 8; frameIndex += 1) {
          const result = auraPreviewFrameGeometry({ ...layout, subject, animation, contentHash, frameIndex });
          expect(result).not.toBeNull();
          const { source, destination } = result;
          expect(source.x).toBeGreaterThanOrEqual(0);
          expect(source.y).toBeGreaterThanOrEqual(0);
          expect(source.x + source.width).toBeLessThanOrEqual(atlasWidth);
          expect(source.y + source.height).toBeLessThanOrEqual(atlasHeight);
          expect(destination.width / source.width).toBeCloseTo(destination.height / source.height, 12);
          expect(Object.values(destination).every(Number.isFinite)).toBe(true);
        }
      }
    }
  });

  it('reduces measured six-seven support drift from 27 px to the authored 3.5 px without anchoring moving hands', () => {
    // Independently measured alpha>=32 lower-leg midlines, rows185..238.
    const observedSupport = [94.5, 85, 68.5, 85.5, 94.5, 85, 67.5, 85.5];
    const observedBottom = [239, 241, 239, 241, 233, 241, 233, 241];
    const observedBodyHeight = [227, 232, 227, 232, 228, 232, 228, 232];
    const expectedPoseHeight = [227, 232, 227, 232, 229, 232, 229, 232];
    const subject = 'donald-trump', animation = 'aura_six_seven';
    const positions = observedSupport.map((supportX, frameIndex) => {
      const result = auraPreviewFrameGeometry({
        ...layout, bodyHeight: 230.5, subject, animation,
        contentHash: auraPreviewExpectedHash(subject, animation), frameIndex,
      });
      const scale = result.destination.width / result.source.width;
      expect(result.destination.y + observedBottom[frameIndex] * scale).toBeCloseTo(layout.rootY);
      expect(observedBodyHeight[frameIndex] * scale).toBeCloseTo(expectedPoseHeight[frameIndex]);
      return result.destination.x + supportX * scale;
    });
    expect(Math.max(...observedSupport) - Math.min(...observedSupport)).toBe(27);
    expect(Math.max(...positions) - Math.min(...positions)).toBeCloseTo(3.5);
    expect(positions[1]).toBeCloseTo(positions[5]);
    expect(positions[3]).toBeCloseTo(positions[7]);
  });

  it('retains the reviewed one-leg neutral reuse and floor-worm crouch proportions', () => {
    const subject = 'donald-trump';
    const hop = (frameIndex) => auraPreviewFrameGeometry({
      ...layout, subject, animation: 'aura_one_leg', frameIndex,
      contentHash: auraPreviewExpectedHash(subject, 'aura_one_leg'),
    });
    expect(hop(0)).toEqual(hop(7));
    expect(hop(0)?.sourceFrame).toBe(7);
    const worm = auraPreviewFrameGeometry({
      ...layout, subject, animation: 'aura_floor_worm', frameIndex: 3,
      contentHash: auraPreviewExpectedHash(subject, 'aura_floor_worm'),
    });
    // Frame3 is prone:54px tall versus216px standing, not stretched upright.
    expect(54 * worm.destination.height / worm.source.height).toBeCloseTo(layout.bodyHeight / 4);
  });

  it('refuses stale images and malformed geometry instead of applying old corrections', () => {
    const input = {
      ...layout, subject: 'donald-trump', animation: 'aura_six_seven', frameIndex: 0,
      contentHash: auraPreviewExpectedHash('donald-trump', 'aura_six_seven'),
    };
    for (const changed of [
      { contentHash: 'regenerated-image' }, { frameIndex: -1 }, { frameIndex: 8 }, { frameIndex: 1.5 },
      { bodyHeight: 0 }, { canvasWidth: Number.NaN }, { rootX: Number.POSITIVE_INFINITY },
    ]) expect(auraPreviewFrameGeometry({ ...input, ...changed })).toBeNull();
  });
});
