import { StateHasher } from '../sim/StateHasher.ts';
import { normalizeBrawlInput, type BrawlInput, type BrawlInputLike } from './BrawlInput.ts';
import {
  RUSH_ROUTE_MAP,
  type BrawlEncounterDefinition,
  type BrawlEnemyArchetype,
  type BrawlEnemyEntranceKind,
  type BrawlEnemySpawn,
  type BrawlMapDefinition,
  type BrawlObstacleDefinition,
  type BrawlObstacleSkin,
  type BrawlObstacleType,
} from './BrawlMap.ts';

export const BRAWL_TICK_RATE = 60;
const PLAYER_SPEED = 220 / BRAWL_TICK_RATE;
const PLAYER_LANE_SPEED = 165 / BRAWL_TICK_RATE;
const AIR_CONTROL = 0.88;
const JUMP_VELOCITY = 10.8;
const JUMP_GRAVITY = 0.56;
const REVIVE_RANGE_X = 92;
const REVIVE_RANGE_LANE = 58;
const REVIVE_TICKS = 75;
const ENCOUNTER_CLEAR_TICKS = 48;
const CHECKPOINT_RECOVERY = 18;
const ENTRANCE_SPEED_X = 4.6;
const ENTRANCE_SPEED_LANE = 3.2;
const PROJECTILE_SPEED = 510 / BRAWL_TICK_RATE;
const PROJECTILE_TTL = 240;
const PROJECTILE_LANE_RANGE = 38;
const VENT_CYCLE_TICKS = 180;
const VENT_TELEGRAPH_START = 42;
const VENT_ACTIVE_START = 72;
const VENT_ACTIVE_END = 106;
const ACTOR_RADIUS_X = 25;
const ACTOR_RADIUS_LANE = 16;

export type BrawlOutcome = 'playing' | 'won' | 'lost';
export type BrawlActorState =
  | 'idle'
  | 'walk'
  | 'jump'
  | 'attack'
  | 'fireball'
  | 'entering'
  | 'hit'
  | 'down'
  | 'victory';
export type BrawlAttackKind = 'light' | 'heavy';

export interface BrawlActor {
  id: string;
  kind: 'player' | 'enemy';
  slot: 0 | 1 | null;
  archetype: BrawlEnemyArchetype | null;
  level: 0 | 1 | 2 | 3;
  name: string;
  x: number;
  lane: number;
  /** Height above the current lane floor, in world pixels. */
  height: number;
  verticalVelocity: number;
  health: number;
  maxHealth: number;
  state: BrawlActorState;
  stateTick: number;
  facingRight: boolean;
  attackKind: BrawlAttackKind | null;
  attackResolved: boolean;
  cooldown: number;
  reviveTicks: number;
  combatReady: boolean;
  entranceKind: BrawlEnemyEntranceKind | null;
  entranceDelayTicks: number;
  entryTargetX: number;
  entryTargetLane: number;
}

export interface BrawlProjectile {
  id: number;
  ownerId: string;
  ownerKind: 'player' | 'enemy';
  x: number;
  lane: number;
  height: number;
  vx: number;
  damage: number;
  age: number;
  ttl: number;
  isSuper: boolean;
}

export interface BrawlObstacle {
  id: string;
  type: BrawlObstacleType;
  x: number;
  lane: number;
  width: number;
  laneDepth: number;
  health: number;
  maxHealth: number;
  jumpClearance: number;
  cycleOffset: number;
  skin: BrawlObstacleSkin;
  explosionRadius: number;
  explosionDamage: number;
  telegraphing: boolean;
  active: boolean;
}

export interface BrawlSimulationSnapshot {
  tick: number;
  started: boolean;
  encounterIndex: number;
  activeEncounterIndex: number;
  encounterClearTicks: number;
  progressX: number;
  outcome: BrawlOutcome;
  nextProjectileId: number;
  players: BrawlActor[];
  enemies: BrawlActor[];
  projectiles: BrawlProjectile[];
  obstacles: BrawlObstacle[];
}

export type BrawlSimEvent =
  | { type: 'runStart' }
  | { type: 'encounterStart'; encounterIndex: number; label: string }
  | { type: 'encounterCleared'; encounterIndex: number }
  | { type: 'checkpointRecovery'; actorId: string; amount: number }
  | { type: 'attack'; actorId: string; attackKind: BrawlAttackKind }
  | { type: 'jump'; actorId: string }
  | { type: 'land'; actorId: string }
  | { type: 'fireball'; actorId: string; projectileId: number; isSuper: boolean }
  | { type: 'hit'; attackerId: string; targetId: string; damage: number }
  | { type: 'obstacleHit'; attackerId: string; obstacleId: string; damage: number }
  | { type: 'obstacleDestroyed'; obstacleId: string }
  | { type: 'obstacleExploded'; obstacleId: string }
  | { type: 'hazardBurst'; obstacleId: string }
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
  projectileDamage?: number;
  projectileCooldown?: number;
  projectileMinRange?: number;
  projectileMaxRange?: number;
  projectileSpeedScale?: number;
}

const ENEMY_STATS: Record<BrawlEnemyArchetype, EnemyStats> = {
  grunt: { health: 70, speed: 96 / BRAWL_TICK_RATE, laneSpeed: 80 / BRAWL_TICK_RATE, damage: 9, range: 58, laneRange: 38, cooldown: 66 },
  bruiser: { health: 125, speed: 74 / BRAWL_TICK_RATE, laneSpeed: 66 / BRAWL_TICK_RATE, damage: 15, range: 68, laneRange: 44, cooldown: 82 },
  shooter: {
    health: 82,
    speed: 84 / BRAWL_TICK_RATE,
    laneSpeed: 76 / BRAWL_TICK_RATE,
    damage: 7,
    range: 52,
    laneRange: 36,
    cooldown: 72,
    projectileDamage: 14,
    projectileCooldown: 104,
    projectileMinRange: 150,
    projectileMaxRange: 520,
    projectileSpeedScale: 0.8,
  },
  captain: {
    health: 240,
    speed: 86 / BRAWL_TICK_RATE,
    laneSpeed: 72 / BRAWL_TICK_RATE,
    damage: 18,
    range: 82,
    laneRange: 48,
    cooldown: 72,
    projectileDamage: 20,
    projectileCooldown: 126,
    projectileMinRange: 190,
    projectileMaxRange: 470,
    projectileSpeedScale: 0.92,
  },
};

function enemyHealthAtLevel(base: number, level: number): number {
  return Math.round(base * (1 + Math.max(0, level - 1) * 0.16));
}

function enemyDamageAtLevel(base: number, level: number): number {
  return Math.round(base * (1 + Math.max(0, level - 1) * 0.14));
}

function enemyCooldownAtLevel(base: number, level: number): number {
  return Math.max(34, Math.round(base * (1 - Math.max(0, level - 1) * 0.08)));
}

function enemySpeedAtLevel(base: number, level: number): number {
  return base * (1 + Math.max(0, level - 1) * 0.06);
}

function cloneActor(actor: BrawlActor): BrawlActor { return { ...actor }; }
function cloneProjectile(projectile: BrawlProjectile): BrawlProjectile { return { ...projectile }; }
function cloneObstacle(obstacle: BrawlObstacle): BrawlObstacle { return { ...obstacle }; }

function distanceSquared(a: Pick<BrawlActor, 'x' | 'lane'>, b: Pick<BrawlActor, 'x' | 'lane'>): number {
  const dx = a.x - b.x;
  const dy = a.lane - b.lane;
  return dx * dx + dy * dy;
}

function direction(value: number, deadZone = 1): -1 | 0 | 1 {
  if (value > deadZone) return 1;
  if (value < -deadZone) return -1;
  return 0;
}

function approach(value: number, target: number, amount: number): number {
  if (value < target) return Math.min(target, value + amount);
  if (value > target) return Math.max(target, value - amount);
  return value;
}

function stateCode(state: BrawlActorState): number {
  switch (state) {
    case 'idle': return 0;
    case 'walk': return 1;
    case 'jump': return 2;
    case 'attack': return 3;
    case 'fireball': return 4;
    case 'entering': return 5;
    case 'hit': return 6;
    case 'down': return 7;
    case 'victory': return 8;
  }
}

function outcomeCode(outcome: BrawlOutcome): number { return outcome === 'playing' ? 0 : outcome === 'won' ? 1 : 2; }
function archetypeCode(archetype: BrawlEnemyArchetype | null): number {
  if (archetype === 'grunt') return 1;
  if (archetype === 'bruiser') return 2;
  if (archetype === 'shooter') return 3;
  if (archetype === 'captain') return 4;
  return 0;
}
function entranceCode(entrance: BrawlEnemyEntranceKind | null): number {
  if (entrance === 'right') return 1;
  if (entrance === 'door') return 2;
  if (entrance === 'background') return 3;
  if (entrance === 'drop') return 4;
  return 0;
}
function obstacleCode(type: BrawlObstacleType): number {
  if (type === 'barricade') return 1;
  if (type === 'steam-vent') return 2;
  return 3;
}
function obstacleSkinCode(skin: BrawlObstacleSkin): number {
  switch (skin) {
    case 'arena': return 1;
    case 'executive': return 2;
    case 'mars': return 3;
    case 'tablao': return 4;
    case 'jaula': return 5;
    case 'custom': return 6;
  }
}

/**
 * Pure deterministic Rush simulation. Route geometry, entrances, jumps,
 * projectiles, and obstacles all live here so rollback can replay them later.
 */
export class BrawlSimulation {
  readonly map: Readonly<BrawlMapDefinition>;
  readonly players: BrawlActor[];
  enemies: BrawlActor[] = [];
  projectiles: BrawlProjectile[] = [];
  obstacles: BrawlObstacle[];
  tick = 0;
  started = false;
  encounterIndex = -1;
  activeEncounterIndex = -1;
  encounterClearTicks = 0;
  progressX: number;
  outcome: BrawlOutcome = 'playing';
  private nextProjectileId = 1;

  constructor(playerNames: readonly [string, string], map: Readonly<BrawlMapDefinition> = RUSH_ROUTE_MAP) {
    this.map = map;
    this.players = map.playerSpawns.map((spawn, slot) => ({
      id: `player-${slot + 1}`,
      kind: 'player' as const,
      slot: slot as 0 | 1,
      archetype: null,
      level: 0 as const,
      name: playerNames[slot] || `Player ${slot + 1}`,
      x: spawn.x,
      lane: spawn.lane,
      height: 0,
      verticalVelocity: 0,
      health: 100,
      maxHealth: 100,
      state: 'idle' as const,
      stateTick: 0,
      facingRight: true,
      attackKind: null,
      attackResolved: false,
      cooldown: 0,
      reviveTicks: 0,
      combatReady: true,
      entranceKind: null,
      entranceDelayTicks: 0,
      entryTargetX: spawn.x,
      entryTargetLane: spawn.lane,
    }));
    this.obstacles = (map.obstacles ?? []).map((definition) => this.createObstacle(definition));
    this.progressX = Math.min(...this.players.map((player) => player.x));
  }

  start(): BrawlSimEvent[] {
    if (this.started) return [];
    this.started = true;
    return [{ type: 'runStart' }];
  }

  step(p1InputLike: BrawlInputLike, p2InputLike: BrawlInputLike): BrawlSimEvent[] {
    if (this.outcome !== 'playing') return [];
    this.tick += 1;
    const events: BrawlSimEvent[] = [];
    const inputs = [normalizeBrawlInput(p1InputLike), normalizeBrawlInput(p2InputLike)] as const;

    this.updateObstacleStates(events);
    this.updatePlayer(this.players[0], inputs[0], events);
    this.updatePlayer(this.players[1], inputs[1], events);
    this.applyPlayerTether();
    this.progressX = Math.max(this.progressX, this.teamProgressX());
    this.updateRevives(inputs, events);
    if (this.activeEncounterIndex < 0) events.push(...this.tryStartEncounter());
    for (const enemy of this.enemies) this.updateEnemy(enemy, events);
    this.updateProjectiles(events);

    if (this.players.every((player) => player.health <= 0)) {
      this.outcome = 'lost';
      events.push({ type: 'missionFailed' });
      return events;
    }
    if (this.activeEncounterIndex >= 0) {
      if (this.enemies.some((enemy) => enemy.health > 0)) {
        this.encounterClearTicks = 0;
        return events;
      }
      this.encounterClearTicks += 1;
      if (this.encounterClearTicks < ENCOUNTER_CLEAR_TICKS) return events;
      const clearedEncounterIndex = this.activeEncounterIndex;
      this.activeEncounterIndex = -1;
      this.encounterClearTicks = 0;
      events.push({ type: 'encounterCleared', encounterIndex: clearedEncounterIndex });
      for (const player of this.players) {
        if (player.health <= 0 || player.health >= player.maxHealth) continue;
        const previousHealth = player.health;
        player.health = Math.min(player.maxHealth, player.health + CHECKPOINT_RECOVERY);
        events.push({
          type: 'checkpointRecovery',
          actorId: player.id,
          amount: player.health - previousHealth,
        });
      }
    }
    if (this.encounterIndex >= this.map.encounters.length - 1 && this.activeEncounterIndex < 0 && this.progressX >= this.map.exitX) {
      this.outcome = 'won';
      for (const player of this.players) if (player.health > 0) this.setActorState(player, 'victory');
      events.push({ type: 'missionComplete' });
    }
    return events;
  }

  snapshot(): BrawlSimulationSnapshot {
    return {
      tick: this.tick,
      started: this.started,
      encounterIndex: this.encounterIndex,
      activeEncounterIndex: this.activeEncounterIndex,
      encounterClearTicks: this.encounterClearTicks,
      progressX: this.progressX,
      outcome: this.outcome,
      nextProjectileId: this.nextProjectileId,
      players: this.players.map(cloneActor),
      enemies: this.enemies.map(cloneActor),
      projectiles: this.projectiles.map(cloneProjectile),
      obstacles: this.obstacles.map(cloneObstacle),
    };
  }

  restore(snapshot: BrawlSimulationSnapshot): void {
    this.tick = snapshot.tick;
    this.started = snapshot.started;
    this.encounterIndex = snapshot.encounterIndex;
    this.activeEncounterIndex = snapshot.activeEncounterIndex;
    this.encounterClearTicks = snapshot.encounterClearTicks;
    this.progressX = snapshot.progressX;
    this.outcome = snapshot.outcome;
    this.nextProjectileId = snapshot.nextProjectileId;
    this.players.splice(0, this.players.length, ...snapshot.players.map(cloneActor));
    this.enemies = snapshot.enemies.map(cloneActor);
    this.projectiles = snapshot.projectiles.map(cloneProjectile);
    this.obstacles = snapshot.obstacles.map(cloneObstacle);
  }

  checksum(): number {
    const hasher = new StateHasher();
    hasher.num(this.tick); hasher.num(this.started ? 1 : 0); hasher.num(this.encounterIndex);
    hasher.num(this.activeEncounterIndex); hasher.num(this.encounterClearTicks); hasher.num(this.progressX);
    hasher.num(outcomeCode(this.outcome)); hasher.num(this.nextProjectileId);
    for (const actor of [...this.players, ...this.enemies]) {
      hasher.num(actor.kind === 'player' ? 1 : 2); hasher.num(actor.slot ?? -1);
      hasher.num(archetypeCode(actor.archetype)); hasher.num(actor.level); hasher.num(actor.x); hasher.num(actor.lane);
      hasher.num(actor.height); hasher.num(actor.verticalVelocity); hasher.num(actor.health); hasher.num(actor.maxHealth);
      hasher.num(stateCode(actor.state)); hasher.num(actor.stateTick); hasher.num(actor.facingRight ? 1 : 0);
      hasher.num(actor.attackKind === 'light' ? 1 : actor.attackKind === 'heavy' ? 2 : 0);
      hasher.num(actor.attackResolved ? 1 : 0); hasher.num(actor.cooldown); hasher.num(actor.reviveTicks);
      hasher.num(actor.combatReady ? 1 : 0); hasher.num(entranceCode(actor.entranceKind));
      hasher.num(actor.entranceDelayTicks); hasher.num(actor.entryTargetX); hasher.num(actor.entryTargetLane);
    }
    for (const projectile of this.projectiles) {
      hasher.num(projectile.id); hasher.num(projectile.ownerKind === 'player' ? 1 : 2);
      hasher.num(projectile.x); hasher.num(projectile.lane); hasher.num(projectile.height);
      hasher.num(projectile.vx); hasher.num(projectile.damage); hasher.num(projectile.age); hasher.num(projectile.ttl);
      hasher.num(projectile.isSuper ? 1 : 0);
    }
    for (const obstacle of this.obstacles) {
      hasher.num(obstacleCode(obstacle.type)); hasher.num(obstacle.x); hasher.num(obstacle.lane);
      hasher.num(obstacle.width); hasher.num(obstacle.laneDepth); hasher.num(obstacle.health);
      hasher.num(obstacle.maxHealth); hasher.num(obstacle.jumpClearance); hasher.num(obstacle.cycleOffset);
      hasher.num(obstacleSkinCode(obstacle.skin)); hasher.num(obstacle.explosionRadius); hasher.num(obstacle.explosionDamage);
      hasher.num(obstacle.telegraphing ? 1 : 0); hasher.num(obstacle.active ? 1 : 0);
    }
    return hasher.digest();
  }

  private createObstacle(definition: BrawlObstacleDefinition): BrawlObstacle {
    const maxHealth = definition.type === 'steam-vent' ? 0 : (definition.health ?? 100);
    return {
      id: definition.id, type: definition.type, x: definition.x, lane: definition.lane,
      width: definition.width, laneDepth: definition.laneDepth, health: maxHealth, maxHealth,
      jumpClearance: definition.jumpClearance ?? 56, cycleOffset: definition.cycleOffset ?? 0,
      skin: definition.skin ?? 'arena',
      explosionRadius: definition.explosionRadius ?? 0,
      explosionDamage: definition.explosionDamage ?? 0,
      telegraphing: false, active: false,
    };
  }

  private tryStartEncounter(): BrawlSimEvent[] {
    const nextEncounterIndex = this.encounterIndex + 1;
    const encounter = this.map.encounters[nextEncounterIndex];
    if (!encounter || this.progressX < encounter.triggerX) return [];
    this.encounterIndex = nextEncounterIndex;
    this.activeEncounterIndex = nextEncounterIndex;
    this.encounterClearTicks = 0;
    this.enemies.push(...encounter.enemies.map((spawn) => this.createEnemy(spawn, encounter)));
    return [{ type: 'encounterStart', encounterIndex: nextEncounterIndex, label: encounter.label }];
  }

  private createEnemy(spawn: BrawlEnemySpawn, encounter: BrawlEncounterDefinition): BrawlActor {
    const stats = ENEMY_STATS[spawn.archetype];
    const level = spawn.level ?? encounter.threat ?? 1;
    const maxHealth = enemyHealthAtLevel(stats.health, level);
    const entrance = spawn.entrance;
    let x = spawn.x;
    let lane = spawn.lane;
    let height = 0;
    if (entrance?.kind === 'right') {
      x = entrance.sourceX ?? encounter.lockRight + 90;
      lane = entrance.sourceLane ?? spawn.lane;
    } else if (entrance?.kind === 'background') {
      x = entrance.sourceX ?? spawn.x;
      lane = entrance.sourceLane ?? this.map.walkArea.back - 54;
    } else if (entrance?.kind === 'door') {
      x = entrance.sourceX ?? spawn.x;
      lane = entrance.sourceLane ?? this.map.walkArea.back - 28;
    } else if (entrance?.kind === 'drop') {
      x = entrance.sourceX ?? spawn.x;
      lane = entrance.sourceLane ?? spawn.lane;
      height = entrance.sourceHeight ?? 220;
    }
    return {
      id: spawn.id, kind: 'enemy', slot: null, archetype: spawn.archetype,
      level,
      name: spawn.archetype === 'captain'
        ? 'Warden'
        : spawn.archetype === 'bruiser'
          ? 'Enforcer'
          : spawn.archetype === 'shooter'
            ? 'Blaster'
            : 'Raider',
      x, lane, height, verticalVelocity: 0, health: maxHealth, maxHealth,
      state: entrance ? 'entering' : 'idle', stateTick: 0,
      facingRight: spawn.facingRight ?? x < spawn.x, attackKind: null, attackResolved: false,
      cooldown: 30, reviveTicks: 0, combatReady: !entrance, entranceKind: entrance?.kind ?? null,
      entranceDelayTicks: entrance?.delayTicks ?? 0, entryTargetX: spawn.x, entryTargetLane: spawn.lane,
    };
  }

  private updatePlayer(actor: BrawlActor, input: BrawlInput, events: BrawlSimEvent[]): void {
    if (actor.cooldown > 0) actor.cooldown -= 1;
    if (actor.health <= 0 || actor.state === 'victory') { actor.stateTick += 1; return; }

    if (actor.height > 0 || actor.verticalVelocity > 0) {
      const landed = this.updateAirborne(actor);
      if (!landed) {
        this.applyPlayerMovement(actor, input, AIR_CONTROL);
        this.setActorState(actor, 'jump', false);
        return;
      }
      events.push({ type: 'land', actorId: actor.id });
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
    if (actor.state === 'fireball') {
      actor.stateTick += 1;
      const isSuper = actor.attackKind === 'heavy';
      if (!actor.attackResolved && actor.stateTick >= 9) {
        actor.attackResolved = true;
        this.spawnProjectile(actor, isSuper, events);
      }
      if (actor.stateTick >= (isSuper ? 34 : 29)) this.setActorState(actor, 'idle');
      return;
    }
    if (input.jump) {
      actor.verticalVelocity = JUMP_VELOCITY;
      this.setActorState(actor, 'jump');
      events.push({ type: 'jump', actorId: actor.id });
      return;
    }
    if ((input.fireball || input.super) && actor.cooldown <= 0) {
      this.setActorState(actor, 'fireball');
      actor.attackKind = input.super ? 'heavy' : 'light';
      actor.cooldown = input.super ? 72 : 46;
      return;
    }
    if (input.punch || input.kick) {
      this.setActorState(actor, 'attack');
      actor.attackKind = input.kick ? 'heavy' : 'light';
      events.push({ type: 'attack', actorId: actor.id, attackKind: actor.attackKind });
      return;
    }
    this.applyPlayerMovement(actor, input, 1);
  }

  private applyPlayerMovement(actor: BrawlActor, input: BrawlInput, scale: number): void {
    const horizontal = Number(input.right) - Number(input.left);
    const vertical = Number(input.down) - Number(input.up);
    if (horizontal === 0 && vertical === 0) {
      if (actor.height <= 0) this.setActorState(actor, 'idle', false);
      this.faceNearestEnemy(actor);
      return;
    }
    const diagonal = horizontal !== 0 && vertical !== 0 ? Math.SQRT1_2 : 1;
    this.moveActor(actor, horizontal * PLAYER_SPEED * diagonal * scale, vertical * PLAYER_LANE_SPEED * diagonal * scale, true);
    if (horizontal !== 0) actor.facingRight = horizontal > 0;
    if (actor.height <= 0) this.setActorState(actor, 'walk', false);
  }

  private updateAirborne(actor: BrawlActor): boolean {
    actor.height += actor.verticalVelocity;
    actor.verticalVelocity -= JUMP_GRAVITY;
    if (actor.height > 0) return false;
    actor.height = 0;
    actor.verticalVelocity = 0;
    this.setActorState(actor, 'idle');
    return true;
  }

  private updateEnemy(actor: BrawlActor, events: BrawlSimEvent[]): void {
    if (actor.health <= 0) { actor.stateTick += 1; return; }
    if (!actor.combatReady) { this.updateEnemyEntrance(actor); return; }
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
        actor.cooldown = enemyCooldownAtLevel(ENEMY_STATS[actor.archetype!].cooldown, actor.level);
        this.setActorState(actor, 'idle');
      }
      return;
    }
    if (actor.state === 'fireball') {
      actor.stateTick += 1;
      const isSuper = actor.attackKind === 'heavy';
      if (!actor.attackResolved && actor.stateTick >= 11) {
        actor.attackResolved = true;
        this.spawnProjectile(actor, isSuper, events);
      }
      if (actor.stateTick >= (isSuper ? 38 : 32)) {
        const stats = ENEMY_STATS[actor.archetype!];
        actor.cooldown = enemyCooldownAtLevel(stats.projectileCooldown ?? stats.cooldown, actor.level);
        this.setActorState(actor, 'idle');
      }
      return;
    }

    const target = this.nearestLivingPlayer(actor);
    if (!target) return;
    const stats = ENEMY_STATS[actor.archetype!];
    const formation = this.enemyFormation(actor);
    const dxToTarget = target.x - actor.x;
    const laneDeltaToTarget = target.lane - actor.lane;
    const laneDelta = this.clampLane(target.lane + formation.lane) - actor.lane;
    actor.facingRight = dxToTarget >= 0;
    const distanceToTarget = Math.abs(dxToTarget);
    const canShoot = stats.projectileDamage !== undefined
      && distanceToTarget >= (stats.projectileMinRange ?? 0)
      && distanceToTarget <= (stats.projectileMaxRange ?? Number.POSITIVE_INFINITY)
      && Math.abs(laneDeltaToTarget) <= PROJECTILE_LANE_RANGE - 4;
    if (canShoot && actor.cooldown <= 0 && target.height < 54) {
      this.setActorState(actor, 'fireball');
      actor.attackKind = actor.archetype === 'captain' && actor.level >= 3 ? 'heavy' : 'light';
      return;
    }
    const inRange = Math.abs(dxToTarget) <= stats.range && Math.abs(laneDeltaToTarget) <= stats.laneRange && target.height < 48;
    if (inRange && actor.cooldown <= 0) {
      this.setActorState(actor, 'attack');
      actor.attackKind = actor.archetype === 'grunt' ? 'light' : 'heavy';
      events.push({ type: 'attack', actorId: actor.id, attackKind: actor.attackKind });
      return;
    }
    const rangedStandOff = stats.projectileDamage === undefined
      ? 0
      : Math.min(
          stats.projectileMaxRange ?? 300,
          Math.max(stats.projectileMinRange ?? 180, 225 + actor.level * 18),
        );
    const rangedTargetX = rangedStandOff > 0
      ? target.x + (actor.x >= target.x ? rangedStandOff : -rangedStandOff)
      : target.x + formation.x;
    const desiredX = rangedStandOff > 0 ? rangedTargetX : target.x + formation.x;
    const xDirection = direction(desiredX - actor.x, Math.max(22, stats.range * 0.72));
    let laneDirection = direction(laneDelta, Math.max(10, stats.laneRange * 0.45));
    if (xDirection !== 0 && laneDirection === 0) laneDirection = this.obstacleAvoidanceDirection(actor, xDirection);
    this.moveActor(
      actor,
      xDirection * enemySpeedAtLevel(stats.speed, actor.level),
      laneDirection * enemySpeedAtLevel(stats.laneSpeed, actor.level),
      false,
    );
    this.setActorState(actor, xDirection === 0 && laneDirection === 0 ? 'idle' : 'walk', false);
  }

  private updateEnemyEntrance(actor: BrawlActor): void {
    actor.stateTick += 1;
    if (actor.entranceDelayTicks > 0) { actor.entranceDelayTicks -= 1; return; }
    actor.facingRight = actor.entryTargetX >= actor.x;
    actor.x = approach(actor.x, actor.entryTargetX, ENTRANCE_SPEED_X);
    actor.lane = approach(actor.lane, actor.entryTargetLane, ENTRANCE_SPEED_LANE);
    actor.height = approach(actor.height, 0, actor.entranceKind === 'drop' ? 7.2 : 12);
    if (actor.x !== actor.entryTargetX || actor.lane !== actor.entryTargetLane || actor.height > 0) return;
    actor.combatReady = true;
    actor.cooldown = 22;
    this.setActorState(actor, 'idle');
  }

  private resolvePlayerAttack(actor: BrawlActor, heavy: boolean, events: BrawlSimEvent[]): void {
    const range = heavy ? 126 : 88;
    const laneRange = heavy ? 58 : 46;
    const damage = heavy ? 52 : 31;
    const maxTargets = heavy ? 2 : 1;
    const candidates = this.enemies
      .filter((enemy) => enemy.health > 0 && enemy.combatReady)
      .filter((enemy) => {
        const forwardDistance = (enemy.x - actor.x) * (actor.facingRight ? 1 : -1);
        return forwardDistance >= -18 && forwardDistance <= range && Math.abs(enemy.lane - actor.lane) <= laneRange;
      })
      .sort((a, b) => distanceSquared(actor, a) - distanceSquared(actor, b));
    for (const enemy of candidates.slice(0, maxTargets)) {
      this.damageActor(actor.id, actor.x, enemy, damage, heavy ? 46 : 28, events);
    }
    if (candidates.length < maxTargets) {
      const obstacle = this.nearestAttackableObstacle(actor, range, laneRange);
      if (obstacle) this.damageObstacle(actor.id, obstacle, damage, events);
    }
  }

  private resolveEnemyAttack(actor: BrawlActor, events: BrawlSimEvent[]): void {
    const target = this.nearestLivingPlayer(actor);
    if (!target || !actor.archetype || target.height >= 48) return;
    const stats = ENEMY_STATS[actor.archetype];
    const forwardDistance = (target.x - actor.x) * (actor.facingRight ? 1 : -1);
    if (forwardDistance < -22 || forwardDistance > stats.range + 18 || Math.abs(target.lane - actor.lane) > stats.laneRange + 8) return;
    this.damageActor(actor.id, actor.x, target, enemyDamageAtLevel(stats.damage, actor.level), 24, events);
  }

  private spawnProjectile(actor: BrawlActor, isSuper: boolean, events: BrawlSimEvent[]): void {
    const enemyStats = actor.kind === 'enemy' && actor.archetype
      ? ENEMY_STATS[actor.archetype]
      : null;
    const baseDamage = enemyStats?.projectileDamage !== undefined
      ? enemyStats.projectileDamage * (isSuper ? 1.45 : 1)
      : (isSuper ? 78 : 44);
    const damage = actor.kind === 'enemy'
      ? enemyDamageAtLevel(baseDamage, actor.level)
      : baseDamage;
    const speedScale = enemyStats?.projectileSpeedScale ?? 1;
    const projectile: BrawlProjectile = {
      id: this.nextProjectileId,
      ownerId: actor.id,
      ownerKind: actor.kind,
      x: actor.x + (actor.facingRight ? 62 : -62),
      lane: actor.lane,
      height: isSuper ? 82 : 72,
      vx: (actor.facingRight ? 1 : -1) * PROJECTILE_SPEED * speedScale * (isSuper ? 1.18 : 1),
      damage,
      age: 0,
      ttl: PROJECTILE_TTL,
      isSuper,
    };
    this.nextProjectileId += 1;
    this.projectiles.push(projectile);
    events.push({ type: 'fireball', actorId: actor.id, projectileId: projectile.id, isSuper });
  }

  private updateProjectiles(events: BrawlSimEvent[]): void {
    const survivors: BrawlProjectile[] = [];
    for (const projectile of this.projectiles) {
      const previousX = projectile.x;
      projectile.x += projectile.vx;
      projectile.age += 1;
      projectile.ttl -= 1;
      const collision = this.projectileCollision(projectile, previousX);
      if (collision?.kind === 'actor') {
        this.damageActor(projectile.ownerId, previousX, collision.actor, projectile.damage, projectile.isSuper ? 58 : 34, events);
        continue;
      }
      if (collision?.kind === 'obstacle') {
        this.damageObstacle(projectile.ownerId, collision.obstacle, projectile.damage, events);
        continue;
      }
      if (projectile.ttl > 0 && projectile.x >= this.map.walkArea.left - 80 && projectile.x <= this.map.walkArea.right + 80) survivors.push(projectile);
    }
    this.projectiles = survivors;
  }

  private projectileCollision(projectile: BrawlProjectile, previousX: number):
    { kind: 'actor'; actor: BrawlActor } | { kind: 'obstacle'; obstacle: BrawlObstacle } | null {
    const travelSign = projectile.vx >= 0 ? 1 : -1;
    const travelDistance = Math.abs(projectile.vx) + 34;
    const candidates: Array<{ distance: number; collision: { kind: 'actor'; actor: BrawlActor } | { kind: 'obstacle'; obstacle: BrawlObstacle } }> = [];
    const targets = projectile.ownerKind === 'player' ? this.enemies : this.players;
    for (const actor of targets) {
      if (actor.health <= 0 || !actor.combatReady || Math.abs(actor.lane - projectile.lane) > PROJECTILE_LANE_RANGE) continue;
      if (projectile.ownerKind === 'enemy' && actor.height >= 58) continue;
      const distance = (actor.x - previousX) * travelSign;
      if (distance >= -18 && distance <= travelDistance) candidates.push({ distance, collision: { kind: 'actor', actor } });
    }
    for (const obstacle of this.obstacles) {
      if (!this.isBlockingObstacle(obstacle) || Math.abs(obstacle.lane - projectile.lane) > obstacle.laneDepth / 2 + 12) continue;
      const nearEdge = obstacle.x - travelSign * obstacle.width / 2;
      const distance = (nearEdge - previousX) * travelSign;
      if (distance >= -(obstacle.width / 2 + 18) && distance <= travelDistance) {
        candidates.push({ distance, collision: { kind: 'obstacle', obstacle } });
      }
    }
    candidates.sort((a, b) => a.distance - b.distance);
    return candidates[0]?.collision ?? null;
  }

  private damageActor(attackerId: string, attackerX: number, target: BrawlActor, damage: number, push: number, events: BrawlSimEvent[]): void {
    if (target.health <= 0) return;
    target.health = Math.max(0, target.health - damage);
    const pushDirection = attackerX <= target.x ? 1 : -1;
    target.x = target.kind === 'player' ? this.clampPlayerX(target.x + pushDirection * push) : this.clampEnemyX(target.x + pushDirection * push);
    events.push({ type: 'hit', attackerId, targetId: target.id, damage });
    if (target.health <= 0) {
      target.height = 0;
      target.verticalVelocity = 0;
      this.setActorState(target, 'down');
      events.push({ type: 'actorDown', actorId: target.id });
      return;
    }
    this.setActorState(target, 'hit');
  }

  private damageObstacle(attackerId: string, obstacle: BrawlObstacle, damage: number, events: BrawlSimEvent[]): void {
    if (!this.isBlockingObstacle(obstacle)) return;
    obstacle.health = Math.max(0, obstacle.health - damage);
    events.push({ type: 'obstacleHit', attackerId, obstacleId: obstacle.id, damage });
    if (obstacle.health > 0) return;
    events.push({ type: 'obstacleDestroyed', obstacleId: obstacle.id });
    if (obstacle.type === 'explosive-barrel') this.explodeObstacle(obstacle, events);
  }

  private explodeObstacle(obstacle: BrawlObstacle, events: BrawlSimEvent[]): void {
    events.push({ type: 'obstacleExploded', obstacleId: obstacle.id });
    const radius = obstacle.explosionRadius || 150;
    const baseDamage = obstacle.explosionDamage || 32;
    for (const actor of [...this.players, ...this.enemies]) {
      if (actor.health <= 0 || !actor.combatReady || actor.height >= 88) continue;
      const dx = actor.x - obstacle.x;
      const laneDelta = (actor.lane - obstacle.lane) * 1.35;
      const distance = Math.sqrt(dx * dx + laneDelta * laneDelta);
      if (distance > radius) continue;
      const falloff = 0.58 + 0.42 * (1 - distance / radius);
      this.damageActor(
        obstacle.id,
        obstacle.x,
        actor,
        Math.max(1, Math.round(baseDamage * falloff)),
        38,
        events,
      );
    }
  }

  private updateObstacleStates(events: BrawlSimEvent[]): void {
    for (const obstacle of this.obstacles) {
      if (obstacle.type !== 'steam-vent') continue;
      const phase = (this.tick + obstacle.cycleOffset) % VENT_CYCLE_TICKS;
      obstacle.telegraphing = phase >= VENT_TELEGRAPH_START && phase < VENT_ACTIVE_START;
      obstacle.active = phase >= VENT_ACTIVE_START && phase < VENT_ACTIVE_END;
      if (phase !== VENT_ACTIVE_START) continue;
      events.push({ type: 'hazardBurst', obstacleId: obstacle.id });
      for (const actor of [...this.players, ...this.enemies]) {
        if (actor.health <= 0 || !actor.combatReady || actor.height >= obstacle.jumpClearance || !this.overlapsObstacle(actor, obstacle, 8)) continue;
        this.damageActor(obstacle.id, obstacle.x, actor, 12, 18, events);
      }
    }
  }

  private nearestAttackableObstacle(actor: BrawlActor, range: number, laneRange: number): BrawlObstacle | null {
    const candidates = this.obstacles
      .filter((obstacle) => this.isBlockingObstacle(obstacle))
      .filter((obstacle) => {
        const forwardDistance = (obstacle.x - actor.x) * (actor.facingRight ? 1 : -1);
        return forwardDistance >= -obstacle.width / 2 && forwardDistance <= range + obstacle.width / 2
          && Math.abs(obstacle.lane - actor.lane) <= laneRange + obstacle.laneDepth / 2;
      })
      .sort((a, b) => Math.abs(a.x - actor.x) - Math.abs(b.x - actor.x));
    return candidates[0] ?? null;
  }

  private updateRevives(inputs: readonly [BrawlInput, BrawlInput], events: BrawlSimEvent[]): void {
    for (let downSlot = 0 as 0 | 1; downSlot <= 1; downSlot = (downSlot + 1) as 0 | 1) {
      const down = this.players[downSlot];
      if (down.health > 0) { down.reviveTicks = 0; continue; }
      const helperSlot = (downSlot === 0 ? 1 : 0) as 0 | 1;
      const helper = this.players[helperSlot];
      const helperInput = inputs[helperSlot];
      const inRange = helper.health > 0 && Math.abs(helper.x - down.x) <= REVIVE_RANGE_X && Math.abs(helper.lane - down.lane) <= REVIVE_RANGE_LANE;
      if (!inRange || !helperInput.guard || helper.state === 'hit' || helper.state === 'attack' || helper.state === 'fireball') {
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

  private moveActor(actor: BrawlActor, deltaX: number, deltaLane: number, player: boolean): void {
    const clampX = (value: number) => player ? this.clampPlayerX(value) : this.clampEnemyX(value);
    let nextX = clampX(actor.x + deltaX);
    let nextLane = this.clampLane(actor.lane + deltaLane);
    for (const obstacle of this.obstacles) {
      if (!this.isBlockingObstacle(obstacle) || actor.height >= obstacle.jumpClearance) continue;
      const halfWidth = obstacle.width / 2 + ACTOR_RADIUS_X;
      const halfLane = obstacle.laneDepth / 2 + ACTOR_RADIUS_LANE;
      const xMin = obstacle.x - halfWidth;
      const xMax = obstacle.x + halfWidth;
      const laneMin = obstacle.lane - halfLane;
      const laneMax = obstacle.lane + halfLane;
      if (actor.lane > laneMin && actor.lane < laneMax && nextX > xMin && nextX < xMax) {
        if (deltaX > 0 && actor.x <= xMin) nextX = xMin;
        else if (deltaX < 0 && actor.x >= xMax) nextX = xMax;
      }
      if (nextX > xMin && nextX < xMax && nextLane > laneMin && nextLane < laneMax) {
        if (deltaLane > 0 && actor.lane <= laneMin) nextLane = laneMin;
        else if (deltaLane < 0 && actor.lane >= laneMax) nextLane = laneMax;
      }
    }
    actor.x = nextX;
    actor.lane = nextLane;
  }

  private obstacleAvoidanceDirection(actor: BrawlActor, xDirection: -1 | 0 | 1): -1 | 0 | 1 {
    if (xDirection === 0) return 0;
    const ahead = this.obstacles.find((obstacle) => {
      if (!this.isBlockingObstacle(obstacle)) return false;
      const distance = (obstacle.x - actor.x) * xDirection;
      return distance > 0 && distance < obstacle.width / 2 + 78
        && Math.abs(obstacle.lane - actor.lane) < obstacle.laneDepth / 2 + ACTOR_RADIUS_LANE + 8;
    });
    if (!ahead) return 0;
    const preferFront = actor.id.charCodeAt(actor.id.length - 1) % 2 === 0;
    if (preferFront && actor.lane < this.map.walkArea.front - 22) return 1;
    if (!preferFront && actor.lane > this.map.walkArea.back + 22) return -1;
    return preferFront ? -1 : 1;
  }

  private overlapsObstacle(actor: BrawlActor, obstacle: BrawlObstacle, margin = 0): boolean {
    return Math.abs(actor.x - obstacle.x) <= obstacle.width / 2 + ACTOR_RADIUS_X + margin
      && Math.abs(actor.lane - obstacle.lane) <= obstacle.laneDepth / 2 + ACTOR_RADIUS_LANE + margin;
  }

  private isBlockingObstacle(obstacle: BrawlObstacle): boolean {
    return obstacle.type !== 'steam-vent' && obstacle.health > 0;
  }

  private applyPlayerTether(): void {
    const [p1, p2] = this.players;
    if (Math.abs(p1.x - p2.x) <= this.map.maxPlayerSeparation) return;
    const leader = p1.x > p2.x ? p1 : p2;
    const trailer = leader === p1 ? p2 : p1;
    leader.x = this.clampPlayerX(trailer.x + this.map.maxPlayerSeparation);
  }

  private teamProgressX(): number { return Math.min(this.players[0].x, this.players[1].x); }

  private nearestLivingPlayer(actor: BrawlActor): BrawlActor | null {
    const living = this.players.filter((player) => player.health > 0);
    if (living.length === 0) return null;
    if (living.length === 1) return living[0];
    const preferredSlot = (actor.id.charCodeAt(actor.id.length - 1) % 2) as 0 | 1;
    return this.players[preferredSlot].health > 0 ? this.players[preferredSlot] : this.players[preferredSlot === 0 ? 1 : 0];
  }

  private enemyFormation(actor: BrawlActor): { x: number; lane: number } {
    const finalCode = actor.id.charCodeAt(actor.id.length - 1);
    return { x: 34 + (finalCode % 2) * 18, lane: ((finalCode % 3) - 1) * 30 };
  }

  private faceNearestEnemy(actor: BrawlActor): void {
    const living = this.enemies.filter((enemy) => enemy.health > 0 && enemy.combatReady);
    if (living.length === 0) return;
    living.sort((a, b) => distanceSquared(actor, a) - distanceSquared(actor, b));
    if (Math.abs(living[0].x - actor.x) > 2) actor.facingRight = living[0].x >= actor.x;
  }

  private setActorState(actor: BrawlActor, state: BrawlActorState, reset = true): void {
    if (actor.state === state && !reset) { actor.stateTick += 1; return; }
    actor.state = state;
    if (reset) actor.stateTick = 0;
    actor.attackResolved = false;
    if (state !== 'attack' && state !== 'fireball') actor.attackKind = null;
  }

  private clampPlayerX(x: number): number {
    let left = Math.max(this.map.walkArea.left, this.progressX - this.map.maxBacktrack);
    let right = this.map.walkArea.right;
    const encounter = this.map.encounters[this.activeEncounterIndex];
    if (encounter) { left = Math.max(left, encounter.lockLeft); right = Math.min(right, encounter.lockRight); }
    return Math.min(right, Math.max(left, x));
  }

  private clampEnemyX(x: number): number {
    const encounter = this.map.encounters[this.activeEncounterIndex];
    const left = encounter?.lockLeft ?? this.map.walkArea.left;
    const right = encounter?.lockRight ?? this.map.walkArea.right;
    return Math.min(right, Math.max(left, x));
  }
  private clampLane(lane: number): number { return Math.min(this.map.walkArea.front, Math.max(this.map.walkArea.back, lane)); }
}
