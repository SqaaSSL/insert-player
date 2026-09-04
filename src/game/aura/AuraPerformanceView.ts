import Phaser from 'phaser';
import type { FighterView } from '../fighters/FighterView.ts';
import type { AuraAnimationName } from '../../services/FighterAssetPacks.ts';
import {
  AURA_PERFORMANCE_DEFINITIONS,
  AURA_ROUTINE_ANIMATION_NAMES,
} from './AuraPerformance.ts';
import type { LoadedAuraAnimationPack } from './AuraSpriteLoader.ts';

/**
 * Visual-only animation layer used by Aura. The underlying Fighter and its
 * regular FighterView continue updating, which makes a miss interruption an
 * immediate, safe return to the existing hit animation.
 */
export class AuraPerformanceView {
  private readonly pack: LoadedAuraAnimationPack;
  private sprite: Phaser.GameObjects.Sprite;
  private shadow: Phaser.GameObjects.Ellipse;
  private activeName: AuraAnimationName | null = null;
  private elapsedMs = 0;
  private stumbleRemainingMs = 0;

  private static readonly STUMBLE_DURATION_MS = 280;

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
    return this.pack.animations.has('aura_unbothered') ? 'aura_unbothered' : null;
  }

  play(name: AuraAnimationName): boolean {
    const animation = this.pack.animations.get(name);
    if (!animation) return false;
    this.stumbleRemainingMs = 0;
    this.sprite.clearTint().setAngle(0);
    if (this.activeName === name) return true;
    this.activeName = name;
    this.elapsedMs = 0;
    this.sprite.setTexture(animation.textureKey, 0).setVisible(true);
    this.shadow.setVisible(true);
    return true;
  }

  interrupt(baseView: FighterView, preserveAuraIdentity = false): void {
    if (preserveAuraIdentity) {
      const fallback = this.pack.animations.has('aura_unbothered')
        ? 'aura_unbothered'
        : this.activeName ?? this.firstRoutineAnimation();
      if (fallback && this.play(fallback)) {
        this.stumbleRemainingMs = AuraPerformanceView.STUMBLE_DURATION_MS;
        this.sprite.setTint(0xff8f9a).setVisible(true);
        this.shadow.setVisible(true);
        baseView.sprite.setVisible(false);
        baseView.shadowSprite?.setVisible(false);
        return;
      }
    }
    this.activeName = null;
    this.elapsedMs = 0;
    this.stumbleRemainingMs = 0;
    this.sprite.clearTint().setAngle(0);
    this.sprite.setVisible(false);
    this.shadow.setVisible(false);
    baseView.sprite.setVisible(true);
    baseView.shadowSprite?.setVisible(true);
  }

  update(deltaMs: number, baseView: FighterView): void {
    if (!this.activeName) return;
    const animation = this.pack.animations.get(this.activeName);
    if (!animation) {
      this.interrupt(baseView);
      return;
    }

    this.elapsedMs += Math.max(0, deltaMs);
    this.stumbleRemainingMs = Math.max(0, this.stumbleRemainingMs - Math.max(0, deltaMs));
    const definition = AURA_PERFORMANCE_DEFINITIONS[this.activeName];
    const progress = definition.loop
      ? (this.elapsedMs % definition.durationMs) / definition.durationMs
      : Math.min(1, this.elapsedMs / definition.durationMs);
    const frame = Math.min(animation.frameCount - 1, Math.floor(progress * animation.frameCount));

    const baseSprite = baseView.sprite;
    const targetHeight = Math.max(1, baseSprite.displayHeight);
    const scale = targetHeight / animation.frameHeight;
    const stumbleProgress = this.stumbleRemainingMs > 0
      ? 1 - this.stumbleRemainingMs / AuraPerformanceView.STUMBLE_DURATION_MS
      : 0;
    const stumbleWave = this.stumbleRemainingMs > 0
      ? Math.sin(stumbleProgress * Math.PI * 5) * (1 - stumbleProgress)
      : 0;
    if (this.stumbleRemainingMs === 0) this.sprite.clearTint();
    baseSprite.setVisible(false);
    baseView.shadowSprite?.setVisible(false);
    this.sprite
      .setVisible(true)
      .setFrame(frame)
      .setPosition(baseSprite.x + stumbleWave * 13, baseView.getRenderY())
      .setFlipX(baseSprite.flipX)
      .setScale(scale)
      .setAngle(stumbleWave * 8)
      .setAlpha(baseSprite.alpha)
      .setDepth(baseSprite.depth);
    this.shadow
      .setVisible(true)
      .setPosition(baseSprite.x, baseView.getRenderY() + 7)
      .setScale(Math.max(0.7, Math.min(1.45, targetHeight / 256)))
      .setAlpha(Math.max(0.08, baseView.shadowSprite?.alpha ?? 0.16))
      .setDepth(baseSprite.depth - 0.5);
  }

  getVisibleTopCenter(): { x: number; y: number } | null {
    if (!this.activeName || !this.sprite.visible) return null;
    const top = this.sprite.getTopCenter();
    return { x: top.x, y: top.y };
  }

  destroy(): void {
    this.sprite.clearTint().setAngle(0);
    this.sprite.destroy();
    this.shadow.destroy();
  }
}
