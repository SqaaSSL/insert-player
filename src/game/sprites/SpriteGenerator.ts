import Phaser from 'phaser';
import { FighterState, FIGHTER_WIDTH, FIGHTER_HEIGHT } from '../constants.ts';
import {
  VIDEO_DENSE_SPRITE_ANIMATION_FORMAT,
  type SpriteAnimationFormat,
} from '../../SpriteAnimationFormat.ts';

const FW = FIGHTER_WIDTH;
const FH = FIGHTER_HEIGHT;

const STATE_FRAMES: Record<string, number> = {
  [FighterState.IDLE]: 4,
  [FighterState.WALK_FORWARD]: 6,
  [FighterState.WALK_BACKWARD]: 6,
  [FighterState.JUMP]: 3,
  [FighterState.CROUCH]: 2,
  [FighterState.HIGH_PUNCH]: 3,
  [FighterState.LOW_PUNCH]: 3,
  [FighterState.HIGH_KICK]: 4,
  [FighterState.LOW_KICK]: 3,
  [FighterState.BLOCK]: 2,
  [FighterState.HIT_STUN]: 2,
  [FighterState.KNOCKDOWN]: 4,
  [FighterState.FIREBALL]: 4,
  [FighterState.UPPERCUT]: 5,
  [FighterState.VICTORY]: 3,
  [FighterState.DEFEAT]: 2,
};

export const MAX_DENSE_VIDEO_FRAMES = 12;
export const MAX_DENSE_HIGH_KICK_FRAMES = MAX_DENSE_VIDEO_FRAMES;
const LEGACY_HIGH_KICK_MAX_FRAMES = 7;

export type SpritePlaybackMode = 'timeline' | 'forward-ping-pong';
export type SpriteSourceFormat =
  | 'timeline'
  | 'forward-keyframes'
  | 'expanded-ping-pong';

export interface SpriteRuntimeProfile {
  frameCount: number;
  playbackMode: SpritePlaybackMode;
  sourceFormat: SpriteSourceFormat;
  durationTicks?: number;
}

export type HighKickRuntimeProfile = SpriteRuntimeProfile;

/**
 * Per-state visual presentation for a full-canvas sprite frame.
 *
 * `scale` and `offsetY` are composed with the stage-level render scale. The
 * origin keeps the animation's measured root anchored to the fighter without
 * rewriting the source atlas coordinates.
 */
export interface SpritePresentationProfile {
  scale: number;
  originX: number;
  originY: number;
  offsetY: number;
}

export const DEFAULT_SPRITE_PRESENTATION_PROFILE: Readonly<SpritePresentationProfile> = {
  scale: 1,
  originX: 0.5,
  originY: 1,
  offsetY: 0,
};

export interface ComposedSpritePresentation extends SpritePresentationProfile {
  y: number;
}

const FORWARD_PING_PONG_STATES = new Set<FighterState>([
  FighterState.HIGH_PUNCH,
  FighterState.LOW_PUNCH,
  FighterState.HIGH_KICK,
  FighterState.LOW_KICK,
]);

const DENSE_VIDEO_SOURCE_MIN: Partial<Record<FighterState, number>> = {
  [FighterState.IDLE]: 8,
  [FighterState.WALK_FORWARD]: 8,
  [FighterState.WALK_BACKWARD]: 8,
  [FighterState.JUMP]: 5,
  [FighterState.CROUCH]: 5,
  [FighterState.HIGH_PUNCH]: 6,
  [FighterState.LOW_PUNCH]: 7,
  [FighterState.HIGH_KICK]: 8,
  [FighterState.LOW_KICK]: 9,
  [FighterState.HIT_STUN]: 5,
  [FighterState.KNOCKDOWN]: 9,
  [FighterState.VICTORY]: 9,
};

const DENSE_VIDEO_RUNTIME_MAX: Partial<Record<FighterState, number>> = {
  [FighterState.IDLE]: 8,
  [FighterState.WALK_FORWARD]: 12,
  [FighterState.WALK_BACKWARD]: 12,
  [FighterState.JUMP]: 8,
  [FighterState.CROUCH]: 6,
  [FighterState.HIGH_PUNCH]: 6,
  [FighterState.LOW_PUNCH]: 7,
  [FighterState.HIGH_KICK]: 12,
  [FighterState.LOW_KICK]: 9,
  [FighterState.HIT_STUN]: 6,
  [FighterState.KNOCKDOWN]: 12,
  [FighterState.VICTORY]: 12,
};

const DENSE_VIDEO_DURATION_TICKS: Partial<Record<FighterState, number>> = {
  [FighterState.IDLE]: 120,
  [FighterState.WALK_FORWARD]: 90,
  [FighterState.WALK_BACKWARD]: 90,
  [FighterState.JUMP]: 48,
  [FighterState.CROUCH]: 8,
  [FighterState.HIT_STUN]: 14,
  [FighterState.KNOCKDOWN]: 30,
  [FighterState.VICTORY]: 108,
};

const STATE_ORDER: FighterState[] = [
  FighterState.IDLE,
  FighterState.WALK_FORWARD,
  FighterState.WALK_BACKWARD,
  FighterState.JUMP,
  FighterState.CROUCH,
  FighterState.HIGH_PUNCH,
  FighterState.LOW_PUNCH,
  FighterState.HIGH_KICK,
  FighterState.LOW_KICK,
  FighterState.BLOCK,
  FighterState.HIT_STUN,
  FighterState.KNOCKDOWN,
  FighterState.FIREBALL,
  FighterState.UPPERCUT,
  FighterState.VICTORY,
  FighterState.DEFEAT,
];

export interface SpriteSheetLayout {
  stateRow: Record<string, number>;
  frameCounts: Record<string, number>;
  playbackModes: Partial<Record<string, SpritePlaybackMode>>;
  durationTicks: Partial<Record<string, number>>;
  presentationProfiles: Partial<Record<string, SpritePresentationProfile>>;
  totalColumns: number;
  textureDensity: number;
}

const registeredLayouts = new Map<string, SpriteSheetLayout>();

export function createSpriteLayout(
  frameCountOverrides: Partial<Record<FighterState, number>> = {},
  playbackModeOverrides: Partial<Record<FighterState, SpritePlaybackMode>> = {},
  durationTickOverrides: Partial<Record<FighterState, number>> = {},
  presentationProfileOverrides: Partial<Record<FighterState, SpritePresentationProfile>> = {},
  textureDensity = 1,
): SpriteSheetLayout {
  const stateRow: Record<string, number> = {};
  const frameCounts = { ...STATE_FRAMES };
  const playbackModes: Partial<Record<string, SpritePlaybackMode>> = {};
  const durationTicks: Partial<Record<string, number>> = {};
  const presentationProfiles: Partial<Record<string, SpritePresentationProfile>> = {};

  for (const [state, frameCount] of Object.entries(frameCountOverrides)) {
    if (Number.isInteger(frameCount) && frameCount > 0) {
      frameCounts[state] = frameCount;
    }
  }
  for (const [state, playbackMode] of Object.entries(playbackModeOverrides)) {
    if (playbackMode) playbackModes[state] = playbackMode;
  }
  for (const [state, duration] of Object.entries(durationTickOverrides)) {
    if (Number.isInteger(duration) && duration > 0) durationTicks[state] = duration;
  }
  for (const [state, profile] of Object.entries(presentationProfileOverrides)) {
    if (
      Number.isFinite(profile.scale) && profile.scale > 0 &&
      Number.isFinite(profile.originX) &&
      Number.isFinite(profile.originY) &&
      Number.isFinite(profile.offsetY)
    ) {
      presentationProfiles[state] = { ...profile };
    }
  }

  let maxCols = 0;
  STATE_ORDER.forEach((state, row) => {
    stateRow[state] = row;
    maxCols = Math.max(maxCols, frameCounts[state]);
  });
  return {
    stateRow,
    frameCounts,
    playbackModes,
    durationTicks,
    presentationProfiles,
    totalColumns: maxCols,
    textureDensity: Number.isFinite(textureDensity) && textureDensity > 0
      ? textureDensity
      : 1,
  };
}

export function getSpritePresentationProfile(
  layout: SpriteSheetLayout,
  state: FighterState,
): Readonly<SpritePresentationProfile> {
  return layout.presentationProfiles[state] ?? DEFAULT_SPRITE_PRESENTATION_PROFILE;
}

export function composeSpritePresentation(
  profile: Readonly<SpritePresentationProfile>,
  renderScale: number,
  baseY: number,
  renderYOffset = 0,
  textureDensity = 1,
): ComposedSpritePresentation {
  const normalizedTextureDensity = Number.isFinite(textureDensity) && textureDensity > 0
    ? textureDensity
    : 1;
  return {
    scale: profile.scale * renderScale / normalizedTextureDensity,
    originX: profile.originX,
    originY: profile.originY,
    offsetY: profile.offsetY,
    y: baseY + renderYOffset + profile.offsetY * renderScale,
  };
}

/** Displayed crouch height relative to the idle; mirrors the 0.6x gameplay
 * hurtbox with a little visual headroom. */
export const LEGACY_CROUCH_DISPLAY_HEIGHT_RATIO = 0.62;
/** Crouched attacks extend limbs, so they sit taller than the idle crouch —
 * same 0.75/0.90 proportion the dense pipeline uses for low attacks. */
export const LEGACY_LOW_ATTACK_DISPLAY_HEIGHT_RATIO = 0.83;
const LEGACY_CROUCH_MIN_PRESENTATION_SCALE = 0.45;

/**
 * Legacy sheets normalize every animation's content to fill its atlas cell,
 * erasing the pose's real height — an AI-drawn crouch or low attack renders
 * as tall as the idle. Given the drawn content heights of both cells, return
 * the presentation scale that pins the pose's displayed height to the given
 * ratio of the idle's. Never upscales (a naturally short pose stays as
 * drawn).
 */
export function calculateLegacyCrouchPresentationScale(
  idleContentHeight: number,
  poseContentHeight: number,
  targetRatio = LEGACY_CROUCH_DISPLAY_HEIGHT_RATIO,
): number {
  if (
    !Number.isFinite(idleContentHeight) || idleContentHeight <= 0 ||
    !Number.isFinite(poseContentHeight) || poseContentHeight <= 0 ||
    !Number.isFinite(targetRatio) || targetRatio <= 0
  ) {
    return 1;
  }
  const scale = (targetRatio * idleContentHeight) / poseContentHeight;
  return Math.min(1, Math.max(LEGACY_CROUCH_MIN_PRESENTATION_SCALE, scale));
}

export function getFacingSpriteOriginX(sourceOriginX: number, flipped: boolean): number {
  return flipped ? 1 - sourceOriginX : sourceOriginX;
}

export function getSpriteLayout(spriteKey?: string): SpriteSheetLayout {
  if (spriteKey) {
    const registered = registeredLayouts.get(spriteKey);
    if (registered) return registered;
  }
  return createSpriteLayout();
}

export function registerSpriteLayout(spriteKey: string, layout: SpriteSheetLayout): void {
  registeredLayouts.set(spriteKey, layout);
}

export function getAnimationRuntimeProfile(
  state: FighterState,
  sourceFrameCount?: number,
  animationFormat: SpriteAnimationFormat = 'legacy',
): SpriteRuntimeProfile {
  if (!Number.isFinite(sourceFrameCount) || !sourceFrameCount || sourceFrameCount < 1) {
    return {
      frameCount: STATE_FRAMES[state] ?? 1,
      playbackMode: 'timeline',
      sourceFormat: 'timeline',
    };
  }

  const normalizedSourceCount = Math.floor(sourceFrameCount);
  const runtimeMax = DENSE_VIDEO_RUNTIME_MAX[state];
  const denseSourceMin = DENSE_VIDEO_SOURCE_MIN[state];
  const supportsForwardPingPong = FORWARD_PING_PONG_STATES.has(state);
  const supportsDenseVideo = state === FighterState.HIGH_KICK ||
    animationFormat === VIDEO_DENSE_SPRITE_ANIMATION_FORMAT;
  const isExpandedPingPong = supportsDenseVideo && supportsForwardPingPong &&
    runtimeMax !== undefined &&
    normalizedSourceCount > runtimeMax &&
    normalizedSourceCount <= runtimeMax * 2 - 1 &&
    normalizedSourceCount % 2 === 1;

  if (isExpandedPingPong) {
    return {
      frameCount: Math.min((normalizedSourceCount + 1) / 2, runtimeMax ?? MAX_DENSE_VIDEO_FRAMES),
      playbackMode: 'forward-ping-pong',
      sourceFormat: 'expanded-ping-pong',
    };
  }

  const isDenseVideoSource = supportsDenseVideo &&
    runtimeMax !== undefined &&
    denseSourceMin !== undefined &&
    normalizedSourceCount >= denseSourceMin &&
    normalizedSourceCount <= MAX_DENSE_VIDEO_FRAMES;

  if (isDenseVideoSource) {
    const playbackMode = supportsForwardPingPong ? 'forward-ping-pong' : 'timeline';
    return {
      frameCount: Math.min(normalizedSourceCount, runtimeMax),
      playbackMode,
      sourceFormat: playbackMode === 'forward-ping-pong' ? 'forward-keyframes' : 'timeline',
      durationTicks: DENSE_VIDEO_DURATION_TICKS[state],
    };
  }

  // HIGH_KICK was the first dense-video action. Preserve its historical
  // 4-7-cell runtime behavior while every other legacy animation keeps the
  // original procedural target count above.
  if (state === FighterState.HIGH_KICK && normalizedSourceCount <= LEGACY_HIGH_KICK_MAX_FRAMES) {
    return {
      frameCount: normalizedSourceCount,
      playbackMode: 'timeline',
      sourceFormat: 'timeline',
    };
  }

  return {
    frameCount: STATE_FRAMES[state] ?? 1,
    playbackMode: 'timeline',
    sourceFormat: 'timeline',
  };
}

export function getHighKickRuntimeProfile(sourceFrameCount?: number): HighKickRuntimeProfile {
  return getAnimationRuntimeProfile(FighterState.HIGH_KICK, sourceFrameCount);
}

/**
 * Generates a simple colored silhouette placeholder spritesheet.
 * Used as fallback when AI-generated sprites are not available.
 */
export interface ProceduralFighterStyle {
  accentColor?: string;
  armor?: 'none' | 'light' | 'heavy';
  headgear?: 'none' | 'mask' | 'visor' | 'commander';
}

export function generateFighterSpriteSheet(
  scene: Phaser.Scene,
  key: string,
  bodyColor: string,
  skinColor: string,
  style: ProceduralFighterStyle = {},
): void {
  const layout = getSpriteLayout();
  registerSpriteLayout(key, layout);
  const cols = layout.totalColumns;
  const rows = STATE_ORDER.length;
  const sheetW = cols * FW;
  const sheetH = rows * FH;

  const canvas = document.createElement('canvas');
  canvas.width = sheetW;
  canvas.height = sheetH;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, sheetW, sheetH);

  STATE_ORDER.forEach((state, row) => {
    const numFrames = STATE_FRAMES[state];
    for (let f = 0; f < numFrames; f++) {
      drawSilhouette(ctx, f * FW, row * FH, bodyColor, skinColor, state, f, style);
    }
  });

  if (scene.textures.exists(key)) {
    scene.textures.remove(key);
  }
  const tex = scene.textures.addCanvas(key + '_canvas', canvas);
  const sourceImage = tex!.getSourceImage() as HTMLCanvasElement;

  scene.textures.addSpriteSheet(key, sourceImage as unknown as HTMLImageElement, {
    frameWidth: FW,
    frameHeight: FH,
  });

  scene.textures.remove(key + '_canvas');
}

function drawSilhouette(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  bodyColor: string,
  skinColor: string,
  state: FighterState,
  frame: number,
  style: ProceduralFighterStyle,
): void {
  const cx = ox + FW / 2;
  const baseY = oy + FH - 7;
  const outline = '#07070b';
  const trousers = '#171522';
  const accent = style.accentColor ?? '#ffce3a';
  const jumpOffset = state === FighterState.JUMP ? -28 : 0;
  const breathing = state === FighterState.IDLE ? (frame % 2 === 0 ? 0 : 2) : 0;
  const crouched = state === FighterState.CROUCH
    || state === FighterState.BLOCK
    || state === FighterState.LOW_PUNCH
    || state === FighterState.LOW_KICK;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (state === FighterState.KNOCKDOWN || state === FighterState.DEFEAT) {
    const floorY = baseY - 12;
    ctx.strokeStyle = outline;
    ctx.lineWidth = 25;
    ctx.beginPath();
    ctx.moveTo(cx - 42, floorY - 5);
    ctx.lineTo(cx + 26, floorY - 20);
    ctx.lineTo(cx + 66, floorY - 5);
    ctx.stroke();
    ctx.strokeStyle = bodyColor;
    ctx.lineWidth = 17;
    ctx.stroke();
    ctx.fillStyle = skinColor;
    ctx.strokeStyle = outline;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(cx - 60, floorY - 3, 16, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    return;
  }

  const headY = oy + (crouched ? 99 : 60) + jumpOffset + breathing;
  const shoulderY = headY + 34;
  const hipY = shoulderY + (crouched ? 54 : 78);
  const stride = state === FighterState.WALK_FORWARD || state === FighterState.WALK_BACKWARD
    ? (frame % 3 - 1) * 10
    : 0;

  const drawLimb = (points: Array<[number, number]>, color: string, width: number): void => {
    ctx.strokeStyle = outline;
    ctx.lineWidth = width + 7;
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (const [x, y] of points.slice(1)) ctx.lineTo(x, y);
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  };

  const leftLeg: Array<[number, number]> = crouched
    ? [[cx - 13, hipY], [cx - 40, hipY + 24], [cx - 50, baseY + jumpOffset]]
    : [[cx - 13, hipY], [cx - 22 + stride, hipY + 36], [cx - 29 + stride, baseY + jumpOffset]];
  let rightLeg: Array<[number, number]> = crouched
    ? [[cx + 13, hipY], [cx + 40, hipY + 22], [cx + 52, baseY + jumpOffset]]
    : [[cx + 13, hipY], [cx + 24 - stride, hipY + 36], [cx + 35 - stride, baseY + jumpOffset]];
  if (state === FighterState.HIGH_KICK) {
    rightLeg = [[cx + 10, hipY], [cx + 46, hipY - 24], [cx + 82, hipY - 52]];
  } else if (state === FighterState.LOW_KICK) {
    rightLeg = [[cx + 10, hipY], [cx + 52, hipY + 9], [cx + 82, hipY + 3]];
  }
  drawLimb(leftLeg, trousers, 16);
  drawLimb(rightLeg, trousers, 16);

  for (const leg of [leftLeg, rightLeg]) {
    const [footX, footY] = leg[leg.length - 1];
    ctx.fillStyle = outline;
    ctx.beginPath();
    ctx.ellipse(footX + 5, footY, 17, 8, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = bodyColor;
  ctx.strokeStyle = outline;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(cx - 31, shoulderY + 2);
  ctx.quadraticCurveTo(cx - 24, shoulderY - 8, cx, shoulderY - 8);
  ctx.quadraticCurveTo(cx + 25, shoulderY - 8, cx + 32, shoulderY + 3);
  ctx.lineTo(cx + 22, hipY + 4);
  ctx.lineTo(cx - 22, hipY + 4);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.38)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx, shoulderY + 2);
  ctx.lineTo(cx, hipY - 4);
  ctx.stroke();
  if (style.armor && style.armor !== 'none') {
    ctx.fillStyle = accent;
    ctx.strokeStyle = outline;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(cx - (style.armor === 'heavy' ? 28 : 22), shoulderY + 8);
    ctx.lineTo(cx + (style.armor === 'heavy' ? 28 : 22), shoulderY + 8);
    ctx.lineTo(cx + 18, hipY - 14);
    ctx.lineTo(cx - 18, hipY - 14);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = outline;
    ctx.fillRect(cx - 3, shoulderY + 13, 6, Math.max(10, hipY - shoulderY - 32));
    if (style.armor === 'heavy') {
      ctx.fillStyle = accent;
      ctx.strokeStyle = outline;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.ellipse(cx - 31, shoulderY + 8, 16, 10, -0.25, 0, Math.PI * 2);
      ctx.ellipse(cx + 31, shoulderY + 8, 16, 10, 0.25, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  let leftArm: Array<[number, number]> = [[cx - 27, shoulderY + 8], [cx - 48, shoulderY + 34], [cx - 22, shoulderY + 48]];
  let rightArm: Array<[number, number]> = [[cx + 27, shoulderY + 8], [cx + 48, shoulderY + 24], [cx + 30, shoulderY + 43]];
  if (state === FighterState.HIGH_PUNCH || state === FighterState.FIREBALL) {
    rightArm = [[cx + 26, shoulderY + 8], [cx + 58, shoulderY + 8], [cx + 84, shoulderY + 4]];
  } else if (state === FighterState.LOW_PUNCH) {
    rightArm = [[cx + 26, shoulderY + 10], [cx + 57, shoulderY + 34], [cx + 82, shoulderY + 42]];
  } else if (state === FighterState.UPPERCUT) {
    rightArm = [[cx + 25, shoulderY + 8], [cx + 37, shoulderY - 24], [cx + 29, shoulderY - 52]];
  } else if (state === FighterState.BLOCK) {
    leftArm = [[cx - 26, shoulderY + 8], [cx - 5, shoulderY + 25], [cx + 16, shoulderY + 5]];
    rightArm = [[cx + 26, shoulderY + 8], [cx + 8, shoulderY + 28], [cx - 16, shoulderY + 9]];
  } else if (state === FighterState.VICTORY) {
    leftArm = [[cx - 26, shoulderY + 8], [cx - 44, shoulderY - 18], [cx - 38, shoulderY - 48]];
    rightArm = [[cx + 26, shoulderY + 8], [cx + 44, shoulderY - 18], [cx + 38, shoulderY - 48]];
  } else if (state === FighterState.HIT_STUN) {
    leftArm = [[cx - 25, shoulderY + 10], [cx - 50, shoulderY + 8], [cx - 67, shoulderY + 30]];
    rightArm = [[cx + 25, shoulderY + 10], [cx + 46, shoulderY + 2], [cx + 64, shoulderY + 24]];
  }
  drawLimb(leftArm, bodyColor, 12);
  drawLimb(rightArm, bodyColor, 12);

  for (const arm of [leftArm, rightArm]) {
    const [handX, handY] = arm[arm.length - 1];
    ctx.fillStyle = bodyColor;
    ctx.strokeStyle = outline;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(handX, handY, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  ctx.fillStyle = skinColor;
  ctx.strokeStyle = outline;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(cx, headY, 18, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = outline;
  ctx.beginPath();
  ctx.arc(cx - 4, headY - 5, 16, Math.PI, Math.PI * 1.92);
  ctx.lineTo(cx + 15, headY - 4);
  ctx.quadraticCurveTo(cx + 5, headY - 20, cx - 4, headY - 19);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(cx + 7, headY - 1, 2, 0, Math.PI * 2);
  ctx.fill();
  if (style.headgear && style.headgear !== 'none') {
    ctx.strokeStyle = outline;
    ctx.lineWidth = 4;
    if (style.headgear === 'mask') {
      ctx.fillStyle = '#171522';
      ctx.beginPath();
      ctx.roundRect(cx - 18, headY - 4, 36, 20, 6);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = accent;
      ctx.fillRect(cx - 12, headY + 2, 24, 3);
    } else {
      ctx.fillStyle = style.headgear === 'commander' ? accent : '#111827';
      ctx.beginPath();
      ctx.roundRect(cx - 21, headY - 13, 42, 20, 7);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = style.headgear === 'commander' ? '#fff4d6' : accent;
      ctx.fillRect(cx - 14, headY - 7, 28, 5);
      if (style.headgear === 'commander') {
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.moveTo(cx - 18, headY - 18);
        ctx.lineTo(cx + 20, headY - 18);
        ctx.lineTo(cx + 13, headY - 28);
        ctx.lineTo(cx - 11, headY - 25);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}
