import type { FighterInput } from './InputManager.ts';
import type { Fighter } from '../fighters/Fighter.ts';
import type { SeededRng } from '../utils/SeededRng.ts';
import { FighterState, BODY_WIDTH, STAGE_LEFT, STAGE_RIGHT } from '../constants.ts';

export class AIController {
  private rng: SeededRng;
  private actionCooldown = 0;
  private currentAction: Partial<FighterInput> = {};
  private specialCooldown = 0;

  constructor(rng: SeededRng) {
    this.rng = rng;
  }

  getInput(self: Fighter, opponent: Fighter): FighterInput {
    const dist = Math.abs(self.x - opponent.x);
    const opponentAttacking = opponent.isInAttack();

    if (this.specialCooldown > 0) this.specialCooldown--;

    if (this.actionCooldown > 0) {
      this.actionCooldown--;
      return this.buildInput();
    }

    this.currentAction = {};
    const roll = this.rng.next();

    const nearLeftWall = self.x < STAGE_LEFT + BODY_WIDTH;
    const nearRightWall = self.x > STAGE_RIGHT - BODY_WIDTH;
    const cornered = (nearLeftWall || nearRightWall) && dist < BODY_WIDTH * 3;

    if (cornered && roll < 0.25) {
      const jumpDir = self.facingRight ? { right: true } : { left: true };
      this.currentAction = { up: true, ...jumpDir };
      this.actionCooldown = 30;
    } else if (dist > BODY_WIDTH * 5) {
      this.currentAction = self.facingRight ? { right: true } : { left: true };
      this.actionCooldown = this.rng.nextInt(10, 25);
    } else if (dist > BODY_WIDTH * 2.5) {
      if (this.specialCooldown <= 0 && dist > BODY_WIDTH * 3 && roll < 0.1) {
        self.forceState(FighterState.FIREBALL);
        this.specialCooldown = 90;
        this.actionCooldown = 32;
        return this.buildInput();
      }
      if (this.specialCooldown <= 0 && dist < BODY_WIDTH * 4 && roll >= 0.1 && roll < 0.18) {
        self.forceState(FighterState.UPPERCUT);
        this.specialCooldown = 90;
        this.actionCooldown = 37;
        return this.buildInput();
      }
      if (roll < 0.3) {
        this.currentAction = self.facingRight ? { right: true } : { left: true };
        this.actionCooldown = this.rng.nextInt(5, 15);
      } else if (roll < 0.5) {
        this.currentAction = { kick: true };
        this.actionCooldown = 20;
      } else if (roll < 0.7) {
        this.currentAction = { up: true, ...(self.facingRight ? { right: true } : { left: true }) };
        this.actionCooldown = 30;
      } else {
        this.currentAction = {};
        this.actionCooldown = this.rng.nextInt(5, 15);
      }
    } else {
      if (opponentAttacking && roll < 0.4) {
        if (roll < 0.2) {
          this.currentAction = { guard: true, down: true };
        } else {
          this.currentAction = { guard: true };
        }
        this.actionCooldown = this.rng.nextInt(8, 16);
      } else if (roll < 0.5) {
        this.currentAction = { punch: true };
        this.actionCooldown = 14;
      } else if (roll < 0.6) {
        this.currentAction = { kick: true };
        this.actionCooldown = 16;
      } else if (roll < 0.7) {
        // Crouch then attack for low attacks
        this.currentAction = { down: true, punch: true };
        this.actionCooldown = 18;
      } else if (roll < 0.8) {
        this.currentAction = { down: true, kick: true };
        this.actionCooldown = 20;
      } else {
        this.currentAction = self.facingRight ? { left: true } : { right: true };
        this.actionCooldown = this.rng.nextInt(5, 12);
      }
    }

    return this.buildInput();
  }

  private buildInput(): FighterInput {
    return {
      left: this.currentAction.left ?? false,
      right: this.currentAction.right ?? false,
      up: this.currentAction.up ?? false,
      down: this.currentAction.down ?? false,
      guard: this.currentAction.guard ?? false,
      punch: this.currentAction.punch ?? false,
      kick: this.currentAction.kick ?? false,
      fireball: this.currentAction.fireball ?? false,
      uppercut: this.currentAction.uppercut ?? false,
    };
  }
}
