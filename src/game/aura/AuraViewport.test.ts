import { describe, expect, it } from 'vitest';
import { getAuraCanvasSize } from './AuraViewport.ts';
import { createAuraPresentationToken, isAuraPresentationDetail } from './AuraPresentationEvents.ts';

describe('Aura viewport and presentation identity', () => {
  it.each([[390, 844], [767, 1024]])('uses upright canvas at %s × %s without querying input hardware', (width, height) => {
    expect(getAuraCanvasSize(width, height)).toEqual({ width: 576, height: 1024, portrait: true });
  });
  it.each([[768, 1024], [844, 390], [390, 390], [0, 1024], [NaN, 844], [390, Infinity]])('keeps landscape canvas at %s × %s', (width, height) => {
    expect(getAuraCanvasSize(width, height)).toEqual({ width: 1024, height: 576, portrait: false });
  });
  it('allocates a new token even when a rematch reuses its seed', () => {
    const previous = createAuraPresentationToken();
    expect(createAuraPresentationToken()).toBeGreaterThan(previous);
  });
  it('accepts only a complete, bounded lifecycle identity and known phase', () => {
    expect(isAuraPresentationDetail({ token: 1, seed: 0xffffffff, phase: 'ready' })).toBe(true);
    for (const detail of [null, {}, { token: 0, seed: 1, phase: 'ready' }, { token: 1, seed: -1, phase: 'ready' },
      { token: 1, seed: 0x100000000, phase: 'ready' }, { token: 1, seed: 1, phase: 'started' }]) {
      expect(isAuraPresentationDetail(detail)).toBe(false);
    }
  });
});
