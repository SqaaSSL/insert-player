import { describe, expect, it, vi } from 'vitest';
import { AuraScoreFeedback } from './AuraScoreFeedback.ts';
import { auraScoreCueAnchor } from './AuraScoreCue.ts';
import { createAuraLayout } from './AuraLayout.ts';

function harness(reducedMotion = false) {
  const texts: Array<{
    x: number; y: number; value: string; textOptions: { fontSize: string };
    setOrigin: ReturnType<typeof vi.fn>; setDepth: ReturnType<typeof vi.fn>; setAlpha: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>;
  }> = [];
  const timers: Array<{ duration: number; callback: () => void; remove: ReturnType<typeof vi.fn> }> = [];
  const layer = { add: vi.fn() };
  const scene = {
    add: { text: vi.fn((x: number, y: number, value: string, textOptions: { fontSize: string }) => {
      const text = { x, y, value, textOptions, setOrigin: vi.fn().mockReturnThis(), setDepth: vi.fn().mockReturnThis(), setAlpha: vi.fn().mockReturnThis(), destroy: vi.fn() };
      texts.push(text);
      return text;
    }) },
    time: { delayedCall: vi.fn((duration: number, callback: () => void) => {
      const timer = { duration, callback, remove: vi.fn() };
      timers.push(timer);
      return timer;
    }) },
    tweens: { add: vi.fn(), killTweensOf: vi.fn() },
  };
  const feedback = new AuraScoreFeedback(
    scene as unknown as ConstructorParameters<typeof AuraScoreFeedback>[0],
    layer as unknown as ConstructorParameters<typeof AuraScoreFeedback>[1],
    reducedMotion,
  );
  return { feedback, scene, layer, texts, timers };
}

const anchor = { x: 24, y: 62, originX: 0 };

describe('quiet Aura score cue', () => {
  it('replaces each real delta without a queue, while an old expiry cannot erase the next hit', () => {
    const h = harness();
    h.feedback.show(1_250, anchor);
    h.feedback.show(-300, anchor);
    expect(h.texts.map(text => text.value)).toEqual(['+1,250', '−300']);
    expect(h.texts[0].destroy).toHaveBeenCalledOnce();
    expect(h.timers[0].remove).toHaveBeenCalledExactlyOnceWith(false);
    h.timers[0].callback();
    expect(h.texts[1].destroy).not.toHaveBeenCalled();
    for (let note = 0; note < 20; note++) {
      h.feedback.show(650 + note * 25, anchor);
      expect(h.texts.filter(text => !text.destroy.mock.calls.length)).toHaveLength(1);
    }
    h.timers.at(-1)!.callback();
    expect(h.texts.every(text => text.destroy.mock.calls.length === 1)).toBe(true);
  });

  it.each([[1024, 576], [576, 1024]])('keeps either seat inside its HUD and out of the stage at %i×%i', (width, height) => {
    const layout = createAuraLayout(width, height);
    for (const slot of [0, 1] as const) {
      const h = harness();
      const position = auraScoreCueAnchor(layout, slot);
      h.feedback.show(1_250, position);
      const text = h.texts[0];
      const flight = h.scene.tweens.add.mock.calls.find(([config]) => 'y' in config)![0];
      expect(text.setOrigin).toHaveBeenCalledWith(slot, 0);
      expect(text.x).toBe(slot === 0 ? 24 : width - 24);
      expect(text.y + Number.parseFloat(text.textOptions.fontSize)).toBeLessThan(layout.hudHeight);
      expect(flight.y).toBeGreaterThanOrEqual(59);
      expect(text.setAlpha).toHaveBeenCalledWith(0.8);
    }
  });

  it('clears timers/tweens at handoff and ignores callbacks after cleanup', () => {
    const h = harness();
    h.feedback.show(100, anchor);
    h.feedback.clear(); h.feedback.clear();
    expect(h.texts[0].destroy).toHaveBeenCalledOnce();
    expect(h.timers[0].remove).toHaveBeenCalledExactlyOnceWith(false);
    expect(h.scene.tweens.killTweensOf).toHaveBeenCalledExactlyOnceWith(h.texts[0]);
    h.feedback.show(500, anchor);
    h.timers[0].callback();
    expect(h.texts[1].destroy).not.toHaveBeenCalled();
    h.feedback.clear();
    expect(h.texts[1].destroy).toHaveBeenCalledOnce();
  });

  it('retains the signed value with reduced motion and no movement or fade tweens', () => {
    const h = harness(true);
    h.feedback.show(-300, anchor);
    expect(h.texts[0].value).toBe('−300');
    expect(h.scene.tweens.add).not.toHaveBeenCalled();
    expect(h.timers[0].duration).toBe(650);
    h.timers[0].callback();
    expect(h.texts[0].destroy).toHaveBeenCalledOnce();
  });

  it('ignores zero, rounded-zero and non-finite values without retiring the current hit', () => {
    const h = harness();
    h.feedback.show(125, anchor);
    for (const delta of [0, 0.1, -0.1, NaN, Infinity, -Infinity]) h.feedback.show(delta, anchor);
    expect(h.scene.add.text).toHaveBeenCalledOnce();
    expect(h.scene.time.delayedCall).toHaveBeenCalledOnce();
    expect(h.texts[0].destroy).not.toHaveBeenCalled();
  });
});
