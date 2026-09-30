import { describe, expect, it, vi } from 'vitest';
import {
  AMBILIGHT_SAMPLE_HEIGHT,
  AMBILIGHT_SAMPLE_WIDTH,
  ambilightEnabled,
  attachStageAmbilight,
  shouldSampleAmbilightFrame,
} from './stageAmbilight.ts';

describe('stage ambilight', () => {
  it('lights only the desktop combat shells and never under reduced motion', () => {
    expect(ambilightEnabled({ sceneKey: 'FightScene', coarsePointer: false, reducedMotion: false })).toBe(true);
    expect(ambilightEnabled({ sceneKey: 'RushScene', coarsePointer: false, reducedMotion: false })).toBe(true);
    expect(ambilightEnabled({ sceneKey: 'AuraScene', coarsePointer: false, reducedMotion: false })).toBe(false);
    expect(ambilightEnabled({ sceneKey: 'FightScene', coarsePointer: true, reducedMotion: false })).toBe(false);
    expect(ambilightEnabled({ sceneKey: 'FightScene', coarsePointer: false, reducedMotion: true })).toBe(false);
  });

  it('samples one frame in six', () => {
    const sampled = Array.from({ length: 18 }, (_, index) => index + 1).filter(frame => shouldSampleAmbilightFrame(frame));
    expect(sampled).toEqual([6, 12, 18]);
  });

  it('copies the game canvas on post-render at the sampling interval, skips hidden tabs and detaches cleanly', () => {
    const handlers = new Map<string, () => void>();
    const canvas = {} as CanvasImageSource;
    const game = {
      canvas,
      events: {
        on: vi.fn((event: string, handler: () => void) => { handlers.set(event, handler); }),
        off: vi.fn((event: string) => { handlers.delete(event); }),
      },
    };
    const surface = { drawImage: vi.fn() };
    let hidden = false;
    const onFirstFrame = vi.fn();
    const detach = attachStageAmbilight(game, surface, { interval: 3, isHidden: () => hidden, onFirstFrame });
    const postRender = handlers.get('postrender');
    expect(postRender).toBeTypeOf('function');

    for (let i = 0; i < 6; i++) postRender!();
    expect(surface.drawImage).toHaveBeenCalledTimes(2);
    expect(surface.drawImage).toHaveBeenLastCalledWith(canvas, 0, 0, AMBILIGHT_SAMPLE_WIDTH, AMBILIGHT_SAMPLE_HEIGHT);
    expect(onFirstFrame).toHaveBeenCalledTimes(1);

    hidden = true;
    for (let i = 0; i < 6; i++) postRender!();
    expect(surface.drawImage).toHaveBeenCalledTimes(2);

    detach();
    expect(game.events.off).toHaveBeenCalledWith('postrender', postRender);
    expect(handlers.has('postrender')).toBe(false);
  });

  it('keeps the match alive when the canvas cannot be read', () => {
    const handlers = new Map<string, () => void>();
    const game = {
      canvas: {} as CanvasImageSource,
      events: { on: (event: string, handler: () => void) => { handlers.set(event, handler); }, off: () => undefined },
    };
    const onFirstFrame = vi.fn();
    attachStageAmbilight(game, { drawImage: () => { throw new Error('tainted'); } }, { interval: 1, isHidden: () => false, onFirstFrame });
    expect(() => handlers.get('postrender')!()).not.toThrow();
    expect(onFirstFrame).not.toHaveBeenCalled();
  });
});
