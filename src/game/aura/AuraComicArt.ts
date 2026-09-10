import type { AuraAnimationName } from '../../services/FighterAssetPacks.ts';

const INK = 0x050507;
const CREAM = 0xfff4d6;
const GOLD = 0xffce3a;
const OUTLINE_PX = 1.6;
type Point = readonly [x: number, y: number];
type Graphics = {
  lineStyle(width: number, color: number, alpha?: number): Graphics;
  fillStyle(color: number, alpha?: number): Graphics;
  beginPath(): Graphics;
  moveTo(x: number, y: number): Graphics;
  lineTo(x: number, y: number): Graphics;
  closePath(): Graphics;
  strokePath(): Graphics;
  fillPath(): Graphics;
  fillCircle(x: number, y: number, radius: number): Graphics;
  fillEllipse(x: number, y: number, width: number, height: number): Graphics;
};
export type AuraComicGraphics = Graphics;

/**
 * Underpaint only the icon's own geometry, never its bounding rectangle.
 * All of this pass sits behind the complete original drawing, so overlapping
 * contours cannot erase fine interior ink (especially the portrait hatching).
 */
function outlineGraphics(g: Graphics): Graphics {
  let lineWidth = 2;
  let points: Point[] = [];
  let closed = false;
  const contour = (width: number) => {
    // Independent segments and round caps avoid long miter spikes at the
    // hair, palms and sparkle tips. Their expansion is exactly width / 2.
    for (let index = 1; index < points.length; index++) {
      line(g, [points[index - 1], points[index]], width, CREAM);
    }
    if (closed && points.length > 2) line(g, [points.at(-1)!, points[0]], width, CREAM);
    g.fillStyle(CREAM, 1);
    for (const point of points) g.fillCircle(...point, width / 2);
  };
  const outline: Graphics = {
    lineStyle(width) { lineWidth = width; return outline; },
    fillStyle() { return outline; },
    beginPath() { points = []; closed = false; return outline; },
    moveTo(x, y) { points.push([x, y]); return outline; },
    lineTo(x, y) { points.push([x, y]); return outline; },
    closePath() { closed = true; return outline; },
    strokePath() {
      contour(lineWidth + OUTLINE_PX * 2);
      return outline;
    },
    fillPath() {
      shape(g, points, CREAM);
      contour(OUTLINE_PX * 2);
      return outline;
    },
    fillCircle(x, y, radius) {
      g.fillStyle(CREAM, 1).fillCircle(x, y, radius + OUTLINE_PX);
      return outline;
    },
    fillEllipse(x, y, width, height) {
      g.fillStyle(CREAM, 1).fillEllipse(x, y, width + OUTLINE_PX * 2, height + OUTLINE_PX * 2);
      return outline;
    },
  };
  return outline;
}

function line(g: Graphics, points: readonly Point[], width = 2, color = INK): void {
  if (points.length < 2) return;
  g.lineStyle(width, color, 1).beginPath().moveTo(...points[0]);
  for (const point of points.slice(1)) g.lineTo(...point);
  g.strokePath();
}

function shape(g: Graphics, points: readonly Point[], color = INK): void {
  if (points.length < 3) return;
  g.fillStyle(color, 1).beginPath().moveTo(...points[0]);
  for (const point of points.slice(1)) g.lineTo(...point);
  g.closePath().fillPath();
}

function sparkle(g: Graphics, x: number, y: number, radius = 5): void {
  shape(g, [[x, y - radius], [x + 1.4, y - 1.4], [x + radius, y],
    [x + 1.4, y + 1.4], [x, y + radius], [x - 1.4, y + 1.4],
    [x - radius, y], [x - 1.4, y - 1.4]], GOLD);
}

function drawUnbothered(g: Graphics): void {
  // The sloping temples and two separate lenses read as sunglasses at 1x.
  line(g, [[-31, -6], [-25, -4], [-22, 8]], 3);
  line(g, [[23, -8], [30, -11]], 3);
  shape(g, [[-27, -9], [-5, -7], [-5, 3], [-9, 11], [-19, 12], [-25, 6]]);
  shape(g, [[2, -8], [26, -13], [24, 3], [18, 9], [7, 9], [3, 3]]);
  line(g, [[-6, -4], [-2, -6], [4, -5]], 3);
  line(g, [[-21, -5], [-12, -4]], 2, CREAM);
  line(g, [[8, -4], [18, -7]], 2, CREAM);
  line(g, [[-7, 22], [0, 24], [8, 22]], 2.2);
  sparkle(g, 29, 15, 5);
  sparkle(g, -21, -23, 4);
}

function drawSixSeven(g: Graphics): void {
  // Leave the upper two thirds clear for the caller's SIX / SEVEN lettering.
  // Alternating, upturned palms are the actual meme gesture, not dice.
  shape(g, [[-31, 31], [-30, 26], [-26, 26], [-24, 23], [-17, 24],
    [-14, 22], [-10, 22], [-8, 24], [-15, 28], [-23, 29], [-24, 31]]);
  shape(g, [[9, 29], [15, 28], [20, 24], [27, 23], [31, 26],
    [31, 30], [27, 30], [24, 28], [21, 29], [16, 31], [10, 31]]);
  line(g, [[-25, 27], [-20, 27], [-16, 26]], 0.9, CREAM);
  line(g, [[21, 26], [26, 25], [29, 27]], 0.9, CREAM);
  line(g, [[-22, 20], [-22, 16], [-25, 18]], 1.7, GOLD);
  line(g, [[24, 15], [24, 19], [27, 17]], 1.7, GOLD);
}

function drawMogCheck(g: Graphics): void {
  // Original ink portrait: swept hair, heavy brow, cheek planes and a square
  // jaw. Deliberately hand-authored contours, not a tracing of a meme photo.
  shape(g, [[-25, 30], [-19, 24], [-10, 21], [-10, 13], [12, 10],
    [14, 22], [25, 26], [29, 31], [-25, 31]]);
  shape(g, [[-7, 17], [7, 18], [10, 24], [3, 29], [-6, 24]], CREAM);
  line(g, [[-5, 20], [-1, 26]], 1.1);
  line(g, [[8, 21], [5, 27]], 1.1);
  shape(g, [[-18, -19], [-7, -27], [8, -27], [18, -20], [22, -7],
    [19, 8], [13, 18], [5, 23], [-5, 22], [-16, 15], [-22, 0]]);
  shape(g, [[-16, -17], [-7, -23], [7, -24], [15, -18], [18, -7],
    [16, 6], [10, 15], [4, 19], [-4, 18], [-13, 12], [-19, -1]], CREAM);
  // Small ear, with its own inner fold, breaks the polygonal face silhouette.
  shape(g, [[-19, -5], [-24, -7], [-25, -2], [-22, 5], [-18, 6]]);
  shape(g, [[-21, -3], [-23, -4], [-22, 1], [-20, 3]], CREAM);
  // A dark quiff with carved, asymmetric locks: white ink is intentional.
  shape(g, [[-20, -9], [-23, -17], [-22, -23], [-15, -28], [-6, -28],
    [-2, -31], [10, -29], [20, -24], [22, -17], [18, -10], [13, -16],
    [7, -17], [0, -14], [-9, -16], [-15, -12], [-17, -5]]);
  line(g, [[-18, -21], [-10, -24], [-2, -23], [6, -25], [15, -23]], 1.2, CREAM);
  line(g, [[-14, -19], [-6, -20], [1, -18]], 1, CREAM);
  line(g, [[4, -27], [11, -26], [18, -22]], 0.8, CREAM);
  // Brows and narrow eyes stay legible before the finer hatching resolves.
  shape(g, [[-15, -9], [-8, -11], [-2, -8], [-3, -5], [-10, -7], [-15, -6]]);
  shape(g, [[3, -8], [12, -11], [16, -9], [15, -6], [9, -7], [4, -5]]);
  line(g, [[-13, -3], [-9, -4], [-5, -2]], 1.2);
  line(g, [[5, -2], [10, -4], [14, -3]], 1.2);
  g.fillStyle(INK, 1).fillCircle(-8, -3, 1).fillCircle(10, -3, 1);
  // Nose bridge, angular tip and a single nostril; no black triangle nose.
  line(g, [[1, -7], [0, -1], [3, 4], [0, 6], [-3, 5]], 1.1);
  line(g, [[4, 5], [6, 5]], 1.2);
  // Cheek shadow stays clear of the mouth and the exaggerated jaw contour.
  shape(g, [[-17, 0], [-12, 3], [-7, 3], [-12, 6], [-14, 10]]);
  shape(g, [[15, -1], [11, 2], [8, 3], [13, 5], [15, 2]]);
  line(g, [[-6, 10], [-1, 9], [3, 10], [8, 8]], 1.4);
  line(g, [[-2, 12], [3, 12], [5, 11]], 0.9);
  line(g, [[-9, 14], [-3, 17], [4, 17], [10, 12]], 1.1);
  for (const [x, y] of [[-15, 7], [-13, 8], [-11, 9], [12, 6], [11, 8]] as const) {
    line(g, [[x, y], [x - 1, y + 2]], 0.7);
  }
  for (let x = -4; x <= 4; x += 2) line(g, [[x, 14], [x + 1, 15]], 0.65);
  line(g, [[-16, 25], [-12, 27]], 0.8, CREAM);
  line(g, [[-19, 27], [-14, 29]], 0.8, CREAM);
  line(g, [[16, 25], [19, 28]], 0.8, CREAM);
  sparkle(g, 29, -12, 4);
}

function drawGlide(g: Graphics): void {
  // Winged low-top: separated sole, toe cap and three lace marks.
  shape(g, [[-21, 0], [-21, -14], [-14, -9], [-17, -23], [-9, -15],
    [-8, -28], [-2, -14], [4, -5], [-3, 6]], GOLD);
  line(g, [[-18, -13], [-11, -4], [-5, -1]], 1.3);
  line(g, [[-13, -20], [-8, -8], [-4, -5]], 1.3);
  shape(g, [[-25, 4], [-15, 4], [-7, -5], [1, -6], [6, 2], [18, 6],
    [26, 8], [29, 14], [27, 21], [-25, 21], [-29, 17]]);
  shape(g, [[-23, 7], [-13, 8], [-6, -1], [-1, -2], [4, 6], [18, 10],
    [23, 11], [25, 15], [-25, 15]], CREAM);
  line(g, [[-25, 18], [25, 18]], 1, CREAM);
  line(g, [[-3, 3], [3, 1]], 1.6);
  line(g, [[0, 6], [6, 4]], 1.6);
  line(g, [[5, 8], [11, 6]], 1.6);
  line(g, [[18, 11], [16, 15]], 1.3);
  line(g, [[-33, 26], [-13, 26]], 1.6);
  line(g, [[-25, 30], [-6, 30]], 1.3);
  line(g, [[19, -2], [31, -2]], 1.5, GOLD);
}

function drawFloorWorm(g: Graphics): void {
  // A prone dancer, not an animal: head, two planted palms and a body wave.
  g.fillStyle(INK, 1).fillCircle(-25, 4, 6);
  shape(g, [[-20, 3], [-14, -4], [-5, -9], [3, -6], [11, 5], [18, 9],
    [26, 6], [30, 9], [29, 13], [18, 16], [9, 12], [1, 3], [-5, 0], [-15, 8]]);
  line(g, [[-17, 6], [-19, 17], [-28, 18]], 4);
  line(g, [[-12, 6], [-8, 16], [-13, 18]], 3.5);
  line(g, [[26, 9], [31, 5]], 3.5);
  line(g, [[-32, 23], [32, 23]], 1.5);
  line(g, [[-14, -13], [-7, -17], [1, -15]], 2, GOLD);
  line(g, [[13, -4], [18, 0], [24, -2]], 2, GOLD);
  line(g, [[28, -11], [29, -19], [34, -20]], 1.6);
  g.fillStyle(INK, 1).fillEllipse(26.5, -10, 5, 3.5);
}

function drawOneLeg(g: Graphics): void {
  g.fillStyle(INK, 1).fillCircle(-4, -23, 5.5);
  shape(g, [[-8, -16], [1, -16], [5, -5], [2, 4], [-7, 3], [-10, -7]]);
  line(g, [[-7, -12], [-17, -5], [-27, -11]], 4);
  g.fillStyle(INK, 1).fillCircle(-28, -11.5, 2.5);
  // One leg supports the body; the other folds behind into the holding hand.
  line(g, [[-3, 2], [-7, 15], [-6, 26], [2, 27]], 5);
  line(g, [[0, 2], [12, 11], [20, 0]], 5);
  line(g, [[2, -12], [14, -6], [21, 1]], 3.8);
  line(g, [[19, 0], [24, -2]], 4);
  line(g, [[-19, 30], [8, 30]], 1.4);
  line(g, [[15, 21], [20, 16], [25, 9]], 1.8, GOLD);
  line(g, [[19, 24], [26, 18]], 1.3, GOLD);
  sparkle(g, -24, 11, 3.5);
}

function drawShrug(g: Graphics): void {
  g.fillStyle(INK, 1).fillCircle(0, -13, 8);
  g.fillStyle(CREAM, 1).fillCircle(-2, -14, 1).fillCircle(3, -14, 1);
  line(g, [[-2, -9], [3, -9]], 1, CREAM);
  shape(g, [[-5, -3], [4, -3], [11, 4], [8, 20], [-9, 20], [-12, 4]]);
  line(g, [[-9, 2], [-18, 11], [-26, 1]], 4);
  line(g, [[8, 2], [17, 10], [26, 0]], 4);
  shape(g, [[-32, -3], [-28, -2], [-25, -5], [-22, -5], [-23, -1],
    [-19, -2], [-18, 0], [-24, 4], [-30, 2]]);
  shape(g, [[19, -2], [24, -1], [23, -5], [26, -6], [29, -3],
    [33, -5], [32, 0], [27, 3], [21, 2]]);
  // A drawn hook and dot, not a font glyph, keeps the question expressive.
  line(g, [[18, -25], [21, -28], [26, -28], [29, -25], [28, -21],
    [24, -18], [24, -15]], 2.5, GOLD);
  g.fillStyle(GOLD, 1).fillCircle(24, -11, 1.5);
  line(g, [[-11, 25], [-3, 25]], 1.4);
  line(g, [[3, 25], [11, 25]], 1.4);
}

function drawIcon(g: Graphics, name: AuraAnimationName): void {
  switch (name) {
    case 'aura_unbothered': drawUnbothered(g); break;
    case 'aura_six_seven': drawSixSeven(g); break;
    case 'aura_mog_check': drawMogCheck(g); break;
    case 'aura_glide': drawGlide(g); break;
    case 'aura_floor_worm': drawFloorWorm(g); break;
    case 'aura_one_leg': drawOneLeg(g); break;
    case 'aura_shrug': drawShrug(g); break;
  }
}

/**
 * Add one free-floating icon with a crisp cream contour, no plate or texture.
 * Local ink bounds are x [-38, 38], y [-35, 35], including the outer contour.
 * Does not clear, position, scale, tint or otherwise mutate the parent object.
 */
export function drawAuraComicIcon(g: AuraComicGraphics, name: AuraAnimationName): void {
  drawIcon(outlineGraphics(g), name);
  drawIcon(g, name);
}
