import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { MatchSceneData } from '../../game/match/MatchConfig.ts';
import { AuraRoutineEditor, auraRoutinePlayerSlots, moveAuraGesture, prepareAuraRoutines, replaceAuraGesture } from './AuraRoutineEditor.tsx';
import type { AuraPerformanceRoutine } from '../../game/aura/AuraPerformance.ts';

const routine: AuraPerformanceRoutine = ['aura_six_seven', 'aura_six_seven', 'aura_floor_worm'];

describe('Aura routine selection', () => {
  it('allows repeated gestures and reorders individual positions without mutating the saved choice', () => {
    const chosen = replaceAuraGesture(['aura_six_seven', 'aura_glide', 'aura_floor_worm'], 1, 'aura_six_seven');
    expect(chosen).toEqual(routine);
    expect(moveAuraGesture(chosen, 2, -1)).toEqual(['aura_six_seven', 'aura_floor_worm', 'aura_six_seven']);
    expect(chosen).toEqual(routine);
    expect(moveAuraGesture(chosen, 0, -1)).toEqual(routine);
    expect(moveAuraGesture(chosen, 2, 1)).toEqual(routine);
  });
  it('prepares only human seats, leaving the CPU free to use the existing seeded routine', () => {
    const solo = prepareAuraRoutines({ seed: 17, vsAI: true });
    expect(solo[0]).toHaveLength(3);
    expect(solo[1]).toBeNull();
    expect(prepareAuraRoutines({ seed: 17, vsAI: true })).toEqual(solo);
    expect(prepareAuraRoutines({ seed: 17, vsAI: false }).every(slot => slot?.length === 3)).toBe(true);
  });
  it('lets either online seat choose only its own gestures', () => {
    for (const localSlot of [0, 1] as const) {
      const data = { online: { localSlot } } as MatchSceneData;
      expect(auraRoutinePlayerSlots(data)).toEqual([localSlot]);
      const prepared = prepareAuraRoutines(data);
      expect(prepared[localSlot]).toHaveLength(3);
      expect(prepared[1 - localSlot]).toBeNull();
    }
  });
  it('preserves a previous custom choice, including repeats, when opening the editor again', () => {
    const previous = [routine, null] as const;
    const next = prepareAuraRoutines({ seed: 91 }, previous);
    expect(next).toEqual(previous);
    expect(next[0]).not.toBe(routine);
  });
  it('shows all available gestures, order and accessible controls without demanding memorized keys', () => {
    const markup = renderToStaticMarkup(<AuraRoutineEditor data={{ p1Name: 'Player A' }} initialRoutines={[routine, null]} onPlay={vi.fn()} onExit={vi.fn()} />);
    expect(markup).toContain('Choose your moves');
    expect(markup).toContain('This order repeats each round.');
    expect(markup).toContain('Change move 2: Six seven');
    expect(markup).toContain('Move gesture 3 earlier');
    expect(markup).toContain('Pick gesture 1');
    expect(markup).toContain('Use this routine');
    expect(markup).toContain('One-leg hop');
    expect(markup).toContain('role="status"');
    expect(markup).not.toContain('Choose P2 moves');
  });
  it('makes the second local player a visible selection step', () => {
    const markup = renderToStaticMarkup(<AuraRoutineEditor data={{ vsAI: false, p1Name: 'A', p2Name: 'B' }} onPlay={vi.fn()} onExit={vi.fn()} />);
    expect(markup).toContain('Choose whose routine to edit');
    expect(markup).toContain('Choose P2 moves');
  });
});
