export interface GameLaunchTarget {
  sceneKey: string;
  data?: object;
}

let pendingLaunchTarget: GameLaunchTarget | null = null;

export function setPendingLaunchTarget(target: GameLaunchTarget | null): void {
  pendingLaunchTarget = target;
}

export function getPendingLaunchTarget(): GameLaunchTarget | null {
  return pendingLaunchTarget;
}

export function clearPendingLaunchTarget(): void {
  pendingLaunchTarget = null;
}
