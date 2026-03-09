import { Fighter } from '../fighters/Fighter.ts';
import { FighterState } from '../constants.ts';

export interface HitEvent {
  attacker: number;
  defender: number;
  damage: number;
  blocked: boolean;
}

export class CombatSystem {
  resolve(p1: Fighter, p2: Fighter): HitEvent[] {
    const events: HitEvent[] = [];

    this.checkHit(p1, p2, events);
    this.checkHit(p2, p1, events);
    this.pushApart(p1, p2);

    return events;
  }

  private checkHit(attacker: Fighter, defender: Fighter, events: HitEvent[]): void {
    const hitbox = attacker.getActiveHitbox();
    if (!hitbox) return;

    const hurtbox = defender.getHurtbox();
    if (!this.aabbOverlap(hitbox, hurtbox)) return;

    attacker.attackHit = true;

    const atk = attacker.getAttackData()!;
    const isBlocking = this.isBlocking(defender, attacker);

    defender.takeDamage(atk, isBlocking);

    events.push({
      attacker: attacker.playerIndex,
      defender: defender.playerIndex,
      damage: isBlocking ? Math.floor(atk.damage * 0.1) : atk.damage,
      blocked: isBlocking,
    });
  }

  private isBlocking(defender: Fighter, attacker: Fighter): boolean {
    if (
      defender.state === FighterState.HIT_STUN ||
      defender.state === FighterState.KNOCKDOWN ||
      defender.isInAttack()
    ) {
      return false;
    }

    if (!defender.isGrounded()) return false;

    const inBlockState =
      defender.state === FighterState.WALK_BACKWARD ||
      defender.state === FighterState.BLOCK;

    if (!inBlockState) return false;

    const attackState = attacker.state;
    const isLowAttack =
      attackState === FighterState.LOW_PUNCH ||
      attackState === FighterState.LOW_KICK;
    const isHighAttack =
      attackState === FighterState.HIGH_PUNCH ||
      attackState === FighterState.HIGH_KICK ||
      attackState === FighterState.UPPERCUT;

    if (defender.crouchBlocking) {
      // Crouch-blocking stops lows but not overheads/highs
      return isLowAttack;
    }
    // Standing block stops highs but not lows
    return isHighAttack;
  }

  private pushApart(p1: Fighter, p2: Fighter): void {
    // Only push apart when both fighters are grounded.
    // This allows jump cross-overs: an airborne fighter can pass over the grounded one.
    if (!p1.isGrounded() || !p2.isGrounded()) return;

    const minDistance = (p1.getBodyWidth() + p2.getBodyWidth()) / 2;
    const overlap = minDistance - Math.abs(p1.x - p2.x);
    if (overlap > 0 && Math.abs(p1.x - p2.x) < minDistance) {
      const push = overlap / 2 + 1;
      if (p1.x < p2.x) {
        p1.x -= push;
        p2.x += push;
      } else {
        p1.x += push;
        p2.x -= push;
      }
    }
  }

  private aabbOverlap(
    a: { x: number; y: number; width: number; height: number },
    b: { x: number; y: number; width: number; height: number },
  ): boolean {
    return (
      a.x < b.x + b.width &&
      a.x + a.width > b.x &&
      a.y < b.y + b.height &&
      a.y + a.height > b.y
    );
  }
}
