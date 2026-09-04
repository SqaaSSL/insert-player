import { EMPTY_BRAWL_INPUT, type BrawlInput } from './BrawlInput.ts';
import type { BrawlActor, BrawlSimulation } from './BrawlSimulation.ts';
import type { RushCompanionOrder } from './RushConfig.ts';

const REVIVE_APPROACH_X = 76;
const REVIVE_APPROACH_LANE = 44;
const COMBAT_RANGE_X = 82;
const COMBAT_RANGE_LANE = 38;
const TRAVEL_LEAD_X = 170;
const TRAVEL_LANE_OFFSET = 42;
const PROJECTILE_DODGE_TICKS = 30;

function movementToward(
  self: BrawlActor,
  targetX: number,
  targetLane: number,
  deadZoneX: number,
  deadZoneLane: number,
): BrawlInput {
  const dx = targetX - self.x;
  const laneDelta = targetLane - self.lane;
  return {
    ...EMPTY_BRAWL_INPUT,
    left: dx < -deadZoneX,
    right: dx > deadZoneX,
    up: laneDelta < -deadZoneLane,
    down: laneDelta > deadZoneLane,
  };
}

function nearestEnemy(self: BrawlActor, enemies: readonly BrawlActor[]): BrawlActor | null {
  let nearest: BrawlActor | null = null;
  let nearestScore = Number.POSITIVE_INFINITY;
  for (const enemy of enemies) {
    if (enemy.health <= 0 || !enemy.combatReady) continue;
    const score = Math.abs(enemy.x - self.x) + Math.abs(enemy.lane - self.lane) * 1.7;
    if (score >= nearestScore) continue;
    nearest = enemy;
    nearestScore = score;
  }
  return nearest;
}

function nearestEnemyToPartner(partner: BrawlActor, enemies: readonly BrawlActor[]): BrawlActor | null {
  return nearestEnemy(partner, enemies);
}

function nearestRecoveryObstacle(self: BrawlActor, sim: BrawlSimulation) {
  return sim.obstacles
    .filter((obstacle) => obstacle.health > 0 && obstacle.healthReward > 0)
    .filter((obstacle) => obstacle.x >= self.x - 100)
    .map((obstacle) => ({
      obstacle,
      score: Math.abs(obstacle.x - self.x) + Math.abs(obstacle.lane - self.lane) * 1.5,
    }))
    .sort((a, b) => a.score - b.score)[0]?.obstacle ?? null;
}

function shouldJumpObstacle(self: BrawlActor, sim: BrawlSimulation, direction: -1 | 1): boolean {
  if (self.height > 0) return false;
  return sim.obstacles.some((obstacle) => {
    if (obstacle.type !== 'steam-vent' && obstacle.health <= 0) return false;
    if (obstacle.type === 'steam-vent' && !obstacle.active && !obstacle.telegraphing) return false;
    const forwardDistance = (obstacle.x - self.x) * direction;
    return forwardDistance > 18
      && forwardDistance < obstacle.width / 2 + 104
      && Math.abs(obstacle.lane - self.lane) < obstacle.laneDepth / 2 + 24;
  });
}

function hasIncomingProjectile(self: BrawlActor, sim: BrawlSimulation): boolean {
  if (self.height > 0) return false;
  return sim.projectiles.some((projectile) => {
    if (projectile.ownerKind !== 'enemy' || Math.abs(projectile.lane - self.lane) > 42) return false;
    const ticksToImpact = (self.x - projectile.x) / projectile.vx;
    return ticksToImpact > 2 && ticksToImpact <= PROJECTILE_DODGE_TICKS;
  });
}

function hasIncomingMelee(self: BrawlActor, sim: BrawlSimulation): boolean {
  return sim.enemies.some((enemy) => enemy.health > 0
    && enemy.combatReady
    && enemy.state === 'attack'
    && !enemy.attackResolved
    && Math.abs(enemy.x - self.x) <= 118
    && Math.abs(enemy.lane - self.lane) <= 72);
}

function hasUnsafeExplosiveLine(self: BrawlActor, target: BrawlActor, sim: BrawlSimulation): boolean {
  const direction = target.x >= self.x ? 1 : -1;
  return sim.obstacles.some((obstacle) => {
    if (obstacle.type !== 'explosive-barrel' || obstacle.health <= 0) return false;
    const distance = (obstacle.x - self.x) * direction;
    if (distance <= 0 || distance >= Math.abs(target.x - self.x)) return false;
    if (Math.abs(obstacle.lane - self.lane) > obstacle.laneDepth / 2 + 12) return false;
    return sim.players.some((player) => player.health > 0
      && Math.hypot(player.x - obstacle.x, (player.lane - obstacle.lane) * 1.35)
        <= obstacle.explosionRadius + 36);
  });
}

function hasUnsafeExplosiveNearby(self: BrawlActor, sim: BrawlSimulation): boolean {
  return sim.obstacles.some((obstacle) => obstacle.type === 'explosive-barrel'
    && obstacle.health > 0
    && Math.abs(obstacle.x - self.x) <= obstacle.width / 2 + 126
    && Math.abs(obstacle.lane - self.lane) <= obstacle.laneDepth / 2 + 58
    && sim.players.some((player) => player.health > 0
      && Math.hypot(player.x - obstacle.x, (player.lane - obstacle.lane) * 1.35)
        <= obstacle.explosionRadius + 36));
}

/**
 * Stateless companion policy derived entirely from deterministic simulation
 * state. Its output can later travel through the same rollback input stream as
 * a remote player's controls without adding hidden Phaser or wall-clock state.
 */
export function getBrawlCompanionInput(
  sim: BrawlSimulation,
  slot: 0 | 1 = 1,
  order: RushCompanionOrder = 'follow',
): BrawlInput {
  const self = sim.players[slot];
  const partner = sim.players[slot === 0 ? 1 : 0];
  if (self.health <= 0 || sim.outcome !== 'playing') return { ...EMPTY_BRAWL_INPUT };

  if (hasIncomingProjectile(self, sim)) {
    return {
      ...EMPTY_BRAWL_INPUT,
      jump: true,
      up: slot === 0,
      down: slot === 1,
    };
  }

  if (hasIncomingMelee(self, sim)) {
    return { ...EMPTY_BRAWL_INPUT, guard: true };
  }

  if (partner.health <= 0) {
    const closeEnough = Math.abs(partner.x - self.x) <= REVIVE_APPROACH_X
      && Math.abs(partner.lane - self.lane) <= REVIVE_APPROACH_LANE;
    if (closeEnough) return { ...EMPTY_BRAWL_INPUT, guard: true };
    return movementToward(self, partner.x, partner.lane, REVIVE_APPROACH_X, REVIVE_APPROACH_LANE);
  }

  const target = order === 'cover'
    ? nearestEnemyToPartner(partner, sim.enemies)
    : nearestEnemy(self, sim.enemies);
  if (target) {
    const dx = target.x - self.x;
    const laneDelta = target.lane - self.lane;
    const travelDirection = dx >= 0 ? 1 : -1;
    if (shouldJumpObstacle(self, sim, travelDirection)) {
      return {
        ...EMPTY_BRAWL_INPUT,
        jump: true,
        left: travelDirection < 0,
        right: travelDirection > 0,
      };
    }
    const inRange = Math.abs(dx) <= COMBAT_RANGE_X && Math.abs(laneDelta) <= COMBAT_RANGE_LANE;
    if (inRange) {
      if (self.state === 'idle' || self.state === 'walk') {
        const safeToCleave = !hasUnsafeExplosiveNearby(self, sim);
        if (safeToCleave && sim.tick % 40 === 0) return { ...EMPTY_BRAWL_INPUT, kick: true };
        const attackPhase = (sim.tick + slot * 13) % 58;
        if (safeToCleave && attackPhase < 22) return { ...EMPTY_BRAWL_INPUT, kick: true };
        return { ...EMPTY_BRAWL_INPUT, punch: true };
      }
      return { ...EMPTY_BRAWL_INPUT };
    }
    if (
      Math.abs(dx) >= (order === 'attack' ? 104 : 135)
      && Math.abs(laneDelta) <= 34
      && self.cooldown <= 0
      && !hasUnsafeExplosiveLine(self, target, sim)
    ) {
      return { ...EMPTY_BRAWL_INPUT, fireball: true };
    }
    if (order === 'cover' && Math.abs(target.x - partner.x) > 260) {
      return movementToward(self, partner.x + 28, partner.lane + TRAVEL_LANE_OFFSET, 72, 38);
    }
    return movementToward(
      self,
      target.x,
      target.lane,
      order === 'attack' ? COMBAT_RANGE_X - 22 : COMBAT_RANGE_X - 8,
      order === 'attack' ? COMBAT_RANGE_LANE - 14 : COMBAT_RANGE_LANE - 6,
    );
  }

  const recoveryThreshold = order === 'cover' ? 86 : order === 'attack' ? 38 : 72;
  const recovery = self.health <= recoveryThreshold || partner.health <= recoveryThreshold
    ? nearestRecoveryObstacle(self, sim)
    : null;
  if (recovery) {
    const closeEnough = Math.abs(recovery.x - self.x) <= recovery.width / 2 + COMBAT_RANGE_X
      && Math.abs(recovery.lane - self.lane) <= recovery.laneDepth / 2 + COMBAT_RANGE_LANE;
    if (closeEnough) {
      if (self.state === 'idle' || self.state === 'walk') return { ...EMPTY_BRAWL_INPUT, kick: true };
      return { ...EMPTY_BRAWL_INPUT };
    }
    return movementToward(
      self,
      recovery.x,
      recovery.lane,
      recovery.width / 2 + COMBAT_RANGE_X - 10,
      recovery.laneDepth / 2 + COMBAT_RANGE_LANE - 8,
    );
  }

  if (shouldJumpObstacle(self, sim, 1)) {
    return { ...EMPTY_BRAWL_INPUT, right: true, jump: true };
  }
  const orderLead = order === 'attack' ? 250 : order === 'cover' ? 36 : TRAVEL_LEAD_X;
  const desiredLane = partner.lane + (slot === 1 ? TRAVEL_LANE_OFFSET : -TRAVEL_LANE_OFFSET);
  const laneDelta = desiredLane - self.lane;
  return {
    ...EMPTY_BRAWL_INPUT,
    right: self.x <= partner.x + orderLead,
    up: laneDelta < -30,
    down: laneDelta > 30,
  };
}
