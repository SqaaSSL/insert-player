import { describe, expect, it, vi } from 'vitest';
import { FighterState, GROUND_Y } from '../constants.ts';

vi.mock('phaser', () => ({
  default: { BlendModes: { MULTIPLY: 'multiply' } },
}));

import { Fighter } from './Fighter.ts';
import { FighterView } from './FighterView.ts';
import { createSpriteLayout, registerSpriteLayout } from '../sprites/SpriteGenerator.ts';
import { StateHasher } from '../sim/StateHasher.ts';

function digest(fighter: Fighter): number {
  const hasher = new StateHasher();
  fighter.hashInto(hasher);
  return hasher.digest();
}

function createMockSprite() {
  return {
    x: 0,
    y: 0,
    originX: 0.5,
    originY: 0.5,
    scale: 1,
    scaleX: 1,
    scaleY: 1,
    flipX: false,
    frame: 0 as unknown,
    setOrigin(x: number, y: number) {
      this.originX = x;
      this.originY = y;
      return this;
    },
    setScale(scale: number) {
      this.scale = scale;
      this.scaleX = scale;
      this.scaleY = scale;
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
    setFrame(frame: unknown) {
      this.frame = frame;
      return this;
    },
    getTopCenter() {
      return { x: this.x, y: this.y };
    },
    setTint() { return this; },
    setAlpha() { return this; },
    setBlendMode() { return this; },
    setDepth() { return this; },
    destroy() {},
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
    const fighter = new Fighter(1, 'Profiled', 250, false);
    const view = new FighterView(fighter, spriteKey);
    const { scene, sprites } = createMockScene();

    view.createSprite(scene as never);
    view.setRenderPresentation(1.2, 18);
    view.syncSprite(100);

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
    expect(shadow.y - sprite.y).toBe(11);
    expect(view.getRenderY()).toBe(GROUND_Y + 18);

    view.syncSprite(100, 64);

    expect(sprite.y).toBeCloseTo(GROUND_Y + 18 - 6 * 1.2 - 64);
    expect(shadow.y).toBeCloseTo(sprite.y + 11);

    fighter.facingRight = true;
    fighter.forceState(FighterState.LOW_PUNCH);
    view.syncSprite(100);

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
    const fighter = new Fighter(0, 'Legacy', 250, true);
    const view = new FighterView(fighter, spriteKey);
    const { scene, sprites } = createMockScene();

    view.createSprite(scene as never);
    view.setRenderPresentation(1.03, 0);
    view.syncSprite(500);

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
    const fighter = new Fighter(0, 'Retina', 250, true);
    const view = new FighterView(fighter, spriteKey);
    const { scene, sprites } = createMockScene();

    view.createSprite(scene as never);
    view.setRenderPresentation(1.2, 0);
    view.syncSprite(500);

    const [, sprite] = sprites;
    expect(sprite.scale).toBeCloseTo(1.25 * 1.2 / 2);
    expect(sprite.originX).toBeCloseTo(0.37);
    expect(sprite.y).toBeCloseTo(GROUND_Y - 6 * 1.2);
  });

  it('anchors overhead UI to the visible pixels and mirrors the anchor with the sprite', () => {
    const fighter = new Fighter(0, 'Visible', 100, true);
    const view = new FighterView(fighter, 'visible-fighter');
    const { scene, sprites } = createMockScene();
    view.createSprite(scene as never);

    const pixels = new Uint8ClampedArray(8 * 8 * 4);
    for (let y = 2; y <= 6; y += 1) {
      for (let x = 1; x <= 3; x += 1) pixels[(y * 8 + x) * 4 + 3] = 255;
    }
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          clearRect() {},
          drawImage() {},
          getImageData: () => ({ data: pixels }),
        }),
      }),
    });

    const [, sprite] = sprites;
    sprite.x = 100;
    sprite.y = 200;
    sprite.originX = 0.5;
    sprite.originY = 1;
    sprite.scaleX = 2;
    sprite.scaleY = 2;
    sprite.frame = {
      cutX: 0,
      cutY: 0,
      cutWidth: 8,
      cutHeight: 8,
      source: { image: {} },
    };

    expect(view.getVisibleTopCenter()).toEqual({ x: 97, y: 188 });
    sprite.flipX = true;
    expect(view.getVisibleTopCenter()).toEqual({ x: 103, y: 188 });
    vi.unstubAllGlobals();
  });
});

describe('fighter simulation snapshot', () => {
  it('round-trips every field that affects a move outcome', () => {
    const fighter = new Fighter(0, 'Snap', 300, true);
    const holdDown = { left: false, right: false, up: false, down: true, guard: false, punch: false, kick: false, fireball: false, uppercut: false, super: false };
    const pressPunch = { ...holdDown, down: false, right: true, punch: true };
    // Feed a motion so the ring buffer and press buffer both hold state.
    for (let i = 0; i < 6; i++) fighter.update(1 / 60, holdDown, 600);
    fighter.update(1 / 60, pressPunch, 600);
    fighter.update(1 / 60, { ...pressPunch, punch: false, kick: true }, 600);

    const snap = fighter.snapshot();
    const before = digest(fighter);
    const other = new Fighter(0, 'Snap', 0, false);
    other.restore(snap);

    expect(other.snapshot()).toEqual(snap);
    expect(digest(other)).toBe(before);
    expect(other.state).toBe(fighter.state);
    expect(other.stateFrame).toBe(fighter.stateFrame);

    // Snapshots are decoupled copies, not shared references.
    fighter.update(1 / 60, holdDown, 600);
    expect(other.snapshot()).toEqual(snap);
  });
});
