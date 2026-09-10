import { describe, expect, it, vi } from 'vitest';
import { FIXED_TIMESTEP } from '../constants.ts';
import { EMPTY_INPUT } from '../sim/FighterInput.ts';
import { BrawlSimulation } from '../brawl/BrawlSimulation.ts';
import { RUSH_ROUTE_MAP, type BrawlMapDefinition } from '../brawl/BrawlMap.ts';

vi.mock('phaser', () => ({ default: { Scene: class {} } }));

import { RushScene } from './RushScene.ts';

function createHarness(attack: 'punch' | 'kick') {
  const map: BrawlMapDefinition = {
    ...RUSH_ROUTE_MAP,
    id: 'rush-flow-test',
    obstacles: [],
    playerSpawns: [{ x: 300, lane: 420 }, { x: 260, lane: 500 }],
    encounters: [{
      label: 'FLOW',
      triggerX: 250,
      lockLeft: 200,
      lockRight: 900,
      enemies: [{ id: 'target', archetype: 'bruiser', x: 350, lane: 420 }],
    }],
  };
  const sim = new BrawlSimulation(['P1', 'P2'], map);
  sim.start();
  sim.step(EMPTY_INPUT, EMPTY_INPUT);
  sim.enemies[0].cooldown = 1_000;

  const scene = Object.assign(new RushScene() as Pick<RushScene, 'update'>, {
    ready: true,
    paused: false,
    waitingForRunAction: false,
    accumulator: 0,
    companionCpu: false,
    inputManager: {
      poll: vi.fn(),
      readPlayer1: vi.fn(() => EMPTY_INPUT).mockReturnValueOnce({ ...EMPTY_INPUT, [attack]: true }),
      readPlayer2: vi.fn(() => ({ ...EMPTY_INPUT, right: true })),
    },
    sim,
    runStats: { damageTaken: 0 },
    presentations: new Map(),
    time: { now: 0 },
    soundManager: { playHit: vi.fn(), playWhoosh: vi.fn(), playUppercut: vi.fn() },
    createHitEffect: vi.fn(),
    consumeQueuedJump: vi.fn(() => false),
    syncPresentations: vi.fn(),
    syncProjectilePresentations: vi.fn(),
    syncObstaclePresentations: vi.fn(),
    updateHud: vi.fn(),
    updateCamera: vi.fn(),
  });
  return scene;
}

describe('RushScene combat flow', () => {
  it.each(['punch', 'kick'] as const)('keeps the partner moving every tick through a landed %s', (attack) => {
    const scene = createHarness(attack);
    const startingTick = scene.sim.tick;

    for (let frame = 0; frame < 20; frame += 1) {
      const partnerX = scene.sim.players[1].x;
      scene.update(frame * FIXED_TIMESTEP, FIXED_TIMESTEP);
      expect(scene.sim.tick).toBe(startingTick + frame + 1);
      expect(scene.sim.players[1].x).toBeGreaterThan(partnerX);
    }

    expect(scene.sim.enemies[0].health).toBeLessThan(scene.sim.enemies[0].maxHealth);
    expect(scene.soundManager.playHit).toHaveBeenCalledWith(attack === 'kick');
    expect(scene.createHitEffect).toHaveBeenCalledOnce();
    expect(scene.updateCamera).toHaveBeenCalledTimes(20);
  });

  it.each(['punch', 'kick'] as const)('does not discard simulation time when a %s lands in a slow frame', (attack) => {
    const scene = createHarness(attack);
    scene.inputManager.readPlayer1.mockReset().mockReturnValue(EMPTY_INPUT);
    scene.sim.players[0].state = 'attack';
    scene.sim.players[0].attackKind = attack === 'kick' ? 'heavy' : 'light';
    scene.sim.players[0].stateTick = attack === 'kick' ? 9 : 5;
    const startingTick = scene.sim.tick;

    scene.update(0, 50.1);

    expect(scene.createHitEffect).toHaveBeenCalledOnce();
    expect(scene.sim.tick).toBe(startingTick + 3);
    expect(scene.inputManager.readPlayer1).toHaveBeenCalledTimes(3);
    expect(scene.inputManager.readPlayer2).toHaveBeenCalledTimes(3);
    expect(scene.accumulator).toBeCloseTo(50.1 - 3 * FIXED_TIMESTEP);
    expect(scene.syncPresentations).toHaveBeenCalledOnce();
    expect(scene.syncProjectilePresentations).toHaveBeenCalledOnce();
    expect(scene.syncObstaclePresentations).toHaveBeenCalledOnce();
    // Hit reactions remain local to the victim while the world advances.
    expect(scene.sim.enemies[0].state).toBe('hit');
    expect(scene.sim.enemies[0].stateTick).toBeGreaterThan(1);
  });

  it('still caps catch-up work after a long browser frame', () => {
    const scene = createHarness('punch');
    scene.accumulator = 0.1;
    const startingTick = scene.sim.tick;
    scene.update(0, 5_000);
    expect(scene.sim.tick).toBe(startingTick + 5);
    expect(scene.accumulator).toBeLessThan(FIXED_TIMESTEP);
  });
});
