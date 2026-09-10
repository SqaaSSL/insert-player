import Phaser from 'phaser';
import type { FighterView } from '../fighters/FighterView.ts';
import type { AuraAnimationName } from '../../services/FighterAssetPacks.ts';
import {
  AURA_PERFORMANCE_DEFINITIONS,
  AURA_ROUTINE_ANIMATION_NAMES,
} from './AuraPerformance.ts';
import type { LoadedAuraAnimationPack } from './AuraSpriteLoader.ts';
import { getFacingSpriteOriginX } from '../sprites/SpriteGenerator.ts';

type VisibleBounds = { x: number; y: number; width: number; height: number };
const visibleBoundsCache = new WeakMap<Phaser.Textures.Frame, VisibleBounds | null>();
let measurementCanvas: HTMLCanvasElement | null = null;

/** Measure the actual selected source frame, including reviewed frame remaps.
 * Phaser frames are immutable for a loaded pack, so no pixel reads recur while
 * a pose holds, loops or switches facing. Old textures can be garbage-collected. */
function visibleBounds(frame: Phaser.Textures.Frame): VisibleBounds | null {
  if (visibleBoundsCache.has(frame)) return visibleBoundsCache.get(frame) ?? null;
  let bounds: VisibleBounds | null = null;
  try {
    const width = frame.cutWidth, height = frame.cutHeight;
    if (typeof document !== 'undefined' && Number.isSafeInteger(width) && width > 0
      && Number.isSafeInteger(height) && height > 0) {
      measurementCanvas ??= document.createElement('canvas');
      if (measurementCanvas.width !== width) measurementCanvas.width = width;
      if (measurementCanvas.height !== height) measurementCanvas.height = height;
      const context = measurementCanvas.getContext('2d', { willReadFrequently: true });
      if (context) {
        context.clearRect(0, 0, width, height);
        context.drawImage(frame.source.image as CanvasImageSource,
          frame.cutX, frame.cutY, width, height, 0, 0, width, height);
        const pixels = context.getImageData(0, 0, width, height).data;
        let left = width, top = height, right = -1, bottom = -1;
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            if (pixels[(y * width + x) * 4 + 3] < 32) continue;
            left = Math.min(left, x); top = Math.min(top, y);
            right = Math.max(right, x); bottom = Math.max(bottom, y);
          }
        }
        if (right >= left && bottom >= top) {
          bounds = { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
        }
      }
    }
  } catch {
    // A non-readable texture keeps the previous geometric fallback. Never
    // mutate the texture, calibration, root or gameplay to place a label.
    measurementCanvas = null;
  }
  visibleBoundsCache.set(frame, bounds);
  return bounds;
}

/**
 * Visual-only animation layer used by Aura. The underlying Fighter and its
 * regular FighterView continue updating for placement. Feedback belongs to
 * the UI: it never tints, shakes or rotates the performer's sprite pixels.
 */
export class AuraPerformanceView {
  private readonly pack: LoadedAuraAnimationPack;
  private sprite: Phaser.GameObjects.Sprite;
  private shadow: Phaser.GameObjects.Ellipse;
  private activeName: AuraAnimationName | null = null;
  private elapsedMs = 0;
  private resting = false;
  private holdAtEnd = false;

  constructor(scene: Phaser.Scene, pack: LoadedAuraAnimationPack) {
    this.pack = pack;
    const first = pack.animations.values().next().value;
    if (!first) throw new Error('AuraPerformanceView requires at least one animation');
    this.shadow = scene.add.ellipse(0, 0, 102, 25, 0x000000, 0.34)
      .setVisible(false)
      .setBlendMode(Phaser.BlendModes.MULTIPLY);
    this.sprite = scene.add.sprite(0, 0, first.textureKey, 0)
      .setOrigin(0.5, 1)
      .setVisible(false);
    if (pack.demoTint !== undefined) this.sprite.setTint(pack.demoTint);
  }

  gameObjects(): [Phaser.GameObjects.Ellipse, Phaser.GameObjects.Sprite] {
    return [this.shadow, this.sprite];
  }

  has(name: AuraAnimationName): boolean {
    return this.pack.animations.has(name);
  }

  firstRoutineAnimation(): AuraAnimationName | null {
    for (const name of AURA_ROUTINE_ANIMATION_NAMES) {
      if (this.pack.animations.has(name)) return name;
    }
    return this.pack.animations.has('aura_unbothered')
      ? 'aura_unbothered'
      : this.pack.animations.keys().next().value ?? null;
  }

  /** A neutral hold, never another looping dance while the rival performs. */
  playResting(): boolean {
    if (!this.play('aura_unbothered')) {
      this.activeName = null;
      this.elapsedMs = 0;
      this.resting = false;
      this.sprite.setVisible(false);
      this.shadow.setVisible(false);
      return false;
    }
    this.resting = true;
    this.elapsedMs = 0;
    const neutral = this.pack.animations.get('aura_unbothered')!;
    this.sprite.setFrame(neutral.calibration?.frames[0]?.sourceFrame ?? 0);
    return true;
  }

  play(name: AuraAnimationName): boolean {
    const animation = this.pack.animations.get(name);
    if (!animation) return false;
    if (this.activeName === name && !this.resting) return true;
    this.activeName = name;
    this.elapsedMs = 0;
    this.resting = false;
    this.holdAtEnd = false;
    this.sprite.setTexture(animation.textureKey, 0).setVisible(true);
    this.shadow.setVisible(true);
    return true;
  }

  /** Keep the Aura identity for the final tableau: the winner dances while
   * the loser finishes a shrug and holds it instead of resuming the routine. */
  playFinale(won: boolean): boolean {
    const candidates: AuraAnimationName[] = won
      ? ['aura_one_leg', 'aura_six_seven', 'aura_mog_check', 'aura_unbothered']
      : ['aura_shrug', 'aura_unbothered'];
    const name = candidates.find(candidate => this.has(candidate)) ?? this.firstRoutineAnimation();
    if (!name || !this.play(name)) return false;
    this.elapsedMs = 0;
    this.holdAtEnd = !won;
    return true;
  }

  /** Compatibility only: feedback belongs to the UI, never the sprite pixels. */
  flash(_color: number, _durationMs = 34): boolean {
    return this.activeName !== null;
  }

  interrupt(baseView: FighterView, preserveAuraIdentity = false): void {
    if (preserveAuraIdentity && this.playResting()) {
      this.update(0, baseView);
      return;
    }
    this.activeName = null;
    this.elapsedMs = 0;
    this.resting = false;
    this.sprite.setVisible(false);
    this.shadow.setVisible(false);
    baseView.sprite.setVisible(true);
    baseView.shadowSprite?.setVisible(true);
  }

  update(deltaMs: number, baseView: FighterView): void {
    if (!this.activeName) {
      baseView.sprite.setVisible(true);
      baseView.shadowSprite?.setVisible(true);
      return;
    }
    const animation = this.pack.animations.get(this.activeName);
    if (!animation) {
      this.interrupt(baseView);
      return;
    }

    if (!this.resting) this.elapsedMs += Math.max(0, deltaMs);
    const definition = AURA_PERFORMANCE_DEFINITIONS[this.activeName];
    const progress = definition.loop && !this.holdAtEnd
      ? (this.elapsedMs % definition.durationMs) / definition.durationMs
      : Math.min(1, this.elapsedMs / definition.durationMs);
    const frame = Math.min(animation.frameCount - 1, Math.floor(progress * animation.frameCount));

    const baseSprite = baseView.sprite;
    const body = baseView.getIdleBodyReference();
    const targetHeight = Math.max(1, body.height);
    const calibration = animation.calibration;
    const pose = calibration?.frames[frame];
    // Loaded legacy packs receive measured calibration too. The fallback is
    // deliberately stable for older callers, never based on the action sprite.
    const referenceBodyHeight = calibration?.referenceBodyHeight ?? animation.frameHeight;
    const unitScale = targetHeight / referenceBodyHeight;
    const scale = unitScale * (pose?.scale ?? 1);
    const facingDirection = baseSprite.flipX ? -1 : 1;
    const originX = getFacingSpriteOriginX(pose?.originX ?? 0.5, baseSprite.flipX);
    const originY = pose?.originY ?? 1;
    baseSprite.setVisible(false);
    baseView.shadowSprite?.setVisible(false);
    this.sprite
      .setVisible(true)
      .setFrame(pose?.sourceFrame ?? frame)
      .setOrigin(originX, originY)
      // Offsets are already calibrated source coordinates. Applying pose.scale
      // again would double-correct an intentional jump or sideways movement.
      .setPosition(
        body.rootX + facingDirection * (pose?.offsetX ?? 0) * unitScale,
        body.rootY + (pose?.offsetY ?? 0) * unitScale,
      )
      .setFlipX(baseSprite.flipX)
      .setScale(scale)
      .setAlpha(baseSprite.alpha)
      .setDepth(baseSprite.depth);
    this.shadow
      .setVisible(true)
      .setPosition(body.rootX, body.rootY + 7)
      .setScale(Math.max(0.7, Math.min(1.45, targetHeight / 256)))
      .setAlpha(Math.max(0.08, baseView.shadowSprite?.alpha ?? 0.16))
      .setDepth(baseSprite.depth - 0.5);
  }

  /** Opaque-pixel top in the sprite parent's coordinates, not camera/UI space. */
  getVisibleTopCenter(): { x: number; y: number } | null {
    if (!this.activeName || !this.sprite.visible) return null;
    const frame = this.sprite.frame;
    const bounds = visibleBounds(frame);
    if (!bounds) {
      const top = this.sprite.getTopCenter();
      return { x: top.x, y: top.y };
    }
    const sourceCenter = bounds.x + bounds.width / 2;
    const visibleCenter = this.sprite.flipX ? frame.cutWidth - sourceCenter : sourceCenter;
    return {
      x: this.sprite.x + (visibleCenter - this.sprite.originX * frame.cutWidth) * this.sprite.scaleX,
      y: this.sprite.y + (bounds.y - this.sprite.originY * frame.cutHeight) * this.sprite.scaleY,
    };
  }

  destroy(): void {
    this.sprite.destroy();
    this.shadow.destroy();
  }
}
