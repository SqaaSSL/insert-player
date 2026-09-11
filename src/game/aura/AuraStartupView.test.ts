import { describe, expect, it, vi } from 'vitest';

vi.mock('phaser', () => ({ default: { Geom: { Point: class {
  x: number; y: number;
  constructor(x: number, y: number) { this.x = x; this.y = y; }
} } } }));

import { AuraStartupView } from './AuraStartupView.ts';
import { createAuraLayout } from './AuraLayout.ts';

function harness() {
  const drawings = {
    clear: vi.fn(), fillStyle: vi.fn().mockReturnThis(), fillPoints: vi.fn(),
    lineStyle: vi.fn().mockReturnThis(), lineBetween: vi.fn(), strokeRect: vi.fn(), destroy: vi.fn(),
  };
  drawings.clear.mockImplementation(() => { drawings.fillPoints.mockClear(); return drawings; });
  const texts: Array<ReturnType<typeof textObject>> = [];
  function textObject() {
    const text = {
      x: 0, y: 0, width: 160, visible: true, value: '',
      setOrigin: vi.fn().mockReturnThis(), setScale: vi.fn().mockReturnThis(),
      setAlpha: vi.fn().mockReturnThis(), setFontSize: vi.fn().mockReturnThis(), destroy: vi.fn(),
      setText: vi.fn(), setPosition: vi.fn(), setVisible: vi.fn(),
    };
    text.setText.mockImplementation((value: string) => { text.value = value; return text; });
    text.setPosition.mockImplementation((x: number, y: number) => { text.x = x; text.y = y; return text; });
    text.setVisible.mockImplementation((visible: boolean) => { text.visible = visible; return text; });
    return text;
  }
  const scene = { add: {
    graphics: () => drawings,
    text: () => { const text = textObject(); texts.push(text); return text; },
  } };
  const view = new AuraStartupView(scene as unknown as ConstructorParameters<typeof AuraStartupView>[0],
    { add: vi.fn() } as unknown as ConstructorParameters<typeof AuraStartupView>[1], ['TRUMP', 'LAMINE']);
  return { view, drawings, texts };
}

describe('Aura musical startup presentation', () => {
  it.each([[1024, 576], [576, 1024]])('keeps every countdown card clear of approaching notes and releases it for the first hit at %i×%i', (width, height) => {
    const layout = createAuraLayout(width, height);
    const { view, drawings, texts } = harness();
    view.render(layout, { phase: 'versus', count: null });
    expect(texts[0].visible).toBe(true);
    expect(texts[1].value).toBe('TRUMP  VS  LAMINE');
    for (const count of [3, 2, 1]) {
      view.render(layout, { phase: 'countdown', count });
      const points = drawings.fillPoints.mock.calls[0][0] as Array<{ x: number; y: number }>;
      expect(points.every(point => point.y >= layout.hudHeight && point.y <= layout.instrument.top)).toBe(true);
      expect(points.every(point => point.x >= layout.instrument.left && point.x <= layout.instrument.right)).toBe(true);
      expect(texts[0].visible).toBe(false);
      expect(texts[1].visible).toBe(false);
      expect(texts[2].visible).toBe(true);
      expect(texts[2].value).toBe(String(count));
    }
    view.render(layout, { phase: 'playing', count: null });
    expect(drawings.fillPoints).not.toHaveBeenCalled();
    expect(texts[2].visible).toBe(false);
    expect(texts[3].visible).toBe(true); // Shared video branding remains.
    view.destroy();
    expect(texts.every(text => text.destroy.mock.calls.length === 1)).toBe(true);
  });
});
