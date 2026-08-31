import { describe, expect, it } from 'vitest';
import { EMPTY_INPUT, type FighterInput } from '../sim/FighterInput.ts';
import { BrawlSimulation } from './BrawlSimulation.ts';
import { RUSH_ARENA_MAP, type BrawlMapDefinition } from './BrawlMap.ts';

function inputAt(tick: number, offset = 0): FighterInput {
  return {
    ...EMPTY_INPUT,
    right: (tick + offset) % 120 < 45,
    left: (tick + offset) % 240 >= 180,
    up: (tick + offset) % 90 < 20,
    down: (tick + offset) % 90 >= 55 && (tick + offset) % 90 < 75,
    punch: (tick + offset) % 31 === 0,
    kick: (tick + offset) % 83 === 0,
  };
}

describe('BrawlSimulation', () => {
  it('stays bit-identical for the same two input streams', () => {
    const first = new BrawlSimulation(['P1', 'P2']);
    const second = new BrawlSimulation(['P1', 'P2']);
    expect(first.start()).toEqual(second.start());
    for (let tick = 0; tick < 2_000; tick += 1) {
      const p1 = inputAt(tick);
      const p2 = inputAt(tick, 17);
      expect(first.step(p1, p2)).toEqual(second.step(p1, p2));
      expect(first.checksum()).toBe(second.checksum());
    }
  });

  it('restores an exact snapshot and replays the same future', () => {
    const sim = new BrawlSimulation(['P1', 'P2']);
    sim.start();
    for (let tick = 0; tick < 180; tick += 1) sim.step(inputAt(tick), inputAt(tick, 7));
    const snapshot = sim.snapshot();
    const future: number[] = [];
    for (let tick = 180; tick < 260; tick += 1) {
      sim.step(inputAt(tick), inputAt(tick, 7));
      future.push(sim.checksum());
    }
    sim.restore(snapshot);
    const replayed: number[] = [];
    for (let tick = 180; tick < 260; tick += 1) {
      sim.step(inputAt(tick), inputAt(tick, 7));
      replayed.push(sim.checksum());
    }
    expect(replayed).toEqual(future);
  });

  it('uses authored map geometry independently from its visual stage', () => {
    const closeRangeMap: BrawlMapDefinition = {
      ...RUSH_ARENA_MAP,
      id: 'test-map',
      playerSpawns: [{ x: 300, lane: 420 }, { x: 260, lane: 480 }],
      waves: [{
        label: 'TEST',
        enemies: [{ id: 'target', archetype: 'grunt', x: 350, lane: 420 }],
      }],
    };
    const sim = new BrawlSimulation(['P1', 'P2'], closeRangeMap);
    sim.start();
    sim.step({ ...EMPTY_INPUT, punch: true }, EMPTY_INPUT);
    for (let tick = 0; tick < 8; tick += 1) sim.step(EMPTY_INPUT, EMPTY_INPUT);
    expect(sim.enemies[0].health).toBeLessThan(sim.enemies[0].maxHealth);
    expect(sim.map.worldWidth).toBe(1024);
  });
});

