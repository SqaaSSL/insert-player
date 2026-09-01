import { EMPTY_BRAWL_INPUT, type BrawlInput } from './BrawlInput.ts';
import type { BrawlActor, BrawlSimulation } from './BrawlSimulation.ts';

const REVIVE_APPROACH_X = 76;
const REVIVE_APPROACH_LANE = 44;
const COMBAT_RANGE_X = 82;
const COMBAT_RANGE_LANE = 38;
const TRAVEL_LEAD_X = 170;
const TRAVEL_LANE_OFFSET = 42;

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

function shouldJumpObstacle(self: BrawlActor, sim: BrawlSimulation, direction: -1 | 1): boolean {
  if (self.height > 0) return false;
  return sim.obstacles.some((obstacle) => {
    if (obstacle.type === 'barricade' && obstacle.health <= 0) return false;
    if (obstacle.type === 'steam-vent' && !obstacle.active && !obstacle.telegraphing) return false;
    const forwardDistance = (obstacle.x - self.x) * direction;
    return forwardDistance > 18
      && forwardDistance < obstacle.width / 2 + 104
      && Math.abs(obstacle.lane - self.lane) < obstacle.laneDepth / 2 + 24;
  });
}

/**
 * Stateless companion policy derived entirely from deterministic simulation
 * state. Its output can later travel through the same rollback input stream as
 * a remote player's controls without adding hidden Phaser or wall-clock state.
 */
export function getBrawlCompanionInput(
  sim: BrawlSimulation,
  slot: 0 | 1 = 1,
): BrawlInput {
  const self = sim.players[slot];
  const partner = sim.players[slot === 0 ? 1 : 0];
  if (self.health <= 0 || sim.outcome !== 'playing') return { ...EMPTY_BRAWL_INPUT };

  if (partner.health <= 0) {
    const closeEnough = Math.abs(partner.x - self.x) <= REVIVE_APPROACH_X
      && Math.abs(partner.lane - self.lane) <= REVIVE_APPROACH_LANE;
    if (closeEnough) return { ...EMPTY_BRAWL_INPUT, guard: true };
    return movementToward(self, partner.x, partner.lane, REVIVE_APPROACH_X, REVIVE_APPROACH_LANE);
  }

  const target = nearestEnemy(self, sim.enemies);
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
      if (sim.tick % 40 === 0) return { ...EMPTY_BRAWL_INPUT, kick: true };
      if (sim.tick % 18 === 0) return { ...EMPTY_BRAWL_INPUT, punch: true };
      return { ...EMPTY_BRAWL_INPUT };
    }
    if (Math.abs(dx) >= 145 && Math.abs(laneDelta) <= 34 && sim.tick % 96 === 0) {
      return { ...EMPTY_BRAWL_INPUT, fireball: true };
    }
    return movementToward(self, target.x, target.lane, COMBAT_RANGE_X - 8, COMBAT_RANGE_LANE - 6);
  }

  if (shouldJumpObstacle(self, sim, 1)) {
    return { ...EMPTY_BRAWL_INPUT, right: true, jump: true };
  }
  const desiredLane = partner.lane + (slot === 1 ? TRAVEL_LANE_OFFSET : -TRAVEL_LANE_OFFSET);
  const laneDelta = desiredLane - self.lane;
  return {
    ...EMPTY_BRAWL_INPUT,
    right: self.x <= partner.x + TRAVEL_LEAD_X,
    up: laneDelta < -30,
    down: laneDelta > 30,
  };
}
