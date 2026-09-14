import { describe, expect, it } from 'vitest';
import { EMPTY_INPUT } from '../../game/sim/FighterInput.ts';
import { consumeVirtualInput, peekVirtualHeldInput, resetVirtualInput, setVirtualInputAction } from '../../game/systems/VirtualInput.ts';
import { controlPreviewMove } from './CombatMovePreview.tsx';

describe('isolated character movement previews', () => {
  it('selects the actual standing and low attack sheets', () => {
    expect(controlPreviewMove({ ...EMPTY_INPUT, kick: true }, 'fight')?.animation).toBe('high_kick');
    expect(controlPreviewMove({ ...EMPTY_INPUT, down: true, kick: true }, 'fight')?.animation).toBe('low_kick');
    expect(controlPreviewMove({ ...EMPTY_INPUT, down: true, punch: true }, 'fight')?.animation).toBe('low_punch');
    expect(controlPreviewMove({ ...EMPTY_INPUT, down: true, punch: true }, 'rush')?.animation).toBe('high_punch');
  });

  it('distinguishes Rush movement and jump from Fight movement', () => {
    expect(controlPreviewMove({ ...EMPTY_INPUT, up: true }, 'rush')?.animation).toBe('walk');
    expect(controlPreviewMove({ ...EMPTY_INPUT, up: true }, 'fight')?.animation).toBe('jump');
    expect(controlPreviewMove({ ...EMPTY_INPUT, uppercut: true }, 'rush')?.animation).toBe('jump');
    expect(controlPreviewMove(EMPTY_INPUT, 'fight')).toBeNull();
  });

  it('describes the procedural effects behind special move gestures', () => {
    expect(controlPreviewMove({ ...EMPTY_INPUT, fireball: true }, 'fight')).toMatchObject({ animation: 'high_punch', note: 'This gesture launches a projectile.' });
    expect(controlPreviewMove({ ...EMPTY_INPUT, super: true }, 'fight')?.note).toContain('full meter');
  });

  it('can preview held touch controls without stealing their gameplay edges', () => {
    resetVirtualInput();
    setVirtualInputAction(0, 'kick', true);
    expect(peekVirtualHeldInput(0).kick).toBe(true);
    expect(peekVirtualHeldInput(0).kick).toBe(true);
    setVirtualInputAction(0, 'kick', false);
    expect(peekVirtualHeldInput(0).kick).toBe(false);
    expect(consumeVirtualInput(0).kick).toBe(true);
    expect(consumeVirtualInput(0).kick).toBe(false);
    resetVirtualInput();
  });
});
