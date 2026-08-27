import { describe, expect, it, vi } from 'vitest';
import { FighterState, GROUND_Y } from '../constants.ts';

vi.mock('phaser', () => ({
  default: { BlendModes: { MULTIPLY: 'multiply' } },
}));

import { Fighter } from './Fighter.ts';
import { createSpriteLayout, registerSpriteLayout } from '../sprites/SpriteGenerator.ts';

function createMockSprite() {
  return {
    x: 0,
    y: 0,
    originX: 0.5,
    originY: 0.5,
    scale: 1,
    flipX: false,
    frame: 0,
    setOrigin(x: number, y: number) {
      this.originX = x;
      this.originY = y;
      return this;
    },
    setScale(scale: number) {
      this.scale = scale;
      return this;
    },
    setFlipX(flipped: boolean) {
      this.flipX = flipped;
      return this;
    },
    setPosition(x: number, y: number) {
      this.x = x;
      this.y = y;
      return this;
    },
    setY(y: number) {
      this.y = y;
      return this;
    },
    setFrame(frame: number) {
      this.frame = frame;
      return this;
    },
    setTint() { return this; },
    setAlpha() { return this; },
    setBlendMode() { return this; },
    setDepth() { return this; },
  };
}

function createMockScene() {
  const sprites: ReturnType<typeof createMockSprite>[] = [];
  return {
    sprites,
    scene: {
      add: {
        sprite(x: number, y: number) {
          const sprite = createMockSprite();
          sprite.x = x;
          sprite.y = y;
          sprites.push(sprite);
          return sprite;
        },
      },
    },
  };
}

describe('fighter sprite presentation', () => {
  it('composes an action profile with stage presentation and mirrored facing', () => {
    const spriteKey = 'profiled-fighter';
    registerSpriteLayout(spriteKey, createSpriteLayout({}, {}, {}, {
      [FighterState.IDLE]: { scale: 1.25, originX: 0.37, originY: 0.92, offsetY: -6 },
      [FighterState.LOW_PUNCH]: { scale: 1.1, originX: 0.44, originY: 0.9, offsetY: -4 },
    }));
    const fighter = new Fighter(1, 'Profiled', spriteKey, 250, false);
    const { scene, sprites } = createMockScene();

    fighter.createSprite(scene as never);
    fighter.setRenderPresentation(1.2, 18);
    fighter.syncSprite(100);

    const [shadow, sprite] = sprites;
    expect(sprite.originX).toBeCloseTo(0.63);
    expect(sprite.originY).toBe(0.92);
    expect(sprite.scale).toBeCloseTo(1.5);
    expect(sprite.flipX).toBe(true);
    expect(sprite.x).toBe(250);
    expect(sprite.y).toBeCloseTo(GROUND_Y + 18 - 6 * 1.2);
    expect(shadow.originX).toBeCloseTo(sprite.originX);
    expect(shadow.originY).toBe(sprite.originY);
    expect(shadow.scale).toBeCloseTo(sprite.scale * 1.015);

    fighter.facingRight = true;
    fighter.forceState(FighterState.LOW_PUNCH);
    fighter.syncSprite(100);

    expect(sprite.originX).toBeCloseTo(0.44);
    expect(sprite.originY).toBe(0.9);
    expect(sprite.scale).toBeCloseTo(1.1 * 1.2);
    expect(sprite.flipX).toBe(false);
    expect(sprite.y).toBeCloseTo(GROUND_Y + 18 - 4 * 1.2);
    expect(shadow.originX).toBeCloseTo(sprite.originX);
    expect(shadow.flipX).toBe(false);
  });

  it('leaves legacy presentation behavior unchanged', () => {
    const spriteKey = 'legacy-fighter';
    registerSpriteLayout(spriteKey, createSpriteLayout());
    const fighter = new Fighter(0, 'Legacy', spriteKey, 250, true);
    const { scene, sprites } = createMockScene();

    fighter.createSprite(scene as never);
    fighter.setRenderPresentation(1.03, 0);
    fighter.syncSprite(500);

    const [, sprite] = sprites;
    expect(sprite.originX).toBe(0.5);
    expect(sprite.originY).toBe(1);
    expect(sprite.scale).toBe(1.03);
    expect(sprite.flipX).toBe(false);
    expect(sprite.x).toBe(250);
    expect(sprite.y).toBe(GROUND_Y);
  });

  it('keeps the same logical size for a 2x texture atlas', () => {
    const spriteKey = 'retina-fighter';
    registerSpriteLayout(spriteKey, createSpriteLayout({}, {}, {}, {
      [FighterState.IDLE]: { scale: 1.25, originX: 0.37, originY: 0.92, offsetY: -6 },
    }, 2));
    const fighter = new Fighter(0, 'Retina', spriteKey, 250, true);
    const { scene, sprites } = createMockScene();

    fighter.createSprite(scene as never);
    fighter.setRenderPresentation(1.2, 0);
    fighter.syncSprite(500);

    const [, sprite] = sprites;
    expect(sprite.scale).toBeCloseTo(1.25 * 1.2 / 2);
    expect(sprite.originX).toBeCloseTo(0.37);
    expect(sprite.y).toBeCloseTo(GROUND_Y - 6 * 1.2);
  });
});
