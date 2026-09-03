import { describe, expect, it } from 'vitest';
import { EMPTY_INPUT } from '../sim/FighterInput.ts';
import { getBrawlCompanionInput } from './BrawlCompanionAI.ts';
import { BrawlSimulation } from './BrawlSimulation.ts';

describe('BrawlCompanionAI', () => {
  it('advances with the player and reaches the first checkpoint', () => {
    const sim = new BrawlSimulation(['P1', 'CPU']);
    sim.start();
    let started = false;
    for (let tick = 0; tick < 240; tick += 1) {
      const events = sim.step(
        { ...EMPTY_INPUT, right: true, uppercut: tick === 94 },
        getBrawlCompanionInput(sim),
      );
      started ||= events.some((event) => event.type === 'encounterStart');
      if (started) break;
    }
    expect(started).toBe(true);
    expect(sim.activeEncounterIndex).toBe(0);
  });

  it('closes both combat axes and attacks once it is in range', () => {
    const sim = new BrawlSimulation(['P1', 'CPU']);
    sim.start();
    sim.progressX = sim.map.encounters[0].triggerX;
    sim.step(EMPTY_INPUT, EMPTY_INPUT);
    const cpu = sim.players[1];
    const enemy = sim.enemies[0];
    enemy.combatReady = true;
    enemy.state = 'idle';

    cpu.x = enemy.x - 180;
    cpu.lane = enemy.lane + 90;
    expect(getBrawlCompanionInput(sim)).toMatchObject({ right: true, up: true });

    cpu.x = enemy.x - 60;
    cpu.lane = enemy.lane;
    sim.tick = 40;
    expect(getBrawlCompanionInput(sim)).toMatchObject({ kick: true });
  });

  it('approaches and revives a downed partner', () => {
    const sim = new BrawlSimulation(['P1', 'CPU']);
    const [partner, cpu] = sim.players;
    partner.health = 0;
    partner.x = 300;
    partner.lane = 420;
    cpu.x = 500;
    cpu.lane = 490;
    expect(getBrawlCompanionInput(sim)).toMatchObject({ left: true, up: true, guard: false });

    cpu.x = 350;
    cpu.lane = 440;
    expect(getBrawlCompanionInput(sim)).toMatchObject({ guard: true });
  });

  it('does not auto-clear the hard route without player skill', () => {
    const sim = new BrawlSimulation(['CPU 1', 'CPU 2']);
    sim.start();
    for (let tick = 0; tick < 6_000 && sim.outcome === 'playing'; tick += 1) {
      sim.step(
        getBrawlCompanionInput(sim, 0),
        getBrawlCompanionInput(sim, 1),
      );
    }
    expect(sim.outcome).toBe('lost');
    expect(sim.activeEncounterIndex).toBe(sim.map.encounters.length - 1);
    expect(sim.progressX).toBeLessThan(sim.map.exitX);
  });
});
