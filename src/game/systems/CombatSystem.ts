import { Fighter } from '../fighters/Fighter.ts';
import { FighterState, type AttackData } from '../constants.ts';

export interface HitEvent {
  attacker: number;
  defender: number;
  damage: number;
  blocked: boolean;
}

interface PendingHit {
  attacker: Fighter;
  defender: Fighter;
  attackData: AttackData;
  blocked: boolean;
}

export class CombatSystem {
  resolve(p1: Fighter, p2: Fighter): HitEvent[] {
    const events: HitEvent[] = [];
    const p1Hit = this.getPendingHit(p1, p2);
    const p2Hit = this.getPendingHit(p2, p1);

    if (p1Hit && p2Hit) {
      this.applyHit(p1Hit, events);
      this.applyHit(p2Hit, events);
    } else if (p1Hit) {
      this.applyHit(p1Hit, events);
    } else if (p2Hit) {
      this.applyHit(p2Hit, events);
    }
    this.pushApart(p1, p2);

    return events;
  }

  private getPendingHit(attacker: Fighter, defender: Fighter): PendingHit | null {
    const hitbox = attacker.getActiveHitbox();
    if (!hitbox) return null;
    const attackData = attacker.getAttackData();
    if (!attackData) return null;

    const hurtbox = defender.getHurtbox();
    if (!this.aabbOverlap(hitbox, hurtbox)) return null;

    return {
      attacker,
      defender,
      attackData,
      blocked: this.isBlocking(defender, attacker),
    };
  }

  private applyHit(hit: PendingHit, events: HitEvent[]): void {
    hit.attacker.attackHit = true;
    hit.defender.takeDamage(hit.attackData, hit.blocked);

    events.push({
      attacker: hit.attacker.playerIndex,
      defender: hit.defender.playerIndex,
      damage: hit.blocked ? Math.floor(hit.attackData.damage * 0.1) : hit.attackData.damage,
      blocked: hit.blocked,
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
