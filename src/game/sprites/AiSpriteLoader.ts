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

    const frames = extractFrames(sourceImg, srcW, srcH, srcTotal, gridCols);
    const unionBox = findUnionBBox(frames, srcW, srcH);

    const cropW = unionBox.w;
    const cropH = unionBox.h;

    const scale = Math.min(FIGHTER_WIDTH / cropW, FIGHTER_HEIGHT / cropH);
    const drawW = Math.round(cropW * scale);
    const drawH = Math.round(cropH * scale);

    for (let f = 0; f < targetFrameCount; f++) {
      const srcIdx = Math.min(
        Math.floor((f / targetFrameCount) * srcTotal),
        srcTotal - 1,
      );

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
