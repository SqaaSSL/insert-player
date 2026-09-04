import {
  getFighterPersonality,
  isValidMatchRoundsToWin,
  resolveMatchRoundsToWin,
  type FighterPersonalityId,
} from '../match/MatchConfig.ts';
import { INPUT_BITS, INPUT_MASK, packInput, unpackInput, type FighterInput } from './FighterInput.ts';
import { MatchSimulation, type MatchSimConfig, type MatchSimEvent } from './MatchSimulation.ts';

export const MATCH_RECORDING_VERSION = 1;

/** Checksum sampled every N ticks — cheap enough to keep on all the time. */
export const CHECKSUM_INTERVAL = 60;

/** Per-tick flags stored above the two 10-bit input masks. */
export const TICK_FLAG_SKIP_INTRO = 1 << (INPUT_BITS * 2);

/** Serializable subset of `MatchSimConfig` (personalities by id). */
export interface MatchRecordingConfig {
  seed: number;
  vsAI: boolean;
  cpuVsCpu: boolean;
  p1Name: string;
  p2Name: string;
  /** Optional for backward compatibility with recordings made before configurable rounds. */
  roundsToWin?: number;
  p1PersonalityId: FighterPersonalityId;
  p2PersonalityId: FighterPersonalityId;
  p2Difficulty: number;
}

/**
 * A complete, replayable match: config + one packed word per tick. The word
 * is `p1 | p2 << 10 | flags`; `frames` is run-length encoded as
 * `[word, count, word, count, …]` because held inputs repeat for many ticks.
 * `checksums` holds `[tick, digest]` pairs sampled every CHECKSUM_INTERVAL.
 */
export interface MatchRecording {
  version: typeof MATCH_RECORDING_VERSION;
  config: MatchRecordingConfig;
  tickCount: number;
  frames: number[];
  checksums: number[];
}

export interface TickInputs {
  p1: FighterInput;
  p2: FighterInput;
  skipIntro?: boolean;
}

export function packTick(p1: FighterInput, p2: FighterInput, skipIntro = false): number {
  return packInput(p1) | (packInput(p2) << INPUT_BITS) | (skipIntro ? TICK_FLAG_SKIP_INTRO : 0);
}

export function unpackTick(word: number): TickInputs {
  return {
    p1: unpackInput(word & INPUT_MASK),
    p2: unpackInput((word >>> INPUT_BITS) & INPUT_MASK),
    skipIntro: (word & TICK_FLAG_SKIP_INTRO) !== 0,
  };
}

export function toRecordingConfig(config: MatchSimConfig): MatchRecordingConfig {
  return {
    seed: config.seed >>> 0,
    vsAI: config.vsAI || config.cpuVsCpu,
    cpuVsCpu: config.cpuVsCpu,
    p1Name: config.p1Name,
    p2Name: config.p2Name,
    ...(config.roundsToWin === undefined
      ? {}
      : { roundsToWin: resolveMatchRoundsToWin(config.roundsToWin) }),
    p1PersonalityId: (config.p1Personality ?? getFighterPersonality()).id,
    p2PersonalityId: (config.p2Personality ?? getFighterPersonality()).id,
    p2Difficulty: config.p2Difficulty ?? 1,
  };
}

export function toSimConfig(config: MatchRecordingConfig): MatchSimConfig {
  return {
    seed: config.seed,
    vsAI: config.vsAI,
    cpuVsCpu: config.cpuVsCpu,
    p1Name: config.p1Name,
    p2Name: config.p2Name,
    roundsToWin: config.roundsToWin,
    p1Personality: getFighterPersonality(config.p1PersonalityId),
    p2Personality: getFighterPersonality(config.p2PersonalityId),
    p2Difficulty: config.p2Difficulty,
  };
}

export function encodeFrames(words: readonly number[]): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < words.length) {
    const word = words[i];
    let count = 1;
    while (i + count < words.length && words[i + count] === word) count++;
    out.push(word, count);
    i += count;
  }
  return out;
}

export function decodeFrames(encoded: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < encoded.length; i += 2) {
    const word = encoded[i];
    const count = encoded[i + 1];
    for (let n = 0; n < count; n++) out.push(word);
  }
  return out;
}

/**
 * Records the tick stream of a live match. Call `recordTick` with exactly
 * what was passed to `sim.step` (plus whether an intro skip was requested
 * just before it) and `sampleChecksum` right after the step.
 */
export class MatchRecorder {
  private readonly config: MatchRecordingConfig;
  private readonly words: number[] = [];
  private readonly checksums: number[] = [];

  constructor(config: MatchSimConfig) {
    this.config = toRecordingConfig(config);
  }

  get tickCount(): number {
    return this.words.length;
  }

  recordTick(p1: FighterInput, p2: FighterInput, skipIntro = false): void {
    this.words.push(packTick(p1, p2, skipIntro));
  }

  /** Sample after the tick was stepped; keeps one digest per interval. */
  sampleChecksum(sim: MatchSimulation): void {
    if (sim.tick % CHECKSUM_INTERVAL !== 0) return;
    this.checksums.push(sim.tick, sim.checksum());
  }

  toRecording(): MatchRecording {
    return {
      version: MATCH_RECORDING_VERSION,
      config: { ...this.config },
      tickCount: this.words.length,
      frames: encodeFrames(this.words),
      checksums: this.checksums.slice(),
    };
  }
}

export function isValidMatchRecording(value: unknown): value is MatchRecording {
  if (!value || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  if (rec.version !== MATCH_RECORDING_VERSION) return false;
  if (!Array.isArray(rec.frames) || !Array.isArray(rec.checksums)) return false;
  if (typeof rec.tickCount !== 'number' || !Number.isSafeInteger(rec.tickCount) || rec.tickCount < 0) return false;
  if (rec.frames.length % 2 !== 0 || rec.checksums.length % 2 !== 0) return false;
  if (!rec.frames.every((n) => Number.isSafeInteger(n) && (n as number) >= 0)) return false;
  const config = rec.config as Record<string, unknown> | undefined;
  if (!config || typeof config !== 'object') return false;
  if (typeof config.seed !== 'number' || typeof config.vsAI !== 'boolean' || typeof config.cpuVsCpu !== 'boolean') return false;
  if (typeof config.p1Name !== 'string' || typeof config.p2Name !== 'string') return false;
  if (config.roundsToWin !== undefined && !isValidMatchRoundsToWin(config.roundsToWin)) return false;
  if (typeof config.p1PersonalityId !== 'string' || typeof config.p2PersonalityId !== 'string') return false;
  if (typeof config.p2Difficulty !== 'number') return false;
  return true;
}

export interface ReplayResult {
  sim: MatchSimulation;
  events: MatchSimEvent[];
  ticksPlayed: number;
  /** First tick whose recorded checksum disagreed with the replay, or null. */
  desyncAtTick: number | null;
  /** Digest of the final state, for comparing two replays or a live match. */
  finalChecksum: number;
}

export interface ReplayOptions {
  /** Stop early (e.g. to scrub to a tick). Defaults to the whole recording. */
  untilTick?: number;
  /** Called after each tick with the events it produced. */
  onTick?: (sim: MatchSimulation, tick: number, events: MatchSimEvent[]) => void;
  /** Stop at the first checksum mismatch instead of playing on. */
  stopOnDesync?: boolean;
}

/**
 * Re-run a recording through a fresh simulation. With the sim deterministic,
 * this reproduces the match exactly — the recorded checksums prove it, and
 * a mismatch pinpoints the first tick where two runs disagreed.
 */
export function replayMatch(recording: MatchRecording, options: ReplayOptions = {}): ReplayResult {
  if (!isValidMatchRecording(recording)) {
    throw new Error('Invalid match recording');
  }
  const words = decodeFrames(recording.frames);
  if (words.length !== recording.tickCount) {
    throw new Error(`Recording tick count mismatch: header ${recording.tickCount}, frames ${words.length}`);
  }
  const expected = new Map<number, number>();
  for (let i = 0; i + 1 < recording.checksums.length; i += 2) {
    expected.set(recording.checksums[i], recording.checksums[i + 1]);
  }

  const sim = new MatchSimulation(toSimConfig(recording.config));
  const events: MatchSimEvent[] = sim.start();
  const limit = Math.min(words.length, options.untilTick ?? words.length);
  let desyncAtTick: number | null = null;

  for (let i = 0; i < limit; i++) {
    const tick = unpackTick(words[i]);
    if (tick.skipIntro) sim.requestIntroSkip();
    const tickEvents = sim.step(tick.p1, tick.p2);
    events.push(...tickEvents);
    options.onTick?.(sim, sim.tick, tickEvents);

    const recorded = expected.get(sim.tick);
    if (recorded !== undefined && desyncAtTick === null && recorded !== sim.checksum()) {
      desyncAtTick = sim.tick;
      if (options.stopOnDesync) break;
    }
  }

  return {
    sim,
    events,
    ticksPlayed: sim.tick,
    desyncAtTick,
    finalChecksum: sim.checksum(),
  };
}
