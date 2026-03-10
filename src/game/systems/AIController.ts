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
    const opponentAttackData = opponent.getAttackData();
    const opponentRecoveryStart = opponentAttackData
      ? opponentAttackData.startup + opponentAttackData.active
      : Number.MAX_SAFE_INTEGER;
    const opponentThreatening = opponentAttacking && opponent.stateFrame < opponentRecoveryStart;
    const opponentInRecovery = opponentAttacking && opponent.stateFrame >= opponentRecoveryStart;
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
    const isBrawler = this.personality.id === 'brawler';
    const isCounter = this.personality.id === 'counter';
    const isZoner = this.personality.id === 'zoner';
    const isShowboat = this.personality.id === 'showboat';
    const punishBonus = opponentInRecovery ? 0.14 + reversal * 0.26 + patience * 0.12 : 0;

    let options: WeightedAction[] = [];

    if (cornered) {
      const escapeDir = self.facingRight ? { right: true } : { left: true };
      this.pushOption(options, 0.18 + flair * 0.15 + zoning * 0.18 + (isZoner ? 0.08 : 0), {
        input: { up: true, ...escapeDir },
        minFrames: 24,
        maxFrames: 32,
      });
      this.pushOption(options, 0.12 + patience * 0.24 + reversal * 0.16 + (isCounter ? 0.08 : 0), {
        input: { guard: true },
        minFrames: 10,
        maxFrames: 18,
      });
    }

    if (dist > farRange) {
      this.pushOption(options, 0.32 + aggression * 0.34 + (isBrawler ? 0.16 : 0) - zoning * 0.28 - patience * 0.12, {
        input: self.facingRight ? { right: true } : { left: true },
        minFrames: 10,
        maxFrames: 24,
      });
      this.pushOption(options, 0.06 + flair * 0.22 + (isShowboat ? 0.16 : 0), {
        input: { up: true, ...(self.facingRight ? { right: true } : { left: true }) },
        minFrames: 20,
        maxFrames: 28,
      });
      this.pushOption(options, this.specialCooldown <= 0 ? 0.1 + zoning * 0.9 + (isZoner ? 0.18 : 0) : 0, {
        forceState: FighterState.FIREBALL,
        minFrames: 28,
        maxFrames: 36,
        specialCooldown: 90,
      });
      this.pushOption(options, 0.08 + patience * 0.24 + zoning * 0.16, {
        input: self.facingRight ? { left: true } : { right: true },
        minFrames: 8,
        maxFrames: 14,
      });
      this.pushOption(options, 0.05 + patience * 0.22, {
        input: {},
        minFrames: 8,
        maxFrames: 16,
      });
    } else if (dist > kickRange) {
      this.pushOption(options, 0.2 + aggression * 0.32 + (isBrawler ? 0.12 : 0) - zoning * 0.18 - patience * 0.08, {
        input: self.facingRight ? { right: true } : { left: true },
        minFrames: 6,
        maxFrames: 16,
      });
      this.pushOption(options, 0.08 + flair * 0.28 + (isShowboat ? 0.12 : 0), {
        input: { up: true, ...(self.facingRight ? { right: true } : { left: true }) },
        minFrames: 24,
        maxFrames: 32,
      });
      this.pushOption(options, this.specialCooldown <= 0 ? 0.08 + zoning * 0.42 + (isZoner ? 0.1 : 0) : 0, {
        forceState: FighterState.FIREBALL,
        minFrames: 28,
        maxFrames: 34,
        specialCooldown: 90,
      });
      this.pushOption(options, this.specialCooldown <= 0 && opponentAirborne && inAntiAirRange ? 0.1 + reversal * 0.34 + (isCounter ? 0.08 : 0) : 0, {
        forceState: FighterState.UPPERCUT,
        minFrames: 28,
        maxFrames: 36,
        specialCooldown: 90,
      });
      this.pushOption(options, 0.12 + patience * 0.22 + zoning * 0.32 + (isZoner ? 0.08 : 0), {
        input: self.facingRight ? { left: true } : { right: true },
        minFrames: 8,
        maxFrames: 14,
      });
      this.pushOption(options, opponentThreatening ? 0.08 + patience * 0.28 + reversal * 0.12 : 0, {
        input: { guard: true },
        minFrames: 8,
        maxFrames: 14,
      });
      this.pushOption(options, 0.05 + patience * 0.18, {
        input: {},
        minFrames: 6,
        maxFrames: 14,
      });
    } else if (!inPunchRange) {
      const retreatInput = self.facingRight ? { left: true } : { right: true };
      const blockWeight = opponentThreatening
        ? 0.24 + patience * 0.46 + reversal * 0.14 + (isCounter ? 0.12 : 0)
        : 0.05 + patience * 0.08;

      this.pushOption(options, blockWeight, {
        input: opponentThreatening && this.rng.next() < 0.42 + reversal * 0.18
          ? { guard: true, down: true }
          : { guard: true },
        minFrames: 8,
        maxFrames: 14,
      });
      this.pushOption(options, 0.14 + aggression * 0.18 + flair * 0.14 + punishBonus * 0.4 - (opponentThreatening ? patience * 0.08 : 0), {
        input: { kick: true },
        minFrames: 14,
        maxFrames: 18,
      });
      this.pushOption(options, inLowStrikeRange ? 0.14 + aggression * 0.16 + flair * 0.08 + zoning * 0.08 + punishBonus * 0.2 : 0, {
        input: { down: true, kick: true },
        minFrames: 16,
        maxFrames: 22,
      });
      this.pushOption(options, 0.1 + aggression * 0.12 + (isBrawler ? 0.12 : 0) - patience * 0.06 - zoning * 0.1, {
        input: self.facingRight ? { right: true } : { left: true },
        minFrames: 4,
        maxFrames: 10,
      });
      this.pushOption(options, this.specialCooldown <= 0 && opponentAirborne && inAntiAirRange ? 0.08 + reversal * 0.46 + (isCounter ? 0.08 : 0) : 0, {
        forceState: FighterState.UPPERCUT,
        minFrames: 28,
        maxFrames: 36,
        specialCooldown: 90,
      });
      this.pushOption(options, 0.12 + patience * 0.28 + zoning * 0.18 + (opponentThreatening ? 0.08 : 0), {
        input: retreatInput,
        minFrames: 5,
        maxFrames: 10,
      });
      this.pushOption(options, this.specialCooldown <= 0 && isZoner && !opponentThreatening ? 0.08 + zoning * 0.22 : 0, {
        forceState: FighterState.FIREBALL,
        minFrames: 28,
        maxFrames: 34,
        specialCooldown: 90,
      });
      this.pushOption(options, 0.04 + patience * 0.12, {
        input: {},
        minFrames: 5,
        maxFrames: 10,
      });
    } else {
      const retreatInput = self.facingRight ? { left: true } : { right: true };
      const blockWeight = opponentThreatening
        ? 0.28 + patience * 0.5 + reversal * 0.16 + (isCounter ? 0.14 : 0)
        : 0.05 + patience * 0.08;

      this.pushOption(options, blockWeight, {
        input: opponentThreatening && this.rng.next() < 0.45 + reversal * 0.2
          ? { guard: true, down: true }
          : { guard: true },
        minFrames: 8,
        maxFrames: 16,
      });
      this.pushOption(options, 0.14 + aggression * 0.18 + punishBonus * 0.9, {
        input: { punch: true },
        minFrames: 12,
        maxFrames: 16,
      });
      this.pushOption(options, inKickRange ? 0.12 + aggression * 0.14 + flair * 0.18 + punishBonus * 0.45 : 0, {
        input: { kick: true },
        minFrames: 14,
        maxFrames: 18,
      });
      this.pushOption(options, inLowStrikeRange ? 0.1 + aggression * 0.1 + flair * 0.08 + punishBonus * 0.28 : 0, {
        input: { down: true, punch: true },
        minFrames: 16,
        maxFrames: 22,
      });
      this.pushOption(options, inLowStrikeRange ? 0.1 + aggression * 0.1 + flair * 0.08 + zoning * 0.08 + punishBonus * 0.2 : 0, {
        input: { down: true, kick: true },
        minFrames: 18,
        maxFrames: 24,
      });
      this.pushOption(options, this.specialCooldown <= 0 && opponentThreatening && inAntiAirRange ? 0.06 + reversal * 0.5 + (isCounter ? 0.08 : 0) : 0, {
        forceState: FighterState.UPPERCUT,
        minFrames: 30,
        maxFrames: 38,
        specialCooldown: 90,
      });
      this.pushOption(options, 0.12 + patience * 0.3 + zoning * 0.2 + (opponentThreatening ? 0.08 : 0), {
        input: retreatInput,
        minFrames: 5,
        maxFrames: 12,
      });
      this.pushOption(options, 0.03 + flair * 0.08 + (isShowboat ? 0.08 : 0) + (isZoner ? 0.04 : 0), {
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
