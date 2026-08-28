import { describe, expect, it } from 'vitest';
import { CombatSystem } from './CombatSystem.ts';
import { ATTACKS, FighterState } from '../constants.ts';
import type { Fighter } from '../fighters/Fighter.ts';

interface StubOptions {
  playerIndex?: number;
  state?: FighterState;
  stateFrame?: number;
  crouchBlocking?: boolean;
  attacking?: FighterState | null;
}

interface StubFighter {
  fighter: Fighter;
  hits: Array<{ damage: number; hitStunFrames: number; blocked: boolean }>;
}

function stub(options: StubOptions = {}): StubFighter {
  const attacking = options.attacking ?? null;
  const state = attacking ?? options.state ?? FighterState.IDLE;
  const attackData = attacking ? ATTACKS[attacking] : null;
  const hits: StubFighter['hits'] = [];
  const fighter = {
    playerIndex: options.playerIndex ?? 0,
    state,
    stateFrame: options.stateFrame ?? 0,
    crouchBlocking: options.crouchBlocking ?? false,
    attackHit: false,
    x: 400,
    y: 480,
    isGrounded: () => true,
    isInAttack: () => attacking !== null,
    isInvulnerable: () => state === FighterState.UPPERCUT && (options.stateFrame ?? 0) < 6,
    getAttackData: () => attackData,
    getActiveHitbox: () => {
      if (!attackData) return null;
      const frame = options.stateFrame ?? 0;
      if (frame < attackData.startup || frame >= attackData.startup + attackData.active) return null;
      return { x: 380, y: 300, width: 100, height: 100 };
    },
    getHurtbox: () => ({ x: 380, y: 280, width: 60, height: 180 }),
    getBodyWidth: () => 60,
    takeDamage: (atk: { damage: number; hitStunFrames: number }, blocked: boolean) => {
      hits.push({ damage: atk.damage, hitStunFrames: atk.hitStunFrames, blocked });
    },
  } as unknown as Fighter;
  return { fighter, hits };
}

function activeFrameOf(state: FighterState): number {
  return ATTACKS[state].startup;
}

describe('combat rules', () => {
  it('every attack declares its Tekken hit level and the sweep knocks down', () => {
    expect(ATTACKS[FighterState.HIGH_PUNCH].hitLevel).toBe('high');
    expect(ATTACKS[FighterState.LOW_PUNCH].hitLevel).toBe('low');
    expect(ATTACKS[FighterState.HIGH_KICK].hitLevel).toBe('high');
    expect(ATTACKS[FighterState.LOW_KICK].hitLevel).toBe('low');
    expect(ATTACKS[FighterState.LOW_KICK].knockdown).toBe(true);
    expect(ATTACKS[FighterState.FIREBALL].hitLevel).toBe('high');
    expect(ATTACKS[FighterState.UPPERCUT].hitLevel).toBe('mid');
  });

  it('standing block stops highs and mids but loses to lows', () => {
    const combat = new CombatSystem();
    for (const [attack, blocked] of [
      [FighterState.HIGH_PUNCH, true],
      [FighterState.HIGH_KICK, true],
      [FighterState.UPPERCUT, true],
      [FighterState.LOW_PUNCH, false],
      [FighterState.LOW_KICK, false],
    ] as const) {
      const attacker = stub({ playerIndex: 0, attacking: attack, stateFrame: activeFrameOf(attack) });
      const defender = stub({ playerIndex: 1, state: FighterState.BLOCK });
      const events = combat.resolve(attacker.fighter, defender.fighter);
      expect(events).toHaveLength(1);
      expect(events[0].blocked, `${attack} vs standing block`).toBe(blocked);
    }
  });

  it('crouch block only stops lows — mids crush it (Tekken triangle)', () => {
    const combat = new CombatSystem();
    for (const [attack, blocked] of [
      [FighterState.LOW_PUNCH, true],
      [FighterState.LOW_KICK, true],
      [FighterState.UPPERCUT, false],
      [FighterState.HIGH_PUNCH, false],
    ] as const) {
      const attacker = stub({ playerIndex: 0, attacking: attack, stateFrame: activeFrameOf(attack) });
      const defender = stub({ playerIndex: 1, state: FighterState.BLOCK, crouchBlocking: true });
      const events = combat.resolve(attacker.fighter, defender.fighter);
      expect(events).toHaveLength(1);
      expect(events[0].blocked, `${attack} vs crouch block`).toBe(blocked);
    }
  });

  it('uppercut startup is invincible; later frames are not', () => {
    const combat = new CombatSystem();
    const attacker = stub({ attacking: FighterState.HIGH_PUNCH, stateFrame: activeFrameOf(FighterState.HIGH_PUNCH) });
    const invulnDefender = stub({ playerIndex: 1, state: FighterState.UPPERCUT, stateFrame: 3, attacking: FighterState.UPPERCUT });
    expect(combat.resolve(attacker.fighter, invulnDefender.fighter).filter((e) => e.defender === 1)).toHaveLength(0);

    const attacker2 = stub({ attacking: FighterState.HIGH_PUNCH, stateFrame: activeFrameOf(FighterState.HIGH_PUNCH) });
    const lateDefender = stub({ playerIndex: 1, state: FighterState.UPPERCUT, stateFrame: 20, attacking: FighterState.UPPERCUT });
    expect(combat.resolve(attacker2.fighter, lateDefender.fighter).filter((e) => e.defender === 1)).toHaveLength(1);
  });

  it('counter-hits deal +25% damage and +4 hitstun', () => {
    const combat = new CombatSystem();
    const attacker = stub({ attacking: FighterState.HIGH_KICK, stateFrame: activeFrameOf(FighterState.HIGH_KICK) });
    // Defender caught in its own startup (frame 1 of a 6f-startup kick).
    const defender = stub({ playerIndex: 1, attacking: FighterState.HIGH_KICK, stateFrame: 1 });
    const events = combat.resolve(attacker.fighter, defender.fighter).filter((e) => e.defender === 1);
    expect(events).toHaveLength(1);
    expect(events[0].counter).toBe(true);
    const base = ATTACKS[FighterState.HIGH_KICK];
    expect(events[0].damage).toBe(Math.floor(base.damage * 1.25));
    expect(defender.hits[0].hitStunFrames).toBe(base.hitStunFrames + 4);
  });

  it('normal hits are not counters', () => {
    const combat = new CombatSystem();
    const attacker = stub({ attacking: FighterState.HIGH_PUNCH, stateFrame: activeFrameOf(FighterState.HIGH_PUNCH) });
    const defender = stub({ playerIndex: 1, state: FighterState.IDLE });
    const events = combat.resolve(attacker.fighter, defender.fighter);
    expect(events[0].counter).toBe(false);
    expect(events[0].damage).toBe(ATTACKS[FighterState.HIGH_PUNCH].damage);
  });
});
