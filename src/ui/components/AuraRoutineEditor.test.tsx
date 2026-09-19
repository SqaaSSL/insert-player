import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { MatchSceneData } from '../../game/match/MatchConfig.ts';
import { AuraRoutineEditor, auraRoutinePlayerSlots, moveAuraGesture, prepareAuraRoutines, replaceAuraGesture } from './AuraRoutineEditor.tsx';
import { resolveAuraPerformanceRoutine, type AuraMatchSelection } from '../../game/aura/AuraChoreography.ts';

const routine: AuraMatchSelection = [
  ['aura_six_seven', 'aura_six_seven', 'aura_floor_worm'],
  ['aura_glide', 'aura_mog_check', 'aura_one_leg'],
  ['aura_floor_worm', 'aura_one_leg', 'aura_six_seven'],
];

describe('Aura nine-move selection', () => {
  it('edits all nine positions independently without mutating saved rounds', () => {
    for (let index = 0; index < 9; index++) {
      const name = routine[Math.floor(index / 3)][index % 3] === 'aura_six_seven' ? 'aura_floor_worm' : 'aura_six_seven';
      const changed = replaceAuraGesture(routine, index, name);
      expect(changed.flat().filter((move, i) => move !== routine.flat()[i])).toEqual([name]);
      expect(changed[Math.floor(index / 3)][index % 3]).toBe(name);
      expect(changed.every((round, i) => round !== routine[i])).toBe(true);
    }
    expect(routine[2][2]).toBe('aura_six_seven');
    expect(replaceAuraGesture(routine, 9, 'aura_glide')).toEqual(routine);
  });
  it('reorders within and across round boundaries, keeping repeated moves and all nine positions', () => {
    expect(moveAuraGesture(routine, 2, -1)[0]).toEqual(['aura_six_seven', 'aura_floor_worm', 'aura_six_seven']);
    const boundary = moveAuraGesture(routine, 2, 1);
    expect(boundary[0][2]).toBe('aura_glide');
    expect(boundary[1][0]).toBe('aura_floor_worm');
    expect(moveAuraGesture(boundary, 3, -1)).toEqual(routine);
    const secondBoundary = moveAuraGesture(routine, 6, -1);
    expect(secondBoundary[1][2]).toBe('aura_floor_worm');
    expect(secondBoundary[2][0]).toBe('aura_one_leg');
    expect(moveAuraGesture(routine, 0, -1)).toEqual(routine);
    expect(moveAuraGesture(routine, 8, 1)).toEqual(routine);
  });
  it('seeds nine moves for both sides of a solo match, exposing only the human seat for editing', () => {
    const solo = prepareAuraRoutines({ seed: 17, vsAI: true });
    expect(auraRoutinePlayerSlots({ vsAI: true })).toEqual([0]);
    for (const side of solo) {
      expect(side).toHaveLength(3);
      expect(side?.every(round => round.length === 3)).toBe(true);
      expect(side?.flat()).toHaveLength(9);
    }
    expect(prepareAuraRoutines({ seed: 17, vsAI: true })).toEqual(solo);
    expect(prepareAuraRoutines({ seed: 17, vsAI: false }).every(slot => slot?.flat().length === 9)).toBe(true);
    expect(prepareAuraRoutines({ seed: 17, cpuVsCpu: true })).toEqual([null, null]);
  });
  it('opens predefined moves unchanged for fresh matches and new rematch seeds', () => {
    for (const seed of [17, 902]) {
      const prepared = prepareAuraRoutines({ seed, vsAI: true });
      for (const slot of [0, 1] as const) {
        expect(prepared[slot]).toEqual([0, 1, 2].map(round => resolveAuraPerformanceRoutine(seed, round, slot)));
      }
    }
  });
  it('lets either online seat choose its own nine moves without fabricating the remote choice', () => {
    for (const localSlot of [0, 1] as const) {
      const data = { online: { localSlot } } as MatchSceneData;
      expect(auraRoutinePlayerSlots(data)).toEqual([localSlot]);
      const prepared = prepareAuraRoutines(data);
      expect(prepared[localSlot]?.flat()).toHaveLength(9);
      expect(prepared[1 - localSlot]).toBeNull();
    }
  });
  it('reopens every round exactly, with deep copies and repeated moves preserved', () => {
    const previous = [routine, routine] as const;
    const next = prepareAuraRoutines({ seed: 91 }, previous);
    expect(next).toEqual(previous);
    expect(next[0]).not.toBe(routine);
    expect(next[0]?.every((round, i) => round !== routine[i])).toBe(true);
  });
  it('shows nine editable positions grouped into three rounds and all available animations', () => {
    const markup = renderToStaticMarkup(<AuraRoutineEditor data={{ p1Name: 'Player A' }} initialRoutines={[routine, null]} onPlay={vi.fn()} onExit={vi.fn()} />);
    expect(markup).toContain('Customize your moves');
    expect(markup).toContain('Your nine moves are ready: three per round');
    expect(markup.match(/Change round [123] move [123]:/g)).toHaveLength(9);
    expect(markup).toContain('Round 1');
    expect(markup).toContain('Round 2');
    expect(markup).toContain('Round 3');
    expect(markup).toContain('Change round 3 move 3: Six seven');
    expect(markup).toContain('Move gesture 9 earlier');
    expect(markup).toContain('Round 1, move 1: choose an animation');
    expect(markup).toContain('Save moves');
    expect(markup).toContain('One-leg hop');
    expect(markup).toContain('role="status"');
    expect(markup).not.toContain('Choose P2 moves');
  });
  it('lets either local player customize without a required second step', () => {
    const markup = renderToStaticMarkup(<AuraRoutineEditor data={{ vsAI: false, p1Name: 'A', p2Name: 'B' }} onPlay={vi.fn()} onExit={vi.fn()} />);
    expect(markup).toContain('Choose whose routine to edit');
    expect(markup).toContain('Save moves');
    expect(markup).not.toContain('Choose P2 moves');
  });
});
