import Phaser from 'phaser';

/**
 * Shared in-canvas hardware language for the Phaser match runtime.
 *
 * Cabinet ink, CRT cream, coin-gold heat, and steel: chamfered plates instead
 * of rounded pills, one pixel font, no gradients. Seats keep the Fight HUD
 * identity (P1 blue, P2 red). This is deliberately separate from the React
 * shell's DESIGN.md: in-game direction is owned per game mode.
 */
export * from './CabinetTheme.ts';

export function chamferedRect(x: number, y: number, w: number, h: number, c: number): Phaser.Geom.Point[] {
  return [
    new Phaser.Geom.Point(x + c, y),
    new Phaser.Geom.Point(x + w - c, y),
    new Phaser.Geom.Point(x + w, y + c),
    new Phaser.Geom.Point(x + w, y + h - c),
    new Phaser.Geom.Point(x + w - c, y + h),
    new Phaser.Geom.Point(x + c, y + h),
    new Phaser.Geom.Point(x, y + h - c),
    new Phaser.Geom.Point(x, y + c),
  ];
}

export function fillChamfered(
  g: Phaser.GameObjects.Graphics,
  x: number, y: number, w: number, h: number, c: number,
  color: number, alpha = 1,
): void {
  g.fillStyle(color, alpha);
  g.fillPoints(chamferedRect(x, y, w, h, c), true);
}

export function strokeChamfered(
  g: Phaser.GameObjects.Graphics,
  x: number, y: number, w: number, h: number, c: number,
  width: number, color: number, alpha = 1,
): void {
  g.lineStyle(width, color, alpha);
  g.strokePoints(chamferedRect(x, y, w, h, c), true);
}

/** Pixel crown, 16x11, drawn with rects so it never depends on a glyph font. */
export function drawPixelCrown(g: Phaser.GameObjects.Graphics, x: number, y: number, color: number, alpha = 1): void {
  g.fillStyle(color, alpha);
  g.fillRect(x - 8, y + 2, 16, 4);
  g.fillRect(x - 8, y - 4, 3, 6);
  g.fillRect(x - 1.5, y - 6, 3, 8);
  g.fillRect(x + 5, y - 4, 3, 6);
  g.fillRect(x - 5, y - 1, 3, 3);
  g.fillRect(x + 2, y - 1, 3, 3);
}
