import { METER_MAX, clampMeter } from '../systems/Meter.ts';
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
  BODY_WIDTH,
  BODY_HEIGHT,
  type AttackData,
} from '../constants.ts';
import type { FighterInput } from '../sim/FighterInput.ts';
import { MotionInputs, type MotionInputsSnapshot } from '../systems/MotionInputs.ts';

/**
 * Complete simulation state of a fighter. Everything that can change a move
 * outcome is here (including the attack-press buffer and the motion-input
 * ring), so `restore(snapshot())` is exact — that is what rollback relies on.
 */
export interface FighterSnapshot {
  x: number;
  y: number;
  vx: number;
  vy: number;
  health: number;
  meter: number;
  pendingSuper: boolean;
  canFireProjectile: boolean;
  state: FighterState;
  stateFrame: number;
  facingRight: boolean;
  attackHit: boolean;
  comboCount: number;
  stunFrames: number;
  crouchBlocking: boolean;
  wasCrouching: boolean;
  bufferedPunch: number;
  bufferedKick: number;
  bufferedFireball: number;
  bufferedSuper: number;
  bufferedUppercut: number;
  motionInputs: MotionInputsSnapshot;
}

const FIGHTER_STATE_CODES: Record<FighterState, number> = Object.values(FighterState).reduce(
  (acc, state, index) => {
    acc[state] = index;
    return acc;
  },
  {} as Record<FighterState, number>,
);

/**
 * Pure fighter simulation. No Phaser, no wall clock, no randomness: given the
 * same input sequence it always produces the same state. Rendering lives in
 * `FighterView`.
 */
export class Fighter {
  x: number;
  y: number;
  vx = 0;
  vy = 0;
  health = MAX_HEALTH;
  /** Super meter, 0..METER_MAX. Persists across rounds within a match. */
  meter = 0;
  /** Set when a SUPER FIREBALL was paid for; consumed at projectile spawn. */
  pendingSuper = false;
  /** Sim-fed each tick: false while this fighter's projectile is live. */
  canFireProjectile = true;
  state = FighterState.IDLE;
  stateFrame = 0;
  facingRight: boolean;
  attackHit = false;
  comboCount = 0;
  stunFrames = 0;
  crouchBlocking = false;
  // Attack-button buffer: presses landing during recovery/stun are kept for a
  // few frames and fire on the first actionable frame (classic leniency).
  private bufferedPunch = 0;
  private bufferedKick = 0;
  private bufferedFireball = 0;
  private bufferedSuper = 0;
  private bufferedUppercut = 0;

  readonly playerIndex: number;
  readonly name: string;
  private motionInputs = new MotionInputs();
  private wasCrouching = false;

  constructor(playerIndex: number, name: string, x: number, facingRight: boolean) {
    this.playerIndex = playerIndex;
    this.name = name;
    this.x = x;
    this.y = GROUND_Y;
    this.facingRight = facingRight;
  }

  snapshot(): FighterSnapshot {
    return {
      x: this.x,
      y: this.y,
      vx: this.vx,
      vy: this.vy,
      health: this.health,
      meter: this.meter,
      pendingSuper: this.pendingSuper,
      canFireProjectile: this.canFireProjectile,
      state: this.state,
      stateFrame: this.stateFrame,
      facingRight: this.facingRight,
      attackHit: this.attackHit,
      comboCount: this.comboCount,
      stunFrames: this.stunFrames,
      crouchBlocking: this.crouchBlocking,
      wasCrouching: this.wasCrouching,
      bufferedPunch: this.bufferedPunch,
      bufferedKick: this.bufferedKick,
      bufferedFireball: this.bufferedFireball,
      bufferedSuper: this.bufferedSuper,
      bufferedUppercut: this.bufferedUppercut,
      motionInputs: this.motionInputs.snapshot(),
    };
  }

  restore(snap: FighterSnapshot): void {
    this.x = snap.x;
    this.y = snap.y;
    this.vx = snap.vx;
    this.vy = snap.vy;
    this.health = snap.health;
    this.meter = snap.meter;
    this.pendingSuper = snap.pendingSuper;
    this.canFireProjectile = snap.canFireProjectile;
    this.state = snap.state;
    this.stateFrame = snap.stateFrame;
    this.facingRight = snap.facingRight;
    this.attackHit = snap.attackHit;
    this.comboCount = snap.comboCount;
    this.stunFrames = snap.stunFrames;
    this.crouchBlocking = snap.crouchBlocking;
    this.wasCrouching = snap.wasCrouching;
    this.bufferedPunch = snap.bufferedPunch;
    this.bufferedKick = snap.bufferedKick;
    this.bufferedFireball = snap.bufferedFireball;
    this.bufferedSuper = snap.bufferedSuper;
    this.bufferedUppercut = snap.bufferedUppercut;
    this.motionInputs.restore(snap.motionInputs);
  }

  /** Feed every state field into a digest (desync detection). */
  hashInto(hasher: { num(value: number): void }): void {
    hasher.num(this.x);
    hasher.num(this.y);
    hasher.num(this.vx);
    hasher.num(this.vy);
    hasher.num(this.health);
    hasher.num(this.meter);
    hasher.num(this.pendingSuper ? 1 : 0);
    hasher.num(this.canFireProjectile ? 1 : 0);
    hasher.num(FIGHTER_STATE_CODES[this.state]);
    hasher.num(this.stateFrame);
    hasher.num(this.facingRight ? 1 : 0);
    hasher.num(this.attackHit ? 1 : 0);
    hasher.num(this.comboCount);
    hasher.num(this.stunFrames);
    hasher.num(this.crouchBlocking ? 1 : 0);
    hasher.num(this.wasCrouching ? 1 : 0);
    hasher.num(this.bufferedPunch);
    hasher.num(this.bufferedKick);
    hasher.num(this.bufferedFireball);
    hasher.num(this.bufferedSuper);
    hasher.num(this.bufferedUppercut);
    this.motionInputs.hashInto(hasher);
  }

  /** Round reset: full health, neutral pose at `x`, meter preserved. */
  resetForRound(x: number, facingRight: boolean): void {
    this.health = MAX_HEALTH;
    this.x = x;
    this.y = GROUND_Y;
    this.vx = 0;
    this.vy = 0;
    // Rounds always open squared up and with an empty bar: whatever side or
    // charge the previous round ended with does not carry over.
    this.facingRight = facingRight;
    this.meter = 0;
    this.forceState(FighterState.IDLE);
    this.stunFrames = 0;
    this.comboCount = 0;
    this.crouchBlocking = false;
    this.wasCrouching = false;
    this.pendingSuper = false;
    this.canFireProjectile = true;
    this.bufferedPunch = 0;
    this.bufferedKick = 0;
    this.bufferedFireball = 0;
    this.bufferedSuper = 0;
    this.bufferedUppercut = 0;
    this.motionInputs.reset();
  }

  gainMeter(amount: number): void {
    this.meter = clampMeter(this.meter + amount);
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

    // Capture attack presses while locked; decay the buffer each frame.
    const BUFFER_FRAMES = 7;
    if (!this.isActionable()) {
      if (input.punch) this.bufferedPunch = BUFFER_FRAMES;
      if (input.kick) this.bufferedKick = BUFFER_FRAMES;
      if (input.fireball) this.bufferedFireball = BUFFER_FRAMES;
      if (input.super) this.bufferedSuper = BUFFER_FRAMES;
      if (input.uppercut) this.bufferedUppercut = BUFFER_FRAMES;
    }
    if (this.bufferedPunch > 0) this.bufferedPunch--;
    if (this.bufferedKick > 0) this.bufferedKick--;
    if (this.bufferedFireball > 0) this.bufferedFireball--;
    if (this.bufferedSuper > 0) this.bufferedSuper--;
    if (this.bufferedUppercut > 0) this.bufferedUppercut--;

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

      // Special cancel: a normal that CONNECTED (hit or block) can cancel
      // into a special from its active frames through half its recovery —
      // the classic SF2 chain that makes punch->fireball a real combo.
      const isNormal =
        this.state === FighterState.HIGH_PUNCH ||
        this.state === FighterState.LOW_PUNCH ||
        this.state === FighterState.HIGH_KICK ||
        this.state === FighterState.LOW_KICK;
      const cancelWindowEnd = atk.startup + atk.active + Math.floor(atk.recovery / 2);
      if (isNormal && this.attackHit && this.stateFrame <= cancelWindowEnd) {
        this.motionInputs.feedInput(input, this.facingRight);
        const motion = this.motionInputs.checkMotion();
        if (input.uppercut || (motion === 'dp' && input.punch)) {
          this.setState(FighterState.UPPERCUT);
          this.vx = 0;
          this.vy = -500;
          this.applyPhysics(dt);
          return;
        }
        if (input.fireball || (motion === 'qcf' && input.punch)) {
          this.setState(FighterState.FIREBALL);
          this.vx = 0;
          this.applyPhysics(dt);
          return;
        }
      }

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

    // Replay buffered presses now that we are actionable.
    if (this.bufferedPunch > 0 || this.bufferedKick > 0 || this.bufferedFireball > 0 || this.bufferedUppercut > 0 || this.bufferedSuper > 0) {
      input = {
        ...input,
        punch: input.punch || this.bufferedPunch > 0,
        kick: input.kick || this.bufferedKick > 0,
        fireball: input.fireball || this.bufferedFireball > 0,
        uppercut: input.uppercut || this.bufferedUppercut > 0,
        super: input.super || this.bufferedSuper > 0,
      };
      this.bufferedPunch = 0;
      this.bufferedKick = 0;
      this.bufferedFireball = 0;
      this.bufferedUppercut = 0;
      this.bufferedSuper = 0;
    }

    const isHoldingBack = this.facingRight ? input.left : input.right;
    const holdingDown = input.down;

    // Shortcut keys for specials
    if (this.isActionable()) {
      if (input.super && this.meter >= METER_MAX && this.canFireProjectile) {
        this.meter = 0;
        this.pendingSuper = true;
        this.setState(FighterState.FIREBALL);
        this.vx = 0;
        this.applyPhysics(dt);
        return;
      }
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
        this.vx = 0;
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
      } else if (atk.knockdown) {
        // Sweep: soft knockdown with a small pop; the existing KNOCKDOWN
        // get-up logic (30 grounded frames) plays it out.
        this.setState(FighterState.KNOCKDOWN);
        this.vy = -260;
        this.vx = (this.facingRight ? -1 : 1) * Math.max(atk.pushback, 120);
        this.stunFrames = 0;
      } else {
        this.setState(FighterState.HIT_STUN);
        this.vx = (this.facingRight ? -1 : 1) * atk.pushback;
      }
    }
  }

  /** Uppercut startup is invincible (the classic reversal), and a downed
   * fighter can't be hit again until they're back up (OTG protection —
   * without it a sweep would loop into itself forever). */
  isInvulnerable(): boolean {
    if (this.state === FighterState.KNOCKDOWN) return true;
    return this.state === FighterState.UPPERCUT && this.stateFrame < 6;
  }

  forceState(state: FighterState): void {
    this.state = state;
    this.stateFrame = 0;
    this.attackHit = false;
    this.vx = 0;
    if (state === FighterState.UPPERCUT) {
      this.vy = -500;
    }
    // Round-end presentation states happen on the floor. Winning or losing
    // mid-jump used to freeze the fighter at their airborne y forever.
    if (
      state === FighterState.VICTORY ||
      state === FighterState.DEFEAT ||
      state === FighterState.KNOCKDOWN ||
      state === FighterState.IDLE
    ) {
      this.y = GROUND_Y;
      this.vy = 0;
    }
  }

  /**
   * Round-end pose playback: the sim keeps ticking a downed fighter until
   * they settle into DEFEAT, so the KO pop plays out identically everywhere.
   */
  advancePresentation(dt: number, opponentX: number): void {
    if (Math.abs(opponentX - this.x) > 4) {
      this.facingRight = opponentX > this.x;
    }

    this.stateFrame++;

    if (this.state === FighterState.KNOCKDOWN) {
      this.applyPhysics(dt);
      if (this.health <= 0 && this.isGrounded() && this.stateFrame >= 30) {
        this.forceState(FighterState.DEFEAT);
      }
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
}
