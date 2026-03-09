import type { FighterInput } from './InputManager.ts';
import type { Fighter } from '../fighters/Fighter.ts';
import type { SeededRng } from '../utils/SeededRng.ts';
import { FighterState, MAX_HEALTH, STAGE_LEFT, STAGE_RIGHT } from '../constants.ts';
import type { FighterPersonality } from '../match/MatchConfig.ts';
import { getFighterPersonality } from '../match/MatchConfig.ts';

interface PlannedAction {
  input?: Partial<FighterInput>;
  forceState?: FighterState;
  minFrames?: number;
  maxFrames?: number;
  specialCooldown?: number;
}

interface WeightedAction {
  weight: number;
  action: PlannedAction;
}

export class AIController {
  private rng: SeededRng;
  private personality: FighterPersonality;
  private actionCooldown = 0;
  private currentAction: Partial<FighterInput> = {};
  private specialCooldown = 0;

  constructor(rng: SeededRng, personality = getFighterPersonality()) {
    this.rng = rng;
    this.personality = personality;
  }

  setPersonality(personality: FighterPersonality): void {
    this.personality = personality;
  }

  getInput(self: Fighter, opponent: Fighter): FighterInput {
    const dist = Math.abs(self.x - opponent.x);
    const opponentAttacking = opponent.isInAttack();
    const opponentAirborne = !opponent.isGrounded();
    const bodyWidth = self.getBodyWidth();
    const punchRange = self.getAttackRange(FighterState.HIGH_PUNCH) + 8;
    const kickRange = Math.max(
      self.getAttackRange(FighterState.HIGH_KICK),
      self.getAttackRange(FighterState.LOW_KICK),
    ) + 10;
    const lowStrikeRange = Math.max(
      self.getAttackRange(FighterState.LOW_PUNCH),
      self.getAttackRange(FighterState.LOW_KICK),
    ) + 8;
    const antiAirRange = self.getAttackRange(FighterState.UPPERCUT) + 18;
    const maxMeleeRange = self.getMaxMeleeRange();
    const approachRange = maxMeleeRange + bodyWidth * 0.85;
    const farRange = maxMeleeRange + bodyWidth * 2.75;
    const inPunchRange = dist <= punchRange;
    const inKickRange = dist <= kickRange;
    const inLowStrikeRange = dist <= lowStrikeRange;
    const inAntiAirRange = dist <= antiAirRange;

    if (this.specialCooldown > 0) this.specialCooldown--;

    if (this.actionCooldown > 0) {
      this.actionCooldown--;
      return this.buildInput();
    }

    this.currentAction = {};
    const nearLeftWall = self.x < STAGE_LEFT + bodyWidth;
    const nearRightWall = self.x > STAGE_RIGHT - bodyWidth;
    const cornered = (nearLeftWall || nearRightWall) && dist < approachRange;

    const comebackFactor = Math.max(0, Math.min(1, (opponent.health - self.health) / MAX_HEALTH));
    const aggression = this.clamp01(this.personality.aggression + comebackFactor * 0.3);
    const patience = this.clamp01(this.personality.patience - comebackFactor * 0.12);
    const flair = this.clamp01(this.personality.flair + comebackFactor * 0.2);
    const zoning = this.clamp01(this.personality.zoning);
    const reversal = this.clamp01(this.personality.reversal + comebackFactor * 0.18);

    let options: WeightedAction[] = [];

    if (cornered) {
      const escapeDir = self.facingRight ? { right: true } : { left: true };
      this.pushOption(options, 0.2 + flair * 0.15 + zoning * 0.1, {
        input: { up: true, ...escapeDir },
        minFrames: 24,
        maxFrames: 32,
      });
      this.pushOption(options, 0.1 + patience * 0.2 + reversal * 0.15, {
        input: { guard: true },
        minFrames: 10,
        maxFrames: 18,
      });
    }

    if (dist > farRange) {
      this.pushOption(options, 0.55 + aggression * 0.5 - zoning * 0.1, {
        input: self.facingRight ? { right: true } : { left: true },
        minFrames: 10,
        maxFrames: 24,
      });
      this.pushOption(options, 0.12 + flair * 0.25, {
        input: { up: true, ...(self.facingRight ? { right: true } : { left: true }) },
        minFrames: 20,
        maxFrames: 28,
      });
      this.pushOption(options, this.specialCooldown <= 0 ? 0.08 + zoning * 0.85 : 0, {
        forceState: FighterState.FIREBALL,
        minFrames: 28,
        maxFrames: 36,
        specialCooldown: 90,
      });
      this.pushOption(options, 0.06 + patience * 0.25, {
        input: {},
        minFrames: 8,
        maxFrames: 16,
      });
    } else if (dist > kickRange) {
      this.pushOption(options, 0.3 + aggression * 0.4, {
        input: self.facingRight ? { right: true } : { left: true },
        minFrames: 6,
        maxFrames: 16,
      });
      this.pushOption(options, 0.12 + flair * 0.35, {
        input: { up: true, ...(self.facingRight ? { right: true } : { left: true }) },
        minFrames: 24,
        maxFrames: 32,
      });
      this.pushOption(options, this.specialCooldown <= 0 ? 0.06 + zoning * 0.38 : 0, {
        forceState: FighterState.FIREBALL,
        minFrames: 28,
        maxFrames: 34,
        specialCooldown: 90,
      });
      this.pushOption(options, this.specialCooldown <= 0 && opponentAirborne && inAntiAirRange ? 0.08 + reversal * 0.32 : 0, {
        forceState: FighterState.UPPERCUT,
        minFrames: 28,
        maxFrames: 36,
        specialCooldown: 90,
      });
      this.pushOption(options, 0.08 + patience * 0.18 + zoning * 0.22, {
        input: self.facingRight ? { left: true } : { right: true },
        minFrames: 8,
        maxFrames: 14,
      });
      this.pushOption(options, 0.06 + patience * 0.18, {
        input: {},
        minFrames: 6,
        maxFrames: 14,
      });
    } else if (!inPunchRange) {
      const retreatInput = self.facingRight ? { left: true } : { right: true };
      const blockWeight = opponentAttacking ? 0.16 + patience * 0.4 + reversal * 0.1 : 0.04 + patience * 0.08;

      this.pushOption(options, blockWeight, {
        input: opponentAttacking && this.rng.next() < 0.42 + reversal * 0.18
          ? { guard: true, down: true }
          : { guard: true },
        minFrames: 8,
        maxFrames: 14,
      });
      this.pushOption(options, 0.24 + aggression * 0.24 + flair * 0.18, {
        input: { kick: true },
        minFrames: 14,
        maxFrames: 18,
      });
      this.pushOption(options, inLowStrikeRange ? 0.18 + aggression * 0.2 + flair * 0.08 : 0, {
        input: { down: true, kick: true },
        minFrames: 16,
        maxFrames: 22,
      });
      this.pushOption(options, 0.16 + aggression * 0.2, {
        input: self.facingRight ? { right: true } : { left: true },
        minFrames: 4,
        maxFrames: 10,
      });
      this.pushOption(options, this.specialCooldown <= 0 && opponentAirborne && inAntiAirRange ? 0.06 + reversal * 0.42 : 0, {
        forceState: FighterState.UPPERCUT,
        minFrames: 28,
        maxFrames: 36,
        specialCooldown: 90,
      });
      this.pushOption(options, 0.08 + patience * 0.24 + zoning * 0.12, {
        input: retreatInput,
        minFrames: 5,
        maxFrames: 10,
      });
      this.pushOption(options, 0.04 + patience * 0.12, {
        input: {},
        minFrames: 5,
        maxFrames: 10,
      });
    } else {
      const retreatInput = self.facingRight ? { left: true } : { right: true };
      const blockWeight = opponentAttacking ? 0.18 + patience * 0.45 + reversal * 0.12 : 0.04 + patience * 0.08;

      this.pushOption(options, blockWeight, {
        input: opponentAttacking && this.rng.next() < 0.45 + reversal * 0.2
          ? { guard: true, down: true }
          : { guard: true },
        minFrames: 8,
        maxFrames: 16,
      });
      this.pushOption(options, 0.22 + aggression * 0.34, {
        input: { punch: true },
        minFrames: 12,
        maxFrames: 16,
      });
      this.pushOption(options, inKickRange ? 0.16 + aggression * 0.18 + flair * 0.22 : 0, {
        input: { kick: true },
        minFrames: 14,
        maxFrames: 18,
      });
      this.pushOption(options, inLowStrikeRange ? 0.14 + aggression * 0.16 + flair * 0.1 : 0, {
        input: { down: true, punch: true },
        minFrames: 16,
        maxFrames: 22,
      });
      this.pushOption(options, inLowStrikeRange ? 0.12 + aggression * 0.18 + flair * 0.08 : 0, {
        input: { down: true, kick: true },
        minFrames: 18,
        maxFrames: 24,
      });
      this.pushOption(options, this.specialCooldown <= 0 && opponentAttacking && inAntiAirRange ? 0.04 + reversal * 0.55 : 0, {
        forceState: FighterState.UPPERCUT,
        minFrames: 30,
        maxFrames: 38,
        specialCooldown: 90,
      });
      this.pushOption(options, 0.08 + patience * 0.24 + zoning * 0.16, {
        input: retreatInput,
        minFrames: 5,
        maxFrames: 12,
      });
      this.pushOption(options, 0.03 + flair * 0.08, {
        input: { up: true, ...retreatInput },
        minFrames: 18,
        maxFrames: 26,
      });
      this.pushOption(options, 0.04 + patience * 0.12, {
        input: {},
        minFrames: 5,
        maxFrames: 10,
      });
    }

    const choice = this.pickAction(options);
    if (choice.forceState !== undefined) {
      self.forceState(choice.forceState);
      this.specialCooldown = choice.specialCooldown ?? this.specialCooldown;
    }

    this.currentAction = choice.input ?? {};
    this.actionCooldown = this.resolveCooldown(choice.minFrames, choice.maxFrames);
    return this.buildInput();
  }

  private pushOption(options: WeightedAction[], weight: number, action: PlannedAction): void {
    if (weight <= 0) return;
    options.push({ weight, action });
  }

  private pickAction(options: WeightedAction[]): PlannedAction {
    if (options.length === 0) return { input: {}, minFrames: 8, maxFrames: 16 };

    let total = 0;
    for (const option of options) total += option.weight;

    let roll = this.rng.next() * total;
    for (const option of options) {
      roll -= option.weight;
      if (roll <= 0) return option.action;
    }

    return options[options.length - 1].action;
  }

  private resolveCooldown(minFrames?: number, maxFrames?: number): number {
    const tempo = this.clamp01(this.personality.tempo);
    const baseMin = minFrames ?? Math.max(4, Math.round(9 - tempo * 4));
    const baseMax = maxFrames ?? Math.max(baseMin, Math.round(18 - tempo * 6));
    return this.rng.nextInt(baseMin, baseMax);
  }

  private clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
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
