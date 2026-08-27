import Phaser from 'phaser';
import { FighterState, FIGHTER_WIDTH, FIGHTER_HEIGHT } from '../constants.ts';
import { getAllSpritesForHash, type CachedSprite } from '../../services/SpriteCache.ts';
import {
  createSpriteLayout,
  getAnimationRuntimeProfile,
  registerSpriteLayout,
  type SpriteRuntimeProfile,
} from './SpriteGenerator.ts';
import { debugInfo } from '../../services/DebugLog.ts';
import {
  VIDEO_DENSE_SPRITE_ANIMATION_FORMAT,
  type SpriteAnimationFormat,
} from '../../SpriteAnimationFormat.ts';

const ANIM_NAME_TO_STATE: Record<string, FighterState> = {
  idle: FighterState.IDLE,
  walk: FighterState.WALK_FORWARD,
  high_punch: FighterState.HIGH_PUNCH,
  low_punch: FighterState.LOW_PUNCH,
  high_kick: FighterState.HIGH_KICK,
  low_kick: FighterState.LOW_KICK,
  jump: FighterState.JUMP,
  crouch: FighterState.CROUCH,
  hit: FighterState.HIT_STUN,
  ko: FighterState.KNOCKDOWN,
  victory: FighterState.VICTORY,
};

const FALLBACK_MAP: Partial<Record<FighterState, FighterState>> = {
  [FighterState.WALK_BACKWARD]: FighterState.WALK_FORWARD,
  [FighterState.BLOCK]: FighterState.CROUCH,
  [FighterState.FIREBALL]: FighterState.HIGH_PUNCH,
  [FighterState.UPPERCUT]: FighterState.HIGH_PUNCH,
  [FighterState.VICTORY]: FighterState.IDLE,
  [FighterState.DEFEAT]: FighterState.KNOCKDOWN,
};

const LOOPING_STATES = new Set<FighterState>([
  FighterState.IDLE,
  FighterState.WALK_FORWARD,
  FighterState.WALK_BACKWARD,
]);

type LoadedAnimation = { img: HTMLImageElement; sprite: CachedSprite };

export async function loadAiSprites(
  scene: Phaser.Scene,
  spriteKey: string,
  photoHash: string,
): Promise<boolean> {
  const cached = await getAllSpritesForHash(photoHash);
  if (cached.length === 0) return false;

  const spritesByAnim = new Map<string, CachedSprite>();
  for (const s of cached) {
    spritesByAnim.set(s.animationName, s);
  }

  const loadedAnims = new Map<string, LoadedAnimation>();

  for (const [animName, sprite] of spritesByAnim) {
    if (!ANIM_NAME_TO_STATE[animName]) continue;
    const img = await blobToImage(sprite.pngBlob);
    loadedAnims.set(animName, { img, sprite });
    debugInfo(`[AiSpriteLoader] ${animName}: ${img.width}x${img.height}, frame ${sprite.frameWidth}x${sprite.frameHeight}, count ${sprite.frameCount}`);
  }
  if (loadedAnims.size === 0) return false;

  const runtimeProfiles = new Map<FighterState, SpriteRuntimeProfile>();
  const frameCountOverrides: Partial<Record<FighterState, number>> = {};
  const playbackModeOverrides: Partial<Record<FighterState, SpriteRuntimeProfile['playbackMode']>> = {};
  const durationTickOverrides: Partial<Record<FighterState, number>> = {};

  for (const state of Object.values(FighterState)) {
    const directAnimName = stateToAnimName(state);
    const resolved = resolveLoadedAnimationForState(state, loadedAnims);
    const usesDenseSource = resolved && (
      resolved.animName === directAnimName ||
      (state === FighterState.WALK_BACKWARD && resolved.animName === 'walk')
    );
    const profileState = state === FighterState.WALK_BACKWARD
      ? FighterState.WALK_FORWARD
      : state;
    const profile = getAnimationRuntimeProfile(
      profileState,
      usesDenseSource ? resolved?.anim.sprite.frameCount : undefined,
      usesDenseSource ? resolved?.anim.sprite.animationFormat : undefined,
    );
    runtimeProfiles.set(state, profile);
    frameCountOverrides[state] = profile.frameCount;
    playbackModeOverrides[state] = profile.playbackMode;
    if (profile.durationTicks) durationTickOverrides[state] = profile.durationTicks;
  }

  const layout = createSpriteLayout(
    frameCountOverrides,
    playbackModeOverrides,
    durationTickOverrides,
  );
  const cols = layout.totalColumns;
  const rows = Object.keys(layout.stateRow).length;

  const canvas = document.createElement('canvas');
  canvas.width = cols * FIGHTER_WIDTH;
  canvas.height = rows * FIGHTER_HEIGHT;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const stateOrder = Object.entries(layout.stateRow)
    .sort(([, a], [, b]) => a - b)
    .map(([state]) => state as FighterState);

  let fallbackFillCount = 0;
  const denseTransforms = new Map<string, AtlasFrameTransform>();
  for (const state of stateOrder) {
    const row = layout.stateRow[state];
    const targetFrameCount = layout.frameCounts[state];

    const directAnimName = stateToAnimName(state);
    const resolved = resolveLoadedAnimationForState(state, loadedAnims);
    if (!resolved) return false;
    const { animName, anim } = resolved;
    if (animName !== directAnimName) fallbackFillCount += 1;

    const { img: sourceImg, sprite } = anim;
    const srcTotal = sprite.frameCount;

    const srcW = sprite.frameWidth;
    const srcH = sprite.frameHeight;
    const gridCols = Math.round(sourceImg.width / srcW);
    const gridRows = Math.round(sourceImg.height / srcH);

    const extractedFrames = extractFrames(sourceImg, srcW, srcH, srcTotal, gridCols);
    const stableFrames = selectStableFramesForState(
      state,
      extractedFrames,
      srcW,
      srcH,
      targetFrameCount,
    );
    const frames = selectSourceFramesForAtlas(
      state,
      stableFrames,
      targetFrameCount,
      runtimeProfiles.get(state) ?? getAnimationRuntimeProfile(state),
      {
        sourceState: ANIM_NAME_TO_STATE[animName],
        animationFormat: sprite.animationFormat,
      },
    );
    const denseSource = sprite.animationFormat === VIDEO_DENSE_SPRITE_ANIMATION_FORMAT;
    let transform = denseSource ? denseTransforms.get(animName) : undefined;
    if (!transform) {
      // Dense video sheets preserve the provider's whole 192x256 canvas. Their
      // transparent padding varies between actions, so drawing that whole canvas
      // makes otherwise valid fighters change apparent size. Normalize one union
      // box for the complete source animation: every frame receives the same
      // transform, fallbacks stay consistent with their source action, and motion
      // inside the cell is preserved without frame-by-frame zoom pumping.
      const contentBox = denseSource
        ? findAlphaUnionBBox(extractedFrames, srcW, srcH)
        : findUnionBBox(frames, srcW, srcH);
      transform = calculateAtlasFrameTransform(srcW, srcH, contentBox);
      if (denseSource) denseTransforms.set(animName, transform);
    }

    for (let f = 0; f < targetFrameCount; f++) {
      const dstX = f * FIGHTER_WIDTH;
      const dstY = row * FIGHTER_HEIGHT;

      ctx.drawImage(
        frames[f],
        transform.source.x,
        transform.source.y,
        transform.source.w,
        transform.source.h,
        dstX + transform.destination.x,
        dstY + transform.destination.y,
        transform.destination.w,
        transform.destination.h,
      );
    }
  }

  debugInfo(`[AiSpriteLoader] Built ${canvas.width}x${canvas.height} sheet for "${spriteKey}" (${loadedAnims.size} anims, ${fallbackFillCount} fallback-filled states, ${cols}x${rows} cells of ${FIGHTER_WIDTH}x${FIGHTER_HEIGHT})`);

  if (scene.textures.exists(spriteKey)) {
    scene.textures.remove(spriteKey);
  }
  scene.textures.addSpriteSheet(spriteKey, canvas as unknown as HTMLImageElement, {
    frameWidth: FIGHTER_WIDTH,
    frameHeight: FIGHTER_HEIGHT,
  });
  registerSpriteLayout(spriteKey, layout);

  return true;
}

function stateToAnimName(state: FighterState): string {
  for (const [name, s] of Object.entries(ANIM_NAME_TO_STATE)) {
    if (s === state) return name;
  }
  return '';
}

function resolveLoadedAnimationForState(
  state: FighterState,
  loadedAnims: Map<string, LoadedAnimation>,
): { animName: string; anim: LoadedAnimation } | null {
  const directName = stateToAnimName(state);
  const directAnim = loadedAnims.get(directName);
  if (directAnim) return { animName: directName, anim: directAnim };

  const fallbackState = FALLBACK_MAP[state];
  if (fallbackState) {
    const fallbackName = stateToAnimName(fallbackState);
    const fallbackAnim = loadedAnims.get(fallbackName);
    if (fallbackAnim) return { animName: fallbackName, anim: fallbackAnim };
  }

  const idleAnim = loadedAnims.get('idle');
  if (idleAnim) return { animName: 'idle', anim: idleAnim };

  const firstLoaded = loadedAnims.entries().next().value;
  return firstLoaded ? { animName: firstLoaded[0], anim: firstLoaded[1] } : null;
}

export function selectSourceFramesForAtlas<T>(
  state: FighterState,
  sourceFrames: T[],
  targetFrameCount: number,
  runtimeProfile: SpriteRuntimeProfile,
  sourceContext?: {
    sourceState?: FighterState;
    animationFormat?: SpriteAnimationFormat;
  },
): T[] {
  const runtimeSourceFrames = runtimeProfile.sourceFormat === 'expanded-ping-pong'
    ? sourceFrames.slice(0, runtimeProfile.frameCount)
    : sourceFrames;

  const holdsDenseKnockdownTerminalPose =
    state === FighterState.DEFEAT &&
    sourceContext?.sourceState === FighterState.KNOCKDOWN &&
    sourceContext.animationFormat === VIDEO_DENSE_SPRITE_ANIMATION_FORMAT;
  if (holdsDenseKnockdownTerminalPose && runtimeSourceFrames.length > 0) {
    const finalFrame = runtimeSourceFrames[runtimeSourceFrames.length - 1];
    return Array.from({ length: targetFrameCount }, () => finalFrame);
  }

  return Array.from({ length: targetFrameCount }, (_, frameIndex) => {
    const sourceIndex = selectSourceFrameIndex(
      state,
      frameIndex,
      targetFrameCount,
      runtimeSourceFrames.length,
    );
    return runtimeSourceFrames[sourceIndex];
  });
}

function selectSourceFrameIndex(
  state: FighterState,
  frameIndex: number,
  targetFrameCount: number,
  sourceFrameCount: number,
): number {
  if (sourceFrameCount <= 1) return 0;

  if (targetFrameCount <= 1) {
    return LOOPING_STATES.has(state) ? 0 : sourceFrameCount - 1;
  }

  if (LOOPING_STATES.has(state)) {
    return Math.min(
      Math.floor((frameIndex / targetFrameCount) * sourceFrameCount),
      sourceFrameCount - 1,
    );
  }

  return Math.min(
    Math.round((frameIndex / (targetFrameCount - 1)) * (sourceFrameCount - 1)),
    sourceFrameCount - 1,
  );
}

function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load sprite image'));
    };
    img.src = url;
  });
}

function extractFrames(
  sheet: HTMLImageElement,
  frameW: number, frameH: number,
  count: number, cols: number,
): HTMLCanvasElement[] {
  const frames: HTMLCanvasElement[] = [];
  for (let i = 0; i < count; i++) {
    const sc = i % cols;
    const sr = Math.floor(i / cols);
    const c = document.createElement('canvas');
    c.width = frameW;
    c.height = frameH;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(sheet, sc * frameW, sr * frameH, frameW, frameH, 0, 0, frameW, frameH);
    frames.push(c);
  }
  return frames;
}

export interface BBox { x: number; y: number; w: number; h: number }

export interface AtlasFrameTransform {
  source: BBox;
  destination: BBox;
}

export function calculateAtlasFrameTransform(
  sourceWidth: number,
  sourceHeight: number,
  contentBox: BBox | null,
): AtlasFrameTransform {
  const source = contentBox ?? { x: 0, y: 0, w: sourceWidth, h: sourceHeight };
  const scale = Math.min(FIGHTER_WIDTH / source.w, FIGHTER_HEIGHT / source.h);
  const drawWidth = Math.round(source.w * scale);
  const drawHeight = Math.round(source.h * scale);
  return {
    source,
    destination: {
      x: Math.round((FIGHTER_WIDTH - drawWidth) / 2),
      y: FIGHTER_HEIGHT - drawHeight,
      w: drawWidth,
      h: drawHeight,
    },
  };
}
const FRAGMENTED_STATES = new Set([FighterState.JUMP, FighterState.HIT_STUN]);

function selectStableFramesForState(
  state: FighterState,
  frames: HTMLCanvasElement[],
  frameW: number,
  frameH: number,
  targetFrameCount: number,
): HTMLCanvasElement[] {
  if (!FRAGMENTED_STATES.has(state) || frames.length <= targetFrameCount) {
    return frames;
  }

  const scored = frames
    .map((frame, index) => {
      const bbox = getFrameBBox(frame, frameW, frameH);
      return bbox ? { frame, index, bbox } : null;
    })
    .filter((entry): entry is { frame: HTMLCanvasElement; index: number; bbox: BBox } => entry != null);

  if (scored.length === 0) {
    return frames;
  }
  if (scored.length <= targetFrameCount) {
    return scored.map((entry) => entry.frame);
  }

  const medianArea = median(scored.map((entry) => entry.bbox.w * entry.bbox.h));
  const medianHeight = median(scored.map((entry) => entry.bbox.h));
  const medianWidth = median(scored.map((entry) => entry.bbox.w));
  const edgeMargin = 2;

  const ranked = scored.map((entry) => {
    const area = entry.bbox.w * entry.bbox.h;
    const areaRatio = medianArea > 0 ? area / medianArea : 1;
    const heightRatio = medianHeight > 0 ? entry.bbox.h / medianHeight : 1;
    const widthRatio = medianWidth > 0 ? entry.bbox.w / medianWidth : 1;
    const touchesEdge =
      entry.bbox.x <= edgeMargin ||
      entry.bbox.x + entry.bbox.w >= frameW - edgeMargin ||
      entry.bbox.y <= edgeMargin;

    let score = 100;
    if (touchesEdge) score -= 55;
    if (areaRatio < 0.55) score -= 45;
    if (areaRatio > 1.75) score -= 45;
    if (heightRatio < 0.7) score -= 35;
    if (widthRatio < 0.45) score -= 20;
    return { ...entry, score, valid: score >= 60 && !touchesEdge };
  });

  let selected = ranked.filter((entry) => entry.valid);
  if (selected.length < targetFrameCount) {
    selected = ranked
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(Math.max(targetFrameCount, 4), ranked.length));
  }

  if (selected.length === 0) {
    return frames;
  }

  return sampleFrames(
    selected
      .sort((a, b) => a.index - b.index)
      .map((entry) => entry.frame),
    Math.min(Math.max(targetFrameCount, 4), selected.length),
  );
}

function sampleFrames(frames: HTMLCanvasElement[], count: number): HTMLCanvasElement[] {
  if (frames.length <= count) return frames;
  if (count <= 1) return [frames[0]];
  const sampled: HTMLCanvasElement[] = [];
  for (let i = 0; i < count; i++) {
    const index = Math.round((i / (count - 1)) * (frames.length - 1));
    sampled.push(frames[index]);
  }
  return sampled;
}

function findUnionBBox(frames: HTMLCanvasElement[], frameW: number, frameH: number): BBox {
  let minX = frameW, minY = frameH, maxX = 0, maxY = 0;
  const ALPHA_THRESHOLD = 20;
  const DARK_THRESHOLD = 25;

  for (const frame of frames) {
    const ctx = frame.getContext('2d')!;
    const data = ctx.getImageData(0, 0, frameW, frameH).data;

    for (let y = 0; y < frameH; y++) {
      for (let x = 0; x < frameW; x++) {
        const i = (y * frameW + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];

        if (a < ALPHA_THRESHOLD) continue;
        if (r < DARK_THRESHOLD && g < DARK_THRESHOLD && b < DARK_THRESHOLD) continue;

        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX <= minX || maxY <= minY) {
    return { x: 0, y: 0, w: frameW, h: frameH };
  }

  const marginX = Math.round(frameW * 0.04);
  const marginY = Math.round(frameH * 0.04);
  minX = Math.max(0, minX - marginX);
  minY = Math.max(0, minY - marginY);
  maxX = Math.min(frameW - 1, maxX + marginX);
  maxY = Math.min(frameH - 1, maxY + marginY);

  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function findAlphaUnionBBox(
  frames: HTMLCanvasElement[],
  frameW: number,
  frameH: number,
): BBox | null {
  let minX = frameW;
  let minY = frameH;
  let maxX = -1;
  let maxY = -1;

  for (const frame of frames) {
    const data = frame.getContext('2d')!.getImageData(0, 0, frameW, frameH).data;
    const bounds = measureAlphaBBox(data, frameW, frameH);
    if (!bounds) continue;
    minX = Math.min(minX, bounds.x);
    minY = Math.min(minY, bounds.y);
    maxX = Math.max(maxX, bounds.x + bounds.w - 1);
    maxY = Math.max(maxY, bounds.y + bounds.h - 1);
  }

  if (maxX < minX || maxY < minY) return null;

  const marginX = Math.round(frameW * 0.04);
  const marginY = Math.round(frameH * 0.04);
  minX = Math.max(0, minX - marginX);
  minY = Math.max(0, minY - marginY);
  maxX = Math.min(frameW - 1, maxX + marginX);
  maxY = Math.min(frameH - 1, maxY + marginY);

  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

export function measureAlphaBBox(
  data: Uint8ClampedArray,
  frameW: number,
  frameH: number,
): BBox | null {
  let minX = frameW;
  let minY = frameH;
  let maxX = -1;
  let maxY = -1;
  const alphaThreshold = 32;

  for (let y = 0; y < frameH; y++) {
    for (let x = 0; x < frameW; x++) {
      if (data[(y * frameW + x) * 4 + 3] < alphaThreshold) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  return maxX < minX || maxY < minY
    ? null
    : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function getFrameBBox(frame: HTMLCanvasElement, frameW: number, frameH: number): BBox | null {
  const ctx = frame.getContext('2d')!;
  const data = ctx.getImageData(0, 0, frameW, frameH).data;
  const ALPHA_THRESHOLD = 20;
  const DARK_THRESHOLD = 25;
  let minX = frameW;
  let minY = frameH;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < frameH; y++) {
    for (let x = 0; x < frameW; x++) {
      const i = (y * frameW + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (a < ALPHA_THRESHOLD) continue;
      if (r < DARK_THRESHOLD && g < DARK_THRESHOLD && b < DARK_THRESHOLD) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < minX || maxY < minY) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}
