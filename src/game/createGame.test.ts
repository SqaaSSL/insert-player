import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const instances = vi.hoisted(() => [] as any[]);
vi.mock('phaser', () => ({ default: {
  AUTO: 'AUTO', Scale: { NONE: 'NONE', FIT: 'FIT', CENTER_BOTH: 'CENTER_BOTH' },
  Game: class {
    scale = { resize: vi.fn(), refresh: vi.fn() };
    events = { once: vi.fn() };
    constructor(public config: unknown) { instances.push(this); }
  },
} }));
vi.mock('./scenes/BootScene.ts', () => ({ BootScene: class {} }));
vi.mock('./scenes/FightScene.ts', () => ({ FightScene: class {} }));
vi.mock('./scenes/RushScene.ts', () => ({ RushScene: class {} }));
vi.mock('./scenes/AuraScene.ts', () => ({ AuraScene: class {} }));
import { createGame } from './createGame.ts';

let viewport: EventTarget & { innerWidth: number; innerHeight: number; matchMedia: ReturnType<typeof vi.fn> };
beforeEach(() => {
  instances.length = 0;
  viewport = Object.assign(new EventTarget(), { innerWidth: 390, innerHeight: 844, matchMedia: vi.fn(() => ({ matches: false })) });
  vi.stubGlobal('window', viewport);
});
afterEach(() => vi.unstubAllGlobals());

describe('Aura responsive runtime ownership', () => {
  it('resizes the existing canvas and cleans its listener without recreating the game', () => {
    const game = createGame('game-container', { sceneKey: 'AuraScene', data: {} });
    expect(instances[0].config).toMatchObject({ width: 576, height: 1024, scale: { mode: 'NONE', expandParent: false } });
    viewport.innerWidth = 844; viewport.innerHeight = 390;
    viewport.dispatchEvent(new Event('resize'));
    expect(game.scale.resize).toHaveBeenCalledExactlyOnceWith(1024, 576);
    viewport.dispatchEvent(new Event('resize'));
    expect(game.scale.refresh).toHaveBeenCalledOnce();
    expect(instances).toHaveLength(1);
    const [event, dispose] = instances[0].events.once.mock.calls[0];
    expect(event).toBe('destroy');
    dispose();
    viewport.innerWidth = 390; viewport.innerHeight = 844;
    viewport.dispatchEvent(new Event('resize'));
    expect(game.scale.resize).toHaveBeenCalledTimes(1);
  });
  it.each(['FightScene', 'RushScene'] as const)('preserves %s landscape dimensions and desktop FIT', sceneKey => {
    createGame('game-container', { sceneKey, data: {} });
    expect(instances[0].config).toMatchObject({ width: 1024, height: 576, scale: { mode: 'FIT', expandParent: true } });
    expect(instances[0].events.once).not.toHaveBeenCalled();
  });
  it('preserves Fight touch CSS-fit behavior', () => {
    viewport.matchMedia.mockReturnValue({ matches: true });
    createGame('game-container', { sceneKey: 'FightScene', data: {} });
    expect(instances[0].config).toMatchObject({ width: 1024, height: 576, scale: { mode: 'NONE' } });
  });
});
