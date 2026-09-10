/** Half-open alpha bounds in native source-cell pixels (not atlas pixels). */
export interface PoseFrameBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PoseFramePoint {
  x: number;
  y: number;
}

export type PoseNormalizationAxis = 'height' | 'width';

export interface PoseFrameCalibrationInput {
  frameWidth: number;
  frameHeight: number;
  sourceBounds: PoseFrameBounds | null;
  targetBounds: PoseFrameBounds;
  /** The animation's STANDING root, not this frame's moving feet/support. */
  targetRoot: PoseFramePoint;
  /** Common standing-body height. Same native pixel units as all bounds. */
  referenceBodyHeight: number;
  /** Horizontal choreography must explicitly select width; never auto-detect. */
  normalizationAxis?: PoseNormalizationAxis;
  /** Allows a segmentation/decoder to report clipping beyond bbox edge tests. */
  sourceClipped?: boolean;
  /** Relative discrepancy in the unfitted dimension; default 0.15 (15%). */
  secondaryAxisToleranceRatio?: number;
}

export interface PoseFrameCalibration {
  /** Isotropic per-RAW correction, independent of display/body-size scaling. */
  scale: number;
  /** Source center/bottom, normalized to source cell dimensions; never flipped. */
  originX: number;
  originY: number;
  /** Native pixel offsets from the standing root; NOT fractions or world units. */
  offsetX: number;
  offsetY: number;
  referenceBodyHeight: number;
}

/** Signed errors relative to the intended pose, not relative to standing size. */
export interface PoseFrameResidual {
  primaryAxisErrorRatio: number;
  secondaryAxisErrorRatio: number;
  widthErrorBodyHeights: number;
  heightErrorBodyHeights: number;
  centerXErrorBodyHeights: number;
  bottomErrorBodyHeights: number;
}

export interface PoseFrameCalibrationAudit {
  /** Geometry only: even a match does not attest anatomy, identity or semantics. */
  verdict: 'geometry-match' | 'shape-mismatch';
  normalizationAxis: PoseNormalizationAxis;
  before: PoseFrameResidual;
  after: PoseFrameResidual;
  normalizedBounds: PoseFrameBounds;
  secondaryAxisErrorRatio: number;
  shapeMismatch: boolean;
}

export type PoseFrameCalibrationFailureReason =
  | 'invalid-frame-size'
  | 'empty-source-bounds'
  | 'invalid-source-bounds'
  | 'source-clipped'
  | 'invalid-target-bounds'
  | 'invalid-target-root'
  | 'invalid-reference-body-height'
  | 'invalid-normalization-axis'
  | 'invalid-shape-tolerance'
  | 'invalid-correction'
  | 'normalized-bounds-clipped';

export type PoseFrameCalibrationResult =
  | { ok: true; calibration: PoseFrameCalibration; audit: PoseFrameCalibrationAudit }
  | { ok: false; reason: PoseFrameCalibrationFailureReason };

const DEFAULT_SHAPE_TOLERANCE = 0.15;
const NUMERICAL_EPSILON = 1e-10;

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function validBounds(bounds: PoseFrameBounds): boolean {
  return Number.isFinite(bounds.x) && Number.isFinite(bounds.y)
    && finitePositive(bounds.width) && finitePositive(bounds.height)
    && Number.isFinite(bounds.x + bounds.width) && Number.isFinite(bounds.y + bounds.height);
}

function insideCell(bounds: PoseFrameBounds, width: number, height: number, epsilon = 0): boolean {
  return bounds.x >= -epsilon && bounds.y >= -epsilon
    && bounds.x + bounds.width <= width + epsilon
    && bounds.y + bounds.height <= height + epsilon;
}

function residual(
  bounds: PoseFrameBounds,
  target: PoseFrameBounds,
  referenceBodyHeight: number,
  axis: PoseNormalizationAxis,
): PoseFrameResidual {
  const otherAxis = axis === 'height' ? 'width' : 'height';
  return {
    primaryAxisErrorRatio: bounds[axis] / target[axis] - 1,
    secondaryAxisErrorRatio: bounds[otherAxis] / target[otherAxis] - 1,
    widthErrorBodyHeights: (bounds.width - target.width) / referenceBodyHeight,
    heightErrorBodyHeights: (bounds.height - target.height) / referenceBodyHeight,
    centerXErrorBodyHeights: (bounds.x + bounds.width / 2 - target.x - target.width / 2) / referenceBodyHeight,
    bottomErrorBodyHeights: (bounds.y + bounds.height - target.y - target.height) / referenceBodyHeight,
  };
}

/**
 * Correct provider zoom to THIS pose's expected extent, never to standing height.
 * Rendering contract (apply displayScale = desiredBodyHeight/referenceBodyHeight):
 *   scale = displayScale * calibration.scale
 *   position = standingWorldRoot + calibration.offset * displayScale
 *   origin = calibration.origin
 * The renderer mirrors originX and the sign of offsetX together when facing left.
 * No flip state belongs here. Target-root offsets retain jumps/lateral motion.
 *
 * Source pixels are neither resampled nor cropped by this pure calculation. A
 * correction that overflows its source-sized cell is rejected, never fit-clamped.
 * Matching the fitted axis by construction is NOT evidence of a correct shape:
 * the secondary dimension remains in the audit and can report shape-mismatch.
 */
export function calibratePoseFrame(input: PoseFrameCalibrationInput): PoseFrameCalibrationResult {
  const { frameWidth, frameHeight, sourceBounds, targetBounds, targetRoot, referenceBodyHeight } = input;
  if (!Number.isSafeInteger(frameWidth) || !Number.isSafeInteger(frameHeight)
    || frameWidth <= 0 || frameHeight <= 0) return { ok: false, reason: 'invalid-frame-size' };
  if (!sourceBounds || sourceBounds.width === 0 || sourceBounds.height === 0) {
    return { ok: false, reason: 'empty-source-bounds' };
  }
  if (!validBounds(sourceBounds)) return { ok: false, reason: 'invalid-source-bounds' };
  // Bounds touching an image edge cannot prove that the silhouette is complete.
  if (input.sourceClipped || !insideCell(sourceBounds, frameWidth, frameHeight)
    || sourceBounds.x <= 0 || sourceBounds.y <= 0
    || sourceBounds.x + sourceBounds.width >= frameWidth
    || sourceBounds.y + sourceBounds.height >= frameHeight) return { ok: false, reason: 'source-clipped' };
  if (!validBounds(targetBounds) || !insideCell(targetBounds, frameWidth, frameHeight)) {
    return { ok: false, reason: 'invalid-target-bounds' };
  }
  if (!Number.isFinite(targetRoot.x) || !Number.isFinite(targetRoot.y)
    || targetRoot.x < 0 || targetRoot.x > frameWidth || targetRoot.y < 0 || targetRoot.y > frameHeight) {
    return { ok: false, reason: 'invalid-target-root' };
  }
  if (!finitePositive(referenceBodyHeight)) return { ok: false, reason: 'invalid-reference-body-height' };
  const axis = input.normalizationAxis ?? 'height';
  if (axis !== 'height' && axis !== 'width') return { ok: false, reason: 'invalid-normalization-axis' };
  const tolerance = input.secondaryAxisToleranceRatio ?? DEFAULT_SHAPE_TOLERANCE;
  if (!Number.isFinite(tolerance) || tolerance < 0) return { ok: false, reason: 'invalid-shape-tolerance' };

  const scale = targetBounds[axis] / sourceBounds[axis];
  const width = sourceBounds.width * scale;
  const height = sourceBounds.height * scale;
  const targetCenterX = targetBounds.x + targetBounds.width / 2;
  const targetBottom = targetBounds.y + targetBounds.height;
  const normalizedBounds = { x: targetCenterX - width / 2, y: targetBottom - height, width, height };
  if (!finitePositive(scale) || !validBounds(normalizedBounds)) return { ok: false, reason: 'invalid-correction' };
  // Tolerance only absorbs floating-point roundoff; it never changes the scale.
  if (!insideCell(normalizedBounds, frameWidth, frameHeight, NUMERICAL_EPSILON * Math.max(frameWidth, frameHeight))) {
    return { ok: false, reason: 'normalized-bounds-clipped' };
  }
  const before = residual(sourceBounds, targetBounds, referenceBodyHeight, axis);
  const after = residual(normalizedBounds, targetBounds, referenceBodyHeight, axis);
  if (![...Object.values(before), ...Object.values(after)].every(Number.isFinite)) {
    return { ok: false, reason: 'invalid-correction' };
  }
  const shapeMismatch = Math.abs(after.secondaryAxisErrorRatio) > tolerance + NUMERICAL_EPSILON;
  return {
    ok: true,
    calibration: {
      scale,
      originX: (sourceBounds.x + sourceBounds.width / 2) / frameWidth,
      originY: (sourceBounds.y + sourceBounds.height) / frameHeight,
      offsetX: targetCenterX - targetRoot.x,
      offsetY: targetBottom - targetRoot.y,
      referenceBodyHeight,
    },
    audit: { verdict: shapeMismatch ? 'shape-mismatch' : 'geometry-match', normalizationAxis: axis,
      before, after, normalizedBounds, secondaryAxisErrorRatio: after.secondaryAxisErrorRatio, shapeMismatch },
  };
}

export interface PoseSequenceResidualAudit {
  maxAbsolutePrimaryAxisErrorRatio: number;
  maxAbsoluteSecondaryAxisErrorRatio: number;
  maxAbsoluteCenterXErrorBodyHeights: number;
  maxAbsoluteBottomErrorBodyHeights: number;
  maxAdjacentPrimaryAxisDrift: number;
  maxAdjacentSecondaryAxisDrift: number;
  maxAdjacentCenterXDriftBodyHeights: number;
  maxAdjacentBottomDriftBodyHeights: number;
}

export interface PoseFrameSequenceAudit {
  verdict: 'geometry-match' | 'shape-mismatch' | 'rejected';
  /** Empty sequences and inconsistent native reference heights are rejected. */
  reason?: 'empty-sequence' | 'inconsistent-reference-body-height' | 'invalid-frame';
  frames: PoseFrameCalibrationResult[];
  rejectedFrameIndices: number[];
  shapeMismatchFrameIndices: number[];
  /** Null on rejected input; skipping a bad frame must not create a fake pass. */
  before: PoseSequenceResidualAudit | null;
  after: PoseSequenceResidualAudit | null;
}

function auditResiduals(values: readonly PoseFrameResidual[]): PoseSequenceResidualAudit {
  const maxAbsolute = (field: keyof PoseFrameResidual) => Math.max(...values.map(value => Math.abs(value[field])));
  const maxAdjacent = (field: keyof PoseFrameResidual) => values.reduce((max, value, index) => index === 0
    ? max : Math.max(max, Math.abs(value[field] - values[index - 1][field])), 0);
  return {
    maxAbsolutePrimaryAxisErrorRatio: maxAbsolute('primaryAxisErrorRatio'),
    maxAbsoluteSecondaryAxisErrorRatio: maxAbsolute('secondaryAxisErrorRatio'),
    maxAbsoluteCenterXErrorBodyHeights: maxAbsolute('centerXErrorBodyHeights'),
    maxAbsoluteBottomErrorBodyHeights: maxAbsolute('bottomErrorBodyHeights'),
    maxAdjacentPrimaryAxisDrift: maxAdjacent('primaryAxisErrorRatio'),
    maxAdjacentSecondaryAxisDrift: maxAdjacent('secondaryAxisErrorRatio'),
    maxAdjacentCenterXDriftBodyHeights: maxAdjacent('centerXErrorBodyHeights'),
    maxAdjacentBottomDriftBodyHeights: maxAdjacent('bottomErrorBodyHeights'),
  };
}

/**
 * Audit residual changes after subtracting EACH frame's intended choreography.
 * Raw bbox heights are never compared as though crouching/jumping were zoom.
 * Supply loop closure explicitly by repeating the first frame if it matters.
 */
export function auditPoseFrameSequence(inputs: readonly PoseFrameCalibrationInput[]): PoseFrameSequenceAudit {
  const frames = inputs.map(calibratePoseFrame);
  const rejectedFrameIndices = frames.flatMap((frame, index) => frame.ok ? [] : [index]);
  const shapeMismatchFrameIndices = frames.flatMap((frame, index) => frame.ok && frame.audit.shapeMismatch ? [index] : []);
  const reason = inputs.length === 0 ? 'empty-sequence'
    : inputs.some(input => input.referenceBodyHeight !== inputs[0].referenceBodyHeight) ? 'inconsistent-reference-body-height'
      : rejectedFrameIndices.length > 0 ? 'invalid-frame' : undefined;
  if (reason) return { verdict: 'rejected', reason, frames, rejectedFrameIndices, shapeMismatchFrameIndices, before: null, after: null };
  const valid = frames.filter((frame): frame is Extract<PoseFrameCalibrationResult, { ok: true }> => frame.ok);
  return {
    verdict: shapeMismatchFrameIndices.length ? 'shape-mismatch' : 'geometry-match',
    frames, rejectedFrameIndices, shapeMismatchFrameIndices,
    before: auditResiduals(valid.map(frame => frame.audit.before)),
    after: auditResiduals(valid.map(frame => frame.audit.after)),
  };
}
