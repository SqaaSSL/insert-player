import { describe, expect, it } from 'vitest';
import {
  CINEMATIC_INTRO_TICKS,
  CINEMATIC_SKIPPABLE_TICK,
  MATCH_END_TICKS,
  MatchSimulation,
  ROUND_END_TICKS,
  ROUND_INTRO_TICKS,
  ROUND_TICKS,
  RoundPhase,
  type MatchSimConfig,
  type MatchSimEvent,
} from './MatchSimulation.ts';
import { EMPTY_INPUT, inputsEqual, packInput, unpackInput, type FighterInput } from './FighterInput.ts';
import { SeededRng } from '../utils/SeededRng.ts';
import { FighterState, MAX_HEALTH, ROUNDS_TO_WIN } from '../constants.ts';
import { getFighterPersonality } from '../match/MatchConfig.ts';

const HUMAN_VS_HUMAN: MatchSimConfig = {
  seed: 0xc0ffee,
  vsAI: false,
  cpuVsCpu: false,
  p1Name: 'P1',
  p2Name: 'P2',
};

const HUMAN_VS_CPU: MatchSimConfig = {
  seed: 0xbadf00d,
  vsAI: true,
  cpuVsCpu: false,
  p1Name: 'P1',
  p2Name: 'CPU',
  p2Personality: getFighterPersonality('brawler'),
  p2Difficulty: 0.6,
};

const CPU_VS_CPU: MatchSimConfig = {
  seed: 0x5eed,
  vsAI: true,
  cpuVsCpu: true,
  p1Name: 'CPU 1',
  p2Name: 'CPU 2',
  p1Personality: getFighterPersonality('zoner'),
  p2Personality: getFighterPersonality('showboat'),
};

/**
 * Scripted "human" inputs: directions are held for a while, buttons pulse
 * for exactly one tick, occasionally a quarter-circle is rolled. Seeded, so
 * every test run produces the same stream.
 */
class InputScript {
  private rng: SeededRng;
  private held: FighterInput = { ...EMPTY_INPUT };
  private holdTicks = 0;
  private motion: FighterInput[] = [];

  constructor(seed: number) {
    this.rng = new SeededRng(seed);
  }

  next(): FighterInput {
    if (this.motion.length > 0) {
      return this.motion.shift()!;
    }
    if (this.holdTicks <= 0) {
      const roll = this.rng.next();
      this.held = {
        ...EMPTY_INPUT,
        left: roll < 0.25,
        right: roll >= 0.25 && roll < 0.5,
        down: roll >= 0.5 && roll < 0.65,
        up: roll >= 0.65 && roll < 0.72,
        guard: roll >= 0.72 && roll < 0.8,
      };
      this.holdTicks = this.rng.nextInt(4, 30);
      if (this.rng.next() < 0.08) {
        // quarter-circle forward + punch
        this.motion = [
          { ...EMPTY_INPUT, down: true },
          { ...EMPTY_INPUT, down: true, right: true },
          { ...EMPTY_INPUT, right: true },
          { ...EMPTY_INPUT, right: true, punch: true },
        ];
      }
    }
    this.holdTicks--;
    const press = this.rng.next();
    return {
      ...this.held,
      punch: press < 0.06,
      kick: press >= 0.06 && press < 0.11,
      fireball: press >= 0.11 && press < 0.125,
      uppercut: press >= 0.125 && press < 0.135,
      super: press >= 0.135 && press < 0.15,
    };
  }
}

interface Frame {
  p1: FighterInput;
  p2: FighterInput;
}

function scriptFrames(count: number, seed: number): Frame[] {
  const s1 = new InputScript(seed);
  const s2 = new InputScript(seed ^ 0x9e3779b9);
  const frames: Frame[] = [];
  for (let i = 0; i < count; i++) frames.push({ p1: s1.next(), p2: s2.next() });
  return frames;
}

function runSim(config: MatchSimConfig, frames: Frame[]): { sim: MatchSimulation; checksums: number[]; events: MatchSimEvent[] } {
  const sim = new MatchSimulation(config);
  const events = sim.start();
  const checksums: number[] = [];
  for (const frame of frames) {
    events.push(...sim.step(frame.p1, frame.p2));
    checksums.push(sim.checksum());
  }
  return { sim, checksums, events };
}

function stepThrough(sim: MatchSimulation, ticks: number, input: FighterInput = EMPTY_INPUT): MatchSimEvent[] {
  const events: MatchSimEvent[] = [];
  for (let i = 0; i < ticks; i++) events.push(...sim.step(input, input));
  return events;
}

describe('FighterInput codec', () => {
  it('packs and unpacks every field losslessly', () => {
    for (let bits = 0; bits < 1024; bits++) {
      expect(packInput(unpackInput(bits))).toBe(bits);
    }
    expect(inputsEqual(unpackInput(0b1010101010), unpackInput(0b1010101010))).toBe(true);
    expect(inputsEqual(unpackInput(1), unpackInput(2))).toBe(false);
  });
});

describe('MatchSimulation determinism', () => {
  it.each([
    ['human vs human', HUMAN_VS_HUMAN],
    ['human vs cpu', HUMAN_VS_CPU],
    ['cpu vs cpu', CPU_VS_CPU],
  ])('%s: two sims fed the same inputs stay bit-identical every tick', (_label, config) => {
    const frames = scriptFrames(4_000, config.seed);
    const a = runSim(config, frames);
    const b = runSim(config, frames);

    expect(a.checksums).toEqual(b.checksums);
    expect(a.sim.snapshot()).toEqual(b.sim.snapshot());
    expect(a.events).toEqual(b.events);
    // The script actually produced a fight, not two idle fighters.
    expect(a.events.some((event) => event.type === 'hit' || event.type === 'projectileHit')).toBe(true);
    expect(a.sim.p1.health + a.sim.p2.health).toBeLessThan(MAX_HEALTH * 2);
  });

  it('different seeds diverge once the CPU acts (the seed is really used)', () => {
    const frames = scriptFrames(1_500, 7);
    const a = runSim(HUMAN_VS_CPU, frames);
    const b = runSim({ ...HUMAN_VS_CPU, seed: HUMAN_VS_CPU.seed + 1 }, frames);
    expect(a.checksums[a.checksums.length - 1]).not.toBe(b.checksums[b.checksums.length - 1]);
  });

  it('checksum ignores nothing: a single-field change is detected', () => {
    const sim = new MatchSimulation(HUMAN_VS_HUMAN);
    sim.start();
    stepThrough(sim, 200);
    const before = sim.checksum();
    sim.p2.meter += 1;
    expect(sim.checksum()).not.toBe(before);
  });
});

describe('MatchSimulation snapshot/restore', () => {
  it.each([
    ['human vs human', HUMAN_VS_HUMAN],
    ['human vs cpu', HUMAN_VS_CPU],
  ])('%s: restoring a snapshot replays the exact same future', (_label, config) => {
    const frames = scriptFrames(3_000, config.seed + 11);
    const sim = new MatchSimulation(config);
    sim.start();

    const SNAP_AT = 900;
    let snapshot = sim.snapshot();
    const afterSnapshot: number[] = [];
    for (let i = 0; i < frames.length; i++) {
      sim.step(frames[i].p1, frames[i].p2);
      if (i === SNAP_AT) snapshot = sim.snapshot();
      if (i > SNAP_AT) afterSnapshot.push(sim.checksum());
    }

    // Snapshot is a deep copy: mutating the live sim does not touch it.
    const snapshotJson = JSON.stringify(snapshot);

    sim.restore(snapshot);
    expect(sim.tick).toBe(snapshot.tick);
    const replayed: number[] = [];
    for (let i = SNAP_AT + 1; i < frames.length; i++) {
      sim.step(frames[i].p1, frames[i].p2);
      replayed.push(sim.checksum());
    }
    expect(replayed).toEqual(afterSnapshot);
    expect(JSON.stringify(snapshot)).toBe(snapshotJson);
  });

  it('restores into a fresh instance built from the same config', () => {
    const frames = scriptFrames(1_200, 42);
    const source = runSim(HUMAN_VS_CPU, frames);
    const snapshot = source.sim.snapshot();

    const clone = new MatchSimulation(HUMAN_VS_CPU);
    clone.start();
    clone.restore(snapshot);
    expect(clone.checksum()).toBe(source.sim.checksum());

    const more = scriptFrames(600, 43);
    for (const frame of more) {
      source.sim.step(frame.p1, frame.p2);
      clone.step(frame.p1, frame.p2);
      expect(clone.checksum()).toBe(source.sim.checksum());
    }
  });

  it('survives rollback with mispredicted opponent inputs (GGPO-style)', () => {
    // Ground truth: both inputs known every tick.
    const frames = scriptFrames(2_400, 99);
    const truth = runSim(HUMAN_VS_HUMAN, frames);

    // Client: knows P1 (local) immediately, learns P2 (remote) DELAY ticks
    // late. Predicts the remote input by repeating the last known one, then
    // rolls back and re-simulates whenever the real input differs.
    const DELAY = 4;
    const client = new MatchSimulation(HUMAN_VS_HUMAN);
    client.start();
    const history: Array<{ snapshot: ReturnType<MatchSimulation['snapshot']>; predictedP2: FighterInput }> = [];
    let lastKnownP2: FighterInput = EMPTY_INPUT;
    let confirmedUpTo = -1;
    let rollbacks = 0;

    for (let t = 0; t < frames.length; t++) {
      // Real remote input for tick t - DELAY arrives now.
      const arriving = t - DELAY;
      if (arriving >= 0) {
        const real = frames[arriving].p2;
        const entry = history[arriving];
        if (!inputsEqual(entry.predictedP2, real)) {
          rollbacks++;
          client.restore(entry.snapshot);
          // Re-simulate: the arriving tick uses the real input, later ticks
          // predict "same as last known", which is now that real input.
          for (let r = arriving; r < t; r++) {
            history[r] = { snapshot: client.snapshot(), predictedP2: real };
            client.step(frames[r].p1, real);
          }
        }
        lastKnownP2 = real;
        confirmedUpTo = arriving;
      }

      const predictedP2 = lastKnownP2;
      history[t] = { snapshot: client.snapshot(), predictedP2 };
      client.step(frames[t].p1, predictedP2);
    }

    // Flush the tail: deliver the last DELAY remote inputs.
    for (let arriving = confirmedUpTo + 1; arriving < frames.length; arriving++) {
      const real = frames[arriving].p2;
      const entry = history[arriving];
      if (!inputsEqual(entry.predictedP2, real)) {
        rollbacks++;
        client.restore(entry.snapshot);
        for (let r = arriving; r < frames.length; r++) {
          history[r] = { snapshot: client.snapshot(), predictedP2: frames[r].p2 };
          client.step(frames[r].p1, frames[r].p2);
        }
        break;
      }
    }

    expect(rollbacks).toBeGreaterThan(0);
    expect(client.checksum()).toBe(truth.sim.checksum());
    expect(client.snapshot()).toEqual(truth.sim.snapshot());
  });
});

describe('MatchSimulation round flow (tick-driven)', () => {
  it('preserves the normal round target and lets a one-round trial end immediately', () => {
    const standard = new MatchSimulation(HUMAN_VS_HUMAN);
    standard.start();
    stepThrough(standard, CINEMATIC_INTRO_TICKS);
    standard.p2.health = 0;
    const standardEvents = standard.step(EMPTY_INPUT, EMPTY_INPUT);
    expect(standard.roundsToWin).toBe(ROUNDS_TO_WIN);
    expect(standardEvents).not.toContainEqual({ type: 'matchEnd', winner: 0 });
    expect(standard.phase).toBe(RoundPhase.ROUND_END);

    const trial = new MatchSimulation({ ...HUMAN_VS_HUMAN, roundsToWin: 1 });
    trial.start();
    stepThrough(trial, CINEMATIC_INTRO_TICKS);
    trial.p2.health = 0;
    const trialEvents = trial.step(EMPTY_INPUT, EMPTY_INPUT);
    expect(trial.roundsToWin).toBe(1);
    expect(trial.p1Wins).toBe(1);
    expect(trialEvents).toContainEqual({ type: 'matchEnd', winner: 0 });
    expect(trial.phase).toBe(RoundPhase.MATCH_END);
  });

  it('runs the cinematic intro on ticks, then a shorter card for later rounds', () => {
    const sim = new MatchSimulation(HUMAN_VS_HUMAN);
    const startEvents = sim.start();
    expect(startEvents).toEqual([{ type: 'roundStart', roundNumber: 1, cinematic: true }]);
    expect(sim.phase).toBe(RoundPhase.INTRO);
    expect(sim.canSkipIntro).toBe(false);

    const introEvents = stepThrough(sim, CINEMATIC_SKIPPABLE_TICK);
    expect(introEvents).toContainEqual({ type: 'introCue', cue: 'skippable', roundNumber: 1 });
    expect(sim.canSkipIntro).toBe(true);

    const rest = stepThrough(sim, CINEMATIC_INTRO_TICKS - CINEMATIC_SKIPPABLE_TICK);
    expect(rest.map((event) => event.type)).toEqual(['introCue', 'introCue', 'introCue', 'fightStart']);
    expect(rest[rest.length - 1]).toEqual({ type: 'fightStart', skipped: false });
    expect(sim.phase).toBe(RoundPhase.FIGHTING);
    expect(sim.tick).toBe(CINEMATIC_INTRO_TICKS);
  });

  it('applies an intro skip on the next tick only while skippable', () => {
    const sim = new MatchSimulation(HUMAN_VS_HUMAN);
    sim.start();
    expect(sim.requestIntroSkip()).toBe(false);
    stepThrough(sim, CINEMATIC_SKIPPABLE_TICK);
    expect(sim.requestIntroSkip()).toBe(true);
    expect(sim.phase).toBe(RoundPhase.INTRO);
    const events = sim.step(EMPTY_INPUT, EMPTY_INPUT);
    expect(events).toEqual([{ type: 'fightStart', skipped: true }]);
    expect(sim.phase).toBe(RoundPhase.FIGHTING);
    expect(sim.p1.state).toBe(FighterState.IDLE);
    expect(sim.p2.state).toBe(FighterState.IDLE);
  });

  it('times out a dead-even round as a draw and replays it with the short intro', () => {
    const sim = new MatchSimulation(HUMAN_VS_HUMAN);
    sim.start();
    stepThrough(sim, CINEMATIC_INTRO_TICKS);
    expect(sim.timerSeconds).toBe(99);

    const events = stepThrough(sim, ROUND_TICKS);
    expect(sim.phase).toBe(RoundPhase.ROUND_END);
    expect(sim.timerSeconds).toBe(0);
    expect(events).toContainEqual({ type: 'roundEnd', outcome: 'draw', winner: null });
    expect(sim.p1Wins).toBe(0);
    expect(sim.p2Wins).toBe(0);

    const next = stepThrough(sim, ROUND_END_TICKS);
    expect(next).toContainEqual({ type: 'roundStart', roundNumber: 1, cinematic: false });
    expect(next).toContainEqual({ type: 'introCue', cue: 'round', roundNumber: 1 });
    expect(sim.phase).toBe(RoundPhase.INTRO);
    expect(sim.phaseTimer).toBe(ROUND_INTRO_TICKS);
  });

  it('plays a whole CPU vs CPU match to matchOver and then stops mutating', () => {
    const sim = new MatchSimulation(CPU_VS_CPU);
    sim.start();
    const seen: MatchSimEvent[] = [];
    let guard = 0;
    while (sim.phase !== RoundPhase.MATCH_OVER && guard++ < 60_000) {
      seen.push(...sim.step(EMPTY_INPUT, EMPTY_INPUT));
    }
    expect(sim.phase).toBe(RoundPhase.MATCH_OVER);
    const matchEnd = seen.find((event) => event.type === 'matchEnd');
    expect(matchEnd).toBeDefined();
    expect(seen.filter((event) => event.type === 'roundEnd').length).toBeGreaterThanOrEqual(2);
    expect(seen).toContainEqual({ type: 'winsCue', winner: (matchEnd as { winner: 0 | 1 }).winner });
    expect(seen[seen.length - 1]).toEqual({ type: 'matchOver' });
    expect(Math.max(sim.p1Wins, sim.p2Wins)).toBe(2);

    const digest = sim.checksum();
    const tick = sim.tick;
    expect(sim.step(EMPTY_INPUT, EMPTY_INPUT)).toEqual([]);
    expect(sim.checksum()).toBe(digest);
    expect(sim.tick).toBe(tick);
    expect(MATCH_END_TICKS).toBeGreaterThan(0);
  });

  it('keeps the seeded CPU stream aligned across hitstop (no RNG draws while frozen)', () => {
    const frames = scriptFrames(2_000, 5);
    const a = runSim(HUMAN_VS_CPU, frames);
    expect(a.events.some((event) => event.type === 'hit')).toBe(true);
    const b = runSim(HUMAN_VS_CPU, frames);
    expect(b.sim.snapshot().ai).toEqual(a.sim.snapshot().ai);
  });
});
