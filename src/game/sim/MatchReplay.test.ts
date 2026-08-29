import { describe, expect, it } from 'vitest';
import {
  CHECKSUM_INTERVAL,
  MatchRecorder,
  decodeFrames,
  encodeFrames,
  isValidMatchRecording,
  packTick,
  replayMatch,
  toRecordingConfig,
  toSimConfig,
  unpackTick,
  type MatchRecording,
} from './MatchReplay.ts';
import { CINEMATIC_SKIPPABLE_TICK, MatchSimulation, RoundPhase, type MatchSimConfig } from './MatchSimulation.ts';
import { EMPTY_INPUT, type FighterInput } from './FighterInput.ts';
import { SeededRng } from '../utils/SeededRng.ts';
import { getFighterPersonality } from '../match/MatchConfig.ts';

const CONFIG: MatchSimConfig = {
  seed: 0x1234abcd,
  vsAI: true,
  cpuVsCpu: false,
  p1Name: 'Rec',
  p2Name: 'CPU',
  p2Personality: getFighterPersonality('counter'),
  p2Difficulty: 0.8,
};

function scriptedInput(rng: SeededRng, prev: FighterInput): FighterInput {
  if (rng.next() < 0.85) {
    return { ...prev, punch: rng.next() < 0.05, kick: rng.next() < 0.04, fireball: false, uppercut: rng.next() < 0.01, super: rng.next() < 0.01 };
  }
  const roll = rng.next();
  return {
    ...EMPTY_INPUT,
    left: roll < 0.3,
    right: roll >= 0.3 && roll < 0.6,
    down: roll >= 0.6 && roll < 0.75,
    up: roll >= 0.75 && roll < 0.82,
    guard: roll >= 0.82 && roll < 0.9,
  };
}

/** Play a live match while recording it, exactly like FightScene does. */
function recordLiveMatch(config: MatchSimConfig, ticks: number, seed = 1, skipIntro = false) {
  const sim = new MatchSimulation(config);
  sim.start();
  const recorder = new MatchRecorder(config);
  const rng = new SeededRng(seed);
  let p1: FighterInput = EMPTY_INPUT;
  let p2: FighterInput = EMPTY_INPUT;
  for (let i = 0; i < ticks; i++) {
    p1 = scriptedInput(rng, p1);
    p2 = scriptedInput(rng, p2);
    const skip = skipIntro && sim.canSkipIntro;
    if (skip) sim.requestIntroSkip();
    recorder.recordTick(p1, p2, skip);
    sim.step(p1, p2);
    recorder.sampleChecksum(sim);
  }
  return { sim, recording: recorder.toRecording() };
}

describe('tick packing and run-length frames', () => {
  it('packs both inputs and the skip flag into one word', () => {
    const p1 = { ...EMPTY_INPUT, left: true, punch: true };
    const p2 = { ...EMPTY_INPUT, down: true, super: true };
    const word = packTick(p1, p2, true);
    const back = unpackTick(word);
    expect(back.p1).toEqual(p1);
    expect(back.p2).toEqual(p2);
    expect(back.skipIntro).toBe(true);
    expect(unpackTick(packTick(p1, p2)).skipIntro).toBe(false);
  });

  it('round-trips run-length encoding and actually compresses held inputs', () => {
    const words = [5, 5, 5, 5, 9, 9, 0, 5, 5];
    const encoded = encodeFrames(words);
    expect(encoded).toEqual([5, 4, 9, 2, 0, 1, 5, 2]);
    expect(decodeFrames(encoded)).toEqual(words);
    expect(decodeFrames(encodeFrames([]))).toEqual([]);
  });

  it('maps sim config to a serializable recording config and back', () => {
    const rec = toRecordingConfig(CONFIG);
    expect(rec).toEqual({
      seed: 0x1234abcd,
      vsAI: true,
      cpuVsCpu: false,
      p1Name: 'Rec',
      p2Name: 'CPU',
      p1PersonalityId: 'balanced',
      p2PersonalityId: 'counter',
      p2Difficulty: 0.8,
    });
    const sim = toSimConfig(rec);
    expect(sim.p2Personality?.id).toBe('counter');
    expect(sim.p1Personality?.id).toBe('balanced');
  });
});

describe('replayMatch', () => {
  it('reproduces a recorded live match bit-for-bit, including recorded checksums', () => {
    const { sim, recording } = recordLiveMatch(CONFIG, 3_000);
    expect(recording.tickCount).toBe(3_000);
    expect(recording.frames.length).toBeLessThan(3_000); // RLE did something
    expect(recording.checksums.length).toBe((3_000 / CHECKSUM_INTERVAL) * 2);

    const json = JSON.stringify(recording);
    const parsed = JSON.parse(json) as MatchRecording;
    expect(isValidMatchRecording(parsed)).toBe(true);

    const result = replayMatch(parsed);
    expect(result.desyncAtTick).toBeNull();
    expect(result.ticksPlayed).toBe(3_000);
    expect(result.finalChecksum).toBe(sim.checksum());
    expect(result.sim.snapshot()).toEqual(sim.snapshot());
    expect(result.events.some((event) => event.type === 'hit' || event.type === 'projectileHit')).toBe(true);
  });

  it('replays an intro skip at the same tick', () => {
    const { sim, recording } = recordLiveMatch(CONFIG, 600, 3, true);
    expect(sim.phase).not.toBe(RoundPhase.INTRO);
    const skipWords = decodeFrames(recording.frames).filter((word) => unpackTick(word).skipIntro);
    expect(skipWords.length).toBe(1);

    let fightStartTick = -1;
    const result = replayMatch(recording, {
      onTick: (_sim, tick, events) => {
        if (events.some((event) => event.type === 'fightStart')) fightStartTick = tick;
      },
    });
    expect(fightStartTick).toBe(CINEMATIC_SKIPPABLE_TICK + 1);
    expect(result.desyncAtTick).toBeNull();
    expect(result.finalChecksum).toBe(sim.checksum());
  });

  it('pinpoints the first checksum interval after a corrupted input', () => {
    const { recording } = recordLiveMatch(CONFIG, 2_400, 7);
    const words = decodeFrames(recording.frames);
    // Flip a punch on a tick well into the fight.
    const corruptAt = 1_000;
    words[corruptAt] ^= 1 << 5;
    const corrupted: MatchRecording = { ...recording, frames: encodeFrames(words) };

    const result = replayMatch(corrupted, { stopOnDesync: true });
    expect(result.desyncAtTick).not.toBeNull();
    expect(result.desyncAtTick!).toBeGreaterThan(corruptAt);
    expect(result.desyncAtTick! - corruptAt).toBeLessThanOrEqual(CHECKSUM_INTERVAL);
    expect(result.ticksPlayed).toBe(result.desyncAtTick);
  });

  it('can scrub to an arbitrary tick', () => {
    const { recording } = recordLiveMatch(CONFIG, 1_500, 9);
    const full = replayMatch(recording);
    const partial = replayMatch(recording, { untilTick: 700 });
    expect(partial.ticksPlayed).toBe(700);
    expect(partial.finalChecksum).not.toBe(full.finalChecksum);
    expect(partial.finalChecksum).toBe(replayMatch(recording, { untilTick: 700 }).finalChecksum);
  });

  it('rejects malformed recordings', () => {
    const { recording } = recordLiveMatch(CONFIG, 120, 11);
    expect(isValidMatchRecording(null)).toBe(false);
    expect(isValidMatchRecording({ ...recording, version: 99 })).toBe(false);
    expect(isValidMatchRecording({ ...recording, frames: [1] })).toBe(false);
    expect(() => replayMatch({ ...recording, tickCount: 5 })).toThrow(/tick count/);
  });
});
