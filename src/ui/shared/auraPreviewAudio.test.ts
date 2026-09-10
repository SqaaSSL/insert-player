import { describe, expect, it, vi } from 'vitest';
import { createAuraPreviewAudio, type AuraPreviewSound } from './auraPreviewAudio.ts';
import { AURA_PREVIEW_CHART, AURA_PREVIEW_CYCLE_MS, AURA_PREVIEW_TURN_MS, auraPreviewDuelAt } from './auraPreviewDuel.ts';

function setup() {
  const sound = {
    prepareAuraMoveAudio: vi.fn(), playAuraMove: vi.fn(),
    pauseBattleMusic: vi.fn(), resumeBattleMusic: vi.fn(), destroy: vi.fn(),
  } satisfies AuraPreviewSound;
  const create = vi.fn(() => sound);
  const audio = createAuraPreviewAudio(create);
  const update = (time: number, running = true, opening = 0) => audio.update(auraPreviewDuelAt(time, opening), time, running);
  return { sound, create, audio, update };
}

describe('Aura preview opt-in movement sounds', () => {
  it('creates no audio while muted and prepares synchronously in the enable gesture', () => {
    const { create, sound, audio, update } = setup();
    update(0);
    update(AURA_PREVIEW_CHART.turns[0].firstNoteMs);
    expect(create).not.toHaveBeenCalled();
    expect(audio.setEnabled(true)).toBe(true);
    expect(create).toHaveBeenCalledOnce();
    expect(sound.prepareAuraMoveAudio).toHaveBeenCalledOnce();
    expect(sound.resumeBattleMusic).toHaveBeenCalledOnce();
    expect(sound.playAuraMove).not.toHaveBeenCalled();
  });

  it('plays once when each movement bubble enters, regardless of its notes or frames', () => {
    const { sound, audio, update } = setup();
    update(0);
    audio.setEnabled(true);
    for (const turn of AURA_PREVIEW_CHART.turns) {
      update(turn.startMs);
      for (let time = turn.firstNoteMs; time < turn.endMs; time += 30) update(time);
    }
    expect(sound.playAuraMove.mock.calls.map(([name]) => name)).toEqual([
      'aura_one_leg', 'aura_one_leg', 'aura_six_seven', 'aura_six_seven', 'aura_floor_worm', 'aura_floor_worm',
    ]);
    update(AURA_PREVIEW_CYCLE_MS);
    update(AURA_PREVIEW_CYCLE_MS + AURA_PREVIEW_CHART.turns[0].firstNoteMs + 1);
    expect(sound.playAuraMove).toHaveBeenCalledTimes(7);
  });

  it('cancels sound on pause or hiding and does not replay the bubble on resume', () => {
    const { sound, audio, update } = setup();
    const first = AURA_PREVIEW_CHART.turns[0].firstNoteMs;
    update(0);
    audio.setEnabled(true);
    update(first);
    update(first + 30, false);
    expect(sound.pauseBattleMusic).toHaveBeenCalledOnce();
    update(first + 30, true);
    update(first + 60, true);
    expect(sound.playAuraMove).toHaveBeenCalledOnce();
    update(AURA_PREVIEW_TURN_MS, false);
    update(AURA_PREVIEW_CHART.turns[1].firstNoteMs, false);
    update(AURA_PREVIEW_CHART.turns[1].firstNoteMs, true);
    expect(sound.playAuraMove).toHaveBeenCalledOnce();
  });

  it('muting stops voices and unmuting consumes the current bubble instead of replaying it', () => {
    const { sound, audio, update } = setup();
    update(0);
    audio.setEnabled(true);
    update(AURA_PREVIEW_CHART.turns[0].firstNoteMs);
    audio.setEnabled(false);
    expect(sound.pauseBattleMusic).toHaveBeenCalledOnce();
    update(AURA_PREVIEW_TURN_MS);
    update(AURA_PREVIEW_CHART.turns[1].firstNoteMs);
    audio.setEnabled(true);
    update(AURA_PREVIEW_CHART.turns[1].firstNoteMs + 30);
    expect(sound.playAuraMove).toHaveBeenCalledOnce();
    expect(sound.prepareAuraMoveAudio).toHaveBeenCalledTimes(2);
  });

  it('stays silent while paused and releases its audio exactly once on unmount', () => {
    const { sound, create, audio, update } = setup();
    update(0, false);
    audio.setEnabled(true);
    expect(sound.resumeBattleMusic).not.toHaveBeenCalled();
    expect(sound.pauseBattleMusic).toHaveBeenCalledOnce();
    audio.destroy();
    audio.destroy();
    update(AURA_PREVIEW_CHART.turns[0].firstNoteMs);
    expect(audio.setEnabled(true)).toBe(false);
    expect(create).toHaveBeenCalledOnce();
    expect(sound.destroy).toHaveBeenCalledOnce();
    expect(sound.pauseBattleMusic).toHaveBeenCalledTimes(2);
    expect(sound.playAuraMove).not.toHaveBeenCalled();
  });

  it('leaves sound off if construction fails and permits a later explicit retry', () => {
    const { create, audio, update } = setup();
    create.mockImplementationOnce(() => { throw new Error('Audio unavailable'); });
    update(0);
    expect(audio.setEnabled(true)).toBe(false);
    expect(audio.setEnabled(true)).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
  });
});
