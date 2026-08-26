import Phaser from 'phaser';
import {
  FighterState,
  GRAVITY,
  WALK_SPEED,
  JUMP_VELOCITY,
  GROUND_Y,
  STAGE_LEFT,
  STAGE_RIGHT,
  MAX_HEALTH,
  ATTACKS,
  FIGHTER_WIDTH,
  FIGHTER_HEIGHT,
  BODY_WIDTH,
  BODY_HEIGHT,
  PUSHBACK_SPEED,
  type AttackData,
} from '../constants.ts';
import type { FighterInput } from '../systems/InputManager.ts';
import { MotionInputs } from '../systems/MotionInputs.ts';
import { getSpriteLayout, type SpriteSheetLayout } from '../sprites/SpriteGenerator.ts';
import { getActionAnimationFrame } from '../sprites/AnimationFrameMapping.ts';

export interface FighterSnapshot {
  x: number;
  y: number;
  vx: number;
  vy: number;
  health: number;
  state: FighterState;
  stateFrame: number;
  facingRight: boolean;
  attackHit: boolean;
  comboCount: number;
  stunFrames: number;
}

export class Fighter {
  x: number;
  y: number;
  vx = 0;
  vy = 0;
  health = MAX_HEALTH;
  state = FighterState.IDLE;
  stateFrame = 0;
  facingRight: boolean;
  attackHit = false;
  comboCount = 0;
  stunFrames = 0;
  crouchBlocking = false;

  readonly playerIndex: number;
  readonly name: string;
  private spriteKey: string;
  private layout: SpriteSheetLayout;
  private motionInputs = new MotionInputs();
  private wasCrouching = false;
  private renderScale = 1;
  private renderYOffset = 0;
  private shadowOffsetX = 8;
  private shadowOffsetY = 8;
  private shadowAlpha = 0.16;

  sprite!: Phaser.GameObjects.Sprite;
  shadowSprite?: Phaser.GameObjects.Sprite;

  constructor(playerIndex: number, name: string, spriteKey: string, x: number, facingRight: boolean) {
    this.playerIndex = playerIndex;
    this.name = name;
    this.spriteKey = spriteKey;
    this.layout = getSpriteLayout(spriteKey);
    this.x = x;
    this.y = GROUND_Y;
    this.facingRight = facingRight;
  }

  createSprite(scene: Phaser.Scene): void {
    this.shadowSprite = scene.add.sprite(this.x, this.y, this.spriteKey, 0);
    this.shadowSprite
      .setOrigin(0.5, 1)
      .setScale(this.renderScale * 1.015)
      .setTint(0x000000)
      .setAlpha(this.shadowAlpha)
      .setBlendMode(Phaser.BlendModes.MULTIPLY);
    this.sprite = scene.add.sprite(this.x, this.y, this.spriteKey, 0);
    this.sprite.setOrigin(0.5, 1).setScale(this.renderScale);
  }

  setRenderPresentation(scale: number, yOffset = 0): void {
    this.renderScale = scale;
    this.renderYOffset = yOffset;
    this.shadowOffsetX = Math.max(7, Math.round(8 * scale));
    this.shadowOffsetY = Math.max(7, Math.round(9 * scale));
    this.shadowAlpha = scale > 1 ? 0.18 : 0.14;
    if (this.shadowSprite) {
      this.shadowSprite
        .setScale(scale * 1.015)
        .setAlpha(this.shadowAlpha)
        .setPosition(this.x + this.shadowOffsetX, this.y + yOffset + this.shadowOffsetY);
    }
    if (this.sprite) {
      this.sprite.setScale(scale);
      this.sprite.setY(this.y + yOffset);
    }
  }

  getRenderY(): number {
    return this.y + this.renderYOffset;
  }

  snapshot(): FighterSnapshot {
    return {
      x: this.x,
      y: this.y,
      vx: this.vx,
      vy: this.vy,
      health: this.health,
      state: this.state,
      stateFrame: this.stateFrame,
      facingRight: this.facingRight,
      attackHit: this.attackHit,
      comboCount: this.comboCount,
      stunFrames: this.stunFrames,
    };
  }

  restore(snap: FighterSnapshot): void {
    this.x = snap.x;
    this.y = snap.y;
    this.vx = snap.vx;
    this.vy = snap.vy;
    this.health = snap.health;
    this.state = snap.state;
    this.stateFrame = snap.stateFrame;
    this.facingRight = snap.facingRight;
    this.attackHit = snap.attackHit;
    this.comboCount = snap.comboCount;
    this.stunFrames = snap.stunFrames;
  }

  isGrounded(): boolean {
    return this.y >= GROUND_Y;
  }

  isCrouching(): boolean {
    return this.state === FighterState.CROUCH;
  }

  isInAttack(): boolean {
    return (
      this.state === FighterState.HIGH_PUNCH ||
      this.state === FighterState.LOW_PUNCH ||
      this.state === FighterState.HIGH_KICK ||
      this.state === FighterState.LOW_KICK ||
      this.state === FighterState.FIREBALL ||
      this.state === FighterState.UPPERCUT
    );
  }

  isActionable(): boolean {
    return (
      this.state === FighterState.IDLE ||
      this.state === FighterState.WALK_FORWARD ||
      this.state === FighterState.WALK_BACKWARD ||
      this.state === FighterState.CROUCH ||
      this.state === FighterState.BLOCK
    );
  }

  getBodyWidth(): number {
    return BODY_WIDTH;
  }

  getBodyHeight(crouching = this.isCrouching() || this.state === FighterState.LOW_PUNCH || this.state === FighterState.LOW_KICK): number {
    return crouching ? BODY_HEIGHT * 0.6 : BODY_HEIGHT;
  }

  getAttackRange(state: FighterState): number {
    const atk = ATTACKS[state];
    if (!atk) return this.getBodyWidth();
    return this.getBodyWidth() / 2 + atk.hitbox.x + atk.hitbox.width;
  }

  getMaxMeleeRange(): number {
    return Math.max(
      this.getAttackRange(FighterState.HIGH_PUNCH),
      this.getAttackRange(FighterState.LOW_PUNCH),
      this.getAttackRange(FighterState.HIGH_KICK),
      this.getAttackRange(FighterState.LOW_KICK),
      this.getAttackRange(FighterState.UPPERCUT),
    );
  }

  getAttackData(): AttackData | null {
    return ATTACKS[this.state] ?? null;
  }

  getHurtbox(): { x: number; y: number; width: number; height: number } {
    const crouching = this.isCrouching() ||
      this.state === FighterState.LOW_PUNCH ||
      this.state === FighterState.LOW_KICK;
    const width = this.getBodyWidth();
    const height = this.getBodyHeight(crouching);
    return {
      x: this.x - width / 2,
      y: this.y - height,
      width,
      height,
    };
  }

  getActiveHitbox(): { x: number; y: number; width: number; height: number } | null {
    const atk = this.getAttackData();
    if (!atk) return null;
    if (this.stateFrame < atk.startup || this.stateFrame >= atk.startup + atk.active) return null;
    if (this.attackHit) return null;

    const dir = this.facingRight ? 1 : -1;
    return {
      x: this.x + atk.hitbox.x * dir - (this.facingRight ? 0 : atk.hitbox.width),
      y: this.y + atk.hitbox.y,
      width: atk.hitbox.width,
      height: atk.hitbox.height,
    };
  }

  update(dt: number, input: FighterInput, opponentX: number): void {
    if (Math.abs(opponentX - this.x) > 4) {
      this.facingRight = opponentX > this.x;
    }

    this.stateFrame++;

    if (this.state === FighterState.VICTORY || this.state === FighterState.DEFEAT) {
      return;
    }

    if (this.stunFrames > 0) {
      this.stunFrames--;
      if (this.stunFrames <= 0) {
        this.setState(FighterState.IDLE);
      }
      this.applyPhysics(dt);
      return;
    }

    if (this.state === FighterState.KNOCKDOWN) {
      if (this.isGrounded() && this.stateFrame > 30) {
        this.setState(FighterState.IDLE);
      }
      this.applyPhysics(dt);
      return;
    }

    if (this.isInAttack()) {
      const atk = this.getAttackData()!;
      const totalFrames = atk.startup + atk.active + atk.recovery;
      if (this.stateFrame >= totalFrames) {
        this.setState(FighterState.IDLE);
        this.wasCrouching = false;
      }
      this.applyPhysics(dt);
      return;
    }

    if (this.state === FighterState.JUMP) {
      if (input.left) this.vx = -WALK_SPEED;
      else if (input.right) this.vx = WALK_SPEED;
      else this.vx = 0;

      if (this.isGrounded() && this.vy >= 0 && this.stateFrame > 3) {
        this.y = GROUND_Y;
        this.vy = 0;
        this.setState(FighterState.IDLE);
      }
      this.applyPhysics(dt);
      return;
    }

    this.motionInputs.feedInput(input, this.facingRight);

    const isHoldingBack = this.facingRight ? input.left : input.right;
    const holdingDown = input.down;

    // Shortcut keys for specials
    if (this.isActionable()) {
      if (input.uppercut) {
        this.setState(FighterState.UPPERCUT);
        this.vx = 0;
        this.vy = -500;
        this.applyPhysics(dt);
        return;
      }
      if (input.fireball) {
        this.setState(FighterState.FIREBALL);
        this.vx = 0;
        this.applyPhysics(dt);
        return;
      }
    }

    // Motion input specials (classic stick motions)
    if (this.isActionable() && (input.punch || input.kick)) {
      const motion = this.motionInputs.checkMotion();
      if (motion === 'dp' && input.punch) {
        this.setState(FighterState.UPPERCUT);
        this.vx = 0;
        this.vy = -500;
        this.applyPhysics(dt);
        return;
      }
      if (motion === 'qcf' && input.punch) {
        this.setState(FighterState.FIREBALL);
        this.vx = 0;
        this.applyPhysics(dt);
        return;
      }
    }

    // Attacks: high/low determined by whether down is held
    if (input.punch && this.isActionable()) {
      const attackState = holdingDown ? FighterState.LOW_PUNCH : FighterState.HIGH_PUNCH;
      this.wasCrouching = holdingDown;
      this.setState(attackState);
      this.vx = 0;
    } else if (input.kick && this.isActionable()) {
      const attackState = holdingDown ? FighterState.LOW_KICK : FighterState.HIGH_KICK;
      this.wasCrouching = holdingDown;
      this.setState(attackState);
      this.vx = 0;
    } else if (input.up && this.isGrounded()) {
      this.setState(FighterState.JUMP);
      this.vy = JUMP_VELOCITY;
      if (input.left) this.vx = -WALK_SPEED;
      else if (input.right) this.vx = WALK_SPEED;
      else this.vx = 0;
    } else if (holdingDown) {
      // Crouch (or crouch-block if also holding back / guard)
      if ((isHoldingBack || input.guard) && this.isGrounded()) {
        this.setState(FighterState.BLOCK);
        this.crouchBlocking = true;
      } else {
        this.setState(FighterState.CROUCH);
        this.crouchBlocking = false;
      }
      this.vx = 0;
    } else if ((isHoldingBack || input.guard) && this.isActionable() && this.isGrounded()) {
      // Standing block (guard button) vs walk backward (just holding back)
      if (input.guard) {
        this.setState(FighterState.BLOCK);
        this.crouchBlocking = false;
      } else {
        this.setState(FighterState.WALK_BACKWARD);
        this.vx = this.facingRight ? -WALK_SPEED : WALK_SPEED;
        this.crouchBlocking = false;
      }
    } else if (input.left) {
      const movingBack = this.facingRight;
      this.setState(movingBack ? FighterState.WALK_BACKWARD : FighterState.WALK_FORWARD);
      this.vx = -WALK_SPEED;
      this.crouchBlocking = false;
    } else if (input.right) {
      const movingBack = !this.facingRight;
      this.setState(movingBack ? FighterState.WALK_BACKWARD : FighterState.WALK_FORWARD);
      this.vx = WALK_SPEED;
      this.crouchBlocking = false;
    } else {
      this.setState(FighterState.IDLE);
      this.vx = 0;
      this.crouchBlocking = false;
    }

    this.applyPhysics(dt);
  }

  applyPhysics(dt: number): void {
    if (!this.isGrounded()) {
      this.vy += GRAVITY * dt;
    }

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    if (this.y >= GROUND_Y) {
      this.y = GROUND_Y;
      this.vy = 0;
    }

    this.x = Math.max(STAGE_LEFT, Math.min(STAGE_RIGHT, this.x));
  }

  takeDamage(atk: AttackData, isBlocking: boolean): void {
    if (isBlocking) {
      this.health -= Math.floor(atk.damage * 0.1);
      this.stunFrames = atk.blockStunFrames;
      this.setState(FighterState.BLOCK);
      this.vx = (this.facingRight ? -1 : 1) * atk.pushback;
    } else {
      this.health -= atk.damage;
      this.stunFrames = atk.hitStunFrames;
      this.comboCount++;
      if (this.health <= 0) {
        this.health = 0;
        this.setState(FighterState.KNOCKDOWN);
        this.vy = -400;
        this.vx = (this.facingRight ? -1 : 1) * 200;
        this.stunFrames = 0;
      } else {
        this.setState(FighterState.HIT_STUN);
        this.vx = (this.facingRight ? -1 : 1) * atk.pushback;
      }
    }
  }

  forceState(state: FighterState): void {
    this.state = state;
    this.stateFrame = 0;
    this.attackHit = false;
    this.vx = 0;
    if (state === FighterState.UPPERCUT) {
      this.vy = -500;
    }
  }

  private setState(state: FighterState): void {
    if (this.state !== state) {
      this.state = state;
      this.stateFrame = 0;
      this.attackHit = false;
      if (
        state !== FighterState.HIT_STUN &&
        state !== FighterState.BLOCK &&
        state !== FighterState.KNOCKDOWN
      ) {
        this.comboCount = 0;
      }
    }
  }

  syncSprite(opponentX: number): void {
    if (!this.sprite) return;
    const spriteDepth = this.x < opponentX ? 10 : 11;
    if (this.shadowSprite) {
      this.shadowSprite.setPosition(
        this.x + this.shadowOffsetX,
        this.getRenderY() + this.shadowOffsetY,
      );
      this.shadowSprite.setFlipX(!this.facingRight);
      this.shadowSprite.setScale(this.renderScale * 1.015);
      this.shadowSprite.setDepth(spriteDepth - 0.5);
    }
    this.sprite.setPosition(this.x, this.getRenderY());
    this.sprite.setFlipX(!this.facingRight);
    this.sprite.setScale(this.renderScale);
    this.sprite.setDepth(spriteDepth);

    const frameIndex = this.getFrameIndex();
    this.shadowSprite?.setFrame(frameIndex);
    this.sprite.setFrame(frameIndex);
  }

  private getFrameIndex(): number {
    const row = this.layout.stateRow[this.state] ?? 0;
    const maxFrames = this.layout.frameCounts[this.state] ?? 1;
    const cols = this.layout.totalColumns;

    let animFrame: number;
    if (
      this.state === FighterState.IDLE ||
      this.state === FighterState.WALK_FORWARD
    ) {
      const animSpeed = this.state === FighterState.IDLE ? 10 : 6;
      animFrame = Math.floor(this.stateFrame / animSpeed) % maxFrames;
    } else if (this.state === FighterState.WALK_BACKWARD) {
      const animSpeed = 6;
      animFrame = (maxFrames - 1) - (Math.floor(this.stateFrame / animSpeed) % maxFrames);
    } else if (
      this.state === FighterState.VICTORY ||
      this.state === FighterState.DEFEAT
    ) {
      animFrame = Math.min(Math.floor(this.stateFrame / 15), maxFrames - 1);
    } else {
      const totalDuration = this.getStateDuration();
      animFrame = getActionAnimationFrame({
        stateFrame: this.stateFrame,
        frameCount: maxFrames,
        totalDuration,
        playbackMode: this.layout.playbackModes[this.state] ?? 'timeline',
        attack: ATTACKS[this.state],
      });
    }

    return row * cols + animFrame;
  }

  private getStateDuration(): number {
    if (this.state === FighterState.FIREBALL) return 32;
    if (this.state === FighterState.UPPERCUT) return 37;
    const atk = ATTACKS[this.state];
    if (atk) {
      return atk.startup + atk.active + atk.recovery;
    }
    switch (this.state) {
      case FighterState.JUMP:       return 30;
      case FighterState.CROUCH:     return 8;
      case FighterState.BLOCK:      return 12;
      case FighterState.HIT_STUN:   return 14;
      case FighterState.KNOCKDOWN:  return 40;
      default:                      return 16;
    }
  }
}
