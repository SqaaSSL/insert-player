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

  it('jumps over a solid route obstacle instead of treating depth as jump', () => {
    const obstacleMap: BrawlMapDefinition = {
      ...RUSH_ROUTE_MAP,
      id: 'jump-test',
      worldWidth: 1000,
      exitX: 900,
      walkArea: { ...RUSH_ROUTE_MAP.walkArea, right: 940 },
      playerSpawns: [{ x: 300, lane: 420 }, { x: 300, lane: 500 }],
      obstacles: [{
        id: 'test-barricade',
        type: 'barricade',
        x: 430,
        lane: 420,
        width: 70,
        laneDepth: 60,
        health: 100,
        jumpClearance: 55,
      }],
      encounters: [],
    };
    const sim = new BrawlSimulation(['P1', 'P2'], obstacleMap);
    sim.start();
    for (let tick = 0; tick < 60; tick += 1) {
      sim.step({ ...EMPTY_INPUT, right: true }, EMPTY_INPUT);
    }
    expect(sim.players[0].x).toBeLessThan(380);

    const jumpEvents = sim.step({ ...EMPTY_INPUT, uppercut: true, right: true }, EMPTY_INPUT);
    expect(jumpEvents).toContainEqual({ type: 'jump', actorId: 'player-1' });
    for (let tick = 0; tick < 42; tick += 1) {
      sim.step({ ...EMPTY_INPUT, right: true }, EMPTY_INPUT);
    }
    expect(sim.players[0].x).toBeGreaterThan(490);
    expect(sim.players[0].height).toBeGreaterThanOrEqual(0);
  });

  it('spawns a real travelling fireball that hits at range', () => {
    const projectileMap: BrawlMapDefinition = {
      ...RUSH_ROUTE_MAP,
      id: 'projectile-test',
      obstacles: [],
      playerSpawns: [{ x: 300, lane: 420 }, { x: 260, lane: 500 }],
      encounters: [{
        label: 'RANGE TEST',
        triggerX: 250,
        lockLeft: 200,
        lockRight: 760,
        enemies: [{ id: 'ranged-target', archetype: 'grunt', x: 540, lane: 420 }],
      }],
    };
    const sim = new BrawlSimulation(['P1', 'P2'], projectileMap);
    sim.start();
    sim.step(EMPTY_INPUT, EMPTY_INPUT);
    const startingHealth = sim.enemies[0].health;
    sim.step({ ...EMPTY_INPUT, fireball: true }, EMPTY_INPUT);
    let sawProjectile = false;
    for (let tick = 0; tick < 55; tick += 1) {
      const events = sim.step(EMPTY_INPUT, EMPTY_INPUT);
      sawProjectile ||= events.some((event) => event.type === 'fireball');
    }
    expect(sawProjectile).toBe(true);
    expect(sim.enemies[0].health).toBeLessThan(startingHealth);
  });

  it('lets projectiles damage breakable barricades on the route', () => {
    const obstacleMap: BrawlMapDefinition = {
      ...RUSH_ROUTE_MAP,
      id: 'projectile-obstacle-test',
      obstacles: [{
        id: 'projectile-barricade',
        type: 'barricade',
        x: 430,
        lane: 420,
        width: 70,
        laneDepth: 60,
        health: 100,
      }],
      playerSpawns: [{ x: 300, lane: 420 }, { x: 260, lane: 500 }],
      encounters: [],
    };
    const sim = new BrawlSimulation(['P1', 'P2'], obstacleMap);
    sim.start();
    sim.step({ ...EMPTY_INPUT, fireball: true }, EMPTY_INPUT);
    let hitObstacle = false;
    for (let tick = 0; tick < 20; tick += 1) {
      const events = sim.step(EMPTY_INPUT, EMPTY_INPUT);
      hitObstacle ||= events.some((event) => event.type === 'obstacleHit');
    }
    expect(hitObstacle).toBe(true);
    expect(sim.obstacles[0].health).toBe(56);
  });

  it('lets dedicated ranged enemies fire projectiles at the team', () => {
    const rangedMap: BrawlMapDefinition = {
      ...RUSH_ROUTE_MAP,
      id: 'enemy-projectile-test',
      obstacles: [],
      playerSpawns: [{ x: 300, lane: 420 }, { x: 260, lane: 500 }],
      encounters: [{
        label: 'BLASTER TEST',
        threat: 1,
        triggerX: 250,
        lockLeft: 200,
        lockRight: 760,
        enemies: [{ id: 'test-blaster', archetype: 'shooter', x: 560, lane: 420, level: 1 }],
      }],
    };
    const sim = new BrawlSimulation(['P1', 'P2'], rangedMap);
    sim.start();
    let fired = false;
    for (let tick = 0; tick < 180; tick += 1) {
      const events = sim.step(EMPTY_INPUT, EMPTY_INPUT);
      fired ||= events.some((event) => event.type === 'fireball' && event.actorId === 'test-blaster');
      if (sim.players[0].health < sim.players[0].maxHealth) break;
    }
    expect(fired).toBe(true);
    expect(sim.players[0].health).toBeLessThan(sim.players[0].maxHealth);
  });

  it('turns explosive route props into tactical chain hits', () => {
    const explosiveMap: BrawlMapDefinition = {
      ...RUSH_ROUTE_MAP,
      id: 'explosive-obstacle-test',
      obstacles: [{
        id: 'test-fuel-cell',
        type: 'explosive-barrel',
        x: 430,
        lane: 420,
        width: 54,
        laneDepth: 44,
        health: 40,
        explosionRadius: 160,
        explosionDamage: 36,
      }],
      playerSpawns: [{ x: 300, lane: 420 }, { x: 260, lane: 500 }],
      encounters: [{
        label: 'CHAIN TEST',
        threat: 1,
        triggerX: 250,
        lockLeft: 200,
        lockRight: 760,
        enemies: [{ id: 'blast-target', archetype: 'bruiser', x: 520, lane: 420, level: 1 }],
      }],
    };
    const sim = new BrawlSimulation(['P1', 'P2'], explosiveMap);
    sim.start();
    sim.step({ ...EMPTY_INPUT, fireball: true }, EMPTY_INPUT);
    let exploded = false;
    for (let tick = 0; tick < 40; tick += 1) {
      const events = sim.step(EMPTY_INPUT, EMPTY_INPUT);
      exploded ||= events.some((event) => event.type === 'obstacleExploded');
    }
    expect(exploded).toBe(true);
    expect(sim.obstacles[0].health).toBe(0);
    expect(sim.enemies[0].health).toBeLessThan(sim.enemies[0].maxHealth);
  });

  it('restores co-op health when a player breaks a recovery barricade', () => {
    const recoveryMap: BrawlMapDefinition = {
      ...RUSH_ROUTE_MAP,
      id: 'recovery-obstacle-test',
      obstacles: [{
        id: 'food-crate',
        type: 'barricade',
        x: 380,
        lane: 420,
        width: 70,
        laneDepth: 54,
        health: 25,
        healthReward: 24,
      }],
      playerSpawns: [{ x: 300, lane: 420 }, { x: 260, lane: 500 }],
      encounters: [],
    };
    const sim = new BrawlSimulation(['P1', 'P2'], recoveryMap);
    sim.start();
    sim.players[0].health = 50;
    sim.players[1].health = 60;
    sim.step({ ...EMPTY_INPUT, punch: true }, EMPTY_INPUT);
    let recovery = null;
    for (let tick = 0; tick < 10; tick += 1) {
      const events = sim.step(EMPTY_INPUT, EMPTY_INPUT);
      recovery ??= events.find((event) => event.type === 'obstacleRecovery') ?? null;
    }
    expect(sim.obstacles[0].health).toBe(0);
    expect(sim.players[0].health).toBe(74);
    expect(sim.players[1].health).toBe(84);
    expect(recovery).toEqual({
      type: 'obstacleRecovery',
      actorId: 'player-1',
      obstacleId: 'food-crate',
      amount: 24,
    });
  });

  it('matches steam damage to the visible root footprint instead of the actor radius', () => {
    const hazardMap: BrawlMapDefinition = {
      ...RUSH_ROUTE_MAP,
      id: 'exact-hazard-footprint-test',
      obstacles: [{
        id: 'exact-vent',
        type: 'steam-vent',
        x: 430,
        lane: 420,
        width: 100,
        laneDepth: 60,
        hazardWidth: 60,
        hazardLaneDepth: 24,
        cycleOffset: 71,
      }],
      // P1 is inside the ellipse's bounding box but outside the ellipse itself.
      playerSpawns: [{ x: 451, lane: 430 }, { x: 430, lane: 420 }],
      encounters: [],
    };
    const sim = new BrawlSimulation(['P1', 'P2'], hazardMap);
    sim.start();
    const events = sim.step(EMPTY_INPUT, EMPTY_INPUT);
    expect(events).toContainEqual({ type: 'hazardBurst', obstacleId: 'exact-vent' });
    expect(sim.players[0].health).toBe(100);
    expect(sim.players[1].health).toBe(88);

    // Entering while the steam is visibly active must still be dangerous;
    // damage is pulsed instead of being limited to the first active frame.
    sim.players[0].x = 430;
    sim.players[0].lane = 420;
    for (let tick = 0; tick < 11; tick += 1) sim.step(EMPTY_INPUT, EMPTY_INPUT);
    const secondPulseEvents = sim.step(EMPTY_INPUT, EMPTY_INPUT);
    expect(secondPulseEvents).toContainEqual({ type: 'hazardBurst', obstacleId: 'exact-vent' });
    expect(sim.players[0].health).toBe(88);
  });

  it('makes an authored threat squad overwhelm a passive team', () => {
    const threatMap: BrawlMapDefinition = {
      ...RUSH_ROUTE_MAP,
      id: 'aggressive-squad-test',
      obstacles: [],
      playerSpawns: [{ x: 300, lane: 420 }, { x: 330, lane: 470 }],
      encounters: [{
        label: 'THREAT SQUAD',
        threat: 3,
        triggerX: 250,
        lockLeft: 220,
        lockRight: 820,
        enemies: [
          { id: 'squad-a', archetype: 'grunt', x: 390, lane: 420, level: 3 },
          { id: 'squad-b', archetype: 'bruiser', x: 420, lane: 470, level: 3 },
          { id: 'squad-c', archetype: 'shooter', x: 650, lane: 420, level: 3 },
          { id: 'squad-d', archetype: 'captain', x: 570, lane: 470, level: 3 },
        ],
      }],
    };
    const sim = new BrawlSimulation(['P1', 'P2'], threatMap);
    sim.start();
    for (let tick = 0; tick < 720 && sim.outcome === 'playing'; tick += 1) {
      sim.step(EMPTY_INPUT, EMPTY_INPUT);
    }
    expect(sim.outcome).toBe('lost');
    expect(sim.players.every((player) => player.health === 0)).toBe(true);
  });

  it('keeps the harder attacks fair by letting a planted guard absorb most damage', () => {
    const guardMap: BrawlMapDefinition = {
      ...RUSH_ROUTE_MAP,
      id: 'guard-counterplay-test',
      obstacles: [],
      playerSpawns: [{ x: 300, lane: 420 }, { x: 260, lane: 500 }],
      encounters: [{
        label: 'GUARD TEST',
        triggerX: 250,
        lockLeft: 220,
        lockRight: 760,
        enemies: [{ id: 'guard-target-b', archetype: 'grunt', x: 352, lane: 420, level: 1 }],
      }],
    };
    const sim = new BrawlSimulation(['P1', 'P2'], guardMap);
    sim.start();
    let guardedDamage = 0;
    for (let tick = 0; tick < 90 && guardedDamage === 0; tick += 1) {
      const events = sim.step({ ...EMPTY_INPUT, guard: true }, EMPTY_INPUT);
      guardedDamage = events.find((event) => event.type === 'guarded')?.damage ?? 0;
    }
    expect(guardedDamage).toBe(5);
    expect(sim.players[0].health).toBe(95);
    expect(sim.players[0].state).not.toBe('hit');
  });

  it('ramps the shipped route from four hostiles to a six-enemy blockade', () => {
    expect(RUSH_ROUTE_MAP.encounters.map((encounter) => encounter.enemies.length)).toEqual([4, 5, 6]);
  });

  it('lets rolling squads arrive while the team keeps pushing toward a soft gate', () => {
    const rollingMap: BrawlMapDefinition = {
      ...RUSH_ROUTE_MAP,
      id: 'rolling-wave-test',
      obstacles: [],
      playerSpawns: [{ x: 300, lane: 420 }, { x: 320, lane: 480 }],
      encounters: [{
        label: 'MOVING WAVE',
        mode: 'rolling',
        triggerX: 290,
        lockLeft: 260,
        lockRight: 420,
        advanceLimit: 680,
        enemies: [{ id: 'rolling-target', archetype: 'shooter', x: 650, lane: 350 }],
      }],
    };
    const sim = new BrawlSimulation(['P1', 'P2'], rollingMap);
    sim.start();
    sim.step(EMPTY_INPUT, EMPTY_INPUT);
    sim.players[0].x = 418;
    sim.players[1].x = 418;
    for (let tick = 0; tick < 18; tick += 1) {
      sim.step({ ...EMPTY_INPUT, right: true }, { ...EMPTY_INPUT, right: true });
    }
    expect(sim.players[0].x).toBeGreaterThan(rollingMap.encounters[0].lockRight);
    sim.players[0].x = 679;
    sim.players[1].x = 679;
    sim.step({ ...EMPTY_INPUT, right: true }, { ...EMPTY_INPUT, right: true });
    expect(sim.players.every((player) => player.x <= 680)).toBe(true);
  });

  it('makes Mayhem tougher than Rookie without changing fighter assets or inputs', () => {
    const rookie = new BrawlSimulation(['P1', 'P2'], RUSH_ROUTE_MAP, { difficulty: 'rookie' });
    const mayhem = new BrawlSimulation(['P1', 'P2'], RUSH_ROUTE_MAP, { difficulty: 'mayhem' });
    rookie.start();
    mayhem.start();
    rookie.progressX = RUSH_ROUTE_MAP.encounters[0].triggerX;
    mayhem.progressX = RUSH_ROUTE_MAP.encounters[0].triggerX;
    rookie.step(EMPTY_INPUT, EMPTY_INPUT);
    mayhem.step(EMPTY_INPUT, EMPTY_INPUT);
    expect(mayhem.enemies[0].maxHealth).toBeGreaterThan(rookie.enemies[0].maxHealth);
    expect(mayhem.difficultyId).toBe('mayhem');
    expect(rookie.difficultyId).toBe('rookie');
  });

  it('scales authored enemy levels and supports drop entrances', () => {
    const difficultyMap: BrawlMapDefinition = {
      ...RUSH_ROUTE_MAP,
      id: 'difficulty-entry-test',
      obstacles: [],
      playerSpawns: [{ x: 300, lane: 420 }, { x: 260, lane: 500 }],
      encounters: [{
        label: 'THREAT TEST',
        threat: 1,
        triggerX: 250,
        lockLeft: 200,
        lockRight: 760,
        enemies: [
          { id: 'level-one', archetype: 'grunt', x: 480, lane: 420, level: 1 },
          {
            id: 'level-three-drop',
            archetype: 'grunt',
            x: 560,
            lane: 470,
            level: 3,
            entrance: { kind: 'drop', sourceHeight: 210, delayTicks: 2 },
          },
        ],
      }],
    };
    const sim = new BrawlSimulation(['P1', 'P2'], difficultyMap);
    sim.start();
    sim.step(EMPTY_INPUT, EMPTY_INPUT);
    const [levelOne, levelThree] = sim.enemies;
    expect(levelThree.maxHealth).toBeGreaterThan(levelOne.maxHealth);
    expect(levelThree).toMatchObject({ height: 210, combatReady: false, entranceKind: 'drop' });
    for (let tick = 0; tick < 60 && !levelThree.combatReady; tick += 1) {
      sim.step(EMPTY_INPUT, EMPTY_INPUT);
    }
    expect(levelThree).toMatchObject({ height: 0, combatReady: true });
  });

  it('stages enemies from authored entrances before enabling combat', () => {
    const entranceMap: BrawlMapDefinition = {
      ...RUSH_ROUTE_MAP,
      id: 'entrance-test',
      obstacles: [],
      playerSpawns: [{ x: 300, lane: 420 }, { x: 260, lane: 500 }],
      encounters: [{
        label: 'DOOR TEST',
        triggerX: 250,
        lockLeft: 200,
        lockRight: 760,
        enemies: [{
          id: 'door-target',
          archetype: 'grunt',
          x: 430,
          lane: 420,
          entrance: { kind: 'door', sourceX: 360, sourceLane: 300, delayTicks: 4 },
        }],
      }],
    };
    const sim = new BrawlSimulation(['P1', 'P2'], entranceMap);
    sim.start();
    sim.step(EMPTY_INPUT, EMPTY_INPUT);
    const enemy = sim.enemies[0];
    expect(enemy).toMatchObject({ x: 360, lane: 300, combatReady: false, state: 'entering' });
    const startingHealth = enemy.health;
    for (let tick = 0; tick < 12; tick += 1) {
      sim.step({ ...EMPTY_INPUT, punch: tick === 0 }, EMPTY_INPUT);
    }
    expect(enemy.health).toBe(startingHealth);
    for (let tick = 0; tick < 80 && !enemy.combatReady; tick += 1) sim.step(EMPTY_INPUT, EMPTY_INPUT);
    expect(enemy).toMatchObject({ x: 430, lane: 420, combatReady: true });
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
        { ...EMPTY_INPUT, right: true, uppercut: tick === 0 },
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
      obstacles: [],
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
