import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FighterState, GROUND_Y } from '../constants.ts';
import { createSpriteLayout, registerSpriteLayout } from '../sprites/SpriteGenerator.ts';
import { Fighter } from './Fighter.ts';
import { FighterView } from './FighterView.ts';

vi.mock('phaser', () => ({ default: {} }));

let sampledPixels: Uint8ClampedArray;
const drawImage = vi.fn((image: { pixels: Uint8ClampedArray }) => { sampledPixels = image.pixels; });

function sourceFrame(height: number, density: number, bottom = 235) {
  const width = 192 * density, frameHeight = 256 * density;
  const pixels = new Uint8ClampedArray(width * frameHeight * 4);
  const minY = (bottom + 1 - height) * density, maxY = (bottom + 1) * density - 1;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = 50 * density; x < 100 * density; x += 1) pixels[(y * width + x) * 4 + 3] = 255;
  }
  return { cutWidth: width, cutHeight: frameHeight, cutX: 0, cutY: 0, source: { image: { pixels } } };
}

function setup(density = 1, dense = true) {
  const spriteKey = `idle-body-${density}-${dense}`;
  const profile = { scale: 1.15, originX: 0.37, originY: ((235 + 1) * density - 1) / (256 * density), offsetY: -6 };
  registerSpriteLayout(spriteKey, createSpriteLayout({ [FighterState.IDLE]: 3 }, {}, {}, dense ? {
    [FighterState.IDLE]: profile,
    [FighterState.CROUCH]: { scale: 0.45, originX: 0.61, originY: 0.8, offsetY: -20 },
  } : {}, density));
  const fighter = new Fighter(0, 'Reference', 250, true);
  const view = new FighterView(fighter, spriteKey);
  const frames = [190, 200, 210].map(height => sourceFrame(height, density));
  const sprite = {
    texture: { get: vi.fn((index: number) => frames[index]) },
    displayHeight: 9000,
    setOrigin: vi.fn().mockReturnThis(), setFlipX: vi.fn().mockReturnThis(),
    setScale: vi.fn().mockReturnThis(), setY: vi.fn().mockReturnThis(),
  };
  view.sprite = sprite as never;
  return { view, fighter, sprite, frames };
}

describe('FighterView stable idle body reference', () => {
  beforeEach(() => {
    drawImage.mockClear();
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0,
      getContext: () => ({ clearRect() {}, drawImage, getImageData: () => ({ data: sampledPixels }) }),
    }) });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('uses median visible idle height and its actual dense foot offset, not the full cell', () => {
    const { view, fighter } = setup();
    view.setRenderPresentation(1.2, 18);
    const before = fighter.snapshot();
    const reference = view.getIdleBodyReference();
    expect(reference.height).toBeCloseTo(200 * 1.15 * 1.2);
    expect(reference.rootX).toBe(250);
    expect(reference.rootY).toBeCloseTo(GROUND_Y + 18 - 6 * 1.2 + 1.15 * 1.2);
    expect(fighter.snapshot()).toEqual(before);
  });

  it('remains unchanged through action, frame, facing and mutable sprite-size changes', () => {
    const { view, fighter, sprite } = setup();
    view.setRenderPresentation(1.2, 18);
    const reference = view.getIdleBodyReference();
    fighter.forceState(FighterState.CROUCH);
    fighter.facingRight = false;
    fighter.stateFrame = 5;
    sprite.displayHeight = 7;
    expect(view.getIdleBodyReference()).toEqual(reference);
    expect(sprite.texture.get).toHaveBeenCalledTimes(3); // one idle measurement, not each tick
  });

  it('gives equal world height and exact physical bottom for 1x and 4x densities', () => {
    const low = setup(1).view, high = setup(4).view;
    low.setRenderPresentation(1.25, -12);
    high.setRenderPresentation(1.25, -12);
    const lowBody = low.getIdleBodyReference(), highBody = high.getIdleBodyReference();
    expect(highBody.height).toBe(lowBody.height);
    expect(highBody.rootX).toBe(lowBody.rootX);
    // Fight's pivot uses inclusive maxY. The visible pixel extends one native
    // pixel below it; physical-bottom alignment retains this subpixel extent.
    expect(lowBody.rootY).toBeCloseTo(GROUND_Y - 12 - 6 * 1.25 + 1.15 * 1.25);
    expect(highBody.rootY).toBeCloseTo(GROUND_Y - 12 - 6 * 1.25 + 1.15 * 1.25 / 4);
    expect(Math.abs(highBody.rootY - lowBody.rootY)).toBeLessThan(1.15 * 1.25);
  });

  it('retains the real idle-foot margin for a legacy bottom-origin sheet', () => {
    const { view } = setup(1, false);
    view.setRenderPresentation(1.2, 18);
    const reference = view.getIdleBodyReference();
    expect(reference.height).toBe(240);
    expect(reference.rootY).toBeCloseTo(GROUND_Y + 18 + (236 - 256) * 1.2);
  });

  it('follows world translation and stage presentation without remeasuring the idle', () => {
    const { view, fighter, sprite } = setup();
    const first = view.getIdleBodyReference();
    fighter.x += 30; fighter.y -= 45;
    view.setRenderPresentation(2, 10);
    const second = view.getIdleBodyReference();
    expect(second.height).toBeCloseTo(first.height * 2);
    expect(second.rootX).toBe(280);
    expect(second.rootY).toBeCloseTo(GROUND_Y - 45 + 10 - 12 + 1.15 * 2);
    expect(sprite.texture.get).toHaveBeenCalledTimes(3);
  });

  it('uses a stable idle-profile fallback before textures are available', () => {
    const { view, fighter } = setup(4);
    view.sprite = undefined as never;
    view.setRenderPresentation(1.2, 18);
    const before = view.getIdleBodyReference();
    fighter.forceState(FighterState.CROUCH);
    expect(view.getIdleBodyReference()).toEqual(before);
    expect(before.height).toBeCloseTo(256 * 1.15 * 1.2);
    expect(before.rootY).toBeCloseTo(GROUND_Y + 18 - 6 * 1.2);
  });
});
