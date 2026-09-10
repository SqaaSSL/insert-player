import type { AuraSlot } from './AuraChart.ts';
import type { AuraLayout } from './AuraLayout.ts';
import { CREAM, HEAT, INK, SLOT_COLORS, STEEL } from '../ui/CabinetTheme.ts';

/** The preview and live match use the same hierarchy and score arithmetic. */
export function auraHudLayout(layout: Pick<AuraLayout, 'width' | 'portrait'>) {
  return {
    nameY: 14, scoreY: 36, cueY: 62,
    headingY: 20, leadY: layout.portrait ? 84 : 46,
    statusY: layout.portrait ? 146 : 114,
    scoreSize: 21, nameSize: 11, leadSize: 12, headingSize: 10, statusSize: 10,
    seatWidth: layout.portrait ? layout.width / 2 - 44 : 270,
    centerWidth: layout.portrait ? layout.width - 48 : layout.width - 2 * 310,
    headingVisible: !layout.portrait,
  };
}

export interface AuraHudState {
  ratio: number;
  leader: AuraSlot | null;
  difference: number;
  leadLabel: string;
}

export function auraHudState(scores: readonly [number, number]): AuraHudState {
  const [p1, p2] = scores.map(score => Number.isFinite(score) ? Math.max(0, score) : 0);
  const leader = p1 === p2 ? null : p1 > p2 ? 0 : 1;
  const difference = Math.abs(p1 - p2);
  // Scaling first avoids Infinity when two valid, large scores are summed.
  const scale = Math.max(p1, p2);
  const share = scale === 0 ? 0.5 : (p1 / scale) / (p1 / scale + p2 / scale);
  return {
    ratio: Math.max(0.08, Math.min(0.92, share)),
    leader,
    difference,
    leadLabel: leader === null ? 'TIED' : `P${leader + 1} LEADS +${difference.toLocaleString('en-US')}`,
  };
}

/** Small structural surface implemented by Phaser Graphics and the preview's
 * Canvas adapter. No Phaser or browser runtime is required to draw this HUD. */
export interface AuraHudGraphics {
  fillStyle(color: number, alpha?: number): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  lineStyle(width: number, color: number, alpha?: number): void;
  lineBetween(x1: number, y1: number, x2: number, y2: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  fillPath(): void;
  strokePath(): void;
}

type Point = readonly [number, number];
type MeterLayout = {
  balance: { left: number; right: number; y: number; height?: number };
};

function path(g: AuraHudGraphics, points: readonly Point[]): void {
  g.beginPath();
  g.moveTo(...points[0]);
  for (let index = 1; index < points.length; index++) g.lineTo(...points[index]);
  g.closePath();
}

/** A shared 24 px duel rail. Its centre tick stays fixed; the gold crown follows
 * the score balance. The visual clamp keeps both seats present, not a percentage. */
export function drawAuraDuelMeter(g: AuraHudGraphics, layout: MeterLayout, state: AuraHudState): void {
  const { left, right, y, height = 24 } = layout.balance;
  const width = right - left;
  if (![left, right, y, height].every(Number.isFinite) || width <= 0 || height <= 0) return;
  const ratio = Number.isFinite(state.ratio) ? Math.max(0.08, Math.min(0.92, state.ratio)) : 0.5;
  const pinX = left + width * ratio;
  const top = y - height / 2;
  const bottom = y + height / 2;
  const corner = Math.min(4, height / 4, width * 0.04);

  // A steel cabinet frame, with clean clipped colour ends inside it.
  const frame: Point[] = [
    [left + corner, top - 2], [right - corner, top - 2], [right + 2, top + corner],
    [right + 2, bottom - corner], [right - corner, bottom + 2], [left + corner, bottom + 2],
    [left - 2, bottom - corner], [left - 2, top + corner],
  ];
  path(g, frame); g.fillStyle(INK); g.fillPath();
  g.lineStyle(2, STEEL, 0.7); g.strokePath();
  path(g, [[left + corner, top], [pinX, top], [pinX, bottom],
    [left + corner, bottom], [left, bottom - corner], [left, top + corner]]);
  g.fillStyle(SLOT_COLORS[0], 0.94); g.fillPath();
  path(g, [[pinX, top], [right - corner, top], [right, top + corner],
    [right, bottom - corner], [right - corner, bottom], [pinX, bottom]]);
  g.fillStyle(SLOT_COLORS[1], 0.94); g.fillPath();

  // Small hardware divisions give the rail substance without implying units.
  g.lineStyle(1, INK, 0.22);
  for (let tick = 1; tick < 16; tick++) {
    const x = left + width * tick / 16;
    g.lineBetween(x, top + 4, x, bottom - 4);
  }
  if (state.leader !== null) {
    const shineLeft = state.leader === 0 ? left + corner : pinX + 2;
    const shineRight = state.leader === 0 ? pinX - 2 : right - corner;
    if (shineRight > shineLeft) {
      g.fillStyle(CREAM, 0.22); g.fillRect(shineLeft, top + 2, shineRight - shineLeft, 2);
    }
  }

  const centreX = (left + right) / 2;
  g.lineStyle(4, INK, 0.9); g.lineBetween(centreX, top - 3, centreX, bottom + 3);
  g.lineStyle(1, CREAM, 0.8); g.lineBetween(centreX, top - 3, centreX, bottom + 3);

  // A 28×32 crown/pin survives the landing miniature without a glow or animation.
  path(g, [
    [pinX - 14, y - 12], [pinX - 8, y - 5], [pinX, y - 16],
    [pinX + 8, y - 5], [pinX + 14, y - 12], [pinX + 12, y + 6],
    [pinX + 5, y + 6], [pinX, y + 16], [pinX - 5, y + 6], [pinX - 12, y + 6],
  ]);
  g.fillStyle(HEAT); g.fillPath();
  g.lineStyle(2, INK); g.strokePath();
  g.fillStyle(INK, 0.85); g.fillRect(pinX - 7, y + 1, 14, 3);
  g.fillRect(pinX - 2, y - 6, 4, 4);
}
