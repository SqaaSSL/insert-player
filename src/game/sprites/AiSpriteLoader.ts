import Phaser from 'phaser';
import { FighterState, FIGHTER_WIDTH, FIGHTER_HEIGHT } from '../constants.ts';
import { getAllSpritesForHash, type CachedSprite } from '../../services/SpriteCache.ts';
import { getSpriteLayout } from './SpriteGenerator.ts';

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

  const layout = getSpriteLayout();
  const cols = layout.totalColumns;
  const rows = Object.keys(layout.stateRow).length;

  const canvas = document.createElement('canvas');
  canvas.width = cols * FIGHTER_WIDTH;
  canvas.height = rows * FIGHTER_HEIGHT;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const loadedAnims = new Map<string, { img: HTMLImageElement; sprite: CachedSprite }>();

  for (const [animName, sprite] of spritesByAnim) {
    if (!ANIM_NAME_TO_STATE[animName]) continue;
    const img = await blobToImage(sprite.pngBlob);
    loadedAnims.set(animName, { img, sprite });
    console.log(`[AiSpriteLoader] ${animName}: ${img.width}x${img.height}, frame ${sprite.frameWidth}x${sprite.frameHeight}, count ${sprite.frameCount}`);
  }

  const stateOrder = Object.entries(layout.stateRow)
    .sort(([, a], [, b]) => a - b)
    .map(([state]) => state as FighterState);

  for (const state of stateOrder) {
    const row = layout.stateRow[state];
    const targetFrameCount = layout.frameCounts[state];

    let animName = stateToAnimName(state);
    let anim = loadedAnims.get(animName);

    if (!anim) {
      const fallback = FALLBACK_MAP[state];
      if (fallback) {
        animName = stateToAnimName(fallback);
        anim = loadedAnims.get(animName);
      }
    }
    if (!anim) continue;

    const { img: sourceImg, sprite } = anim;
    const srcTotal = sprite.frameCount;

    const srcW = sprite.frameWidth;
    const srcH = sprite.frameHeight;
    const gridCols = Math.round(sourceImg.width / srcW);
    const gridRows = Math.round(sourceImg.height / srcH);

    const extractedFrames = extractFrames(sourceImg, srcW, srcH, srcTotal, gridCols);
    const frames = selectStableFramesForState(state, extractedFrames, srcW, srcH, targetFrameCount);
    const sourceFrameCount = frames.length;
    const unionBox = findUnionBBox(frames, srcW, srcH);

    const cropW = unionBox.w;
    const cropH = unionBox.h;

    const scale = Math.min(FIGHTER_WIDTH / cropW, FIGHTER_HEIGHT / cropH);
    const drawW = Math.round(cropW * scale);
    const drawH = Math.round(cropH * scale);

    for (let f = 0; f < targetFrameCount; f++) {
      const srcIdx = selectSourceFrameIndex(state, f, targetFrameCount, sourceFrameCount);

      const dstX = f * FIGHTER_WIDTH;
      const dstY = row * FIGHTER_HEIGHT;

      const offsetX = Math.round((FIGHTER_WIDTH - drawW) / 2);
      const offsetY = FIGHTER_HEIGHT - drawH;

      ctx.drawImage(
        frames[srcIdx],
        unionBox.x, unionBox.y, cropW, cropH,
        dstX + offsetX, dstY + offsetY, drawW, drawH,
      );
    }
  }

  console.log(`[AiSpriteLoader] Built ${canvas.width}x${canvas.height} sheet for "${spriteKey}" (${loadedAnims.size} anims, ${cols}x${rows} cells of ${FIGHTER_WIDTH}x${FIGHTER_HEIGHT})`);

  if (scene.textures.exists(spriteKey)) {
    scene.textures.remove(spriteKey);
  }
  scene.textures.addSpriteSheet(spriteKey, canvas as unknown as HTMLImageElement, {
    frameWidth: FIGHTER_WIDTH,
    frameHeight: FIGHTER_HEIGHT,
  });

  return true;
}

function stateToAnimName(state: FighterState): string {
  for (const [name, s] of Object.entries(ANIM_NAME_TO_STATE)) {
    if (s === state) return name;
  }
  return '';
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

interface BBox { x: number; y: number; w: number; h: number }
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
