import Phaser from 'phaser';
import { GAME_WIDTH } from '../constants.ts';

const PROJECTILE_SPEED = 500;
const HITBOX_SIZE = 30;

export class Projectile {
  x: number;
  y: number;
  vx: number;
  active = true;
  ownerIndex: number;
  readonly damage: number;
  sprite: Phaser.GameObjects.Sprite;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    facingRight: boolean,
    ownerIndex: number,
    isHeavy: boolean,
  ) {
    this.x = x;
    this.y = y;
    this.vx = facingRight ? PROJECTILE_SPEED : -PROJECTILE_SPEED;
    this.ownerIndex = ownerIndex;
    this.damage = isHeavy ? 80 : 60;

    this.sprite = scene.add.sprite(this.x, this.y, 'fireball_projectile');
    this.sprite.setOrigin(0.5, 0.5);
    this.sprite.setDepth(15);
    this.sprite.setFlipX(!facingRight);
  }

  /** Standing-guard reflect: the ball changes sides and comes back faster. */
  reflect(newOwnerIndex: number): void {
    this.ownerIndex = newOwnerIndex;
    this.vx = -this.vx * 1.3;
    this.sprite.setFlipX(this.vx < 0);
    this.sprite.setTint(0x9ee7ff);
  }

  update(dt: number): void {
    if (!this.active) return;
    this.x += this.vx * dt;
    this.sprite.setPosition(this.x, this.y);

    if (this.x < -50 || this.x > GAME_WIDTH + 50) {
      this.destroy();
    }
  }

  getHitbox(): { x: number; y: number; width: number; height: number } {
    return {
      x: this.x - HITBOX_SIZE / 2,
      y: this.y - HITBOX_SIZE / 2,
      width: HITBOX_SIZE,
      height: HITBOX_SIZE,
    };
  }

  destroy(): void {
    this.active = false;
    this.sprite.destroy();
  }
}
