import { describe, expect, it, vi } from 'vitest';
import { FIXED_TIMESTEP } from '../constants.ts';
import { BrawlSimulation } from '../brawl/BrawlSimulation.ts';
import { MatchSimulation } from '../sim/MatchSimulation.ts';
import { EMPTY_INPUT } from '../sim/FighterInput.ts';
import type { MatchSceneData } from '../match/MatchConfig.ts';

vi.mock('phaser', () => ({ default: {
  Scene: class {},
  Input: { Keyboard: { KeyCodes: { ENTER: 13, SPACE: 32 }, JustDown: () => false } },
} }));

import { FightScene } from './FightScene.ts';
import { RushScene } from './RushScene.ts';

function createHarness(sceneKey: 'FightScene' | 'RushScene', data: MatchSceneData = { vsAI: true, seed: 23 }) {
  const scene = (sceneKey === 'FightScene' ? new FightScene() : new RushScene()) as unknown as Record<string, any>;
  scene.init(data);
  const sim = sceneKey === 'FightScene'
    ? new MatchSimulation({ seed: 23, vsAI: true, cpuVsCpu: false, p1Name: 'P1', p2Name: 'CPU' })
    : new BrawlSimulation(['P1', 'CPU']);
  const inputs = {
    poll: vi.fn(), reset: vi.fn(),
    readPlayer1: vi.fn(() => EMPTY_INPUT), readPlayer2: vi.fn(() => EMPTY_INPUT),
  };
  const sound = { startBattleMusic: vi.fn() };
  Object.assign(scene, {
    ready: true, sim, inputMgr: inputs, inputManager: inputs, sound_mgr: sound, soundManager: sound,
    input: { keyboard: { addCapture: vi.fn() } },
    introEnterKey: { reset: vi.fn() }, introSpaceKey: { reset: vi.fn() }, jumpKey: { reset: vi.fn() },
    handleSimEvents: vi.fn(), handleEvents: vi.fn(),
    recorder: { recordTick: vi.fn(), sampleChecksum: vi.fn() },
    syncViews: vi.fn(), emitHudState: vi.fn(), shouldSkipIntro: () => false,
    syncPresentations: vi.fn(), syncProjectilePresentations: vi.fn(), syncObstaclePresentations: vi.fn(),
    updateHud: vi.fn(), updateCamera: vi.fn(),
  });
  const start = vi.spyOn(sim, 'start');
  const startEvent = (startToken = scene.startGate.token, key = sceneKey) => ({ detail: { sceneKey: key, startToken } });
  return { scene, sim, inputs, sound, start, startEvent };
}

describe.each(['FightScene', 'RushScene'] as const)('%s player-ready startup', (sceneKey) => {
  it('keeps the CPU, clock and player untouched while the control panel is explored', () => {
    const { scene, sim, inputs, start } = createHarness(sceneKey);
    const initial = sim.snapshot();
    for (let frame = 0; frame < 300; frame += 1) scene.update(frame * 100, 100);
    expect(sim.snapshot()).toEqual(initial);
    expect(inputs.poll).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('starts once after confirmation and drops waiting time and queued controls', () => {
    const { scene, sim, inputs, sound, start, startEvent } = createHarness(sceneKey);
    const event = startEvent();
    scene.update(0, 5_000);
    scene.jumpQueued = true;
    scene.onMatchStart(event);
    scene.onMatchStart(event);
    expect(start).toHaveBeenCalledOnce();
    expect(sound.startBattleMusic).toHaveBeenCalledOnce();
    expect(inputs.reset).toHaveBeenCalledOnce();
    expect(inputs.readPlayer1).toHaveBeenCalledOnce();
    expect(inputs.readPlayer2).toHaveBeenCalledOnce();
    expect(scene.accumulator).toBe(0);
    if (sceneKey === 'RushScene') expect(scene.jumpQueued).toBe(false);
    scene.update(5_000, FIXED_TIMESTEP);
    expect(sim.tick).toBe(1);
  });

  it('rejects premature and wrong-scene confirmations without consuming the token', () => {
    const { scene, start, startEvent } = createHarness(sceneKey);
    const event = startEvent();
    scene.ready = false;
    scene.onMatchStart(event);
    scene.ready = true;
    scene.onMatchStart(startEvent(event.detail.startToken, sceneKey === 'FightScene' ? 'RushScene' : 'FightScene'));
    expect(start).not.toHaveBeenCalled();
    expect(scene.startGate.waiting).toBe(true);
    scene.onMatchStart(event);
    expect(start).toHaveBeenCalledOnce();
  });

  it('requires the new token after a rematch even when the previous run was paused', () => {
    const { scene, start, startEvent } = createHarness(sceneKey);
    const previous = startEvent();
    scene.onMatchStart(previous);
    scene.paused = true;
    scene.init({ vsAI: true, seed: 23 });
    scene.ready = true;
    expect(scene.paused).toBe(false);
    scene.onMatchStart(previous);
    expect(start).toHaveBeenCalledOnce();
    expect(scene.startGate.waiting).toBe(true);
    scene.onMatchStart(startEvent());
    expect(start).toHaveBeenCalledTimes(2);
  });
});
