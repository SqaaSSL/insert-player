import { describe, expect, it } from 'vitest';
import { createAuraChart } from './AuraChart.ts';
import { AuraBattle, auraRank, createAuraCpuPlan } from './AuraBattle.ts';

describe('Aura chart', () => {
  it('is deterministic and gives both players the same phrase', () => {
    const first = createAuraChart(42, 'viral');
    const second = createAuraChart(42, 'viral');
    expect(second).toEqual(first);
    expect(first.turns).toHaveLength(4);
    for (let round = 0; round < 2; round += 1) {
      const lead = first.turns[round * 2].notes.map(({ beat, lane }) => ({ beat, lane }));
      const response = first.turns[round * 2 + 1].notes.map(({ beat, lane }) => ({ beat, lane }));
      expect(response).toEqual(lead);
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
