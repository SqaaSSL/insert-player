import { describe, expect, it } from 'vitest';
import {
  AURA_BEAT_MS,
  AURA_DEFAULT_LANE_KEYS,
  AURA_LOCAL_P1_LANE_KEYS,
  AURA_LOCAL_P2_LANE_KEYS,
  AURA_NOTE_TRAVEL_MS,
  AURA_ROUNDS,
} from './AuraConfig.ts';
import { auraNoteTravelProgress, createAuraChart } from './AuraChart.ts';
import { AuraBattle, auraRank, createAuraCpuPlan } from './AuraBattle.ts';
import { AURA_TRACKS, DEFAULT_AURA_TRACK, getAuraTrack, pickAuraTrackForMatch, pickAuraTrackFromSeed } from './AuraTracks.ts';

describe('Aura chart', () => {
  it('is deterministic and gives both players the same phrase', () => {
    const first = createAuraChart(42, 'viral');
    const second = createAuraChart(42, 'viral');
    expect(second).toEqual(first);
    expect(first.turns).toHaveLength(AURA_ROUNDS * 2);
    for (let round = 0; round < AURA_ROUNDS; round += 1) {
      const lead = first.turns[round * 2].notes.map(({ beat, lane }) => ({ beat, lane }));
      const response = first.turns[round * 2 + 1].notes.map(({ beat, lane }) => ({ beat, lane }));
      expect(response).toEqual(lead);
    }
  });

  it('escalates density across three rounds without changing turn length', () => {
    const chart = createAuraChart(42, 'viral');
    const leadTurns = chart.turns.filter((turn) => turn.slot === 0);
    expect(leadTurns).toHaveLength(3);
    expect(leadTurns.map((turn) => turn.notes.length)).toEqual([22, 24, 26]);
    for (const turn of leadTurns) {
      expect(turn.endMs - turn.startMs).toBeCloseTo(20 * AURA_BEAT_MS);
    }
  });

  it('changes the phrase when the seed changes', () => {
    const lanes = (seed: number) => createAuraChart(seed).notes.map((note) => note.lane);
    expect(lanes(1)).not.toEqual(lanes(2));
  });

  it('never puts consecutive notes on the same rail', () => {
    for (const difficulty of ['lowkey', 'viral', 'untouchable'] as const) {
      for (let seed = 1; seed <= 64; seed += 1) {
        const chart = createAuraChart(seed, difficulty);
        for (const turn of chart.turns) {
          for (let index = 1; index < turn.notes.length; index += 1) {
            expect(turn.notes[index].lane).not.toBe(turn.notes[index - 1].lane);
          }
          for (const lane of [0, 1, 2, 3] as const) {
            const laneNotes = turn.notes.filter((note) => note.lane === lane);
            for (let index = 1; index < laneNotes.length; index += 1) {
              expect(laneNotes[index].beat - laneNotes[index - 1].beat).toBeGreaterThanOrEqual(1);
            }
          }
        }
      }
    }
  });

  it('moves every note at one constant four-beat scroll rate', () => {
    const targetMs = 10_000;
    expect(AURA_NOTE_TRAVEL_MS).toBeCloseTo(AURA_BEAT_MS * 4);
    expect(auraNoteTravelProgress(targetMs, targetMs - AURA_BEAT_MS * 4)).toBeCloseTo(0);
    expect(auraNoteTravelProgress(targetMs, targetMs - AURA_BEAT_MS * 3)).toBeCloseTo(0.25);
    expect(auraNoteTravelProgress(targetMs, targetMs - AURA_BEAT_MS * 2)).toBeCloseTo(0.5);
    expect(auraNoteTravelProgress(targetMs, targetMs - AURA_BEAT_MS)).toBeCloseTo(0.75);
    expect(auraNoteTravelProgress(targetMs, targetMs)).toBeCloseTo(1);
    expect(auraNoteTravelProgress(targetMs, targetMs + AURA_BEAT_MS)).toBeCloseTo(1.25);

    const chart = createAuraChart(42, 'viral');
    for (const turn of chart.turns) {
      expect(turn.firstNoteMs - turn.startMs).toBeCloseTo(AURA_NOTE_TRAVEL_MS);
    }
  });

  it('locks every timing to the chosen track', () => {
    const slow = { id: 'test-slow', title: 'Slow', url: '/x.mp3', bpm: 120, beatOffsetMs: 500 };
    const chart = createAuraChart(42, 'viral', slow);
    expect(chart.trackId).toBe('test-slow');
    expect(chart.beatMs).toBeCloseTo(500);
    expect(chart.beatOffsetMs).toBe(500);
    expect(chart.noteTravelMs).toBeCloseTo(2_000);
    expect(chart.firstTurnMs).toBeCloseTo(500 + 8 * 500);
    for (const turn of chart.turns) {
      expect(turn.firstNoteMs - turn.startMs).toBeCloseTo(chart.noteTravelMs);
      expect(turn.endMs - turn.startMs).toBeCloseTo(20 * 500);
    }
    // Same phrase, different clock: lanes are identical, times scale with the beat.
    const reference = createAuraChart(42, 'viral');
    expect(chart.notes.map((note) => note.lane)).toEqual(reference.notes.map((note) => note.lane));
    expect(reference.trackId).toBe(DEFAULT_AURA_TRACK.id);
    expect(auraNoteTravelProgress(10_000, 8_000, chart.noteTravelMs)).toBeCloseTo(0);
    expect(getAuraTrack('does-not-exist')).toBeNull();
    expect(pickAuraTrackFromSeed(7)).toBe(pickAuraTrackFromSeed(7));
    // Stage pairing prefers a track written for the stage and never fails on unknown stages.
    const paired = pickAuraTrackForMatch(7, DEFAULT_AURA_TRACK.stageId);
    expect(paired.stageId).toBe(DEFAULT_AURA_TRACK.stageId);
    expect(AURA_TRACKS).toContain(pickAuraTrackForMatch(7, 'no-such-stage'));
    // The Fight/Rush battle theme never enters the draw once real tracks exist.
    if (AURA_TRACKS.length > 0 && getAuraTrack('neon-arena')?.fallback) {
      expect(AURA_TRACKS.some((track) => track.id === 'neon-arena')).toBe(AURA_TRACKS.every((track) => track.fallback));
    }
  });

  it('uses a two-hand default while keeping local-versus controls conflict-free', () => {
    expect(AURA_DEFAULT_LANE_KEYS).toEqual(['D', 'F', 'J', 'K']);
    expect(new Set([...AURA_LOCAL_P1_LANE_KEYS, ...AURA_LOCAL_P2_LANE_KEYS]).size).toBe(8);
  });
});

describe('AuraBattle', () => {
  it('grades timing, builds flow, and rejects mashing', () => {
    const chart = createAuraChart(7, 'viral');
    const battle = new AuraBattle(chart, 'viral');
    const note = chart.turns[0].notes[0];
    expect(battle.judgeInput(0, note.lane, note.atMs + 12).grade).toBe('perfect');
    expect(battle.scoreFor(0).score).toBe(1_000);
    expect(battle.judgeInput(0, ((note.lane + 1) % 4) as 0 | 1 | 2 | 3, note.atMs + 20).grade).toBe('mash');
    expect(battle.scoreFor(0).combo).toBe(0);
    expect(battle.scoreFor(0).mashes).toBe(1);
  });

  it('does not punish inputs during the rival turn', () => {
    const chart = createAuraChart(9);
    const battle = new AuraBattle(chart);
    const p2Turn = chart.turns[1];
    const result = battle.judgeInput(0, 0, p2Turn.startMs + 10);
    expect(result.grade).toBe('wrong_turn');
    expect(battle.scoreFor(0).score).toBe(0);
    expect(battle.scoreFor(0).mashes).toBe(0);
  });

  it('collects expired notes once', () => {
    const chart = createAuraChart(11, 'viral');
    const battle = new AuraBattle(chart, 'viral');
    const first = chart.turns[0].notes[0];
    const misses = battle.collectMisses(first.atMs + 500, [0]);
    expect(misses.some((entry) => entry.noteId === first.id)).toBe(true);
    expect(battle.collectMisses(first.atMs + 500, [0])).toHaveLength(0);
  });

  it('builds a deterministic and threatening default CPU', () => {
    const chart = createAuraChart(99, 'viral');
    const first = createAuraCpuPlan(chart, 1, 'viral');
    expect(createAuraCpuPlan(chart, 1, 'viral')).toEqual(first);
    const hits = first.filter((entry) => entry.grade !== 'miss').length;
    expect(hits / first.length).toBeGreaterThan(0.8);
  });

  it('reserves NPC rank for a genuinely disastrous performance', () => {
    const chart = createAuraChart(4, 'lowkey');
    const battle = new AuraBattle(chart, 'lowkey');
    battle.collectMisses(chart.durationMs, [0]);
    expect(auraRank(battle.scoreFor(0))).toBe('NPC');
  });
});
