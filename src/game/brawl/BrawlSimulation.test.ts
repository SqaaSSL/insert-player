import { describe, expect, it } from 'vitest';
import { EMPTY_INPUT, type FighterInput } from '../sim/FighterInput.ts';
import { BrawlSimulation } from './BrawlSimulation.ts';
import { RUSH_ROUTE_MAP, type BrawlMapDefinition } from './BrawlMap.ts';

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
      ...RUSH_ROUTE_MAP,
      id: 'test-map',
      worldWidth: 1024,
      exitX: 900,
      walkArea: { ...RUSH_ROUTE_MAP.walkArea, right: 952 },
      playerSpawns: [{ x: 300, lane: 420 }, { x: 260, lane: 480 }],
      encounters: [{
        label: 'TEST',
        triggerX: 250,
        lockLeft: 200,
        lockRight: 700,
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

  it('makes both players advance before a checkpoint can begin', () => {
    const sim = new BrawlSimulation(['P1', 'P2']);
    expect(sim.start()).toEqual([{ type: 'runStart' }]);
    expect(sim.enemies).toHaveLength(0);

    for (let tick = 0; tick < 500; tick += 1) {
      sim.step({ ...EMPTY_INPUT, right: true }, EMPTY_INPUT);
    }
    expect(sim.encounterIndex).toBe(-1);
    expect(Math.abs(sim.players[0].x - sim.players[1].x)).toBeLessThanOrEqual(
      RUSH_ROUTE_MAP.maxPlayerSeparation,
    );

    let checkpointStarted = false;
    for (let tick = 0; tick < 220; tick += 1) {
      const events = sim.step(
        { ...EMPTY_INPUT, right: true },
        { ...EMPTY_INPUT, right: true },
      );
      checkpointStarted ||= events.some((event) => event.type === 'encounterStart');
      if (checkpointStarted) break;
    }
    expect(checkpointStarted).toBe(true);
    expect(sim.activeEncounterIndex).toBe(0);
    expect(sim.enemies.length).toBe(RUSH_ROUTE_MAP.encounters[0].enemies.length);
  });

  it('locks combat locally, then requires reaching the exit to finish the route', () => {
    const route: BrawlMapDefinition = {
      ...RUSH_ROUTE_MAP,
      id: 'short-route',
      worldWidth: 900,
      exitX: 720,
      walkArea: { ...RUSH_ROUTE_MAP.walkArea, right: 820 },
      playerSpawns: [{ x: 240, lane: 420 }, { x: 280, lane: 470 }],
      encounters: [{
        label: 'ROADBLOCK',
        triggerX: 340,
        lockLeft: 280,
        lockRight: 540,
        enemies: [{ id: 'blocker', archetype: 'grunt', x: 500, lane: 420 }],
      }],
    };
    const sim = new BrawlSimulation(['P1', 'P2'], route);
    sim.start();

    for (let tick = 0; tick < 60 && sim.activeEncounterIndex < 0; tick += 1) {
      sim.step({ ...EMPTY_INPUT, right: true }, { ...EMPTY_INPUT, right: true });
    }
    expect(sim.activeEncounterIndex).toBe(0);
    sim.players[0].x = route.encounters[0].lockRight - 1;
    sim.players[1].x = route.encounters[0].lockRight - 1;
    sim.step({ ...EMPTY_INPUT, right: true }, { ...EMPTY_INPUT, right: true });
    expect(sim.players.every((player) => player.x <= route.encounters[0].lockRight)).toBe(true);

    sim.enemies[0].health = 0;
    sim.enemies[0].state = 'down';
    let cleared = false;
    for (let tick = 0; tick < 60; tick += 1) {
      const events = sim.step(EMPTY_INPUT, EMPTY_INPUT);
      cleared ||= events.some((event) => event.type === 'encounterCleared');
    }
    expect(cleared).toBe(true);
    expect(sim.outcome).toBe('playing');

    let completed = false;
    for (let tick = 0; tick < 120; tick += 1) {
      const events = sim.step(
        { ...EMPTY_INPUT, right: true },
        { ...EMPTY_INPUT, right: true },
      );
      completed ||= events.some((event) => event.type === 'missionComplete');
      if (completed) break;
    }
    expect(completed).toBe(true);
    expect(sim.outcome).toBe('won');
  });
});
