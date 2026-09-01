import { EMPTY_INPUT, type FighterInput } from '../sim/FighterInput.ts';
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
): FighterInput {
  const dx = targetX - self.x;
  const laneDelta = targetLane - self.lane;
  return {
    ...EMPTY_INPUT,
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
    if (enemy.health <= 0) continue;
    const score = Math.abs(enemy.x - self.x) + Math.abs(enemy.lane - self.lane) * 1.7;
    if (score >= nearestScore) continue;
    nearest = enemy;
    nearestScore = score;
  }
  return nearest;
}

/**
 * Stateless companion policy derived entirely from deterministic simulation
 * state. Its output can later travel through the same rollback input stream as
 * a remote player's controls without adding hidden Phaser or wall-clock state.
 */
export function getBrawlCompanionInput(
  sim: BrawlSimulation,
  slot: 0 | 1 = 1,
): FighterInput {
  const self = sim.players[slot];
  const partner = sim.players[slot === 0 ? 1 : 0];
  if (self.health <= 0 || sim.outcome !== 'playing') return { ...EMPTY_INPUT };

  if (partner.health <= 0) {
    const closeEnough = Math.abs(partner.x - self.x) <= REVIVE_APPROACH_X
      && Math.abs(partner.lane - self.lane) <= REVIVE_APPROACH_LANE;
    if (closeEnough) return { ...EMPTY_INPUT, guard: true };
    return movementToward(self, partner.x, partner.lane, REVIVE_APPROACH_X, REVIVE_APPROACH_LANE);
  }

  const target = nearestEnemy(self, sim.enemies);
  if (target) {
    const dx = target.x - self.x;
    const laneDelta = target.lane - self.lane;
    const inRange = Math.abs(dx) <= COMBAT_RANGE_X && Math.abs(laneDelta) <= COMBAT_RANGE_LANE;
    if (inRange) {
      if (sim.tick % 40 === 0) return { ...EMPTY_INPUT, kick: true };
      if (sim.tick % 18 === 0) return { ...EMPTY_INPUT, punch: true };
      return { ...EMPTY_INPUT };
    }
    return movementToward(self, target.x, target.lane, COMBAT_RANGE_X - 8, COMBAT_RANGE_LANE - 6);
  }

  const desiredLane = partner.lane + (slot === 1 ? TRAVEL_LANE_OFFSET : -TRAVEL_LANE_OFFSET);
  const laneDelta = desiredLane - self.lane;
  return {
    ...EMPTY_INPUT,
    right: self.x <= partner.x + TRAVEL_LEAD_X,
    up: laneDelta < -30,
    down: laneDelta > 30,
  };
}
