import { describe, expect, it } from 'vitest';
import { auraCameraComposition, AURA_CAMERA_FINALE_MS, AURA_CAMERA_HANDOFF_MS } from './AuraCamera.ts';
import { createAuraLayout } from './AuraLayout.ts';
import type { AuraSlot } from './AuraChart.ts';

describe('Aura continuous camera composition', () => {
  it('keeps presentation timing separate from the musical rules', () => {
    expect(AURA_CAMERA_HANDOFF_MS).toBeGreaterThanOrEqual(600);
    expect(AURA_CAMERA_HANDOFF_MS).toBeLessThanOrEqual(800);
    expect(AURA_CAMERA_FINALE_MS).toBe(800);
  });

  it.each([[1024, 576], [576, 1024]])('preserves the active stage mark and fixed UI at %i×%i', (width, height) => {
    const layout = createAuraLayout(width, height);
    const original = structuredClone(layout);
    for (const activeSlot of [0, 1] as const) {
      const view = auraCameraComposition(layout, { activeSlot });
      expect(view.performers[activeSlot]).toEqual({ ...layout.active, alpha: 1 });
      expect(view.performers[1 - activeSlot]).toMatchObject({ alpha: 0, visible: false });
      expect(view.transitioning).toBe(false);
      expect(view.finale).toBe(false);
    }
    expect(layout).toEqual(original);
  });

  it.each([0, 1] as const)('pans continuously from slot %i with both actors visible midway and no identity swap', fromSlot => {
    const activeSlot = (1 - fromSlot) as AuraSlot;
    const layout = createAuraLayout();
    const before = auraCameraComposition(layout, { activeSlot: fromSlot });
    const start = auraCameraComposition(layout, { fromSlot, activeSlot, transitionProgress: 0 });
    const middle = auraCameraComposition(layout, { fromSlot, activeSlot, transitionProgress: 0.5 });
    const end = auraCameraComposition(layout, { fromSlot, activeSlot, transitionProgress: 1 });
    const after = auraCameraComposition(layout, { activeSlot });
    expect(start.performers).toEqual(before.performers);
    expect(start.camera).toEqual(before.camera);
    expect(end.performers).toEqual(after.performers);
    expect(end.camera).toEqual(after.camera);
    expect(middle.performers.map(actor => actor.alpha)).toEqual([1, 1]);
    expect(middle.camera.zoom).toBeCloseTo(0.9, 10);
    let lastFocus = start.camera.focusX;
    for (let frame = 0; frame <= 120; frame++) {
      const view = auraCameraComposition(layout, { fromSlot, activeSlot, transitionProgress: frame / 120 });
      const [left, right] = view.performers;
      expect(left.x).toBeLessThan(right.x);
      expect((right.x - left.x) / view.camera.zoom).toBeCloseTo(layout.width * 0.24, 10);
      expect(left.height).toBe(right.height);
      expect(left.footY).toBe(layout.active.footY);
      expect(right.footY).toBe(layout.active.footY);
      expect(Math.abs(view.camera.focusX - lastFocus)).toBeLessThan(4);
      lastFocus = view.camera.focusX;
    }
  });

  it.each([0, 0.15, 0.5, 0.9, 1])('begins a finale at the exact handoff frame %s', transitionProgress => {
    const layout = createAuraLayout();
    const input = { activeSlot: 1 as const, fromSlot: 0 as const, transitionProgress };
    const before = auraCameraComposition(layout, input);
    const finale = auraCameraComposition(layout, { ...input, finaleProgress: 0 });
    expect(finale.performers).toEqual(before.performers);
    expect(finale.camera).toEqual(before.camera);
    expect(finale.backdropOffsetX).toBe(before.backdropOffsetX);
    expect(finale.backdropScale).toBe(before.backdropScale);
  });

  it.each([[1024, 576], [576, 1024]])('ends with two equal, close, centred bodies at %i×%i', (width, height) => {
    const layout = createAuraLayout(width, height);
    const leftStart = auraCameraComposition(layout, { activeSlot: 0, finaleProgress: 1 });
    const rightStart = auraCameraComposition(layout, { activeSlot: 1, finaleProgress: 1 });
    expect(leftStart.performers).toEqual(rightStart.performers);
    const [left, right] = leftStart.performers;
    expect(leftStart.transitioning).toBe(false);
    expect(leftStart.performers.map(actor => actor.alpha)).toEqual([1, 1]);
    expect(left.height).toBe(right.height);
    expect(left.x + right.x).toBeCloseTo(width, 10);
    expect(right.x - left.x).toBeLessThan(width * 0.35);
    expect(left.x - left.height * 0.28).toBeGreaterThan(0);
    expect(right.x + right.height * 0.28).toBeLessThan(width);
    expect(left.footY - left.height).toBeGreaterThan(layout.hudHeight);
    expect(left.footY).toBeLessThanOrEqual(layout.stage.y + layout.stage.height);
  });

  it('snaps handoffs and finales for reduced motion, with no residual pullback or hidden rival in the finale', () => {
    const layout = createAuraLayout();
    const handoff = auraCameraComposition(layout, { activeSlot: 1, fromSlot: 0, transitionProgress: 0.2, reducedMotion: true });
    expect(handoff.performers).toEqual(auraCameraComposition(layout, { activeSlot: 1 }).performers);
    expect(handoff.camera.zoom).toBe(1);
    expect(handoff.transitioning).toBe(false);
    const finale = auraCameraComposition(layout, { activeSlot: 1, fromSlot: 0, transitionProgress: 0.2, finaleProgress: 0, reducedMotion: true });
    expect(finale.performers).toEqual(auraCameraComposition(layout, { activeSlot: 1, finaleProgress: 1 }).performers);
    expect(finale.transitioning).toBe(false);
  });

  it.each([[1024, 576], [576, 1024]])('provides enough background overscan for every pan and finale at %i×%i', (width, height) => {
    const layout = createAuraLayout(width, height);
    for (const fromSlot of [0, 1] as const) for (let frame = 0; frame <= 100; frame++) {
      const activeSlot = (1 - fromSlot) as AuraSlot;
      const input = { fromSlot, activeSlot, transitionProgress: frame / 100 };
      const views = [auraCameraComposition(layout, input), auraCameraComposition(layout, { ...input, finaleProgress: frame / 100 })];
      for (const view of views) {
        expect((view.backdropScale - 1) * width / 2).toBeGreaterThan(Math.abs(view.backdropOffsetX));
        expect(view.performers.every(actor => actor.alpha >= 0 && actor.alpha <= 1)).toBe(true);
      }
    }
  });

  it('clamps overshoot and remains deterministic when seeking backwards', () => {
    const layout = createAuraLayout();
    const input = { fromSlot: 0 as const, activeSlot: 1 as const };
    expect(auraCameraComposition(layout, { ...input, transitionProgress: -10 }).performers)
      .toEqual(auraCameraComposition(layout, { ...input, transitionProgress: 0 }).performers);
    expect(auraCameraComposition(layout, { ...input, transitionProgress: 10 }).performers)
      .toEqual(auraCameraComposition(layout, { ...input, transitionProgress: 1 }).performers);
    const middle = auraCameraComposition(layout, { ...input, transitionProgress: 0.5 });
    auraCameraComposition(layout, { ...input, transitionProgress: 0.9 });
    expect(auraCameraComposition(layout, { ...input, transitionProgress: 0.5 })).toEqual(middle);
    expect(auraCameraComposition(layout, { ...input, transitionProgress: Number.NaN }).camera.focusX).toBe(0);
  });
});
