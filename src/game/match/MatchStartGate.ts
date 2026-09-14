import type { MatchSceneData } from './MatchConfig.ts';

let nextStartToken = 0;

/** A presentation gate; waiting never advances or modifies combat state. */
export class MatchStartGate {
  private pendingToken: number | undefined;

  get token(): number | undefined { return this.pendingToken; }
  get waiting(): boolean { return this.pendingToken !== undefined; }

  reset(data: Pick<MatchSceneData, 'online' | 'cpuVsCpu'>): void {
    // Peers already agreed to start, and spectator matches need no confirmation.
    this.pendingToken = !data.online && !data.cpuVsCpu ? ++nextStartToken : undefined;
  }

  accept(token: unknown): boolean {
    if (!this.waiting || token !== this.pendingToken) return false;
    this.pendingToken = undefined;
    return true;
  }
}
