export const GAME_WIDTH = 1024;
export const GAME_HEIGHT = 576;
export const GROUND_Y = 480;
export const STAGE_LEFT = 50;
export const STAGE_RIGHT = GAME_WIDTH - 50;

export const FIXED_TIMESTEP = 1000 / 60; // 60 FPS deterministic
export const GRAVITY = 1800;
export const WALK_SPEED = 300;
export const JUMP_VELOCITY = -700;
export const PUSHBACK_SPEED = 200;

export const ROUND_TIME = 99;
export const MAX_HEALTH = 1000;
export const ROUNDS_TO_WIN = 2;

export const FIGHTER_WIDTH = 192;
export const FIGHTER_HEIGHT = 256;

export const BODY_WIDTH = 60;
export const BODY_HEIGHT = 180;

export enum FighterState {
  IDLE = 'idle',
  WALK_FORWARD = 'walkForward',
  WALK_BACKWARD = 'walkBackward',
  JUMP = 'jump',
  CROUCH = 'crouch',
  HIGH_PUNCH = 'highPunch',
  LOW_PUNCH = 'lowPunch',
  HIGH_KICK = 'highKick',
  LOW_KICK = 'lowKick',
  BLOCK = 'block',
  HIT_STUN = 'hitStun',
  KNOCKDOWN = 'knockdown',
  FIREBALL = 'fireball',
  UPPERCUT = 'uppercut',
  VICTORY = 'victory',
  DEFEAT = 'defeat',
}

export interface HitboxData {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type HitLevel = 'high' | 'mid' | 'low';

export interface AttackData {
  damage: number;
  hitStunFrames: number;
  blockStunFrames: number;
  pushback: number;
  startup: number;
  active: number;
  recovery: number;
  hitbox: HitboxData;
  /** Tekken-style guard triangle: highs whiff on crouchers, lows beat
   * standing guard, mids beat crouch guard. */
  hitLevel: HitLevel;
  /** Sweep-style hit: puts the defender into a knockdown instead of hitstun. */
  knockdown?: boolean;
}

export const ATTACKS: Record<string, AttackData> = {
  // Redesigned movelist (same animations, new roles):
  // - HIGH_PUNCH: fast jab, plus on hit (+3) — the pressure/link starter.
  // - LOW_PUNCH: crouch jab, safe poke that clips standing guard.
  // - HIGH_KICK: the damage normal — slower, cancelable, minus on block.
  // - LOW_KICK: sweep — knocks down on hit, very punishable on block.
  // - FIREBALL: high projectile — duck it, reflect it, one per player.
  // - UPPERCUT: invincible-startup MID that crushes crouch guard.
  [FighterState.HIGH_PUNCH]: {
    damage: 25,
    hitStunFrames: 13,
    blockStunFrames: 6,
    pushback: 60,
    startup: 3,
    active: 3,
    recovery: 8,
    hitbox: { x: 20, y: -150, width: 55, height: 30 },
    hitLevel: 'high',
  },
  [FighterState.LOW_PUNCH]: {
    damage: 30,
    hitStunFrames: 13,
    blockStunFrames: 7,
    pushback: 70,
    startup: 4,
    active: 3,
    recovery: 10,
    hitbox: { x: 20, y: -50, width: 55, height: 30 },
    hitLevel: 'low',
  },
  [FighterState.HIGH_KICK]: {
    damage: 85,
    hitStunFrames: 20,
    blockStunFrames: 10,
    pushback: 150,
    startup: 6,
    active: 5,
    recovery: 14,
    hitbox: { x: 25, y: -160, width: 70, height: 40 },
    hitLevel: 'high',
  },
  [FighterState.LOW_KICK]: {
    damage: 50,
    hitStunFrames: 16,
    blockStunFrames: 9,
    pushback: 90,
    startup: 5,
    active: 4,
    recovery: 12,
    hitbox: { x: 25, y: -30, width: 70, height: 35 },
    hitLevel: 'low',
    knockdown: true,
  },
  [FighterState.FIREBALL]: {
    damage: 50,
    hitStunFrames: 18,
    blockStunFrames: 10,
    pushback: 0,
    startup: 8,
    active: 6,
    recovery: 18,
    hitbox: { x: 0, y: 0, width: 0, height: 0 },
    hitLevel: 'high',
  },
  [FighterState.UPPERCUT]: {
    damage: 100,
    hitStunFrames: 24,
    blockStunFrames: 14,
    pushback: 200,
    startup: 4,
    active: 8,
    recovery: 20,
    hitbox: { x: 15, y: -170, width: 50, height: 100 },
    hitLevel: 'mid',
  },
};
