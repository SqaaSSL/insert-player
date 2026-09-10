import { calibrateAuraAtlas, type AuraAnimationCalibration } from '../../game/aura/AuraPoseCalibration.ts';
import { AURA_POSE_TEMPLATES } from '../../game/aura/AuraPoseTemplates.ts';
import type { PoseFrameBounds } from '../../game/sprites/PoseFrameCalibration.ts';

export type AuraPreviewSubject = 'donald-trump' | 'template-zero';
export type AuraPreviewAnimation = 'aura_unbothered' | 'aura_one_leg' | 'aura_six_seven' | 'aura_floor_worm' | 'aura_shrug';

export interface AuraPreviewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AuraPreviewFrameGeometry {
  source: AuraPreviewRect;
  destination: AuraPreviewRect;
  sourceFrame: number;
}

/** Alpha >= 32 bounds of the exact, hash-bound public Trump atlases. */
const TRUMP_BOUNDS = {
  aura_unbothered: [
    [68, 20, 74, 219], [68, 20, 72, 220], [68, 20, 74, 220], [68, 21, 73, 219],
    [61, 21, 79, 219], [60, 22, 79, 218], [68, 20, 71, 220], [67, 19, 74, 220],
  ],
  aura_one_leg: [
    [89, 16, 88, 223], [65, 23, 174, 216], [68, 45, 170, 194], [80, 28, 162, 211],
    [65, 31, 170, 208], [57, 23, 167, 216], [60, 20, 145, 219], [99, 10, 69, 229],
  ],
  aura_six_seven: [
    [65, 12, 96, 227], [55, 9, 90, 232], [39, 12, 102, 227], [53, 9, 82, 232],
    [65, 5, 104, 228], [55, 9, 90, 232], [36, 5, 106, 228], [53, 9, 82, 232],
  ],
  aura_floor_worm: [
    [169, 24, 81, 215], [165, 110, 118, 129], [98, 126, 172, 113], [85, 185, 184, 54],
    [58, 107, 184, 132], [85, 164, 179, 75], [119, 123, 120, 116], [169, 22, 81, 217],
  ],
  aura_shrug: [
    [40, 8, 124, 231], [40, 8, 123, 231], [40, 8, 124, 231], [43, 8, 124, 232],
    [40, 8, 124, 231], [40, 8, 123, 231], [40, 8, 124, 231], [43, 8, 124, 232],
  ],
} as const;

/**
 * Six-seven keeps both feet planted. Measure the median silhouette midline in
 * rows 185..238 (alpha >= 32), below the moving hands; whole-body alpha centres
 * would mistake each hand extension for root motion. Trump drifts 27 native
 * pixels there, while the reviewed template has only 3.5 px of stance motion.
 * Retain that small authored motion, centred on the template median (106).
 * These measurements must never be applied to a regenerated same-path image.
 */
const SIX_SEVEN_SUPPORT_X = {
  'donald-trump': [94.5, 85, 68.5, 85.5, 94.5, 85, 67.5, 85.5],
  'template-zero': [105, 107, 104.5, 105, 107.5, 107, 108, 105],
} as const;
const SIX_SEVEN_REFERENCE_X = 106;

const profiles = new Map<string, AuraAnimationCalibration>();

export function auraPreviewExpectedHash(subject: AuraPreviewSubject, animation: AuraPreviewAnimation): string {
  const template = AURA_POSE_TEMPLATES[animation];
  return subject === 'donald-trump' ? template.trumpSha256 : template.templateSha256;
}

function profileFor(subject: AuraPreviewSubject, animation: AuraPreviewAnimation): AuraAnimationCalibration {
  const key = `${subject}/${animation}`;
  const cached = profiles.get(key);
  if (cached) return cached;
  const template = AURA_POSE_TEMPLATES[animation];
  const bounds: PoseFrameBounds[] = subject === 'donald-trump'
    ? TRUMP_BOUNDS[animation].map(([x, y, width, height]) => ({ x, y, width, height }))
    : template.frames.map(({ x, y, w, h }) => ({ x, y, width: w, height: h }));
  const result = calibrateAuraAtlas({
    name: animation,
    contentHash: auraPreviewExpectedHash(subject, animation),
    frameWidth: template.frameWidth,
    frameHeight: template.frameHeight,
    frameCount: template.frames.length,
    bounds,
  }, { bodyHeightRatio: 219 / 256, rootXRatio: 0.5, rootYRatio: 239 / 256 });
  profiles.set(key, result);
  return result;
}

/**
 * Lightweight canvas drawImage geometry; imports no Phaser/runtime. A caller
 * hashes the loaded image once, then passes that hash to each frame request.
 * A mismatch returns null so a future asset cannot inherit stale pose fixes.
 * Draw the full source cell into destination; transparent margins may extend
 * beyond the canvas. Scaling remains isotropic, including the floor worm.
 */
export function auraPreviewFrameGeometry(input: {
  subject: AuraPreviewSubject;
  animation: AuraPreviewAnimation;
  contentHash: string;
  frameIndex: number;
  canvasWidth: number;
  canvasHeight: number;
  bodyHeight: number;
  rootX?: number;
  rootY?: number;
}): AuraPreviewFrameGeometry | null {
  const { subject, animation, frameIndex, canvasWidth, canvasHeight, bodyHeight } = input;
  if (!Object.hasOwn(AURA_POSE_TEMPLATES, animation) || !Object.hasOwn(TRUMP_BOUNDS, animation)
    || (subject !== 'donald-trump' && subject !== 'template-zero')
    || input.contentHash !== auraPreviewExpectedHash(subject, animation)
    || !Number.isSafeInteger(frameIndex) || frameIndex < 0 || frameIndex >= 8
    || ![canvasWidth, canvasHeight, bodyHeight].every(value => Number.isFinite(value) && value > 0)) return null;
  const rootX = input.rootX ?? canvasWidth / 2;
  const rootY = input.rootY ?? canvasHeight * 15 / 16;
  if (!Number.isFinite(rootX) || !Number.isFinite(rootY)) return null;

  const template = AURA_POSE_TEMPLATES[animation];
  const profile = profileFor(subject, animation);
  const frame = profile.frames[frameIndex];
  const sourceFrame = frame.sourceFrame ?? frameIndex;
  const displayScale = bodyHeight / profile.referenceBodyHeight;
  const scale = frame.scale * displayScale;
  const width = template.frameWidth * scale;
  const height = template.frameHeight * scale;
  const x = animation === 'aura_six_seven'
    ? rootX + (SIX_SEVEN_SUPPORT_X['template-zero'][frameIndex] - SIX_SEVEN_REFERENCE_X) * displayScale
      - SIX_SEVEN_SUPPORT_X[subject][sourceFrame] * scale
    : rootX + frame.offsetX * displayScale - frame.originX * width;

  return {
    source: {
      x: sourceFrame % 4 * template.frameWidth,
      y: Math.floor(sourceFrame / 4) * template.frameHeight,
      width: template.frameWidth,
      height: template.frameHeight,
    },
    destination: { x, y: rootY + frame.offsetY * displayScale - frame.originY * height, width, height },
    sourceFrame,
  };
}
