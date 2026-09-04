import { Fighter, type FighterSnapshot } from '../fighters/Fighter.ts';
import { Projectile, type ProjectileSnapshot } from '../fighters/Projectile.ts';
import { CombatSystem, type HitEvent } from '../systems/CombatSystem.ts';
import { AIController, type AIControllerSnapshot } from '../systems/AIController.ts';
import {
  REFLECT_METER_GAIN,
  attackerMeterGain,
  defenderMeterGain,
} from '../systems/Meter.ts';
import { SeededRng } from '../utils/SeededRng.ts';
import {
  ATTACKS,
  FIXED_TIMESTEP,
  FighterState,
  GAME_WIDTH,
  ROUND_TIME,
} from '../constants.ts';
import {
  getFighterPersonality,
  resolveMatchRoundsToWin,
  type FighterPersonality,
} from '../match/MatchConfig.ts';
import { EMPTY_INPUT, packInput, unpackInput, type FighterInput } from './FighterInput.ts';
import { StateHasher } from './StateHasher.ts';

export const SIM_TICK_RATE = 60;
const DT = FIXED_TIMESTEP / 1000;

export const P1_START_X = 250;
export const P2_START_X = GAME_WIDTH - 250;

/** Round 1 plays the versus cinematic (2.5 s); later rounds a shorter card. */
export const CINEMATIC_INTRO_TICKS = 150;
export const ROUND_INTRO_TICKS = 120;
/** Cinematic intro cue schedule, in ticks (was 420/760/1750/1900 ms). */
export const CINEMATIC_SKIPPABLE_TICK = 25;
export const CINEMATIC_ROUND_CUE_TICK = 46;
export const CINEMATIC_FIGHT_CUE_TICK = 105;
export const CINEMATIC_HIDE_CUE_TICK = 114;
/** Later rounds: "ROUND N" immediately, "FIGHT" at 1.3 s. */
export const ROUND_FIGHT_CUE_TICK = 78;
export const ROUND_END_TICKS = 180;
export const MATCH_END_TICKS = 300;
export const MATCH_WINS_CUE_TICK = 160;
export const ROUND_TICKS = ROUND_TIME * SIM_TICK_RATE;
const KO_HITSTOP_TICKS = 14;

export enum RoundPhase {
  INTRO = 0,
  FIGHTING = 1,
  ROUND_END = 2,
  MATCH_END = 3,
  /** Terminal: the match-over UI owns the screen; `step` is a no-op. */
  MATCH_OVER = 4,
}

export type PlayerSlot = 0 | 1;

export type RoundOutcome = 'ko' | 'double_ko' | 'draw' | 'decision';

export type IntroCue = 'skippable' | 'round' | 'fight' | 'hide';

export type MatchSimEvent =
  | { type: 'roundStart'; roundNumber: number; cinematic: boolean }
  | { type: 'introCue'; cue: IntroCue; roundNumber: number }
  | { type: 'fightStart'; skipped: boolean }
  | { type: 'attackStart'; playerIndex: PlayerSlot; state: FighterState }
  | {
      type: 'hit';
      attacker: PlayerSlot;
      defender: PlayerSlot;
      damage: number;
      blocked: boolean;
      counter: boolean;
      comboCount: number;
    }
  | {
      type: 'projectileHit';
      attacker: PlayerSlot;
      defender: PlayerSlot;
      damage: number;
      blocked: boolean;
    }
  | { type: 'reflect'; playerIndex: PlayerSlot; x: number; y: number }
  | { type: 'clash'; x: number; y: number }
  | { type: 'superFireball'; playerIndex: PlayerSlot }
  | { type: 'roundEnd'; outcome: RoundOutcome; winner: PlayerSlot | null }
  | { type: 'matchEnd'; winner: PlayerSlot }
  | { type: 'winsCue'; winner: PlayerSlot }
  | { type: 'matchOver' };

export interface MatchSimConfig {
  seed: number;
  /** P2 is CPU-controlled. */
  vsAI: boolean;
  /** P1 is also CPU-controlled (attract mode). Implies vsAI. */
  cpuVsCpu: boolean;
  p1Name: string;
  p2Name: string;
  /** Round wins needed for the match. Omitted preserves the normal value. */
  roundsToWin?: number;
  p1Personality?: FighterPersonality;
  p2Personality?: FighterPersonality;
  /** Arcade-ladder AI strength for the P2 CPU, 0..1. */
  p2Difficulty?: number;
}

export interface MatchSimSnapshot {
  tick: number;
  phase: RoundPhase;
  phaseTimer: number;
  introTick: number;
  introCinematic: boolean;
  introSkippable: boolean;
  introSkipRequested: boolean;
  introPlayed: boolean;
  roundTicks: number;
  fightTicks: number;
  p1Wins: number;
  p2Wins: number;
  hitstopFrames: number;
  latchedP1: number | null;
  latchedP2: number | null;
  nextProjectileId: number;
  p1: FighterSnapshot;
  p2: FighterSnapshot;
  projectiles: ProjectileSnapshot[];
  ai: AIControllerSnapshot | null;
  ai2: AIControllerSnapshot | null;
}

function mixSeed(seed: number, salt: number): number {
  const mixed = Math.imul(seed ^ salt, 0x45d9f3b);
  const normalized = mixed >>> 0;
  return normalized === 0 ? salt >>> 0 : normalized;
}

function aabbOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/**
 * Headless, deterministic match simulation: fighters, projectiles, round
 * flow, hitstop, and the CPU opponents, all advanced one 60 Hz tick at a
 * time by `step()`. It never touches Phaser, the DOM, timers, or `Math.random`,
 * so two machines fed the same `MatchSimConfig` and the same per-tick inputs
 * reach bit-identical state (`checksum()`), and `restore(snapshot())` is exact
 * — the two properties rollback netplay and replays depend on.
 */
export class MatchSimulation {
  readonly config: Readonly<MatchSimConfig>;
  readonly p1: Fighter;
  readonly p2: Fighter;
  readonly p1IsCpu: boolean;
  readonly p2IsCpu: boolean;
  readonly roundsToWin: number;
  projectiles: Projectile[] = [];

  /** Total ticks stepped since the match began (all phases). */
  tick = 0;
  phase = RoundPhase.INTRO;
  phaseTimer = 0;
  p1Wins = 0;
  p2Wins = 0;
  hitstopFrames = 0;
  /** Remaining round clock in ticks. */
  roundTicks = ROUND_TICKS;
  /** FIGHTING ticks stepped in the current round. */
  fightTicks = 0;

  private introTick = 0;
  private introCinematic = false;
  private introSkippable = false;
  private introSkipRequested = false;
  private introPlayed = false;
  private latchedP1: FighterInput | null = null;
  private latchedP2: FighterInput | null = null;
  private nextProjectileId = 1;

  private readonly combat = new CombatSystem();
  private readonly ai: AIController | null;
  private readonly ai2: AIController | null;

  constructor(config: MatchSimConfig) {
    const cpuVsCpu = config.cpuVsCpu === true;
    const vsAI = config.vsAI || cpuVsCpu;
    this.roundsToWin = resolveMatchRoundsToWin(config.roundsToWin);
    this.config = Object.freeze({
      ...config,
      vsAI,
      cpuVsCpu,
      roundsToWin: this.roundsToWin,
    });
    this.p1IsCpu = cpuVsCpu;
    this.p2IsCpu = vsAI;

    this.p1 = new Fighter(0, config.p1Name, P1_START_X, true);
    this.p2 = new Fighter(1, config.p2Name, P2_START_X, false);

    const p1Personality = config.p1Personality ?? getFighterPersonality();
    const p2Personality = config.p2Personality ?? getFighterPersonality();
    this.ai = vsAI
      ? new AIController(new SeededRng(mixSeed(config.seed, 0x6d2b79f5)), p2Personality, config.p2Difficulty ?? 1)
      : null;
    this.ai2 = cpuVsCpu
      ? new AIController(new SeededRng(mixSeed(config.seed, 0x1b873593)), p1Personality)
      : null;
  }

  /** Round number about to be played / in progress (1-based). */
  get roundNumber(): number {
    return this.p1Wins + this.p2Wins + 1;
  }

  /** Seconds left on the round clock as shown on the HUD. */
  get timerSeconds(): number {
    return Math.max(0, Math.ceil(this.roundTicks / SIM_TICK_RATE));
  }

  get isCinematicIntroActive(): boolean {
    return this.phase === RoundPhase.INTRO && this.introCinematic;
  }

  get canSkipIntro(): boolean {
    return this.phase === RoundPhase.INTRO && this.introSkippable && !this.introSkipRequested;
  }

  /** Emits the first round's `roundStart`. Call exactly once before stepping. */
  start(): MatchSimEvent[] {
    const events: MatchSimEvent[] = [];
    this.startRound(events);
    return events;
  }

  /**
   * Ask to cut the cinematic intro short. Applied on the next `step`, so the
   * request is part of the tick stream rather than a mid-tick mutation.
   */
  requestIntroSkip(): boolean {
    if (!this.canSkipIntro) return false;
    this.introSkipRequested = true;
    return true;
  }

  /**
   * Advance one tick. Inputs for CPU-controlled slots are ignored (the sim
   * generates them), so callers can always pass whatever they sampled.
   */
  step(p1Input: FighterInput, p2Input: FighterInput): MatchSimEvent[] {
    const events: MatchSimEvent[] = [];
    if (this.phase === RoundPhase.MATCH_OVER) return events;
    this.tick++;

    switch (this.phase) {
      case RoundPhase.INTRO:
        this.stepIntro(events);
        break;
      case RoundPhase.FIGHTING:
        this.stepFight(p1Input, p2Input, events);
        break;
      case RoundPhase.ROUND_END:
      case RoundPhase.MATCH_END:
        this.stepRoundEnd(events);
        break;
    }
    return events;
  }

  snapshot(): MatchSimSnapshot {
    return {
      tick: this.tick,
      phase: this.phase,
      phaseTimer: this.phaseTimer,
      introTick: this.introTick,
      introCinematic: this.introCinematic,
      introSkippable: this.introSkippable,
      introSkipRequested: this.introSkipRequested,
      introPlayed: this.introPlayed,
      roundTicks: this.roundTicks,
      fightTicks: this.fightTicks,
      p1Wins: this.p1Wins,
      p2Wins: this.p2Wins,
      hitstopFrames: this.hitstopFrames,
      latchedP1: this.latchedP1 ? packInput(this.latchedP1) : null,
      latchedP2: this.latchedP2 ? packInput(this.latchedP2) : null,
      nextProjectileId: this.nextProjectileId,
      p1: this.p1.snapshot(),
      p2: this.p2.snapshot(),
      projectiles: this.projectiles.map((proj) => proj.snapshot()),
      ai: this.ai?.snapshot() ?? null,
      ai2: this.ai2?.snapshot() ?? null,
    };
  }

  restore(snap: MatchSimSnapshot): void {
    this.tick = snap.tick;
    this.phase = snap.phase;
    this.phaseTimer = snap.phaseTimer;
    this.introTick = snap.introTick;
    this.introCinematic = snap.introCinematic;
    this.introSkippable = snap.introSkippable;
    this.introSkipRequested = snap.introSkipRequested;
    this.introPlayed = snap.introPlayed;
    this.roundTicks = snap.roundTicks;
    this.fightTicks = snap.fightTicks;
    this.p1Wins = snap.p1Wins;
    this.p2Wins = snap.p2Wins;
    this.hitstopFrames = snap.hitstopFrames;
    this.latchedP1 = snap.latchedP1 === null ? null : unpackInput(snap.latchedP1);
    this.latchedP2 = snap.latchedP2 === null ? null : unpackInput(snap.latchedP2);
    this.nextProjectileId = snap.nextProjectileId;
    this.p1.restore(snap.p1);
    this.p2.restore(snap.p2);
    this.projectiles = snap.projectiles.map((proj) => Projectile.fromSnapshot(proj));
    if (this.ai && snap.ai) this.ai.restore(snap.ai);
    if (this.ai2 && snap.ai2) this.ai2.restore(snap.ai2);
  }

  /** Bit-exact digest of the whole simulation state. */
  checksum(): number {
    const hasher = new StateHasher();
    hasher.num(this.tick);
    hasher.num(this.phase);
    hasher.num(this.phaseTimer);
    hasher.num(this.introTick);
    hasher.num(this.introCinematic ? 1 : 0);
    hasher.num(this.introSkippable ? 1 : 0);
    hasher.num(this.introSkipRequested ? 1 : 0);
    hasher.num(this.introPlayed ? 1 : 0);
    hasher.num(this.roundTicks);
    hasher.num(this.fightTicks);
    hasher.num(this.p1Wins);
    hasher.num(this.p2Wins);
    hasher.num(this.hitstopFrames);
    hasher.num(this.latchedP1 ? packInput(this.latchedP1) : -1);
    hasher.num(this.latchedP2 ? packInput(this.latchedP2) : -1);
    hasher.num(this.nextProjectileId);
    this.p1.hashInto(hasher);
    this.p2.hashInto(hasher);
    hasher.num(this.projectiles.length);
    for (const proj of this.projectiles) proj.hashInto(hasher);
    this.ai?.hashInto(hasher);
    this.ai2?.hashInto(hasher);
    return hasher.digest();
  }

  // ---------------------------------------------------------------- rounds

  private startRound(events: MatchSimEvent[]): void {
    const roundNumber = this.roundNumber;
    const cinematic = !this.introPlayed;
    this.introPlayed = true;

    this.phase = RoundPhase.INTRO;
    this.phaseTimer = cinematic ? CINEMATIC_INTRO_TICKS : ROUND_INTRO_TICKS;
    this.introTick = 0;
    this.introCinematic = cinematic;
    this.introSkippable = false;
    this.introSkipRequested = false;
    this.roundTicks = ROUND_TICKS;
    this.fightTicks = 0;
    this.hitstopFrames = 0;
    this.latchedP1 = null;
    this.latchedP2 = null;
    this.projectiles = [];

    this.p1.resetForRound(P1_START_X, true);
    this.p2.resetForRound(P2_START_X, false);

    events.push({ type: 'roundStart', roundNumber, cinematic });
    if (!cinematic) {
      events.push({ type: 'introCue', cue: 'round', roundNumber });
    }
  }

  private stepIntro(events: MatchSimEvent[]): void {
    if (this.introSkipRequested) {
      this.beginFight(events, true);
      return;
    }

    this.introTick++;
    const roundNumber = this.roundNumber;
    if (this.introCinematic) {
      if (this.introTick === CINEMATIC_SKIPPABLE_TICK) {
        this.introSkippable = true;
        events.push({ type: 'introCue', cue: 'skippable', roundNumber });
      } else if (this.introTick === CINEMATIC_ROUND_CUE_TICK) {
        events.push({ type: 'introCue', cue: 'round', roundNumber });
      } else if (this.introTick === CINEMATIC_FIGHT_CUE_TICK) {
        events.push({ type: 'introCue', cue: 'fight', roundNumber });
      } else if (this.introTick === CINEMATIC_HIDE_CUE_TICK) {
        events.push({ type: 'introCue', cue: 'hide', roundNumber });
      }
    } else if (this.introTick === ROUND_FIGHT_CUE_TICK) {
      events.push({ type: 'introCue', cue: 'fight', roundNumber });
    }

    this.phaseTimer--;
    if (this.phaseTimer <= 0) {
      this.beginFight(events, false);
    }
  }

  private beginFight(events: MatchSimEvent[], skipped: boolean): void {
    this.phase = RoundPhase.FIGHTING;
    this.phaseTimer = 0;
    this.introCinematic = false;
    this.introSkippable = false;
    this.introSkipRequested = false;
    this.p1.x = P1_START_X;
    this.p2.x = P2_START_X;
    this.p1.forceState(FighterState.IDLE);
    this.p2.forceState(FighterState.IDLE);
    events.push({ type: 'fightStart', skipped });
  }

  private stepRoundEnd(events: MatchSimEvent[]): void {
    this.phaseTimer--;
    if (this.hitstopFrames > 0) {
      // KO freeze: hold the death pop for a beat before it plays out.
      this.hitstopFrames--;
    } else {
      this.p1.advancePresentation(DT, this.p2.x);
      this.p2.advancePresentation(DT, this.p1.x);
    }

    if (
      this.phase === RoundPhase.MATCH_END &&
      this.phaseTimer === MATCH_END_TICKS - MATCH_WINS_CUE_TICK
    ) {
      events.push({ type: 'winsCue', winner: this.p1Wins > this.p2Wins ? 0 : 1 });
    }

    if (this.phaseTimer > 0) return;
    if (this.phase === RoundPhase.MATCH_END) {
      this.phase = RoundPhase.MATCH_OVER;
      events.push({ type: 'matchOver' });
      return;
    }
    this.startRound(events);
  }

  private endRound(events: MatchSimEvent[]): void {
    if (this.phase !== RoundPhase.FIGHTING) return;

    this.phase = RoundPhase.ROUND_END;
    this.phaseTimer = ROUND_END_TICKS;

    let winner: Fighter;
    if (this.p1.health <= 0 && this.p2.health <= 0) {
      // Double KO: both take the round; a tied match plays extra rounds
      // until someone is ahead (sudden-death, handled by the win check).
      this.p1Wins++;
      this.p2Wins++;
      this.hitstopFrames = KO_HITSTOP_TICKS;
      events.push({ type: 'roundEnd', outcome: 'double_ko', winner: null });
      return;
    } else if (this.p1.health === this.p2.health) {
      // Timed-out dead-even round: a draw. Nobody scores; replay the round.
      events.push({ type: 'roundEnd', outcome: 'draw', winner: null });
      return;
    } else if (this.p1.health > this.p2.health) {
      winner = this.p1;
      this.p1Wins++;
    } else {
      winner = this.p2;
      this.p2Wins++;
    }

    const loser = winner === this.p1 ? this.p2 : this.p1;
    const winnerSlot: PlayerSlot = winner === this.p1 ? 0 : 1;

    winner.forceState(FighterState.VICTORY);
    if (loser.health <= 0) {
      if (loser.state !== FighterState.KNOCKDOWN) {
        loser.forceState(FighterState.KNOCKDOWN);
      }
      this.hitstopFrames = KO_HITSTOP_TICKS;
      events.push({ type: 'roundEnd', outcome: 'ko', winner: winnerSlot });
    } else {
      loser.forceState(FighterState.DEFEAT);
      events.push({ type: 'roundEnd', outcome: 'decision', winner: winnerSlot });
    }

    if (
      (this.p1Wins >= this.roundsToWin || this.p2Wins >= this.roundsToWin) &&
      this.p1Wins !== this.p2Wins
    ) {
      this.phase = RoundPhase.MATCH_END;
      this.phaseTimer = MATCH_END_TICKS;
      events.push({ type: 'matchEnd', winner: winnerSlot });
    }
  }

  // ---------------------------------------------------------------- fighting

  private stepFight(p1Input: FighterInput, p2Input: FighterInput, events: MatchSimEvent[]): void {
    this.fightTicks++;

    // Hitstop: freeze the whole combat sim for a few frames on impact.
    // Human button presses during the freeze are latched so mashed inputs
    // still come out on unfreeze; CPU sides are simply not ticked (keeps the
    // seeded RNG stream untouched).
    if (this.hitstopFrames > 0) {
      this.hitstopFrames--;
      if (!this.p1IsCpu) this.latchedP1 = orInputs(this.latchedP1, p1Input);
      if (!this.p2IsCpu) this.latchedP2 = orInputs(this.latchedP2, p2Input);
      return;
    }

    // Timer
    this.roundTicks--;
    if (this.roundTicks <= 0) {
      this.roundTicks = 0;
      this.endRound(events);
      return;
    }

    // One-projectile rule feeds the fighters so a super is never wasted on
    // a throw that cannot spawn.
    this.p1.canFireProjectile = !this.projectiles.some((proj) => proj.ownerIndex === 0);
    this.p2.canFireProjectile = !this.projectiles.some((proj) => proj.ownerIndex === 1);

    // Resolve inputs
    const in1 = this.ai2
      ? this.ai2.getInput(this.p1, this.p2)
      : mergeLatched(p1Input, this.latchedP1);
    const in2 = this.ai
      ? this.ai.getInput(this.p2, this.p1)
      : mergeLatched(p2Input, this.latchedP2);
    this.latchedP1 = null;
    this.latchedP2 = null;

    // Update fighters
    const p1PrevState = this.p1.state;
    const p2PrevState = this.p2.state;
    this.p1.update(DT, in1, this.p2.x);
    this.p2.update(DT, in2, this.p1.x);
    if (p1PrevState !== this.p1.state && this.p1.isInAttack()) {
      events.push({ type: 'attackStart', playerIndex: 0, state: this.p1.state });
    }
    if (p2PrevState !== this.p2.state && this.p2.isInAttack()) {
      events.push({ type: 'attackStart', playerIndex: 1, state: this.p2.state });
    }

    // Spawn fireballs at release frame
    this.checkFireballSpawn(this.p1, events);
    this.checkFireballSpawn(this.p2, events);

    // Update projectiles (may end the round on a projectile KO)
    this.updateProjectiles(events);
    if (this.phase !== RoundPhase.FIGHTING) return;

    // Resolve combat
    const hits = this.combat.resolve(this.p1, this.p2);
    for (const hit of hits) {
      this.onHit(hit, events);
    }

    // Check KO
    if (this.p1.health <= 0 || this.p2.health <= 0) {
      this.endRound(events);
    }
  }

  private checkFireballSpawn(fighter: Fighter, events: MatchSimEvent[]): void {
    if (fighter.state !== FighterState.FIREBALL) return;
    // Classic one-projectile rule: with your ball still live, the throw
    // animation plays but nothing comes out.
    if (this.projectiles.some((proj) => proj.ownerIndex === fighter.playerIndex)) return;
    const startup = ATTACKS[FighterState.FIREBALL].startup;
    if (fighter.stateFrame !== startup) return;

    const spawnX =
      fighter.x +
      (fighter.facingRight ? fighter.getBodyWidth() : -fighter.getBodyWidth());
    // High trajectory: crouching ducks clean under the ball (Tekken rules).
    const spawnY = fighter.y - fighter.getBodyHeight() * 0.78;
    const isSuper = fighter.pendingSuper;
    fighter.pendingSuper = false;
    // Super flies at mid height: crouching does not duck it.
    const superY = fighter.y - fighter.getBodyHeight() * 0.45;
    const proj = new Projectile(
      this.nextProjectileId++,
      spawnX,
      isSuper ? superY : spawnY,
      fighter.facingRight,
      fighter.playerIndex,
      false,
      isSuper,
    );
    this.projectiles.push(proj);
    if (isSuper) {
      events.push({ type: 'superFireball', playerIndex: fighter.playerIndex as PlayerSlot });
    }
  }

  private updateProjectiles(events: MatchSimEvent[]): void {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const proj = this.projectiles[i];
      // A clash removes two entries in one pass, so the walking index can
      // briefly point past the end of the array.
      if (!proj) continue;
      proj.update(DT);

      if (!proj.active) {
        this.projectiles.splice(i, 1);
        continue;
      }

      // Projectile clash: opposing fireballs cancel each other out.
      const rival = this.projectiles.find(
        (other) => other !== proj && other.active && other.ownerIndex !== proj.ownerIndex &&
          aabbOverlap(proj.getHitbox(), other.getHitbox()),
      );
      if (rival) {
        events.push({ type: 'clash', x: (proj.x + rival.x) / 2, y: proj.y });
        if (proj.isSuper !== rival.isSuper) {
          // A super burns through a normal fireball and keeps travelling.
          const loser = proj.isSuper ? rival : proj;
          loser.destroy();
          this.projectiles = this.projectiles.filter((other) => other !== loser);
          if (loser === proj) continue;
        } else {
          rival.destroy();
          proj.destroy();
          this.projectiles = this.projectiles.filter(
            (other) => other !== proj && other !== rival,
          );
          continue;
        }
      }

      const defender = proj.ownerIndex === 0 ? this.p2 : this.p1;
      const hurtbox = defender.getHurtbox();
      const pHitbox = proj.getHitbox();

      if (!aabbOverlap(pHitbox, hurtbox)) continue;
      if (defender.isInvulnerable()) continue;

      // Standing guard-button block REFLECTS the ball back, faster.
      // Walk-back block absorbs it with chip as usual; crouching simply
      // ducks under it (the ball flies high).
      if (
        !proj.isSuper &&
        defender.state === FighterState.BLOCK &&
        !defender.crouchBlocking &&
        defender.isGrounded()
      ) {
        defender.gainMeter(REFLECT_METER_GAIN);
        proj.reflect(defender.playerIndex);
        this.hitstopFrames = Math.max(this.hitstopFrames, 4);
        events.push({ type: 'reflect', playerIndex: defender.playerIndex as PlayerSlot, x: proj.x, y: proj.y });
        continue;
      }

      // Super is a MID: standing guard blocks it, crouch guard is crushed.
      const isBlocking = this.combat.isBlockingProjectile(defender) &&
        (!proj.isSuper || !defender.crouchBlocking);

      const fakeAtk = {
        damage: proj.damage,
        hitStunFrames: proj.isSuper ? 24 : 18,
        blockStunFrames: proj.isSuper ? 14 : 10,
        pushback: proj.isSuper ? 200 : 120,
        startup: 0,
        active: 0,
        recovery: 0,
        hitbox: { x: 0, y: 0, width: 0, height: 0 },
        hitLevel: (proj.isSuper ? 'mid' : 'high') as 'mid' | 'high',
      };

      defender.takeDamage(fakeAtk, isBlocking);
      const shooter = proj.ownerIndex === 0 ? this.p1 : this.p2;
      shooter.gainMeter(attackerMeterGain({ blocked: isBlocking }));
      defender.gainMeter(defenderMeterGain({ blocked: isBlocking }));

      events.push({
        type: 'projectileHit',
        attacker: shooter.playerIndex as PlayerSlot,
        defender: defender.playerIndex as PlayerSlot,
        damage: isBlocking ? Math.floor(proj.damage * 0.1) : proj.damage,
        blocked: isBlocking,
      });

      proj.destroy();
      this.projectiles.splice(i, 1);

      if (defender.health <= 0) {
        this.endRound(events);
        return;
      }
    }
  }

  private onHit(hit: HitEvent, events: MatchSimEvent[]): void {
    const defender = hit.defender === 0 ? this.p1 : this.p2;
    const attacker = hit.attacker === 0 ? this.p1 : this.p2;

    // Every exchange feeds the super meter.
    attacker.gainMeter(attackerMeterGain({ blocked: hit.blocked, counter: hit.counter }));
    defender.gainMeter(defenderMeterGain({ blocked: hit.blocked }));

    // Impact: deterministic sim freeze scaled by weight.
    if (hit.blocked) {
      this.hitstopFrames = Math.max(this.hitstopFrames, 3);
    } else if (hit.damage > 50) {
      this.hitstopFrames = Math.max(this.hitstopFrames, hit.counter ? 12 : 10);
    } else {
      this.hitstopFrames = Math.max(this.hitstopFrames, hit.counter ? 8 : 6);
    }

    events.push({
      type: 'hit',
      attacker: hit.attacker as PlayerSlot,
      defender: hit.defender as PlayerSlot,
      damage: hit.damage,
      blocked: hit.blocked,
      counter: hit.counter,
      comboCount: defender.comboCount,
    });
  }
}

function orInputs(base: FighterInput | null, next: FighterInput): FighterInput {
  if (!base) return { ...next };
  return {
    left: next.left,
    right: next.right,
    up: base.up || next.up,
    down: next.down,
    guard: next.guard,
    punch: base.punch || next.punch,
    kick: base.kick || next.kick,
    fireball: base.fireball || next.fireball,
    super: base.super || next.super,
    uppercut: base.uppercut || next.uppercut,
  };
}

function mergeLatched(current: FighterInput, latched: FighterInput | null): FighterInput {
  if (!latched) return current;
  return {
    ...current,
    up: current.up || latched.up,
    punch: current.punch || latched.punch,
    kick: current.kick || latched.kick,
    fireball: current.fireball || latched.fireball,
    uppercut: current.uppercut || latched.uppercut,
  };
}

export { EMPTY_INPUT };
