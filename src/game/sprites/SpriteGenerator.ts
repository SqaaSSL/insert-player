import Phaser from 'phaser';
import { FighterState, FIGHTER_WIDTH, FIGHTER_HEIGHT } from '../constants.ts';

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

export const MAX_DENSE_HIGH_KICK_FRAMES = 12;
const LEGACY_HIGH_KICK_MAX_FRAMES = 7;

export type SpritePlaybackMode = 'timeline' | 'forward-ping-pong';
export type HighKickSourceFormat =
  | 'timeline'
  | 'forward-keyframes'
  | 'expanded-ping-pong';

export interface HighKickRuntimeProfile {
  frameCount: number;
  playbackMode: SpritePlaybackMode;
  sourceFormat: HighKickSourceFormat;
}

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
  totalColumns: number;
}

const registeredLayouts = new Map<string, SpriteSheetLayout>();

export function createSpriteLayout(
  frameCountOverrides: Partial<Record<FighterState, number>> = {},
  playbackModeOverrides: Partial<Record<FighterState, SpritePlaybackMode>> = {},
): SpriteSheetLayout {
  const stateRow: Record<string, number> = {};
  const frameCounts = { ...STATE_FRAMES };
  const playbackModes: Partial<Record<string, SpritePlaybackMode>> = {};

  for (const [state, frameCount] of Object.entries(frameCountOverrides)) {
    if (Number.isInteger(frameCount) && frameCount > 0) {
      frameCounts[state] = frameCount;
    }
  }
  for (const [state, playbackMode] of Object.entries(playbackModeOverrides)) {
    if (playbackMode) playbackModes[state] = playbackMode;
  }

  let maxCols = 0;
  STATE_ORDER.forEach((state, row) => {
    stateRow[state] = row;
    maxCols = Math.max(maxCols, frameCounts[state]);
  });
  return { stateRow, frameCounts, playbackModes, totalColumns: maxCols };
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

export function getHighKickRuntimeProfile(sourceFrameCount?: number): HighKickRuntimeProfile {
  if (!Number.isFinite(sourceFrameCount) || !sourceFrameCount || sourceFrameCount < 1) {
    return {
      frameCount: STATE_FRAMES[FighterState.HIGH_KICK],
      playbackMode: 'timeline',
      sourceFormat: 'timeline',
    };
  }

  const normalizedSourceCount = Math.floor(sourceFrameCount);
  const isExpandedPingPong = normalizedSourceCount > MAX_DENSE_HIGH_KICK_FRAMES &&
    normalizedSourceCount <= MAX_DENSE_HIGH_KICK_FRAMES * 2 - 1 &&
    normalizedSourceCount % 2 === 1;

  if (isExpandedPingPong) {
    return {
      frameCount: (normalizedSourceCount + 1) / 2,
      playbackMode: 'forward-ping-pong',
      sourceFormat: 'expanded-ping-pong',
    };
  }

  const frameCount = Math.min(normalizedSourceCount, MAX_DENSE_HIGH_KICK_FRAMES);

  // Existing generated attacks contain their return-to-stance frames already.
  // The dense video format stores 8-12 forward keyframes and derives recovery
  // locally so the runtime does not duplicate those large source cells.
  const playbackMode = normalizedSourceCount > LEGACY_HIGH_KICK_MAX_FRAMES &&
    normalizedSourceCount <= MAX_DENSE_HIGH_KICK_FRAMES
    ? 'forward-ping-pong'
    : 'timeline';

  return {
    frameCount,
    playbackMode,
    sourceFormat: playbackMode === 'forward-ping-pong' ? 'forward-keyframes' : 'timeline',
  };
}

/**
 * Generates a simple colored silhouette placeholder spritesheet.
 * Used as fallback when AI-generated sprites are not available.
 */
export function generateFighterSpriteSheet(
  scene: Phaser.Scene,
  key: string,
  bodyColor: string,
  _skinColor: string,
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
      drawSilhouette(ctx, f * FW, row * FH, bodyColor, state, f);
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
  color: string,
  state: FighterState,
  _frame: number,
): void {
  const cx = ox + FW / 2;
  const baseY = oy + FH;

  ctx.fillStyle = color;
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 2;

  const headR = 14;
  let bodyH = 100;
  let bodyW = 36;
  let headY = baseY - bodyH - headR * 2 - 8;
  let bodyTop = headY + headR * 2 + 4;
  let legSpread = 14;

  if (
    state === FighterState.CROUCH ||
    state === FighterState.BLOCK ||
    state === FighterState.LOW_PUNCH ||
    state === FighterState.LOW_KICK
  ) {
    bodyH = 60;
    headY = baseY - bodyH - headR * 2 + 10;
    bodyTop = headY + headR * 2 + 4;
  } else if (state === FighterState.KNOCKDOWN || state === FighterState.DEFEAT) {
    bodyH = 30;
    bodyW = 60;
    headY = baseY - 40;
    bodyTop = baseY - 24;
    legSpread = 24;
  } else if (state === FighterState.JUMP) {
    headY -= 30;
    bodyTop -= 30;
  }

  ctx.beginPath();
  ctx.arc(cx, headY, headR, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.beginPath();
  ctx.roundRect(cx - bodyW / 2, bodyTop, bodyW, bodyH, 6);
  ctx.fill();
  ctx.stroke();

  ctx.lineWidth = 10;
  ctx.lineCap = 'round';
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx - legSpread, bodyTop + bodyH);
  ctx.lineTo(cx - legSpread - 4, baseY - 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx + legSpread, bodyTop + bodyH);
  ctx.lineTo(cx + legSpread + 4, baseY - 2);
  ctx.stroke();

  ctx.strokeStyle = '#111';
  ctx.lineWidth = 2;

  ctx.strokeStyle = color;
  ctx.lineWidth = 8;
  const armY = bodyTop + 10;

  if (state === FighterState.BLOCK) {
    ctx.beginPath();
    ctx.moveTo(cx - bodyW / 2, armY);
    ctx.lineTo(cx - 4, armY - 20);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + bodyW / 2, armY);
    ctx.lineTo(cx + 4, armY - 20);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(cx - bodyW / 2, armY);
    ctx.lineTo(cx - bodyW / 2 - 18, armY + 30);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + bodyW / 2, armY);
    ctx.lineTo(cx + bodyW / 2 + 18, armY + 6);
    ctx.stroke();
  }

  ctx.fillStyle = '#fff';
  ctx.font = 'bold 16px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('?', cx, bodyTop + bodyH / 2);
}
