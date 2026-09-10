import { describe, expect, it } from 'vitest';
import { auraHudLayout, auraHudState, drawAuraDuelMeter, type AuraHudGraphics } from './AuraHud.ts';
import { createAuraLayout } from './AuraLayout.ts';
import { CREAM, HEAT, SLOT_COLORS } from '../ui/CabinetTheme.ts';

type Point = readonly [number, number];
type Shape = { points: Point[]; color: number; alpha: number };
function drawing() {
  const shapes: Shape[] = [];
  const lines: { points: Point[]; color: number; alpha: number; width: number }[] = [];
  let points: Point[] = [];
  let fill = { color: 0, alpha: 1 };
  let line = { color: 0, alpha: 1, width: 1 };
  const g: AuraHudGraphics = {
    fillStyle(color, alpha = 1) { fill = { color, alpha }; },
    fillRect(x, y, width, height) { shapes.push({ ...fill, points: [[x, y], [x + width, y + height]] }); },
    lineStyle(width, color, alpha = 1) { line = { width, color, alpha }; },
    lineBetween(x1, y1, x2, y2) { lines.push({ ...line, points: [[x1, y1], [x2, y2]] }); },
    beginPath() { points = []; },
    moveTo(x, y) { points.push([x, y]); },
    lineTo(x, y) { points.push([x, y]); },
    closePath() {},
    fillPath() { shapes.push({ ...fill, points: [...points] }); },
    strokePath() { lines.push({ ...line, points: [...points] }); },
  };
  return { g, shapes, lines };
}
function meterLayout(width = 1024, portrait = false) {
  return { balance: { left: 24, right: width - 24, y: portrait ? 114 : 90, height: 24 } };
}

describe('shared Aura HUD', () => {
  it('gives live and preview canvases the same readable hierarchy', () => {
    const live = auraHudLayout(createAuraLayout());
    expect(live).toEqual({
      nameY: 14, scoreY: 36, cueY: 62, headingY: 20, leadY: 46, statusY: 114,
      scoreSize: 21, nameSize: 11, leadSize: 12, headingSize: 10, statusSize: 10,
      seatWidth: 270, centerWidth: 404, headingVisible: true,
    });
    expect(auraHudLayout({ width: 1024, portrait: false })).toEqual(live);
    expect(live.cueY).toBeGreaterThan(live.scoreY + live.scoreSize);
    expect(live.statusY + live.statusSize).toBeLessThan(128);
  });

  it.each([180, 320, 480, 576])('keeps the portrait hierarchy inside %i logical pixels', width => {
    const hud = auraHudLayout({ width, portrait: true });
    expect(hud).toMatchObject({ headingVisible: false, leadY: 84, statusY: 146, scoreY: 36, cueY: 62 });
    expect(hud.seatWidth).toBeGreaterThan(0);
    expect(hud.seatWidth * 2 + 88).toBe(width);
    expect(hud.centerWidth + 48).toBe(width);
    expect(hud.statusY + hud.statusSize).toBeLessThan(160);
  });

  it.each([[0, 0], [1200, 1200], [Number.MAX_VALUE, Number.MAX_VALUE]])('keeps a real tie centred for %s/%s', (p1, p2) => {
    expect(auraHudState([p1, p2])).toEqual({ ratio: 0.5, leader: null, difference: 0, leadLabel: 'TIED' });
  });

  it('flips leader and reports the actual point difference rather than a share or score', () => {
    expect(auraHudState([5250, 4000])).toMatchObject({ leader: 0, difference: 1250, leadLabel: 'P1 LEADS +1,250' });
    expect(auraHudState([5250, 4000]).ratio).toBeCloseTo(5250 / 9250, 14);
    expect(auraHudState([4000, 5250])).toMatchObject({ leader: 1, difference: 1250, leadLabel: 'P2 LEADS +1,250' });
    expect(auraHudState([4000, 5250]).ratio).toBeCloseTo(4000 / 9250, 14);
    expect(auraHudState([1.75, 0.25])).toMatchObject({ difference: 1.5, leadLabel: 'P1 LEADS +1.5' });
  });

  it('retains both colours for one-sided scores without changing the lead arithmetic', () => {
    expect(auraHudState([1_000_000, 0])).toEqual({ ratio: 0.92, leader: 0, difference: 1_000_000, leadLabel: 'P1 LEADS +1,000,000' });
    expect(auraHudState([0, 1_000_000])).toEqual({ ratio: 0.08, leader: 1, difference: 1_000_000, leadLabel: 'P2 LEADS +1,000,000' });
    expect(auraHudState([Number.MAX_VALUE, Number.MAX_VALUE / 2]).ratio).toBeCloseTo(2 / 3);
  });

  it.each([[-100, -200], [NaN, Infinity], [-Infinity, 0]])('normalizes invalid or negative scores to zero: %s/%s', (p1, p2) => {
    expect(auraHudState([p1, p2])).toEqual(auraHudState([0, 0]));
    expect(auraHudState([p1, 500])).toEqual(auraHudState([0, 500]));
  });

  it('uses identical data and drawing commands for match and preview, with no mutation', () => {
    const scores = Object.freeze([15_375, 12_750] as const);
    const live = auraHudState(scores);
    const preview = auraHudState([...scores]);
    expect(live).toEqual(preview);
    const a = drawing(); const b = drawing();
    drawAuraDuelMeter(a.g, meterLayout(), live);
    drawAuraDuelMeter(b.g, meterLayout(), preview);
    expect(a.shapes).toEqual(b.shapes);
    expect(a.lines).toEqual(b.lines);
    expect(scores).toEqual([15_375, 12_750]);
  });

  it.each([180, 320, 480, 1024, 1920])('keeps the full rail and crown visible at width %i, including extreme leads', width => {
    const layout = meterLayout(width, width < 600);
    const { left, right, y } = layout.balance;
    for (const scores of [[0, 0], [1, 0], [0, 1], [7, 8]] as const) {
      const state = auraHudState(scores);
      const d = drawing();
      drawAuraDuelMeter(d.g, layout, state);
      for (const point of [...d.shapes, ...d.lines].flatMap(shape => shape.points)) {
        expect(point.every(Number.isFinite)).toBe(true);
        expect(point[0]).toBeGreaterThanOrEqual(0);
        expect(point[0]).toBeLessThanOrEqual(width);
        expect(point[1]).toBeGreaterThanOrEqual(y - 16);
        expect(point[1]).toBeLessThanOrEqual(y + 16);
      }
      const blue = d.shapes.find(shape => shape.color === SLOT_COLORS[0])!;
      const red = d.shapes.find(shape => shape.color === SLOT_COLORS[1])!;
      expect(Math.min(...blue.points.map(([x]) => x))).toBe(left);
      expect(Math.max(...blue.points.map(([x]) => x))).toBeCloseTo(left + (right - left) * state.ratio);
      expect(Math.min(...red.points.map(([x]) => x))).toBeCloseTo(left + (right - left) * state.ratio);
      expect(Math.max(...red.points.map(([x]) => x))).toBe(right);
      expect(Math.max(...blue.points.map(([, py]) => py)) - Math.min(...blue.points.map(([, py]) => py))).toBe(24);
    }
  });

  it('moves a substantial gold crown while keeping the tie marker fixed and leader shine subtle', () => {
    const layout = meterLayout();
    for (const scores of [[2, 1], [1, 1], [1, 2]] as const) {
      const state = auraHudState(scores);
      const d = drawing();
      drawAuraDuelMeter(d.g, layout, state);
      const crown = d.shapes.find(shape => shape.color === HEAT)!;
      const xs = crown.points.map(([x]) => x); const ys = crown.points.map(([, y]) => y);
      expect(Math.max(...xs) - Math.min(...xs)).toBe(28);
      expect(Math.max(...ys) - Math.min(...ys)).toBe(32);
      expect((Math.max(...xs) + Math.min(...xs)) / 2).toBeCloseTo(24 + 976 * state.ratio);
      expect(d.lines.find(line => line.color === CREAM)?.points).toEqual([[512, 75], [512, 105]]);
      const shine = d.shapes.filter(shape => shape.color === CREAM);
      expect(shine).toHaveLength(state.leader === null ? 0 : 1);
      if (shine[0]) {
        expect(shine[0].alpha).toBeLessThanOrEqual(0.22);
        const middle = (shine[0].points[0][0] + shine[0].points[1][0]) / 2;
        if (state.leader === 0) expect(middle).toBeLessThan(24 + 976 * state.ratio);
        else expect(middle).toBeGreaterThan(24 + 976 * state.ratio);
      }
    }
  });

  it('stays bounded for a bad presentation ratio and ignores unusable rails', () => {
    const d = drawing();
    drawAuraDuelMeter(d.g, meterLayout(), { ...auraHudState([0, 0]), ratio: NaN });
    expect(d.shapes.flatMap(shape => shape.points).flat().every(Number.isFinite)).toBe(true);
    const count = d.shapes.length;
    for (const balance of [{ left: 24, right: 20, y: 90 }, { left: 24, right: 100, y: NaN }, { left: 24, right: 100, y: 90, height: -1 }]) {
      drawAuraDuelMeter(d.g, { balance }, auraHudState([0, 0]));
    }
    expect(d.shapes).toHaveLength(count);
  });
});
