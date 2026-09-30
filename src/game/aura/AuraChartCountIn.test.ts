import { describe, expect, it } from 'vitest';
import { createAuraChart } from './AuraChart.ts';
import { AURA_FIRST_RUN_COUNT_IN_BEATS, AURA_INITIAL_COUNT_IN_BEATS } from './AuraConfig.ts';

describe('Aura first-run count-in', () => {
  it('keeps the shared two-bar chart byte-identical by default', () => {
    expect(JSON.stringify(createAuraChart(42, 'lowkey')))
      .toBe(JSON.stringify(createAuraChart(42, 'lowkey', undefined, AURA_INITIAL_COUNT_IN_BEATS)));
  });

  it('starts the demo one bar earlier and keeps every note on the same beat grid', () => {
    const shared = createAuraChart(42, 'lowkey');
    const firstRun = createAuraChart(42, 'lowkey', undefined, AURA_FIRST_RUN_COUNT_IN_BEATS);
    const shift = (AURA_INITIAL_COUNT_IN_BEATS - AURA_FIRST_RUN_COUNT_IN_BEATS) * shared.beatMs;
    expect(shared.turns[0].firstNoteMs - firstRun.turns[0].firstNoteMs).toBeCloseTo(shift, 6);
    expect(firstRun.notes.map(note => note.lane)).toEqual(shared.notes.map(note => note.lane));
    firstRun.notes.forEach((note, index) => expect(shared.notes[index].atMs - note.atMs).toBeCloseTo(shift, 6));
  });

  it('never accepts a count-in shorter than the note travel time', () => {
    expect(JSON.stringify(createAuraChart(7, 'viral', undefined, 1))).toBe(JSON.stringify(createAuraChart(7, 'viral')));
  });
});
