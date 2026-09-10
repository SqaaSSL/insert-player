import { describe, expect, it } from 'vitest';
import { auditPoseFrameSequence, calibratePoseFrame } from './PoseFrameCalibration.ts';
import type { PoseFrameBounds, PoseFrameCalibrationInput, PoseFramePoint } from './PoseFrameCalibration.ts';

const STANDING: PoseFrameBounds = { x: 70, y: 40, width: 60, height: 200 };
const ROOT = { x: 100, y: 240 };

function input(overrides: Partial<PoseFrameCalibrationInput> = {}): PoseFrameCalibrationInput {
  return { frameWidth: 240, frameHeight: 300, sourceBounds: { ...STANDING }, targetBounds: { ...STANDING },
    targetRoot: { ...ROOT }, referenceBodyHeight: 200, ...overrides };
}

/** Simulate isotropic provider zoom around an arbitrary fixed canvas point. */
function zoom(bounds: PoseFrameBounds, scale: number, anchor = ROOT): PoseFrameBounds {
  return { x: anchor.x + (bounds.x - anchor.x) * scale, y: anchor.y + (bounds.y - anchor.y) * scale,
    width: bounds.width * scale, height: bounds.height * scale };
}

function accepted(value: PoseFrameCalibrationInput) {
  const result = calibratePoseFrame(value);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result;
}

/** Same composition the renderer uses, expressed without Phaser or scene state. */
function renderPoint(value: PoseFrameCalibrationInput, point: PoseFramePoint, desiredBodyHeight: number, flipped = false) {
  const { calibration: c } = accepted(value);
  const unitScale = desiredBodyHeight / c.referenceBodyHeight;
  const sign = flipped ? -1 : 1;
  const originX = flipped ? 1 - c.originX : c.originX;
  const sourceX = flipped ? value.frameWidth - point.x : point.x;
  return {
    x: sign * c.offsetX * unitScale + (sourceX - originX * value.frameWidth) * c.scale * unitScale,
    y: c.offsetY * unitScale + (point.y - c.originY * value.frameHeight) * c.scale * unitScale,
  };
}

function density(value: PoseFrameCalibrationInput, factor: number): PoseFrameCalibrationInput {
  const bounds = (b: PoseFrameBounds) => ({ x: b.x * factor, y: b.y * factor, width: b.width * factor, height: b.height * factor });
  return { ...value, frameWidth: value.frameWidth * factor, frameHeight: value.frameHeight * factor,
    sourceBounds: value.sourceBounds ? bounds(value.sourceBounds) : null, targetBounds: bounds(value.targetBounds),
    targetRoot: { x: value.targetRoot.x * factor, y: value.targetRoot.y * factor }, referenceBodyHeight: value.referenceBodyHeight * factor };
}

describe('pose frame calibration', () => {
  it('keeps an exact standing frame unchanged with source-sized-cell origins', () => {
    const result = accepted(input());
    expect(result.calibration).toEqual({ scale: 1, originX: 100 / 240, originY: 240 / 300, offsetX: 0, offsetY: 0, referenceBodyHeight: 200 });
    expect(result.audit.verdict).toBe('geometry-match');
    expect(Object.values(result.audit.before).every(value => value === 0)).toBe(true);
  });

  it('preserves a 95% expected pose while removing spurious provider zoom', () => {
    const target = { x: 71.5, y: 50, width: 57, height: 190 };
    const value = input({ targetBounds: target, sourceBounds: zoom(target, 1.15) });
    const result = accepted(value);
    expect(result.calibration.scale).toBeCloseTo(1 / 1.15);
    expect(result.calibration.referenceBodyHeight).toBe(200);
    expect(result.audit.normalizedBounds.height).toBeCloseTo(190);
    expect(result.audit.normalizedBounds.height).not.toBe(200);
    expect(result.audit.before.primaryAxisErrorRatio).toBeCloseTo(0.15);
    expect(result.audit.after.primaryAxisErrorRatio).toBeCloseTo(0);
    expect(result.audit.shapeMismatch).toBe(false);
  });

  it('corrects each RAW separately instead of applying one batch correction', () => {
    const target = { x: 72, y: 55, width: 56, height: 185 };
    const values = [0.8, 1, 1.15].map(factor => input({ targetBounds: target, sourceBounds: zoom(target, factor) }));
    const results = values.map(accepted);
    expect(results.map(result => result.calibration.scale)).toEqual([1.25, 1, 1 / 1.15]);
    for (const result of results) expect(result.audit.normalizedBounds.height).toBeCloseTo(185);
  });

  it('does not enlarge a crouched pose to standing height', () => {
    const target = { x: 64, y: 140, width: 85, height: 100 };
    const result = accepted(input({ targetBounds: target, sourceBounds: zoom(target, 1.2) }));
    expect(result.audit.normalizedBounds.height).toBeCloseTo(100);
    expect(result.calibration.offsetY).toBe(0);
    expect(result.calibration.offsetX).toBe(6.5);
    expect(result.calibration.referenceBodyHeight).toBe(200);
  });

  it('keeps authored jump lift and lateral displacement relative to a standing root', () => {
    const target = { x: 100, y: 70, width: 60, height: 120 };
    const value = input({ targetBounds: target, sourceBounds: zoom(target, 1.2) });
    const result = accepted(value);
    expect(result.calibration.offsetX).toBe(30);
    expect(result.calibration.offsetY).toBe(-50);
    const source = value.sourceBounds!;
    const rendered = renderPoint(value, { x: source.x + source.width / 2, y: source.y + source.height }, 200);
    expect(rendered.x).toBeCloseTo(30); expect(rendered.y).toBeCloseTo(-50);
  });

  it('uses explicit width normalization for a wide horizontal floor pose', () => {
    const target = { x: 40, y: 200, width: 280, height: 40 };
    const value = input({ frameWidth: 384, targetRoot: { x: 192, y: 240 }, normalizationAxis: 'width',
      targetBounds: target, sourceBounds: { x: 22, y: 180, width: 336, height: 50 } });
    const result = accepted(value);
    expect(result.calibration.scale).toBeCloseTo(280 / 336);
    expect(result.audit.normalizedBounds.width).toBeCloseTo(280);
    expect(result.audit.normalizedBounds.height).toBeCloseTo(50 * 280 / 336);
    expect(result.calibration.offsetY).toBe(0);
    expect(result.audit.after.secondaryAxisErrorRatio).toBeCloseTo(1 / 24);
    expect(accepted({ ...value, normalizationAxis: 'height' }).calibration.scale).toBeCloseTo(0.8);
  });

  it('flags secondary shape mismatch instead of calling an after-fit height match a pass', () => {
    const result = accepted(input({ sourceBounds: { x: 54, y: 40, width: 92, height: 200 } }));
    expect(result.audit.after.primaryAxisErrorRatio).toBe(0);
    expect(result.audit.after.secondaryAxisErrorRatio).toBeCloseTo(92 / 60 - 1);
    expect(result.audit.shapeMismatch).toBe(true);
    expect(result.audit.verdict).toBe('shape-mismatch');
  });

  it('reports secondary temporal shape drift even when fitted primary drift is zero', () => {
    const audit = auditPoseFrameSequence([input(), input({ sourceBounds: { x: 55, y: 40, width: 90, height: 200 } })]);
    expect(audit.verdict).toBe('shape-mismatch');
    expect(audit.shapeMismatchFrameIndices).toEqual([1]);
    expect(audit.after!.maxAdjacentPrimaryAxisDrift).toBe(0);
    expect(audit.after!.maxAdjacentSecondaryAxisDrift).toBeCloseTo(0.5);
  });

  it('does not silently shrink a correction to fit a cell', () => {
    expect(calibratePoseFrame(input({ sourceBounds: { x: 15, y: 100, width: 210, height: 100 } })))
      .toEqual({ ok: false, reason: 'normalized-bounds-clipped' });
  });

  it('returns flip-independent origins and lets the renderer mirror the entire registration', () => {
    const target = { x: 110, y: 100, width: 50, height: 110 };
    const value = input({ targetBounds: target, sourceBounds: { x: 40, y: 60, width: 60, height: 132 } });
    const source = value.sourceBounds!;
    const point = { x: source.x + 12, y: source.y + 35 };
    const unflipped = renderPoint(value, point, 180), flipped = renderPoint(value, point, 180, true);
    expect(flipped.x).toBeCloseTo(-unflipped.x);
    expect(flipped.y).toBeCloseTo(unflipped.y);
    expect(accepted(value).calibration.originX).toBe(70 / 240);
    expect(accepted(value).calibration.offsetX).toBe(35);
  });

  it('has identical world rendering at 1x and 4x source density', () => {
    const value = input({ targetBounds: { x: 110, y: 100, width: 50, height: 110 }, sourceBounds: { x: 40, y: 60, width: 60, height: 132 } });
    const hq = density(value, 4);
    const one = accepted(value), four = accepted(hq);
    expect(four.calibration.scale).toBe(one.calibration.scale);
    expect(four.calibration.originX).toBe(one.calibration.originX);
    expect(four.calibration.originY).toBe(one.calibration.originY);
    expect(four.calibration.offsetX).toBe(one.calibration.offsetX * 4);
    expect(four.calibration.offsetY).toBe(one.calibration.offsetY * 4);
    expect(four.audit.before).toEqual(one.audit.before);
    expect(four.audit.after).toEqual(one.audit.after);
    for (const flip of [false, true]) {
      const low = renderPoint(value, { x: 50, y: 90 }, 180, flip);
      const high = renderPoint(hq, { x: 200, y: 360 }, 180, flip);
      expect(high.x).toBeCloseTo(low.x); expect(high.y).toBeCloseTo(low.y);
    }
  });

  it.each([
    [null, 'empty-source-bounds'],
    [{ x: 10, y: 10, width: 0, height: 20 }, 'empty-source-bounds'],
    [{ x: 10, y: 10, width: -1, height: 20 }, 'invalid-source-bounds'],
    [{ x: Number.NaN, y: 10, width: 20, height: 20 }, 'invalid-source-bounds'],
    [{ x: 10, y: 10, width: 20, height: Infinity }, 'invalid-source-bounds'],
    [{ x: 0, y: 10, width: 20, height: 20 }, 'source-clipped'],
    [{ x: 10, y: 0, width: 20, height: 20 }, 'source-clipped'],
    [{ x: 220, y: 10, width: 20, height: 20 }, 'source-clipped'],
    [{ x: 10, y: 280, width: 20, height: 20 }, 'source-clipped'],
    [{ x: -1, y: 10, width: 20, height: 20 }, 'source-clipped'],
  ] as const)('rejects invalid or potentially clipped alpha bounds: %j', (sourceBounds, reason) => {
    expect(calibratePoseFrame(input({ sourceBounds }))).toEqual({ ok: false, reason });
  });

  it('honors external clipping evidence even with an interior bbox', () => {
    expect(calibratePoseFrame(input({ sourceClipped: true }))).toEqual({ ok: false, reason: 'source-clipped' });
  });

  it.each([
    [{ frameWidth: Infinity }, 'invalid-frame-size'],
    [{ frameHeight: 0 }, 'invalid-frame-size'],
    [{ frameWidth: 240.5 }, 'invalid-frame-size'],
    [{ targetBounds: { x: 20, y: 20, width: 300, height: 10 } }, 'invalid-target-bounds'],
    [{ targetBounds: { x: 20, y: 20, width: 10, height: Number.NaN } }, 'invalid-target-bounds'],
    [{ targetRoot: { x: 100, y: Infinity } }, 'invalid-target-root'],
    [{ targetRoot: { x: -1, y: 200 } }, 'invalid-target-root'],
    [{ referenceBodyHeight: 0 }, 'invalid-reference-body-height'],
    [{ referenceBodyHeight: Infinity }, 'invalid-reference-body-height'],
    [{ secondaryAxisToleranceRatio: -1 }, 'invalid-shape-tolerance'],
  ] as const)('rejects invalid calibration contract: %j', (overrides, reason) => {
    expect(calibratePoseFrame(input(overrides))).toEqual({ ok: false, reason });
  });
});

describe('temporal pose residual audit', () => {
  it('subtracts intended crouch, jump and sideways motion instead of flagging choreography as drift', () => {
    const targets = [STANDING, { x: 65, y: 135, width: 90, height: 105 }, { x: 112, y: 55, width: 64, height: 115 }];
    const audit = auditPoseFrameSequence(targets.map(target => input({ targetBounds: target, sourceBounds: target })));
    expect(audit.verdict).toBe('geometry-match');
    expect(Object.values(audit.before!).every(value => value === 0)).toBe(true);
    expect(Object.values(audit.after!).every(value => value === 0)).toBe(true);
  });

  it('quantifies provider zoom/root drift before and residual drift after normalization', () => {
    const target = { x: 70, y: 70, width: 60, height: 150 };
    const values = [0.9, 1.1, 1].map((factor, index) => {
      const source = zoom(target, factor); source.x += index * 3; source.y -= index * 2;
      return input({ sourceBounds: source, targetBounds: target });
    });
    const audit = auditPoseFrameSequence(values);
    expect(audit.before!.maxAdjacentPrimaryAxisDrift).toBeCloseTo(0.2);
    expect(audit.before!.maxAdjacentCenterXDriftBodyHeights).toBeGreaterThan(0);
    expect(audit.before!.maxAdjacentBottomDriftBodyHeights).toBeGreaterThan(0);
    for (const value of Object.values(audit.after!)) expect(value).toBeCloseTo(0);
    const hq = auditPoseFrameSequence(values.map(value => density(value, 4)));
    expect(hq.before).toEqual(audit.before); expect(hq.after).toEqual(audit.after);
  });

  it('rejects missing frames rather than hiding a temporal gap in a successful summary', () => {
    const audit = auditPoseFrameSequence([input(), input({ sourceBounds: null }), input()]);
    expect(audit.verdict).toBe('rejected'); expect(audit.reason).toBe('invalid-frame');
    expect(audit.rejectedFrameIndices).toEqual([1]);
    expect(audit.before).toBeNull(); expect(audit.after).toBeNull();
  });

  it('rejects inconsistent native reference heights and empty sequences', () => {
    expect(auditPoseFrameSequence([]).reason).toBe('empty-sequence');
    const audit = auditPoseFrameSequence([input(), input({ referenceBodyHeight: 190 })]);
    expect(audit.reason).toBe('inconsistent-reference-body-height');
    expect(audit.before).toBeNull(); expect(audit.after).toBeNull();
  });

  it('does not mutate input geometry or return a live reference to target bounds', () => {
    const value = input(), snapshot = structuredClone(value);
    const result = accepted(value);
    result.audit.normalizedBounds.x = 999;
    expect(value).toEqual(snapshot);
  });
});
