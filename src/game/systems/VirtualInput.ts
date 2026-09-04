export type VirtualInputAction =
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'guard'
  | 'punch'
  | 'kick'
  | 'fireball'
  | 'uppercut'
  | 'super';

export interface VirtualInputSnapshot {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  guard: boolean;
  punch: boolean;
  kick: boolean;
  fireball: boolean;
  uppercut: boolean;
  super: boolean;
}

const PLAYER_COUNT = 2;
const pulseActions = new Set<VirtualInputAction>(['punch', 'kick', 'fireball', 'uppercut', 'super']);
const heldByPlayer = Array.from({ length: PLAYER_COUNT }, () => new Set<VirtualInputAction>());
const pressedByPlayer = Array.from({ length: PLAYER_COUNT }, () => new Set<VirtualInputAction>());

export function setVirtualInputAction(
  playerIndex: number,
  action: VirtualInputAction,
  active: boolean,
): void {
  const held = heldByPlayer[playerIndex];
  const pressed = pressedByPlayer[playerIndex];
  if (!held || !pressed) return;

  if (active) {
    if (!held.has(action) && pulseActions.has(action)) pressed.add(action);
    held.add(action);
    return;
  }

  held.delete(action);
}

export function consumeVirtualInput(playerIndex: number): VirtualInputSnapshot {
  const held = heldByPlayer[playerIndex] ?? new Set<VirtualInputAction>();
  const pressed = pressedByPlayer[playerIndex] ?? new Set<VirtualInputAction>();
  const snapshot: VirtualInputSnapshot = {
    left: held.has('left'),
    right: held.has('right'),
    up: held.has('up'),
    down: held.has('down'),
    guard: held.has('guard'),
    punch: pressed.has('punch'),
    kick: pressed.has('kick'),
    fireball: pressed.has('fireball'),
    uppercut: pressed.has('uppercut'),
    super: pressed.has('super'),
  };
  pressed.clear();
  return snapshot;
}

export function resetVirtualInput(playerIndex?: number): void {
  if (typeof playerIndex === 'number') {
    heldByPlayer[playerIndex]?.clear();
    pressedByPlayer[playerIndex]?.clear();
    return;
  }

  for (let index = 0; index < PLAYER_COUNT; index += 1) {
    heldByPlayer[index].clear();
    pressedByPlayer[index].clear();
  }
}
