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

  it.each([[1024, 576], [576, 1024]])('opens with both bodies separated and clear of the frame at %i×%i', (width, height) => {
    const layout = createAuraLayout(width, height);
    const original = structuredClone(layout);
    const intro = auraCameraComposition(layout, { activeSlot: 0, introProgress: 1 });
    const [left, right] = intro.performers;
    const previousFaceoff = auraCameraComposition(layout, { activeSlot: 0, finaleProgress: 1 });
    expect(intro.performers).toEqual(auraCameraComposition(layout, { activeSlot: 1, introProgress: 1 }).performers);
    expect(intro.performers.map(actor => actor.alpha)).toEqual([1, 1]);
    expect(intro.finale).toBe(false);
    expect(intro.transitioning).toBe(false);
    expect((left.x + right.x) / 2).toBeCloseTo(width / 2, 10);
    expect(left.height).toBe(right.height);
    expect(right.x - left.x).toBeGreaterThan(previousFaceoff.performers[1].x - previousFaceoff.performers[0].x);
    // Leave room around the two silhouettes, not just around their centre marks.
    expect(left.x + left.height * 0.35).toBeLessThan(right.x - right.height * 0.35);
    expect(left.x - left.height * 0.35).toBeGreaterThan(16);
    expect(right.x + right.height * 0.35).toBeLessThan(width - 16);
    expect(left.footY - left.height).toBeGreaterThan(layout.hudHeight);
    expect(left.footY).toBe(layout.active.footY);
    expect(right.footY).toBe(layout.active.footY);
    expect(layout).toEqual(original);
  });

  it.each([[1024, 576], [576, 1024]])('pans and zooms continuously from the intro to either player at %i×%i', (width, height) => {
    const layout = createAuraLayout(width, height);
    for (const activeSlot of [0, 1] as const) {
      let previous = auraCameraComposition(layout, { activeSlot, introProgress: 1 });
      for (let frame = 1; frame <= 120; frame++) {
        const view = auraCameraComposition(layout, { activeSlot, introProgress: 1 - frame / 120 });
        expect(view.camera.zoom).toBeGreaterThanOrEqual(previous.camera.zoom);
        expect(view.performers[activeSlot].alpha).toBe(1);
        expect(view.performers[1 - activeSlot].alpha).toBeLessThanOrEqual(previous.performers[1 - activeSlot].alpha);
        expect(view.performers[0].x).toBeLessThan(view.performers[1].x);
        expect(view.performers.every(actor => actor.footY === layout.active.footY)).toBe(true);
        expect(view.performers[0].height).toBe(view.performers[1].height);
        expect(view.finale).toBe(false);
        expect(view.transitioning).toBe(frame < 120);
        view.performers.forEach((actor, slot) => {
          expect(Math.abs(actor.x - previous.performers[slot].x)).toBeLessThan(width / 60);
          expect(Math.abs(actor.height - previous.performers[slot].height)).toBeLessThan(2);
        });
        previous = view;
      }
      expect(previous).toEqual(auraCameraComposition(layout, { activeSlot }));
      const midway = auraCameraComposition(layout, { activeSlot, introProgress: 0.5 });
      auraCameraComposition(layout, { activeSlot, introProgress: 0.1 });
      expect(auraCameraComposition(layout, { activeSlot, introProgress: 0.5 })).toEqual(midway);
    }
  });

  it.each([[1024, 576], [576, 1024]])('keeps the opening two-shot but reaches focused play with reduced motion at %i×%i', (width, height) => {
    const layout = createAuraLayout(width, height);
    for (const activeSlot of [0, 1] as const) {
      expect(auraCameraComposition(layout, { activeSlot, introProgress: 1, reducedMotion: true }))
        .toEqual(auraCameraComposition(layout, { activeSlot, introProgress: 1 }));
      for (const introProgress of [0.99, 0.5, 0.01, 0, -1, Number.NaN]) {
        const focused = auraCameraComposition(layout, { activeSlot, introProgress, reducedMotion: true });
        expect(focused).toEqual(auraCameraComposition(layout, { activeSlot }));
        expect(focused.performers[1 - activeSlot].visible).toBe(false);
      }
    }
  });

  it('keeps final scoring and result framing independent of any stale intro value', () => {
    const layout = createAuraLayout();
    for (const finaleProgress of [0, 0.5, 1]) {
      const input = { activeSlot: 1 as const, fromSlot: 0 as const, transitionProgress: 0.4, finaleProgress, resultTableau: true };
      expect(auraCameraComposition(layout, { ...input, introProgress: 1 })).toEqual(auraCameraComposition(layout, input));
    }
  });

  it('leaves an existing player handoff untouched at the intro focus endpoint', () => {
    const layout = createAuraLayout();
    for (const transitionProgress of [0, 0.25, 0.5, 0.9, 1]) {
      const input = { activeSlot: 1 as const, fromSlot: 0 as const, transitionProgress };
      expect(auraCameraComposition(layout, { ...input, introProgress: 0 })).toEqual(auraCameraComposition(layout, input));
    }
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

  it.each([[1024, 576], [576, 1024]])('centres the captured finale before making room for results at %i×%i', (width, height) => {
    const layout = createAuraLayout(width, height);
    const captured = auraCameraComposition(layout, { activeSlot: 1, finaleProgress: 1, resultTableau: true });
    expect((captured.performers[0].x + captured.performers[1].x) / 2).toBe(width / 2);
    const end = auraCameraComposition(layout, { activeSlot: 1, finaleProgress: 1, resultTableau: true, resultDockProgress: 1 });
    const [left, right] = end.performers;
    expect(left.visible && right.visible).toBe(true);
    expect(left.alpha).toBe(1); expect(right.alpha).toBe(1);
    expect(left.footY).toBe(layout.active.footY);
    expect(right.footY).toBe(layout.active.footY);
    expect(left.height).toBe(layout.portrait ? 260 : 270);
    expect(right.height).toBe(left.height);
    expect(right.x - left.x).toBeGreaterThan(180);
    expect(right.x - left.x).toBeLessThan(220);
    for (let frame = 0; frame <= 60; frame++) {
      const dock = auraCameraComposition(layout, { activeSlot: 1, finaleProgress: 1, resultTableau: true, resultDockProgress: frame / 60 });
      expect(dock.performers[0].footY).toBe(left.footY);
      expect(dock.performers[1].height).toBe(right.height);
      expect(dock.performers[1].x - dock.performers[0].x).toBeCloseTo(right.x - left.x);
      expect(dock.camera.anchorX).toBeGreaterThanOrEqual(end.camera.anchorX);
      expect(dock.camera.anchorX).toBeLessThanOrEqual(captured.camera.anchorX);
    }
    if (layout.portrait) {
      expect((left.x + right.x) / 2).toBe(width / 2);
      expect(left.footY).toBeLessThan(height * 0.52);
    } else {
      expect(left.x).toBeGreaterThan(160);
      expect(right.x).toBeLessThan(400);
      expect(right.x + right.height * 0.5).toBeLessThan(width * 0.52);
    }
    const handoff = { activeSlot: 1 as const, fromSlot: 0 as const, transitionProgress: 0.4 };
    expect(auraCameraComposition(layout, { ...handoff, finaleProgress: 0, resultTableau: true }).performers)
      .toEqual(auraCameraComposition(layout, handoff).performers);
    // Startup has its own wider faceoff, independent of the result dock.
    const intro = auraCameraComposition(layout, { activeSlot: 1, introProgress: 1 });
    expect((intro.performers[0].x + intro.performers[1].x) / 2).toBe(width / 2);
  });

  it.each([[1024, 576], [576, 1024]])('provides enough background overscan for every pan and finale at %i×%i', (width, height) => {
    const layout = createAuraLayout(width, height);
    for (const fromSlot of [0, 1] as const) for (let frame = 0; frame <= 100; frame++) {
      const activeSlot = (1 - fromSlot) as AuraSlot;
      const input = { fromSlot, activeSlot, transitionProgress: frame / 100 };
      const views = [auraCameraComposition(layout, input), auraCameraComposition(layout, { ...input, finaleProgress: frame / 100 }),
        auraCameraComposition(layout, { ...input, introProgress: frame / 100 })];
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
