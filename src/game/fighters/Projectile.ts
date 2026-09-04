import { GAME_WIDTH } from '../constants.ts';
import { SUPER_FIREBALL_DAMAGE, SUPER_FIREBALL_SPEED_SCALE } from '../systems/Meter.ts';

const PROJECTILE_SPEED = 500;
const HITBOX_SIZE = 30;

export interface ProjectileSnapshot {
  id: number;
  x: number;
  y: number;
  vx: number;
  active: boolean;
  ownerIndex: number;
  damage: number;
  isSuper: boolean;
  reflected: boolean;
}

/**
 * Pure projectile simulation. The scene mirrors these into sprites by `id`
 * (see `ProjectileView`), so creating or rewinding one never touches Phaser.
 */
export class Projectile {
  /** Stable per-match id so a view can be matched across rollbacks. */
  readonly id: number;
  x: number;
  y: number;
  vx: number;
  active = true;
  ownerIndex: number;
  readonly damage: number;
  /** Super fireball: mid-height, unreflectable, wins clashes, hits harder. */
  readonly isSuper: boolean;
  /** Bounced back by a standing guard (presentation tint). */
  reflected = false;

  constructor(
    id: number,
    x: number,
    y: number,
    facingRight: boolean,
    ownerIndex: number,
    isHeavy: boolean,
    isSuper = false,
  ) {
    this.id = id;
    this.x = x;
    this.y = y;
    const speed = PROJECTILE_SPEED * (isSuper ? SUPER_FIREBALL_SPEED_SCALE : 1);
    this.vx = facingRight ? speed : -speed;
    this.ownerIndex = ownerIndex;
    this.isSuper = isSuper;
    this.damage = isSuper ? SUPER_FIREBALL_DAMAGE : isHeavy ? 80 : 60;
  }

  static fromSnapshot(snap: ProjectileSnapshot): Projectile {
    const proj = new Projectile(snap.id, snap.x, snap.y, snap.vx >= 0, snap.ownerIndex, false, snap.isSuper);
    proj.vx = snap.vx;
    proj.active = snap.active;
    proj.reflected = snap.reflected;
    (proj as { damage: number }).damage = snap.damage;
    return proj;
  }

  snapshot(): ProjectileSnapshot {
    return {
      id: this.id,
      x: this.x,
      y: this.y,
      vx: this.vx,
      active: this.active,
      ownerIndex: this.ownerIndex,
      damage: this.damage,
      isSuper: this.isSuper,
      reflected: this.reflected,
    };
  }

  hashInto(hasher: { num(value: number): void }): void {
    hasher.num(this.id);
    hasher.num(this.x);
    hasher.num(this.y);
    hasher.num(this.vx);
    hasher.num(this.active ? 1 : 0);
    hasher.num(this.ownerIndex);
    hasher.num(this.damage);
    hasher.num(this.isSuper ? 1 : 0);
    hasher.num(this.reflected ? 1 : 0);
  }

  get facingRight(): boolean {
    return this.vx >= 0;
  }

  /** Standing-guard reflect: the ball changes sides and comes back faster. */
  reflect(newOwnerIndex: number): void {
    this.ownerIndex = newOwnerIndex;
    this.vx = -this.vx * 1.3;
    this.reflected = true;
  }

  update(dt: number): void {
    if (!this.active) return;
    this.x += this.vx * dt;

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
  }
}
