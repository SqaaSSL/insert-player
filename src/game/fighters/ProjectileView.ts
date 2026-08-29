import Phaser from 'phaser';
import type { Projectile } from './Projectile.ts';

/**
 * Keeps one sprite per live sim projectile, matched by id. Called once per
 * render frame after the simulation stepped; a rollback that removes or
 * re-creates projectiles is reconciled the same way.
 */
export class ProjectileViewPool {
  private readonly scene: Phaser.Scene;
  private readonly onCreate: (sprite: Phaser.GameObjects.Sprite) => void;
  private readonly sprites = new Map<number, Phaser.GameObjects.Sprite>();
  private renderYOffset = 0;

  constructor(scene: Phaser.Scene, onCreate: (sprite: Phaser.GameObjects.Sprite) => void) {
    this.scene = scene;
    this.onCreate = onCreate;
  }

  setRenderYOffset(offset: number): void {
    this.renderYOffset = offset;
  }

  sync(projectiles: readonly Projectile[]): void {
    const live = new Set<number>();
    for (const proj of projectiles) {
      if (!proj.active) continue;
      live.add(proj.id);
      let sprite = this.sprites.get(proj.id);
      if (!sprite) {
        sprite = this.scene.add.sprite(proj.x, proj.y + this.renderYOffset, 'fireball_projectile');
        sprite.setOrigin(0.5, 0.5);
        sprite.setDepth(15);
        if (proj.isSuper) {
          sprite.setScale(1.6);
        }
        this.sprites.set(proj.id, sprite);
        this.onCreate(sprite);
      }
      sprite.setPosition(proj.x, proj.y + this.renderYOffset);
      sprite.setFlipX(!proj.facingRight);
      if (proj.isSuper) {
        sprite.setTint(0xffce3a);
      } else if (proj.reflected) {
        sprite.setTint(0x9ee7ff);
      } else {
        sprite.clearTint();
      }
    }
    for (const [id, sprite] of this.sprites) {
      if (!live.has(id)) {
        sprite.destroy();
        this.sprites.delete(id);
      }
    }
  }

  clear(): void {
    for (const sprite of this.sprites.values()) sprite.destroy();
    this.sprites.clear();
  }
}
