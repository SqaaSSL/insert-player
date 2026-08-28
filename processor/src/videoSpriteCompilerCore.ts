import { createHash } from 'node:crypto';
import {
  VIDEO_SPRITE_ACTION_PROFILES,
  type VideoSpriteActionProfile,
  type VideoSpriteDecision,
} from './videoSpriteContract.ts';

const ALPHA_VISIBLE = 32;
const ALPHA_ROOT = 96;
const ROUND_DIGITS = 6;

export const VIDEO_SPRITE_GATE_POLICY = Object.freeze({
  minimumAlphaAreaRatio: 0.005,
  maximumAlphaAreaRatio: 0.72,
  minimumHardLargestComponentRatio: 0.55,
  minimumReviewLargestComponentRatio: 0.88,
  maximumHardEdgeGreenSpillRatio: 0.18,
  maximumReviewEdgeGreenSpillRatio: 0.04,
  minimumSafeMarginRatio: 0.012,
  maximumDuplicateTransitionRatio: 0.45,
  duplicateMotionStep: 0.002,
  suspectedFacingFlipScore: -0.015,
  maximumSuspectedFacingFlipRatio: 0.35,
});

export interface VideoSpriteRgbaFrame {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  pngSha256?: string;
  sourceIndex: number | null;
}

export interface VideoSpriteFrameBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VideoSpriteFrameMetrics {
  sourceIndex: number | null;
  pixelSha256: string;
  alphaAreaRatio: number;
  opaqueAreaRatio: number;
  bounds: VideoSpriteFrameBounds | null;
  margins: { left: number; right: number; top: number; bottom: number } | null;
  centroid: { x: number; y: number } | null;
  root: { x: number; y: number } | null;
  connectedComponentCount: number;
  largestComponentRatio: number;
  edgeGreenSpillRatio: number;
  nonTransparentCornerRatio: number;
  sharpness: number;
}

export interface VideoSpriteTransitionMetrics {
  fromSourceIndex: number | null;
  toSourceIndex: number | null;
  pixelDifference: number;
  silhouetteDifference: number;
  centroidDistance: number;
  rootDistance: number;
  motionScore: number;
}

export interface VideoSpriteGate {
  code: string;
  severity: 'hard' | 'review';
  passed: boolean;
  value: number | string | boolean | null;
  threshold: number | string | boolean;
  evidenceFrames: number[];
}

export interface VideoSpriteCoreCompileResult {
  profile: VideoSpriteActionProfile;
  selectedVideoIndices: number[];
  playback: number[];
  translations: Array<{ dx: number; dy: number }>;
  uniqueFrames: VideoSpriteRgbaFrame[];
  playbackFrames: VideoSpriteRgbaFrame[];
  sourceMetrics: VideoSpriteFrameMetrics[];
  selectedMetrics: VideoSpriteFrameMetrics[];
  sourceTransitions: VideoSpriteTransitionMetrics[];
  selectedTransitions: VideoSpriteTransitionMetrics[];
  sequenceMetrics: {
    totalMotion: number;
    maximumMotionStep: number;
    medianMotionStep: number;
    maximumScaleStepRatio: number;
    maximumAppliedTranslationXRatio: number;
    maximumAppliedTranslationYRatio: number;
    loopSeam: number | null;
    duplicateTransitionRatio: number;
    facingConsistencyScores: number[];
    minimumFacingConsistencyScore: number;
    medianFacingConsistencyScore: number;
    suspectedFacingFlipRatio: number;
  };
  gates: VideoSpriteGate[];
  decision: VideoSpriteDecision;
  reasonCodes: string[];
}

function round(value: number): number {
  if (!Number.isFinite(value)) return value;
  return Number(value.toFixed(ROUND_DIGITS));
}

function sha256(bytes: Uint8ClampedArray): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

function assertFrame(frame: VideoSpriteRgbaFrame, expected?: { width: number; height: number }): void {
  if (!Number.isSafeInteger(frame.width) || !Number.isSafeInteger(frame.height) || frame.width < 8 || frame.height < 8) {
    throw new Error('Video sprite frame dimensions are invalid.');
  }
  if (frame.data.byteLength !== frame.width * frame.height * 4) {
    throw new Error('Video sprite RGBA byte length does not match its dimensions.');
  }
  if (expected && (frame.width !== expected.width || frame.height !== expected.height)) {
    throw new Error('All video sprite frames must have identical dimensions.');
  }
}

function connectedComponents(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  visibleCount: number,
): { count: number; largestRatio: number } {
  if (visibleCount === 0) return { count: 0, largestRatio: 0 };
  const pixelCount = width * height;
  const visited = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  const componentSizes: number[] = [];
  for (let start = 0; start < pixelCount; start += 1) {
    if (visited[start] || data[start * 4 + 3] < ALPHA_VISIBLE) continue;
    let head = 0;
    let tail = 1;
    let size = 0;
    queue[0] = start;
    visited[start] = 1;
    while (head < tail) {
      const pixel = queue[head++];
      size += 1;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      const neighbors = [
        x > 0 ? pixel - 1 : -1,
        x + 1 < width ? pixel + 1 : -1,
        y > 0 ? pixel - width : -1,
        y + 1 < height ? pixel + width : -1,
      ];
      for (const neighbor of neighbors) {
        if (neighbor < 0 || visited[neighbor] || data[neighbor * 4 + 3] < ALPHA_VISIBLE) continue;
        visited[neighbor] = 1;
        queue[tail++] = neighbor;
      }
    }
    componentSizes.push(size);
  }
  const meaningfulMinimum = Math.max(4, Math.floor(visibleCount * 0.005));
  const meaningful = componentSizes.filter((size) => size >= meaningfulMinimum);
  const largest = componentSizes.length === 0 ? 0 : Math.max(...componentSizes);
  return {
    count: meaningful.length,
    largestRatio: round(largest / visibleCount),
  };
}

export function measureVideoSpriteFrame(frame: VideoSpriteRgbaFrame): VideoSpriteFrameMetrics {
  assertFrame(frame);
  const { data, width, height } = frame;
  let visible = 0;
  let opaque = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let alphaWeight = 0;
  let weightedX = 0;
  let weightedY = 0;
  let edgeGreen = 0;
  let sharpnessSum = 0;
  let sharpnessEdges = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      const alpha = data[offset + 3];
      if (alpha < ALPHA_VISIBLE) continue;
      visible += 1;
      if (alpha >= 224) opaque += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      alphaWeight += alpha;
      weightedX += x * alpha;
      weightedY += y * alpha;
      if (alpha < 240 && green >= red + 20 && green >= blue + 20) edgeGreen += 1;
      const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
      if (x + 1 < width && data[offset + 7] >= ALPHA_VISIBLE) {
        const next = data[offset + 4] * 0.2126 + data[offset + 5] * 0.7152 + data[offset + 6] * 0.0722;
        sharpnessSum += Math.abs(luminance - next);
        sharpnessEdges += 1;
      }
      if (y + 1 < height && data[offset + width * 4 + 3] >= ALPHA_VISIBLE) {
        const belowOffset = offset + width * 4;
        const below = data[belowOffset] * 0.2126 + data[belowOffset + 1] * 0.7152 + data[belowOffset + 2] * 0.0722;
        sharpnessSum += Math.abs(luminance - below);
        sharpnessEdges += 1;
      }
    }
  }

  let cornerVisible = 0;
  let cornerSamples = 0;
  const cornerSize = Math.max(2, Math.min(6, Math.floor(Math.min(width, height) * 0.04)));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!((x < cornerSize || x >= width - cornerSize) && (y < cornerSize || y >= height - cornerSize))) continue;
      cornerSamples += 1;
      if (data[(y * width + x) * 4 + 3] >= ALPHA_VISIBLE) cornerVisible += 1;
    }
  }

  const components = connectedComponents(data, width, height, visible);
  if (visible === 0) {
    return {
      sourceIndex: frame.sourceIndex,
      pixelSha256: sha256(data),
      alphaAreaRatio: 0,
      opaqueAreaRatio: 0,
      bounds: null,
      margins: null,
      centroid: null,
      root: null,
      connectedComponentCount: 0,
      largestComponentRatio: 0,
      edgeGreenSpillRatio: 0,
      nonTransparentCornerRatio: round(cornerVisible / cornerSamples),
      sharpness: 0,
    };
  }

  const rootBandStart = maxY - Math.max(2, Math.floor((maxY - minY + 1) * 0.10));
  let rootWeight = 0;
  let rootX = 0;
  for (let y = rootBandStart; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha < ALPHA_ROOT) continue;
      rootWeight += alpha;
      rootX += x * alpha;
    }
  }

  return {
    sourceIndex: frame.sourceIndex,
    pixelSha256: sha256(data),
    alphaAreaRatio: round(visible / (width * height)),
    opaqueAreaRatio: round(opaque / (width * height)),
    bounds: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
    margins: {
      left: round(minX / width),
      right: round((width - 1 - maxX) / width),
      top: round(minY / height),
      bottom: round((height - 1 - maxY) / height),
    },
    centroid: {
      x: round((weightedX / alphaWeight) / width),
      y: round((weightedY / alphaWeight) / height),
    },
    root: {
      x: round(((rootWeight > 0 ? rootX / rootWeight : weightedX / alphaWeight)) / width),
      y: round(maxY / height),
    },
    connectedComponentCount: components.count,
    largestComponentRatio: components.largestRatio,
    edgeGreenSpillRatio: round(edgeGreen / visible),
    nonTransparentCornerRatio: round(cornerVisible / cornerSamples),
    sharpness: round(sharpnessEdges === 0 ? 0 : sharpnessSum / sharpnessEdges / 255),
  };
}

export function measureVideoSpriteTransition(
  from: VideoSpriteRgbaFrame,
  to: VideoSpriteRgbaFrame,
  fromMetrics = measureVideoSpriteFrame(from),
  toMetrics = measureVideoSpriteFrame(to),
): VideoSpriteTransitionMetrics {
  assertFrame(from);
  assertFrame(to, from);
  let union = 0;
  let intersection = 0;
  let pixelDifference = 0;
  for (let pixel = 0; pixel < from.width * from.height; pixel += 2) {
    const offset = pixel * 4;
    const fromAlpha = from.data[offset + 3] / 255;
    const toAlpha = to.data[offset + 3] / 255;
    const fromVisible = fromAlpha >= ALPHA_VISIBLE / 255;
    const toVisible = toAlpha >= ALPHA_VISIBLE / 255;
    if (!fromVisible && !toVisible) continue;
    union += 1;
    if (fromVisible && toVisible) intersection += 1;
    const alphaDifference = Math.abs(fromAlpha - toAlpha);
    const redDifference = Math.abs(from.data[offset] * fromAlpha - to.data[offset] * toAlpha) / 255;
    const greenDifference = Math.abs(from.data[offset + 1] * fromAlpha - to.data[offset + 1] * toAlpha) / 255;
    const blueDifference = Math.abs(from.data[offset + 2] * fromAlpha - to.data[offset + 2] * toAlpha) / 255;
    pixelDifference += alphaDifference * 0.45 + (redDifference + greenDifference + blueDifference) / 3 * 0.55;
  }
  const normalizedPixelDifference = union === 0 ? 0 : pixelDifference / union;
  const silhouetteDifference = union === 0 ? 0 : 1 - intersection / union;
  const centroidDistance = fromMetrics.centroid && toMetrics.centroid
    ? Math.hypot(fromMetrics.centroid.x - toMetrics.centroid.x, fromMetrics.centroid.y - toMetrics.centroid.y)
    : 0;
  const rootDistance = fromMetrics.root && toMetrics.root
    ? Math.hypot(fromMetrics.root.x - toMetrics.root.x, fromMetrics.root.y - toMetrics.root.y)
    : 0;
  const motionScore = normalizedPixelDifference * 0.62
    + silhouetteDifference * 0.25
    + centroidDistance * 0.08
    + rootDistance * 0.05;
  return {
    fromSourceIndex: from.sourceIndex,
    toSourceIndex: to.sourceIndex,
    pixelDifference: round(normalizedPixelDifference),
    silhouetteDifference: round(silhouetteDifference),
    centroidDistance: round(centroidDistance),
    rootDistance: round(rootDistance),
    motionScore: round(motionScore),
  };
}

export function buildVideoSpritePlayback(
  uniqueCount: number,
  format: VideoSpriteActionProfile['sequenceFormat'],
): number[] {
  if (!Number.isSafeInteger(uniqueCount) || uniqueCount < 2 || uniqueCount > 64) {
    throw new Error('uniqueCount must be an integer from 2 to 64.');
  }
  const forward = Array.from({ length: uniqueCount }, (_, index) => index);
  if (format !== 'forward-ping-pong') return forward;
  return [...forward, ...forward.slice(0, -1).reverse()];
}

function chooseStrictIndices(cumulative: number[], targets: number[], minimumIndex: number): number[] {
  const selected: number[] = [];
  for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
    const remaining = targets.length - targetIndex - 1;
    const lower = selected.length === 0 ? minimumIndex : selected[selected.length - 1] + 1;
    const upper = cumulative.length - remaining - 1;
    if (lower > upper) throw new Error('Not enough source frames for deterministic selection.');
    let best = lower;
    let bestDistance = Math.abs(cumulative[lower] - targets[targetIndex]);
    for (let candidate = lower + 1; candidate <= upper; candidate += 1) {
      const distance = Math.abs(cumulative[candidate] - targets[targetIndex]);
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    selected.push(best);
  }
  return selected;
}

export function selectVideoSpriteFrames(
  frames: VideoSpriteRgbaFrame[],
  profile: VideoSpriteActionProfile,
  selectedVideoIndices?: number[],
): { indices: number[]; metrics: VideoSpriteFrameMetrics[]; transitions: VideoSpriteTransitionMetrics[] } {
  const rawOnlyLoop = profile.sequenceFormat === 'loop';
  const needed = rawOnlyLoop ? profile.uniqueFrameCount : profile.uniqueFrameCount - 1;
  const minimumFrames = rawOnlyLoop ? needed : needed + 1;
  if (frames.length < minimumFrames) {
    throw new Error(`Action ${profile.action} needs at least ${minimumFrames} decoded video frames.`);
  }
  const metrics = frames.map(measureVideoSpriteFrame);
  const transitions = frames.slice(1).map((frame, index) => (
    measureVideoSpriteTransition(frames[index], frame, metrics[index], metrics[index + 1])
  ));
  if (selectedVideoIndices) {
    if (
      selectedVideoIndices.length !== needed ||
      selectedVideoIndices.some((index, position) => (
        !Number.isSafeInteger(index) || index < 0 || index >= frames.length ||
        (position > 0 && index <= selectedVideoIndices[position - 1])
      ))
    ) {
      throw new Error(`Action ${profile.action} received an invalid explicit frame selection.`);
    }
    return { indices: [...selectedVideoIndices], metrics, transitions };
  }
  const cumulative = [0];
  for (const transition of transitions) {
    cumulative.push(cumulative[cumulative.length - 1] + transition.motionScore);
  }
  const total = cumulative[cumulative.length - 1];
  const minimumIndex = rawOnlyLoop ? 0 : frames.length > needed ? 1 : 0;
  if (total <= 0.000_001) {
    const temporal = frames.map((_, index) => index);
    const targets = Array.from({ length: needed }, (_, index) => (
      rawOnlyLoop
        ? index * frames.length / profile.uniqueFrameCount
        : (index + 1) * (frames.length - 1) / needed
    ));
    return {
      indices: chooseStrictIndices(temporal, targets, minimumIndex),
      metrics,
      transitions,
    };
  }
  const targets = Array.from({ length: needed }, (_, index) => (
    rawOnlyLoop
      ? total * index / profile.uniqueFrameCount
      : total * (index + 1) / needed
  ));
  return {
    indices: chooseStrictIndices(cumulative, targets, minimumIndex),
    metrics,
    transitions,
  };
}

export function translateVideoSpriteFrame(
  frame: VideoSpriteRgbaFrame,
  dx: number,
  dy: number,
): VideoSpriteRgbaFrame {
  if (!Number.isSafeInteger(dx) || !Number.isSafeInteger(dy)) {
    throw new Error('Frame translations must be integers.');
  }
  const output = new Uint8ClampedArray(frame.data.byteLength);
  for (let y = 0; y < frame.height; y += 1) {
    const targetY = y + dy;
    if (targetY < 0 || targetY >= frame.height) continue;
    for (let x = 0; x < frame.width; x += 1) {
      const targetX = x + dx;
      if (targetX < 0 || targetX >= frame.width) continue;
      const sourceOffset = (y * frame.width + x) * 4;
      const targetOffset = (targetY * frame.width + targetX) * 4;
      output[targetOffset] = frame.data[sourceOffset];
      output[targetOffset + 1] = frame.data[sourceOffset + 1];
      output[targetOffset + 2] = frame.data[sourceOffset + 2];
      output[targetOffset + 3] = frame.data[sourceOffset + 3];
    }
  }
  return { ...frame, data: output };
}

export function mirrorVideoSpriteFrame(frame: VideoSpriteRgbaFrame): VideoSpriteRgbaFrame {
  const output = new Uint8ClampedArray(frame.data.byteLength);
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const sourceOffset = (y * frame.width + x) * 4;
      const targetOffset = (y * frame.width + (frame.width - 1 - x)) * 4;
      output[targetOffset] = frame.data[sourceOffset];
      output[targetOffset + 1] = frame.data[sourceOffset + 1];
      output[targetOffset + 2] = frame.data[sourceOffset + 2];
      output[targetOffset + 3] = frame.data[sourceOffset + 3];
    }
  }
  return { ...frame, data: output };
}

function registrationTranslation(
  anchor: VideoSpriteFrameMetrics,
  candidate: VideoSpriteFrameMetrics,
  width: number,
  height: number,
  mode: VideoSpriteActionProfile['registration'],
): { dx: number; dy: number } {
  if (mode === 'none') return { dx: 0, dy: 0 };
  if (!anchor.root || !candidate.root) return { dx: 0, dy: 0 };
  return {
    dx: mode === 'vertical-root' ? 0 : Math.round((anchor.root.x - candidate.root.x) * width),
    dy: Math.round((anchor.root.y - candidate.root.y) * height),
  };
}

const REGISTRATION_EDGE_MARGIN_PX = 2;

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function safeRegistrationAxis(
  requested: number,
  start: number,
  length: number,
  extent: number,
): number {
  const end = start + length;
  if (start === 0 || end === extent) return 0;
  const preferredMinimum = REGISTRATION_EDGE_MARGIN_PX - start;
  const preferredMaximum = extent - REGISTRATION_EDGE_MARGIN_PX - end;
  if (preferredMinimum <= preferredMaximum) {
    return clampInteger(requested, preferredMinimum, preferredMaximum);
  }
  return 0;
}

/**
 * Root registration must never turn a complete source pose into a cropped emitted frame.
 * Keep the requested integer alignment whenever it fits inside a two-pixel alpha runtime
 * margin; otherwise retain that axis at its complete source position.
 */
function safeRegistrationTranslation(
  anchor: VideoSpriteFrameMetrics,
  candidate: VideoSpriteFrameMetrics,
  width: number,
  height: number,
  mode: VideoSpriteActionProfile['registration'],
): { dx: number; dy: number } {
  const requested = registrationTranslation(anchor, candidate, width, height, mode);
  const bounds = candidate.bounds;
  if (!bounds) return requested;
  return {
    dx: safeRegistrationAxis(requested.dx, bounds.x, bounds.width, width),
    dy: safeRegistrationAxis(requested.dy, bounds.y, bounds.height, height),
  };
}

function maximum(values: number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function frameEvidence(metrics: VideoSpriteFrameMetrics[], predicate: (metric: VideoSpriteFrameMetrics) => boolean): number[] {
  return metrics.flatMap((metric, index) => predicate(metric) ? [index] : []);
}

function gate(
  code: string,
  severity: VideoSpriteGate['severity'],
  passed: boolean,
  value: VideoSpriteGate['value'],
  threshold: VideoSpriteGate['threshold'],
  evidenceFrames: number[] = [],
): VideoSpriteGate {
  return { code, severity, passed, value, threshold, evidenceFrames };
}

function buildGates(
  profile: VideoSpriteActionProfile,
  metrics: VideoSpriteFrameMetrics[],
  translations: Array<{ dx: number; dy: number }>,
  sequence: VideoSpriteCoreCompileResult['sequenceMetrics'],
  width: number,
  height: number,
  registrationMetrics: VideoSpriteFrameMetrics[] = metrics,
): VideoSpriteGate[] {
  const noForeground = frameEvidence(metrics, (metric) => (
    metric.alphaAreaRatio < VIDEO_SPRITE_GATE_POLICY.minimumAlphaAreaRatio
  ));
  const excessiveForeground = frameEvidence(metrics, (metric) => (
    metric.alphaAreaRatio > VIDEO_SPRITE_GATE_POLICY.maximumAlphaAreaRatio
  ));
  const cropped = frameEvidence(metrics, (metric) => Boolean(metric.bounds && (
    metric.bounds.x === 0 || metric.bounds.y === 0 ||
    metric.bounds.x + metric.bounds.width === width ||
    metric.bounds.y + metric.bounds.height === height
  )));
  const detachedHard = frameEvidence(metrics, (metric) => (
    metric.alphaAreaRatio >= VIDEO_SPRITE_GATE_POLICY.minimumAlphaAreaRatio &&
    metric.largestComponentRatio < VIDEO_SPRITE_GATE_POLICY.minimumHardLargestComponentRatio
  ));
  const detachedReview = frameEvidence(metrics, (metric) => (
    metric.alphaAreaRatio >= VIDEO_SPRITE_GATE_POLICY.minimumAlphaAreaRatio &&
    metric.largestComponentRatio < VIDEO_SPRITE_GATE_POLICY.minimumReviewLargestComponentRatio
  ));
  const spillHard = frameEvidence(metrics, (metric) => (
    metric.edgeGreenSpillRatio > VIDEO_SPRITE_GATE_POLICY.maximumHardEdgeGreenSpillRatio
  ));
  const spillReview = frameEvidence(metrics, (metric) => (
    metric.edgeGreenSpillRatio > VIDEO_SPRITE_GATE_POLICY.maximumReviewEdgeGreenSpillRatio
  ));
  const corners = frameEvidence(metrics, (metric) => metric.nonTransparentCornerRatio > 0);
  const unsafeMargin = frameEvidence(metrics, (metric) => Boolean(metric.margins && (
    Math.min(metric.margins.left, metric.margins.right, metric.margins.top, metric.margins.bottom) <
      VIDEO_SPRITE_GATE_POLICY.minimumSafeMarginRatio
  )));
  const registrationWouldCrop = registrationMetrics.flatMap((metric, index) => {
    const bounds = metric.bounds;
    const translation = translations[index];
    if (!bounds || !translation) return [];
    return bounds.x + translation.dx < 0 || bounds.y + translation.dy < 0 ||
      bounds.x + bounds.width + translation.dx > width ||
      bounds.y + bounds.height + translation.dy > height ? [index] : [];
  });
  return [
    gate('foreground_present', 'hard', noForeground.length === 0, noForeground.length, '0 frames below 0.5% alpha', noForeground),
    gate('foreground_bounded', 'hard', excessiveForeground.length === 0, excessiveForeground.length, '0 frames above 72% alpha', excessiveForeground),
    gate('subject_not_cropped', 'hard', cropped.length === 0, cropped.length, '0 frames touching an edge', cropped),
    gate('registration_preserves_subject', 'hard', registrationWouldCrop.length === 0, registrationWouldCrop.length, '0 translated frames cropped', registrationWouldCrop),
    gate('foreground_cohesion_hard', 'hard', detachedHard.length === 0, detachedHard.length, 'largest component >= 55%', detachedHard),
    gate('edge_green_spill_hard', 'hard', spillHard.length === 0, spillHard.length, 'edge spill <= 18%', spillHard),
    gate('transparent_corners', 'hard', corners.length === 0, corners.length, 'all sampled corners transparent', corners),
    gate('foreground_cohesion_review', 'review', detachedReview.length === 0, detachedReview.length, 'largest component >= 88%', detachedReview),
    gate('safe_subject_margin', 'review', unsafeMargin.length === 0, unsafeMargin.length, 'all margins >= 1.2%', unsafeMargin),
    gate('edge_green_spill_review', 'review', spillReview.length === 0, spillReview.length, 'edge spill <= 4%', spillReview),
    gate(
      'registration_translation_x', 'review',
      sequence.maximumAppliedTranslationXRatio <= profile.maxReviewTranslationXRatio,
      sequence.maximumAppliedTranslationXRatio, profile.maxReviewTranslationXRatio,
    ),
    gate(
      'registration_translation_y', 'review',
      sequence.maximumAppliedTranslationYRatio <= profile.maxReviewTranslationYRatio,
      sequence.maximumAppliedTranslationYRatio, profile.maxReviewTranslationYRatio,
    ),
    gate(
      'scale_continuity', 'review',
      sequence.maximumScaleStepRatio <= profile.maxReviewScaleStepRatio,
      sequence.maximumScaleStepRatio, profile.maxReviewScaleStepRatio,
    ),
    gate(
      'motion_step_continuity', 'review',
      sequence.maximumMotionStep <= profile.maxReviewMotionStep,
      sequence.maximumMotionStep, profile.maxReviewMotionStep,
    ),
    gate(
      'motion_coverage', 'review',
      profile.allowStatic || sequence.totalMotion >= profile.minReviewTotalMotion,
      sequence.totalMotion, profile.allowStatic ? 'static allowed' : profile.minReviewTotalMotion,
    ),
    gate(
      'duplicate_frame_ratio', 'review',
      profile.allowStatic || sequence.duplicateTransitionRatio <= VIDEO_SPRITE_GATE_POLICY.maximumDuplicateTransitionRatio,
      sequence.duplicateTransitionRatio,
      profile.allowStatic ? 'static allowed' : VIDEO_SPRITE_GATE_POLICY.maximumDuplicateTransitionRatio,
    ),
    gate(
      'facing_consistency_to_canonical', 'review',
      sequence.suspectedFacingFlipRatio <= VIDEO_SPRITE_GATE_POLICY.maximumSuspectedFacingFlipRatio,
      sequence.suspectedFacingFlipRatio,
      VIDEO_SPRITE_GATE_POLICY.maximumSuspectedFacingFlipRatio,
    ),
    gate(
      'loop_seam', 'review',
      profile.maxReviewLoopSeam === null || (sequence.loopSeam ?? Number.POSITIVE_INFINITY) <= profile.maxReviewLoopSeam,
      sequence.loopSeam, profile.maxReviewLoopSeam ?? 'not applicable',
    ),
  ];
}

export interface VideoSpriteSequenceEvaluation {
  selectedMetrics: VideoSpriteFrameMetrics[];
  selectedTransitions: VideoSpriteTransitionMetrics[];
  sequenceMetrics: VideoSpriteCoreCompileResult['sequenceMetrics'];
  gates: VideoSpriteGate[];
  decision: VideoSpriteDecision;
  reasonCodes: string[];
}

export function evaluateVideoSpriteSequence(
  profile: VideoSpriteActionProfile,
  canonical: VideoSpriteRgbaFrame,
  uniqueFrames: VideoSpriteRgbaFrame[],
  translations: Array<{ dx: number; dy: number }>,
  registrationSourceFrames: VideoSpriteRgbaFrame[] = uniqueFrames,
): VideoSpriteSequenceEvaluation {
  if (uniqueFrames.length !== profile.uniqueFrameCount || translations.length !== uniqueFrames.length) {
    throw new Error('Evaluated video sprite frames do not match the action profile.');
  }
  assertFrame(canonical);
  for (const frame of [...uniqueFrames, ...registrationSourceFrames]) assertFrame(frame, canonical);
  const selectedMetrics = uniqueFrames.map(measureVideoSpriteFrame);
  const registrationMetrics = registrationSourceFrames.map(measureVideoSpriteFrame);
  const selectedTransitions = uniqueFrames.slice(1).map((frame, index) => (
    measureVideoSpriteTransition(uniqueFrames[index], frame, selectedMetrics[index], selectedMetrics[index + 1])
  ));
  const motionSteps = selectedTransitions.map((transition) => transition.motionScore);
  const scaleSteps = selectedMetrics.slice(1).map((metric, index) => {
    const previous = selectedMetrics[index];
    if (!previous.bounds || !metric.bounds) return 0;
    const previousArea = previous.bounds.width * previous.bounds.height;
    const area = metric.bounds.width * metric.bounds.height;
    return previousArea === 0 ? 0 : Math.abs(area - previousArea) / previousArea;
  });
  const loopTransition = profile.sequenceFormat === 'loop'
    ? measureVideoSpriteTransition(
      uniqueFrames[uniqueFrames.length - 1],
      uniqueFrames[0],
      selectedMetrics[selectedMetrics.length - 1],
      selectedMetrics[0],
    )
    : null;
  const canonicalMetric = measureVideoSpriteFrame(canonical);
  const facingCandidates = profile.sequenceFormat === 'loop' ? uniqueFrames : uniqueFrames.slice(1);
  const facingConsistencyScores = facingCandidates.map((frame) => {
    const frameMetric = measureVideoSpriteFrame(frame);
    const normalDifference = measureVideoSpriteTransition(
      canonical, frame, canonicalMetric, frameMetric,
    ).motionScore;
    const mirrored = mirrorVideoSpriteFrame(frame);
    const mirroredDifference = measureVideoSpriteTransition(
      canonical, mirrored, canonicalMetric, measureVideoSpriteFrame(mirrored),
    ).motionScore;
    return round(mirroredDifference - normalDifference);
  });
  const suspectedFacingFlips = facingConsistencyScores.filter((score) => (
    score < VIDEO_SPRITE_GATE_POLICY.suspectedFacingFlipScore
  )).length;
  const sequenceMetrics = {
    totalMotion: round(selectedTransitions.reduce((sum, transition) => sum + transition.motionScore, 0)),
    maximumMotionStep: round(maximum(motionSteps)),
    medianMotionStep: round(median(motionSteps)),
    maximumScaleStepRatio: round(maximum(scaleSteps)),
    maximumAppliedTranslationXRatio: round(maximum(translations.map((translation) => Math.abs(translation.dx) / canonical.width))),
    maximumAppliedTranslationYRatio: round(maximum(translations.map((translation) => Math.abs(translation.dy) / canonical.height))),
    loopSeam: loopTransition ? loopTransition.motionScore : null,
    duplicateTransitionRatio: round(
      motionSteps.filter((step) => step < VIDEO_SPRITE_GATE_POLICY.duplicateMotionStep).length /
        Math.max(1, motionSteps.length),
    ),
    facingConsistencyScores,
    minimumFacingConsistencyScore: round(Math.min(...facingConsistencyScores)),
    medianFacingConsistencyScore: round(median(facingConsistencyScores)),
    suspectedFacingFlipRatio: round(suspectedFacingFlips / Math.max(1, facingConsistencyScores.length)),
  };
  const gates = buildGates(
    profile,
    selectedMetrics,
    translations,
    sequenceMetrics,
    canonical.width,
    canonical.height,
    registrationMetrics,
  );
  const hardFailures = gates.filter((entry) => entry.severity === 'hard' && !entry.passed);
  const reviewFailures = gates.filter((entry) => entry.severity === 'review' && !entry.passed);
  const decision: VideoSpriteDecision = hardFailures.length > 0
    ? 'reject'
    : reviewFailures.length > 0 ? 'needs_review' : 'technical_pass';
  return {
    selectedMetrics,
    selectedTransitions,
    sequenceMetrics,
    gates,
    decision,
    reasonCodes: gates.filter((entry) => !entry.passed).map((entry) => entry.code),
  };
}

export function compileVideoSpriteFrames(
  action: keyof typeof VIDEO_SPRITE_ACTION_PROFILES,
  canonical: VideoSpriteRgbaFrame,
  videoFrames: VideoSpriteRgbaFrame[],
  selectedVideoIndices?: number[],
): VideoSpriteCoreCompileResult {
  assertFrame(canonical);
  for (const frame of videoFrames) assertFrame(frame, canonical);
  const profile = VIDEO_SPRITE_ACTION_PROFILES[action];
  const selection = selectVideoSpriteFrames(videoFrames, profile, selectedVideoIndices);
  const rawOnlyLoop = profile.sequenceFormat === 'loop';
  const selectedSources = rawOnlyLoop
    ? selection.indices.map((index) => videoFrames[index])
    : [canonical, ...selection.indices.map((index) => videoFrames[index])];
  const canonicalMetric = measureVideoSpriteFrame(canonical);
  const sourceSelectedMetrics = selectedSources.map(measureVideoSpriteFrame);
  const translations = sourceSelectedMetrics.map((metric, index) => (
    !rawOnlyLoop && index === 0
      ? { dx: 0, dy: 0 }
      : safeRegistrationTranslation(
          canonicalMetric,
          metric,
          canonical.width,
          canonical.height,
          profile.registration,
        )
  ));
  const uniqueFrames = selectedSources.map((frame, index) => (
    translateVideoSpriteFrame(frame, translations[index].dx, translations[index].dy)
  ));
  const evaluation = evaluateVideoSpriteSequence(
    profile,
    canonical,
    uniqueFrames,
    translations,
    selectedSources,
  );
  const playback = buildVideoSpritePlayback(profile.uniqueFrameCount, profile.sequenceFormat);
  return {
    profile,
    selectedVideoIndices: selection.indices,
    playback,
    translations,
    uniqueFrames,
    playbackFrames: playback.map((index) => uniqueFrames[index]),
    sourceMetrics: selection.metrics,
    selectedMetrics: evaluation.selectedMetrics,
    sourceTransitions: selection.transitions,
    selectedTransitions: evaluation.selectedTransitions,
    sequenceMetrics: evaluation.sequenceMetrics,
    gates: evaluation.gates,
    decision: evaluation.decision,
    reasonCodes: evaluation.reasonCodes,
  };
}
