import { MatchSimulation, type MatchSimEvent, type MatchSimSnapshot } from '../sim/MatchSimulation.ts';
import type { FighterInput } from '../sim/FighterInput.ts';
import {
  decodeInputPacket,
  encodeInputPacket,
  tickWord,
  tickWordInput,
  tickWordSkipsIntro,
} from './InputPackets.ts';

export interface RollbackSessionOptions {
  sim: MatchSimulation;
  /** Which fighter the local player controls (0 = P1 / host, 1 = P2 / guest). */
  localSlot: 0 | 1;
  /** Ticks between sampling a local input and the tick it applies to. */
  inputDelay?: number;
  /** How far past the last confirmed tick we may predict before stalling. */
  maxRollback?: number;
  /** Tick words repeated in every packet so lost datagrams are covered. */
  redundancy?: number;
  /** Compare state digests with the peer every N confirmed ticks. */
  checksumInterval?: number;
  send: (packet: Uint8Array) => void;
}

export interface AdvanceResult {
  /** Events from ticks simulated for the first time this frame. */
  events: MatchSimEvent[];
  /** True when no tick was simulated (too far ahead of the peer). */
  stalled: boolean;
  /** Ticks re-simulated after a misprediction this frame. */
  rolledBack: number;
}

export interface RollbackStats {
  localTick: number;
  confirmedTick: number;
  remoteLatestTick: number;
  rollbacks: number;
  rolledBackTicks: number;
  stalls: number;
  predictedTicks: number;
  desyncTick: number | null;
}

export interface ChecksumReport {
  tick: number;
  checksum: number;
}

export const DEFAULT_INPUT_DELAY = 2;
export const DEFAULT_MAX_ROLLBACK = 8;
export const DEFAULT_REDUNDANCY = 8;
export const DEFAULT_CHECKSUM_INTERVAL = 60;
const PREDICTION_LOOKBACK = 64;
/** Skip one frame in every N when running ahead of the peer's clock. */
const AHEAD_THROTTLE_PERIOD = 4;
const AHEAD_THROTTLE_TICKS = 2;

/**
 * GGPO-style rollback netcode over the deterministic `MatchSimulation`.
 *
 * Every frame the caller hands in the local input; it is stamped for tick
 * `localTick + inputDelay` and broadcast with the previous few inputs. The
 * simulation then advances one tick using the remote input if it has
 * arrived, or a prediction (repeat the last known remote input) otherwise.
 * When a real remote input contradicts a prediction, the session restores
 * the snapshot taken before that tick and re-simulates silently up to the
 * present. Both peers run this symmetrically; with identical inputs the
 * deterministic sim guarantees identical state, which the periodic
 * checksum exchange verifies.
 */
export class RollbackSession {
  readonly sim: MatchSimulation;
  readonly localSlot: 0 | 1;
  readonly inputDelay: number;
  readonly maxRollback: number;
  readonly redundancy: number;
  readonly checksumInterval: number;
  private readonly send: (packet: Uint8Array) => void;

  private localTick = 0;
  private confirmedTick = 0;
  private remoteLatestTick = -1;
  private readonly localInputs = new Map<number, number>();
  private readonly remoteInputs = new Map<number, number>();
  /** Snapshot taken *before* stepping tick t, for every unconfirmed tick. */
  private readonly snapshots = new Map<number, MatchSimSnapshot>();
  /** Remote word used for ticks that were stepped before the real input arrived. */
  private readonly predicted = new Map<number, number>();
  private readonly localChecksums = new Map<number, number>();
  private readonly remoteChecksums = new Map<number, number>();
  private readonly reportedChecksums = new Set<number>();
  private desyncTick: number | null = null;
  private rollbacks = 0;
  private rolledBackTicks = 0;
  private stalls = 0;
  private frameCounter = 0;

  constructor(options: RollbackSessionOptions) {
    this.sim = options.sim;
    this.localSlot = options.localSlot;
    this.inputDelay = Math.max(0, Math.floor(options.inputDelay ?? DEFAULT_INPUT_DELAY));
    this.maxRollback = Math.max(1, Math.floor(options.maxRollback ?? DEFAULT_MAX_ROLLBACK));
    this.redundancy = Math.max(1, Math.floor(options.redundancy ?? DEFAULT_REDUNDANCY));
    this.checksumInterval = Math.max(1, Math.floor(options.checksumInterval ?? DEFAULT_CHECKSUM_INTERVAL));
    this.send = options.send;
    // Neither side has sampled anything for the first `inputDelay` ticks;
    // both agree those are empty.
    for (let tick = 0; tick < this.inputDelay; tick++) {
      this.localInputs.set(tick, 0);
      this.remoteInputs.set(tick, 0);
    }
  }

  get isDesynced(): boolean {
    return this.desyncTick !== null;
  }

  stats(): RollbackStats {
    return {
      localTick: this.localTick,
      confirmedTick: this.confirmedTick,
      remoteLatestTick: this.remoteLatestTick,
      rollbacks: this.rollbacks,
      rolledBackTicks: this.rolledBackTicks,
      stalls: this.stalls,
      predictedTicks: this.predicted.size,
      desyncTick: this.desyncTick,
    };
  }

  /** One local render frame. */
  advanceFrame(localInput: FighterInput, skipIntro = false): AdvanceResult {
    this.frameCounter++;
    if (this.desyncTick !== null) return { events: [], stalled: true, rolledBack: 0 };

    // Stamp and broadcast this frame's input.
    const inputTick = this.localTick + this.inputDelay;
    if (!this.localInputs.has(inputTick)) {
      this.localInputs.set(inputTick, tickWord(localInput, skipIntro));
    }
    this.broadcastInputs(inputTick);

    const rolledBack = this.rollbackIfNeeded();
    this.updateConfirmedTick();

    // Do not run away from the peer: cap outstanding predictions, and ease
    // off when our clock is ahead of theirs.
    const outstanding = this.localTick - this.confirmedTick;
    const peerTick = this.remoteLatestTick - this.inputDelay;
    const ahead = this.remoteLatestTick >= 0 && this.localTick - peerTick > AHEAD_THROTTLE_TICKS;
    if (outstanding >= this.maxRollback || (ahead && this.frameCounter % AHEAD_THROTTLE_PERIOD === 0)) {
      this.stalls++;
      return { events: [], stalled: true, rolledBack };
    }

    const events = this.stepTick(this.localTick);
    this.updateConfirmedTick();
    this.prune();
    return { events, stalled: false, rolledBack };
  }

  /** Feed an input packet received from the peer. */
  receiveInputPacket(bytes: Uint8Array): boolean {
    const packet = decodeInputPacket(bytes);
    if (!packet) return false;
    for (let i = 0; i < packet.words.length; i++) {
      const tick = packet.firstTick + i;
      if (tick < this.inputDelay && !this.remoteInputs.has(tick)) continue;
      if (!this.remoteInputs.has(tick)) {
        this.remoteInputs.set(tick, packet.words[i]);
      }
      if (tick > this.remoteLatestTick) this.remoteLatestTick = tick;
    }
    return true;
  }

  /** Digest recorded after tick `tick` (interval ticks only), if still retained. */
  localChecksumAt(tick: number): number | undefined {
    return this.localChecksums.get(tick);
  }

  /** Digests for confirmed ticks not yet handed out; send them on the reliable channel. */
  takeChecksumReports(): ChecksumReport[] {
    const reports: ChecksumReport[] = [];
    for (const [tick, checksum] of this.localChecksums) {
      if (tick > this.confirmedTick || this.reportedChecksums.has(tick)) continue;
      this.reportedChecksums.add(tick);
      reports.push({ tick, checksum });
    }
    reports.sort((a, b) => a.tick - b.tick);
    return reports;
  }

  /** Compare a peer digest with ours; the first mismatch freezes the session. */
  receiveChecksumReport(report: ChecksumReport): void {
    if (!Number.isInteger(report.tick) || report.tick < 0) return;
    this.remoteChecksums.set(report.tick, report.checksum >>> 0);
    this.compareChecksums();
  }

  // ------------------------------------------------------------ internals

  private broadcastInputs(latestTick: number): void {
    const words: number[] = [];
    const firstTick = Math.max(0, latestTick - this.redundancy + 1);
    for (let tick = firstTick; tick <= latestTick; tick++) {
      words.push(this.localInputs.get(tick) ?? 0);
    }
    this.send(encodeInputPacket({ firstTick, words }));
  }

  private stepTick(tick: number): MatchSimEvent[] {
    const localWord = this.localInputs.get(tick) ?? 0;
    let remoteWord: number;
    if (this.remoteInputs.has(tick)) {
      remoteWord = this.remoteInputs.get(tick)!;
      this.predicted.delete(tick);
    } else {
      remoteWord = this.predictRemote(tick);
      this.predicted.set(tick, remoteWord);
    }
    this.snapshots.set(tick, this.sim.snapshot());
    if (tickWordSkipsIntro(localWord) || tickWordSkipsIntro(remoteWord)) {
      this.sim.requestIntroSkip();
    }
    const local = tickWordInput(localWord);
    const remote = tickWordInput(remoteWord);
    const events = this.localSlot === 0 ? this.sim.step(local, remote) : this.sim.step(remote, local);
    this.localTick = tick + 1;
    if (this.localTick % this.checksumInterval === 0) {
      this.localChecksums.set(this.localTick, this.sim.checksum());
    }
    return events;
  }

  private predictRemote(tick: number): number {
    for (let t = tick - 1; t >= Math.max(0, tick - PREDICTION_LOOKBACK); t--) {
      const word = this.remoteInputs.get(t);
      if (word !== undefined) return word;
    }
    return 0;
  }

  private rollbackIfNeeded(): number {
    let firstWrong = -1;
    for (const [tick, guess] of this.predicted) {
      const actual = this.remoteInputs.get(tick);
      if (actual === undefined) continue;
      if (actual === guess) {
        this.predicted.delete(tick);
        continue;
      }
      if (firstWrong === -1 || tick < firstWrong) firstWrong = tick;
    }
    if (firstWrong === -1) return 0;

    const snapshot = this.snapshots.get(firstWrong);
    if (!snapshot) {
      // Should never happen: predictions are always newer than the pruned
      // horizon. Treat as a desync rather than diverging silently.
      this.desyncTick = firstWrong;
      return 0;
    }
    const resumeAt = this.localTick;
    this.sim.restore(snapshot);
    this.localTick = firstWrong;
    for (let tick = firstWrong; tick < resumeAt; tick++) {
      this.predicted.delete(tick);
      this.stepTick(tick);
    }
    this.rollbacks++;
    this.rolledBackTicks += resumeAt - firstWrong;
    return resumeAt - firstWrong;
  }

  private updateConfirmedTick(): void {
    let tick = this.confirmedTick;
    while (tick < this.localTick && this.remoteInputs.has(tick) && !this.predicted.has(tick)) {
      tick++;
    }
    this.confirmedTick = tick;
    this.compareChecksums();
  }

  private compareChecksums(): void {
    if (this.desyncTick !== null) return;
    for (const [tick, remote] of this.remoteChecksums) {
      if (tick > this.confirmedTick) continue;
      const local = this.localChecksums.get(tick);
      if (local === undefined) continue;
      if (local !== remote) {
        this.desyncTick = tick;
        return;
      }
      this.remoteChecksums.delete(tick);
    }
  }

  private prune(): void {
    const horizon = this.confirmedTick - 1;
    for (const tick of this.snapshots.keys()) {
      if (tick < horizon) this.snapshots.delete(tick);
    }
    const inputHorizon = this.confirmedTick - PREDICTION_LOOKBACK - this.redundancy;
    for (const tick of this.localInputs.keys()) {
      if (tick < inputHorizon) this.localInputs.delete(tick);
    }
    for (const tick of this.remoteInputs.keys()) {
      if (tick < inputHorizon) this.remoteInputs.delete(tick);
    }
    const checksumHorizon = this.confirmedTick - this.checksumInterval * 4;
    for (const tick of this.localChecksums.keys()) {
      if (tick < checksumHorizon && this.reportedChecksums.has(tick)) {
        this.localChecksums.delete(tick);
        this.reportedChecksums.delete(tick);
      }
    }
  }
}
