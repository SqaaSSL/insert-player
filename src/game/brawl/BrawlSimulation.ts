import type { FighterInput } from '../sim/FighterInput.ts';
import { StateHasher } from '../sim/StateHasher.ts';
import {
  RUSH_ARENA_MAP,
  type BrawlEnemyArchetype,
  type BrawlEnemySpawn,
  type BrawlMapDefinition,
} from './BrawlMap.ts';

export const BRAWL_TICK_RATE = 60;
const PLAYER_SPEED = 220 / BRAWL_TICK_RATE;
const PLAYER_LANE_SPEED = 165 / BRAWL_TICK_RATE;
const REVIVE_RANGE_X = 92;
const REVIVE_RANGE_LANE = 58;
const REVIVE_TICKS = 75;
const BETWEEN_WAVE_TICKS = 72;

export type BrawlOutcome = 'playing' | 'won' | 'lost';
export type BrawlActorState = 'idle' | 'walk' | 'attack' | 'hit' | 'down' | 'victory';
export type BrawlAttackKind = 'light' | 'heavy';

export interface BrawlActor {
  id: string;
  kind: 'player' | 'enemy';
  slot: 0 | 1 | null;
  archetype: BrawlEnemyArchetype | null;
  name: string;
  x: number;
  lane: number;
  health: number;
  maxHealth: number;
  state: BrawlActorState;
  stateTick: number;
  facingRight: boolean;
  attackKind: BrawlAttackKind | null;
  attackResolved: boolean;
  cooldown: number;
  reviveTicks: number;
}

export interface BrawlSimulationSnapshot {
  tick: number;
  waveIndex: number;
  betweenWaveTicks: number;
  outcome: BrawlOutcome;
  players: BrawlActor[];
  enemies: BrawlActor[];
}

export type BrawlSimEvent =
  | { type: 'waveStart'; waveIndex: number; label: string }
  | { type: 'attack'; actorId: string; attackKind: BrawlAttackKind }
  | { type: 'hit'; attackerId: string; targetId: string; damage: number }
  | { type: 'actorDown'; actorId: string }
  | { type: 'revived'; actorId: string; byActorId: string }
  | { type: 'missionComplete' }
  | { type: 'missionFailed' };

interface EnemyStats {
  health: number;
  speed: number;
  laneSpeed: number;
  damage: number;
  range: number;
  laneRange: number;
  cooldown: number;
}

const ENEMY_STATS: Record<BrawlEnemyArchetype, EnemyStats> = {
  grunt: {
    health: 70,
    speed: 96 / BRAWL_TICK_RATE,
    laneSpeed: 80 / BRAWL_TICK_RATE,
    damage: 9,
    range: 58,
    laneRange: 38,
    cooldown: 66,
  },
  bruiser: {
    health: 125,
    speed: 74 / BRAWL_TICK_RATE,
    laneSpeed: 66 / BRAWL_TICK_RATE,
    damage: 15,
    range: 68,
    laneRange: 44,
    cooldown: 82,
  },
  captain: {
    health: 260,
    speed: 86 / BRAWL_TICK_RATE,
    laneSpeed: 72 / BRAWL_TICK_RATE,
    damage: 20,
    range: 82,
    laneRange: 48,
    cooldown: 72,
  },
};

function cloneActor(actor: BrawlActor): BrawlActor {
  return { ...actor };
}

function distanceSquared(a: BrawlActor, b: BrawlActor): number {
  const dx = a.x - b.x;
  const dy = a.lane - b.lane;
  return dx * dx + dy * dy;
}

function direction(value: number, deadZone = 1): -1 | 0 | 1 {
  if (value > deadZone) return 1;
  if (value < -deadZone) return -1;
  return 0;
}

function stateCode(state: BrawlActorState): number {
  switch (state) {
    case 'idle': return 0;
    case 'walk': return 1;
    case 'attack': return 2;
    case 'hit': return 3;
    case 'down': return 4;
    case 'victory': return 5;
  }
}

function outcomeCode(outcome: BrawlOutcome): number {
  return outcome === 'playing' ? 0 : outcome === 'won' ? 1 : 2;
}

function archetypeCode(archetype: BrawlEnemyArchetype | null): number {
  if (archetype === 'grunt') return 1;
  if (archetype === 'bruiser') return 2;
  if (archetype === 'captain') return 3;
  return 0;
}

/**
 * Pure, deterministic arena-brawler simulation. It deliberately mirrors the
 * Fight runtime contract: no Phaser, DOM, wall clock, timers, or randomness.
 * That keeps the mode ready for the existing rollback transport once its
 * session wrapper is generalized from MatchSimulation.
 */
export class BrawlSimulation {
  readonly map: Readonly<BrawlMapDefinition>;
  readonly players: BrawlActor[];
  enemies: BrawlActor[] = [];
  tick = 0;
  waveIndex = -1;
  betweenWaveTicks = 0;
  outcome: BrawlOutcome = 'playing';

  constructor(
    playerNames: readonly [string, string],
    map: Readonly<BrawlMapDefinition> = RUSH_ARENA_MAP,
  ) {
    this.map = map;
    this.players = map.playerSpawns.map((spawn, slot) => ({
      id: `player-${slot + 1}`,
      kind: 'player' as const,
      slot: slot as 0 | 1,
      archetype: null,
      name: playerNames[slot] || `Player ${slot + 1}`,
      x: spawn.x,
      lane: spawn.lane,
      health: 100,
      maxHealth: 100,
      state: 'idle' as const,
      stateTick: 0,
      facingRight: true,
      attackKind: null,
      attackResolved: false,
      cooldown: 0,
      reviveTicks: 0,
    }));
  }

  start(): BrawlSimEvent[] {
    if (this.waveIndex >= 0) return [];
    return this.spawnNextWave();
  }

  step(p1Input: FighterInput, p2Input: FighterInput): BrawlSimEvent[] {
    if (this.outcome !== 'playing') return [];
    this.tick += 1;
    const events: BrawlSimEvent[] = [];

    this.updatePlayer(this.players[0], p1Input, events);
    this.updatePlayer(this.players[1], p2Input, events);
    this.updateRevives([p1Input, p2Input], events);

    for (const enemy of this.enemies) {
      this.updateEnemy(enemy, events);
    }

    if (this.players.every((player) => player.health <= 0)) {
      this.outcome = 'lost';
      events.push({ type: 'missionFailed' });
      return events;
    }

    if (this.enemies.some((enemy) => enemy.health > 0)) {
      this.betweenWaveTicks = 0;
      return events;
    }

    this.betweenWaveTicks += 1;
    if (this.betweenWaveTicks < BETWEEN_WAVE_TICKS) return events;

    if (this.waveIndex >= this.map.waves.length - 1) {
      this.outcome = 'won';
      for (const player of this.players) {
        if (player.health > 0) this.setActorState(player, 'victory');
      }
      events.push({ type: 'missionComplete' });
      return events;
    }

    events.push(...this.spawnNextWave());
    return events;
  }

  snapshot(): BrawlSimulationSnapshot {
    return {
      tick: this.tick,
      waveIndex: this.waveIndex,
      betweenWaveTicks: this.betweenWaveTicks,
      outcome: this.outcome,
      players: this.players.map(cloneActor),
      enemies: this.enemies.map(cloneActor),
    };
  }

  restore(snapshot: BrawlSimulationSnapshot): void {
    this.tick = snapshot.tick;
    this.waveIndex = snapshot.waveIndex;
    this.betweenWaveTicks = snapshot.betweenWaveTicks;
    this.outcome = snapshot.outcome;
    this.players.splice(0, this.players.length, ...snapshot.players.map(cloneActor));
    this.enemies = snapshot.enemies.map(cloneActor);
  }

  checksum(): number {
    const hasher = new StateHasher();
    hasher.num(this.tick);
    hasher.num(this.waveIndex);
    hasher.num(this.betweenWaveTicks);
    hasher.num(outcomeCode(this.outcome));
    for (const actor of [...this.players, ...this.enemies]) {
      hasher.num(actor.kind === 'player' ? 1 : 2);
      hasher.num(actor.slot ?? -1);
      hasher.num(archetypeCode(actor.archetype));
      hasher.num(actor.x);
      hasher.num(actor.lane);
      hasher.num(actor.health);
      hasher.num(actor.maxHealth);
      hasher.num(stateCode(actor.state));
      hasher.num(actor.stateTick);
      hasher.num(actor.facingRight ? 1 : 0);
      hasher.num(actor.attackKind === 'light' ? 1 : actor.attackKind === 'heavy' ? 2 : 0);
      hasher.num(actor.attackResolved ? 1 : 0);
      hasher.num(actor.cooldown);
      hasher.num(actor.reviveTicks);
    }
    return hasher.digest();
  }

  private spawnNextWave(): BrawlSimEvent[] {
    this.waveIndex += 1;
    this.betweenWaveTicks = 0;
    const wave = this.map.waves[this.waveIndex];
    if (!wave) return [];
    this.enemies.push(...wave.enemies.map((spawn) => this.createEnemy(spawn)));
    return [{ type: 'waveStart', waveIndex: this.waveIndex, label: wave.label }];
  }

  private createEnemy(spawn: BrawlEnemySpawn): BrawlActor {
    const stats = ENEMY_STATS[spawn.archetype];
    return {
      id: spawn.id,
      kind: 'enemy',
      slot: null,
      archetype: spawn.archetype,
      name: spawn.archetype === 'captain' ? 'Captain' : spawn.archetype === 'bruiser' ? 'Bruiser' : 'Grunt',
      x: spawn.x,
      lane: spawn.lane,
      health: stats.health,
      maxHealth: stats.health,
      state: 'idle',
      stateTick: 0,
      facingRight: spawn.facingRight ?? false,
      attackKind: null,
      attackResolved: false,
      cooldown: 30,
      reviveTicks: 0,
    };
  }

  private updatePlayer(actor: BrawlActor, input: FighterInput, events: BrawlSimEvent[]): void {
    if (actor.health <= 0 || actor.state === 'victory') {
      actor.stateTick += 1;
      return;
    }
    if (actor.state === 'hit') {
      actor.stateTick += 1;
      if (actor.stateTick >= 13) this.setActorState(actor, 'idle');
      return;
    }
    if (actor.state === 'attack') {
      actor.stateTick += 1;
      const heavy = actor.attackKind === 'heavy';
      const activeTick = heavy ? 10 : 6;
      const duration = heavy ? 27 : 17;
      if (!actor.attackResolved && actor.stateTick >= activeTick) {
        actor.attackResolved = true;
        this.resolvePlayerAttack(actor, heavy, events);
      }
      if (actor.stateTick >= duration) this.setActorState(actor, 'idle');
      return;
    }

    const wantsHeavy = input.kick || input.fireball || input.uppercut || input.super;
    if (input.punch || wantsHeavy) {
      this.setActorState(actor, 'attack');
      actor.attackKind = wantsHeavy ? 'heavy' : 'light';
      events.push({ type: 'attack', actorId: actor.id, attackKind: actor.attackKind });
      return;
    }

    const horizontal = Number(input.right) - Number(input.left);
    const vertical = Number(input.down) - Number(input.up);
    if (horizontal === 0 && vertical === 0) {
      this.setActorState(actor, 'idle', false);
      this.faceNearestEnemy(actor);
      return;
    }

    const diagonal = horizontal !== 0 && vertical !== 0 ? Math.SQRT1_2 : 1;
    actor.x += horizontal * PLAYER_SPEED * diagonal;
    actor.lane += vertical * PLAYER_LANE_SPEED * diagonal;
    actor.x = this.clampX(actor.x);
    actor.lane = this.clampLane(actor.lane);
    if (horizontal !== 0) actor.facingRight = horizontal > 0;
    this.setActorState(actor, 'walk', false);
  }

  private updateEnemy(actor: BrawlActor, events: BrawlSimEvent[]): void {
    if (actor.health <= 0) {
      actor.stateTick += 1;
      return;
    }
    if (actor.cooldown > 0) actor.cooldown -= 1;
    if (actor.state === 'hit') {
      actor.stateTick += 1;
      if (actor.stateTick >= 15) this.setActorState(actor, 'idle');
      return;
    }
    if (actor.state === 'attack') {
      actor.stateTick += 1;
      const activeTick = actor.archetype === 'captain' ? 12 : 14;
      const duration = actor.archetype === 'captain' ? 31 : 34;
      if (!actor.attackResolved && actor.stateTick >= activeTick) {
        actor.attackResolved = true;
        this.resolveEnemyAttack(actor, events);
      }
      if (actor.stateTick >= duration) {
        actor.cooldown = ENEMY_STATS[actor.archetype!].cooldown;
        this.setActorState(actor, 'idle');
      }
      return;
    }

    const target = this.nearestLivingPlayer(actor);
    if (!target) return;
    const stats = ENEMY_STATS[actor.archetype!];
    const formation = this.enemyFormation(actor);
    const dxToTarget = target.x - actor.x;
    const dx = target.x + formation.x - actor.x;
    const laneDeltaToTarget = target.lane - actor.lane;
    const laneDelta = this.clampLane(target.lane + formation.lane) - actor.lane;
    actor.facingRight = dxToTarget >= 0;
    const inRange = Math.abs(dxToTarget) <= stats.range && Math.abs(laneDeltaToTarget) <= stats.laneRange;
    if (inRange && actor.cooldown <= 0) {
      this.setActorState(actor, 'attack');
      actor.attackKind = actor.archetype === 'grunt' ? 'light' : 'heavy';
      events.push({ type: 'attack', actorId: actor.id, attackKind: actor.attackKind });
      return;
    }

    const xDirection = direction(dx, Math.max(22, stats.range * 0.72));
    const laneDirection = direction(laneDelta, Math.max(10, stats.laneRange * 0.45));
    actor.x = this.clampX(actor.x + xDirection * stats.speed);
    actor.lane = this.clampLane(actor.lane + laneDirection * stats.laneSpeed);
    this.setActorState(actor, xDirection === 0 && laneDirection === 0 ? 'idle' : 'walk', false);
  }

  private resolvePlayerAttack(actor: BrawlActor, heavy: boolean, events: BrawlSimEvent[]): void {
    const range = heavy ? 126 : 88;
    const laneRange = heavy ? 58 : 46;
    const damage = heavy ? 52 : 31;
    const maxTargets = heavy ? 2 : 1;
    const candidates = this.enemies
      .filter((enemy) => enemy.health > 0)
      .filter((enemy) => {
        const forwardDistance = (enemy.x - actor.x) * (actor.facingRight ? 1 : -1);
        return forwardDistance >= -18 && forwardDistance <= range && Math.abs(enemy.lane - actor.lane) <= laneRange;
      })
      .sort((a, b) => distanceSquared(actor, a) - distanceSquared(actor, b));

    for (const enemy of candidates.slice(0, maxTargets)) {
      this.damageActor(actor, enemy, damage, heavy ? 46 : 28, events);
    }
  }

  private resolveEnemyAttack(actor: BrawlActor, events: BrawlSimEvent[]): void {
    const target = this.nearestLivingPlayer(actor);
    if (!target || !actor.archetype) return;
    const stats = ENEMY_STATS[actor.archetype];
    const forwardDistance = (target.x - actor.x) * (actor.facingRight ? 1 : -1);
    if (
      forwardDistance < -22 ||
      forwardDistance > stats.range + 18 ||
      Math.abs(target.lane - actor.lane) > stats.laneRange + 8
    ) return;
    this.damageActor(actor, target, stats.damage, 24, events);
  }

  private damageActor(
    attacker: BrawlActor,
    target: BrawlActor,
    damage: number,
    push: number,
    events: BrawlSimEvent[],
  ): void {
    if (target.health <= 0) return;
    target.health = Math.max(0, target.health - damage);
    const pushDirection = attacker.x <= target.x ? 1 : -1;
    target.x = this.clampX(target.x + pushDirection * push);
    events.push({ type: 'hit', attackerId: attacker.id, targetId: target.id, damage });
    if (target.health <= 0) {
      this.setActorState(target, 'down');
      events.push({ type: 'actorDown', actorId: target.id });
      return;
    }
    this.setActorState(target, 'hit');
  }

  private updateRevives(inputs: readonly [FighterInput, FighterInput], events: BrawlSimEvent[]): void {
    for (let downSlot = 0 as 0 | 1; downSlot <= 1; downSlot = (downSlot + 1) as 0 | 1) {
      const down = this.players[downSlot];
      if (down.health > 0) {
        down.reviveTicks = 0;
        continue;
      }
      const helperSlot = (downSlot === 0 ? 1 : 0) as 0 | 1;
      const helper = this.players[helperSlot];
      const helperInput = inputs[helperSlot];
      const inRange = helper.health > 0
        && Math.abs(helper.x - down.x) <= REVIVE_RANGE_X
        && Math.abs(helper.lane - down.lane) <= REVIVE_RANGE_LANE;
      if (!inRange || !helperInput.guard || helper.state === 'hit' || helper.state === 'attack') {
        down.reviveTicks = 0;
        continue;
      }
      down.reviveTicks += 1;
      if (down.reviveTicks < REVIVE_TICKS) continue;
      down.health = Math.ceil(down.maxHealth * 0.4);
      down.reviveTicks = 0;
      this.setActorState(down, 'idle');
      events.push({ type: 'revived', actorId: down.id, byActorId: helper.id });
    }
  }

  private nearestLivingPlayer(actor: BrawlActor): BrawlActor | null {
    const living = this.players.filter((player) => player.health > 0);
    if (living.length === 0) return null;
    if (living.length === 1) return living[0];
    const finalCode = actor.id.charCodeAt(actor.id.length - 1);
    const preferredSlot = (finalCode % 2) as 0 | 1;
    return this.players[preferredSlot].health > 0
      ? this.players[preferredSlot]
      : this.players[preferredSlot === 0 ? 1 : 0];
  }

  private enemyFormation(actor: BrawlActor): { x: number; lane: number } {
    const finalCode = actor.id.charCodeAt(actor.id.length - 1);
    return {
      x: 34 + (finalCode % 2) * 18,
      lane: ((finalCode % 3) - 1) * 30,
    };
  }

  private faceNearestEnemy(actor: BrawlActor): void {
    const living = this.enemies.filter((enemy) => enemy.health > 0);
    if (living.length === 0) return;
    living.sort((a, b) => distanceSquared(actor, a) - distanceSquared(actor, b));
    if (Math.abs(living[0].x - actor.x) > 2) actor.facingRight = living[0].x >= actor.x;
  }

  private setActorState(actor: BrawlActor, state: BrawlActorState, reset = true): void {
    if (actor.state === state && !reset) {
      actor.stateTick += 1;
      return;
    }
    actor.state = state;
    if (reset) actor.stateTick = 0;
    actor.attackResolved = false;
    if (state !== 'attack') actor.attackKind = null;
  }

  private clampX(x: number): number {
    return Math.min(this.map.walkArea.right, Math.max(this.map.walkArea.left, x));
  }

  private clampLane(lane: number): number {
    return Math.min(this.map.walkArea.front, Math.max(this.map.walkArea.back, lane));
  }
}
