import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('phaser', () => ({ default: {} }));
import { AuraPerformanceView } from './AuraPerformanceView.ts';
import { AURA_PERFORMANCE_DEFINITIONS } from './AuraPerformance.ts';
import type { AuraAnimationName } from '../../services/FighterAssetPacks.ts';

function gameObject() {
  return {
    x: 250, y: 500, displayHeight: 300, flipX: false, alpha: 0.82, depth: 8,
    clearTint: vi.fn().mockReturnThis(), setAngle: vi.fn().mockReturnThis(),
    setTint: vi.fn().mockReturnThis(), setTintFill: vi.fn().mockReturnThis(),
    setTexture: vi.fn().mockReturnThis(), setVisible: vi.fn().mockReturnThis(),
    setOrigin: vi.fn().mockReturnThis(),
    setFrame: vi.fn().mockReturnThis(), setPosition: vi.fn().mockReturnThis(),
    setFlipX: vi.fn().mockReturnThis(), setScale: vi.fn().mockReturnThis(),
    setAlpha: vi.fn().mockReturnThis(), setDepth: vi.fn().mockReturnThis(),
    destroy: vi.fn(),
  };
}

function harness() {
  const sprite = gameObject();
  const body = { height: 230.4, rootX: 250, rootY: 494 };
  const base = { sprite: gameObject(), shadowSprite: gameObject(), getRenderY: () => 500,
    getIdleBodyReference: vi.fn(() => ({ ...body })) };
  const calibration = { referenceBodyHeight: 220, frames: Array.from({ length: 24 }, () => ({
    scale: 1, originX: 0.4, originY: 239 / 256, offsetX: 0, offsetY: 0,
  })) };
  const view = Object.assign(Object.create(AuraPerformanceView.prototype), {
    pack: { animations: new Map([['aura_six_seven', { name: 'aura_six_seven', textureKey: 'aura-pack', frameCount: 24, frameHeight: 256, calibration }]]) },
    sprite, shadow: gameObject(), activeName: null, elapsedMs: 0,
    resting: false,
  });
  return { view, sprite, base, body, calibration };
}

describe('Aura visible performance layer', () => {
  it('keeps the winner’s own one-leg animation looping through the finale at its calibrated anchor', () => {
    const { view, sprite, base, calibration } = harness();
    const ownTexture = 'official-player-own-one-leg';
    view.pack.animations.set('aura_one_leg', { name: 'aura_one_leg', textureKey: ownTexture,
      frameWidth: 256, frameHeight: 256, frameCount: 8,
      calibration: { ...calibration, frames: calibration.frames.slice(0, 8) } });
    expect(view.playFinale(true)).toBe(true);
    expect(sprite.setTexture).toHaveBeenLastCalledWith(ownTexture, 0);
    const duration = AURA_PERFORMANCE_DEFINITIONS.aura_one_leg.durationMs;
    view.update(duration / 2, base);
    expect(sprite.setFrame).toHaveBeenLastCalledWith(4);
    view.update(duration, base);
    expect(sprite.setFrame).toHaveBeenLastCalledWith(4);
    view.update(duration / 2, base);
    expect(sprite.setFrame).toHaveBeenLastCalledWith(0);
    expect(sprite.setPosition).toHaveBeenLastCalledWith(250, 494);
    expect(sprite.setScale).toHaveBeenLastCalledWith(230.4 / 220);
    expect(base.sprite.setVisible.mock.calls.every(([visible]) => visible === false)).toBe(true);
    expect(sprite.setTexture.mock.calls.every(([key]) => key === ownTexture)).toBe(true);
  });

  it('plays the loser’s own shrug once and holds its final pose instead of restarting at the loop boundary', () => {
    const { view, sprite, base, calibration } = harness();
    const ownTexture = 'official-player-own-shrug';
    view.pack.animations.set('aura_shrug', { name: 'aura_shrug', textureKey: ownTexture,
      frameWidth: 192, frameHeight: 256, frameCount: 8,
      calibration: { ...calibration, frames: calibration.frames.slice(0, 8) } });
    view.play('aura_six_seven'); view.update(600, base);
    expect(view.playFinale(false)).toBe(true);
    expect(view.elapsedMs).toBe(0);
    expect(sprite.setTexture).toHaveBeenLastCalledWith(ownTexture, 0);
    const duration = AURA_PERFORMANCE_DEFINITIONS.aura_shrug.durationMs;
    view.update(duration / 2, base);
    expect(sprite.setFrame).toHaveBeenLastCalledWith(4);
    for (const delta of [duration / 2, duration, 10_000]) {
      view.update(delta, base);
      expect(sprite.setFrame).toHaveBeenLastCalledWith(7);
      expect(base.sprite.setVisible).toHaveBeenLastCalledWith(false);
    }
    expect(sprite.setTint).not.toHaveBeenCalled();
    expect(sprite.setTintFill).not.toHaveBeenCalled();
    expect(sprite.setAngle).not.toHaveBeenCalled();
  });

  it.each([true, false])('preserves Aura identity for partial packs in the finale, won=%s', won => {
    for (const name of ['aura_glide', 'aura_floor_worm', 'aura_six_seven', 'aura_one_leg', 'aura_unbothered'] as AuraAnimationName[]) {
      const { view, sprite, base, calibration } = harness();
      view.pack.animations.clear();
      view.pack.animations.set(name, { name, textureKey: `same-owner-${name}`,
        frameWidth: 192, frameHeight: 256, frameCount: 8,
        calibration: { ...calibration, frames: calibration.frames.slice(0, 8) } });
      expect(view.playFinale(won), `partial ${name} pack`).toBe(true);
      view.update(AURA_PERFORMANCE_DEFINITIONS[name].durationMs * 1.5, base);
      expect(sprite.setTexture).toHaveBeenLastCalledWith(`same-owner-${name}`, 0);
      expect(sprite.setFrame).toHaveBeenLastCalledWith(won ? 4 : 7);
      expect(base.sprite.setVisible).toHaveBeenLastCalledWith(false);
    }
  });

  it('signals combat fallback only when no Aura animation remains available', () => {
    const { view, sprite, base } = harness();
    view.pack.animations.clear();
    expect(view.playFinale(true)).toBe(false);
    expect(view.playFinale(false)).toBe(false);
    view.update(100, base);
    expect(base.sprite.setVisible).toHaveBeenLastCalledWith(true);
    expect(sprite.setTexture).not.toHaveBeenCalled();
  });

  it('actually renders the chosen pack and hides the base fighter at the same stage anchor/scale', () => {
    const { view, sprite, base } = harness();
    expect(view.play('aura_six_seven')).toBe(true);
    view.update(0, base);
    expect(sprite.setTexture).toHaveBeenCalledWith('aura-pack', 0);
    expect(base.sprite.setVisible).toHaveBeenCalledWith(false);
    expect(sprite.setPosition).toHaveBeenCalledWith(250, 494);
    expect(sprite.setScale).toHaveBeenCalledWith(230.4 / 220);
    expect(sprite.setOrigin).toHaveBeenCalledWith(0.4, 239 / 256);
    expect(sprite.setAlpha).toHaveBeenCalledWith(0.82);
  });

  it('never tints or rotates either sprite for white or red legacy feedback', () => {
    const { view, sprite, base } = harness();
    view.play('aura_six_seven');
    for (const color of [0xffffff, 0xfff4d6, 0xff8f9a, 0xff0000]) {
      expect(view.flash(color, 100)).toBe(true);
      view.update(16, base);
    }
    for (const object of [sprite, base.sprite]) {
      expect(object.setTintFill).not.toHaveBeenCalled();
      expect(object.setTint).not.toHaveBeenCalled();
      expect(object.setAngle).not.toHaveBeenCalled();
    }
    expect(sprite.setPosition.mock.calls.every(call => call[0] === 250 && call[1] === 494)).toBe(true);
    expect(view.activeName).toBe('aura_six_seven');
  });

  it('does not restart the dance on repeated notes or milestone flashes', () => {
    const { view, base } = harness();
    view.play('aura_six_seven');
    view.update(500, base);
    view.flash(0xfff4d6, 100);
    view.play('aura_six_seven');
    view.update(20, base);
    expect(view.elapsedMs).toBe(520);
    expect(view.activeName).toBe('aura_six_seven');
  });

  it('rejects unavailable animation without discarding the current identity', () => {
    const { view } = harness();
    expect(view.flash(0xffffff)).toBe(false);
    view.play('aura_six_seven');
    expect(view.play('aura_glide')).toBe(false);
    expect(view.activeName).toBe('aura_six_seven');
    expect(view.firstRoutineAnimation()).toBe('aura_six_seven');
  });

  it('falls back to the base idle when a partial pack has no neutral, never another dance', () => {
    const { view, sprite, base } = harness();
    view.play('aura_six_seven'); view.update(500, base);
    expect(view.playResting()).toBe(false);
    view.update(500, base);
    expect(view.activeName).toBeNull();
    expect(view.elapsedMs).toBe(0);
    expect(sprite.setVisible).toHaveBeenLastCalledWith(false);
    expect(view.shadow.setVisible).toHaveBeenLastCalledWith(false);
    expect(base.sprite.setVisible).toHaveBeenLastCalledWith(true);
    expect(base.shadowSprite.setVisible).toHaveBeenLastCalledWith(true);
  });

  it('holds the same calibrated neutral frame indefinitely without consuming playback time', () => {
    const { view, sprite, base, calibration } = harness();
    view.pack.animations.set('aura_unbothered', { textureKey: 'aura-idle', frameCount: 24, frameHeight: 256, calibration });
    expect(view.playResting()).toBe(true);
    expect(view.activeName).toBe('aura_unbothered');
    for (const delta of [0, 16, 1_000, 60_000]) view.update(delta, base);
    expect(view.elapsedMs).toBe(0);
    expect(sprite.setFrame.mock.calls.every(call => call[0] === 0)).toBe(true);
    expect(sprite.setScale).toHaveBeenLastCalledWith(230.4 / 220);
    expect(sprite.setPosition).toHaveBeenLastCalledWith(250, 494);
    expect(sprite.setOrigin).toHaveBeenLastCalledWith(0.4, 239 / 256);
    expect(base.sprite.setVisible).toHaveBeenLastCalledWith(false);
  });

  it('restarts active playback from the neutral hold, including the same animation name', () => {
    const { view, sprite, base, calibration } = harness();
    view.pack.animations.set('aura_unbothered', { textureKey: 'aura-idle', frameCount: 24, frameHeight: 256, calibration });
    view.play('aura_unbothered'); view.update(500, base);
    expect(sprite.setFrame.mock.lastCall![0]).toBeGreaterThan(0);
    view.playResting(); view.update(10_000, base);
    expect(sprite.setFrame).toHaveBeenLastCalledWith(0);
    expect(view.elapsedMs).toBe(0);
    view.play('aura_unbothered'); view.update(500, base);
    expect(view.elapsedMs).toBe(500);
    expect(sprite.setFrame.mock.lastCall![0]).toBeGreaterThan(0);
    view.play('aura_unbothered'); view.update(20, base);
    expect(view.elapsedMs).toBe(520);
    view.playResting(); view.update(10_000, base);
    view.play('aura_six_seven'); view.update(20, base);
    expect(view.elapsedMs).toBe(20);
    expect(view.activeName).toBe('aura_six_seven');
  });

  it('handles legacy miss interruptions without red tint, rotation or extra translation', () => {
    const { view, sprite, base, calibration } = harness();
    calibration.frames[0] = { scale: 0.8, originX: 0.3, originY: 0.75, offsetX: 22, offsetY: -44 };
    view.pack.animations.set('aura_unbothered', { textureKey: 'aura-idle', frameCount: 24, frameHeight: 256, calibration });
    view.play('aura_six_seven'); view.update(500, base);
    view.interrupt(base, true);
    const expected = [250 + 22 * 230.4 / 220, 494 - 44 * 230.4 / 220];
    for (const delta of [16, 70, 200, 1_000]) {
      view.update(delta, base);
      expect(sprite.setPosition.mock.lastCall).toEqual(expected);
      expect(sprite.setScale).toHaveBeenLastCalledWith(230.4 / 220 * 0.8);
    }
    expect(sprite.setTint).not.toHaveBeenCalled();
    expect(sprite.setTintFill).not.toHaveBeenCalled();
    expect(sprite.setAngle).not.toHaveBeenCalled();
    expect(view.elapsedMs).toBe(0);
    view.interrupt(base);
    expect(base.sprite.setVisible).toHaveBeenLastCalledWith(true);
    expect(sprite.setVisible).toHaveBeenLastCalledWith(false);
  });

  it('ignores the hidden current action size and preserves the common Fight foot offset', () => {
    const { view, sprite, base } = harness();
    view.play('aura_six_seven');
    view.update(0, base);
    base.sprite.displayHeight = 900;
    view.update(16, base);
    expect(sprite.setScale).toHaveBeenLastCalledWith(230.4 / 220);
    expect(sprite.setPosition).toHaveBeenLastCalledWith(250, 494);
    expect(view.shadow.setPosition).toHaveBeenLastCalledWith(250, 501);
  });

  it('keeps the same size between calibrated actions with different native cells', () => {
    const { view, sprite, base, calibration } = harness();
    view.pack.animations.set('aura_floor_worm', { textureKey: 'wide-floor', frameCount: 8,
      frameWidth: 1536, frameHeight: 1024,
      calibration: { referenceBodyHeight: 880, frames: calibration.frames.slice(0, 8) } });
    view.play('aura_six_seven'); view.update(0, base);
    const initial = sprite.setScale.mock.lastCall![0];
    view.play('aura_floor_worm'); view.update(0, base);
    expect(sprite.setScale.mock.lastCall![0] * 4).toBeCloseTo(initial);
    expect(sprite.setPosition).toHaveBeenLastCalledWith(250, 494);
  });

  it('mirrors asymmetric origins and lateral motion while preserving the root and jump offset', () => {
    const { view, sprite, base, calibration } = harness();
    calibration.frames[0] = { scale: 0.8, originX: 0.3, originY: 0.75, offsetX: 22, offsetY: -44 };
    view.play('aura_six_seven'); view.update(0, base);
    const unit = 230.4 / 220;
    expect(sprite.setOrigin).toHaveBeenLastCalledWith(0.3, 0.75);
    expect(sprite.setScale).toHaveBeenLastCalledWith(unit * 0.8);
    expect(sprite.setPosition).toHaveBeenLastCalledWith(250 + 22 * unit, 494 - 44 * unit);
    base.sprite.flipX = true;
    view.update(0, base);
    expect(sprite.setOrigin).toHaveBeenLastCalledWith(0.7, 0.75);
    expect(sprite.setPosition).toHaveBeenLastCalledWith(250 - 22 * unit, 494 - 44 * unit);
  });

  it('does not inflate an intentionally short pose to the standing height', () => {
    const { view, sprite, base, calibration } = harness();
    // Same registered scale: a 55px horizontal pose should stay one quarter
    // the 220px standing reference. Its own bbox is never used as Hbase.
    view.pack.animations.set('aura_floor_worm', { textureKey: 'floor', frameCount: 8,
      frameWidth: 384, frameHeight: 256,
      calibration: { referenceBodyHeight: 220, frames: calibration.frames.slice(0, 8) } });
    view.play('aura_floor_worm'); view.update(0, base);
    expect(55 * sprite.setScale.mock.lastCall![0]).toBeCloseTo(230.4 / 4);
    expect(sprite.setPosition).toHaveBeenLastCalledWith(250, 494);
  });

  it('applies calibrated 1x and 4x offsets identically without double scaling the pose', () => {
    const low = harness(), high = harness();
    low.calibration.frames[0] = { scale: 0.8, originX: 0.3, originY: 0.75, offsetX: 22, offsetY: -44 };
    high.calibration.referenceBodyHeight *= 4;
    high.calibration.frames[0] = { ...low.calibration.frames[0], offsetX: 88, offsetY: -176 };
    high.view.pack.animations.get('aura_six_seven').frameHeight *= 4;
    for (const h of [low, high]) { h.view.play('aura_six_seven'); h.view.update(0, h.base); }
    expect(high.sprite.setScale.mock.lastCall![0] * 4).toBeCloseTo(low.sprite.setScale.mock.lastCall![0]);
    expect(high.sprite.setPosition.mock.lastCall).toEqual(low.sprite.setPosition.mock.lastCall);
    expect(high.sprite.setOrigin.mock.lastCall).toEqual(low.sprite.setOrigin.mock.lastCall);
  });

  it('keeps an older uncalibrated caller independent of the mutable action size', () => {
    const { view, sprite, base } = harness();
    delete view.pack.animations.get('aura_six_seven').calibration;
    view.play('aura_six_seven'); view.update(0, base);
    base.sprite.displayHeight = 3;
    view.update(0, base);
    expect(sprite.setScale).toHaveBeenLastCalledWith(230.4 / 256);
    expect(sprite.setPosition).toHaveBeenLastCalledWith(250, 494);
  });

  it('uses an explicitly reviewed source frame without changing slot count or playback timing', () => {
    const { view, sprite, base, calibration } = harness();
    Object.assign(calibration.frames[0], { sourceFrame: 7 });
    view.play('aura_six_seven');
    view.update(0, base);
    expect(sprite.setFrame).toHaveBeenLastCalledWith(7);
    expect(view.elapsedMs).toBe(0);
    expect(view.pack.animations.get('aura_six_seven').frameCount).toBe(24);
    view.update(100, base);
    expect(view.elapsedMs).toBe(100);
    expect(sprite.setFrame.mock.lastCall![0]).not.toBe(7);
  });
});

describe('Aura opaque top anchor', () => {
  let sampledPixels: Uint8ClampedArray;
  const drawImage = vi.fn((image: { pixels: Uint8ClampedArray }) => { sampledPixels = image.pixels; });

  function frame(density = 1, left = 68, top = 20, width = 74, height = 219) {
    const cutWidth = 192 * density, cutHeight = 256 * density;
    const pixels = new Uint8ClampedArray(cutWidth * cutHeight * 4);
    for (let y = top * density; y < (top + height) * density; y += 1) {
      for (let x = left * density; x < (left + width) * density; x += 1) {
        pixels[(y * cutWidth + x) * 4 + 3] = 255;
      }
    }
    pixels[3] = 31; // Transparent fringe is excluded by the loader's alpha-32 policy.
    return { cutWidth, cutHeight, cutX: 192 * density, cutY: 256 * density, source: { image: { pixels } } };
  }

  function setup(density = 1, flipX = false) {
    const unit = 200 / 219;
    const sprite = {
      frame: frame(density), visible: true, flipX,
      x: 250 + (flipX ? -9 : 9) * unit, y: 494,
      originX: flipX ? 1 - 105 / 192 : 105 / 192, originY: 239 / 256,
      scaleX: unit / density, scaleY: unit / density,
      getTopCenter: vi.fn(() => ({ x: -100, y: -200 })),
    };
    const view = Object.assign(Object.create(AuraPerformanceView.prototype), {
      sprite, activeName: 'aura_unbothered',
    }) as AuraPerformanceView;
    return { view, sprite, unit };
  }

  beforeEach(() => {
    drawImage.mockReset();
    drawImage.mockImplementation((image: { pixels: Uint8ClampedArray }) => { sampledPixels = image.pixels; });
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0,
      getContext: () => ({ clearRect() {}, drawImage, getImageData: () => ({ data: sampledPixels }) }),
    }) });
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([false, true])('uses the alpha center/top with asymmetric origin, flipX=%s, without recentering the body', flipX => {
    const { view, sprite, unit } = setup(1, flipX);
    const position = { x: sprite.x, y: sprite.y, originX: sprite.originX, originY: sprite.originY };
    expect(view.getVisibleTopCenter()).toEqual({ x: sprite.x, y: 294 });
    expect(sprite.x).toBeCloseTo(250 + (flipX ? -9 : 9) * unit);
    expect(sprite).toMatchObject(position);
    expect(sprite.getTopCenter).not.toHaveBeenCalled();
    expect(drawImage).toHaveBeenCalledWith(sprite.frame.source.image, 192, 256, 192, 256, 0, 0, 192, 256);
  });

  it('caches measured pixels per actual source frame while honoring scale, translation and facing changes', () => {
    const { view, sprite } = setup();
    const first = view.getVisibleTopCenter()!;
    sprite.x += 40; sprite.y -= 10;
    expect(view.getVisibleTopCenter()).toEqual({ x: first.x + 40, y: first.y - 10 });
    sprite.flipX = true; sprite.originX = 1 - sprite.originX;
    expect(view.getVisibleTopCenter()).toEqual({ x: first.x + 40, y: first.y - 10 });
    expect(drawImage).toHaveBeenCalledOnce();
    // Same texture, a different actual frame (also covers reviewed source remaps).
    sprite.frame = frame(1, 40, 80, 100, 159);
    const changed = view.getVisibleTopCenter()!;
    expect(changed.y).toBeCloseTo(sprite.y + (80 - 239) * sprite.scaleY);
    expect(drawImage).toHaveBeenCalledTimes(2);
    view.getVisibleTopCenter();
    expect(drawImage).toHaveBeenCalledTimes(2);
  });

  it('returns identical opaque anchors for 1x and 4x atlases under each facing', () => {
    for (const flipX of [false, true]) {
      const low = setup(1, flipX), high = setup(4, flipX);
      expect(high.view.getVisibleTopCenter()).toEqual(low.view.getVisibleTopCenter());
    }
  });

  it('keeps the previous geometric fallback for an unreadable texture without retrying every frame', () => {
    const { view, sprite } = setup();
    drawImage.mockImplementation(() => { throw new Error('Unreadable texture'); });
    expect(view.getVisibleTopCenter()).toEqual({ x: -100, y: -200 });
    expect(view.getVisibleTopCenter()).toEqual({ x: -100, y: -200 });
    expect(drawImage).toHaveBeenCalledOnce();
    expect(sprite.getTopCenter).toHaveBeenCalledTimes(2);
  });

  it('does not sample or expose an anchor when the Aura performer is hidden or inactive', () => {
    const { view, sprite } = setup();
    sprite.visible = false;
    expect(view.getVisibleTopCenter()).toBeNull();
    sprite.visible = true;
    Object.assign(view, { activeName: null });
    expect(view.getVisibleTopCenter()).toBeNull();
    expect(drawImage).not.toHaveBeenCalled();
  });
});
