import { describe, expect, it } from 'vitest';
import { drawAuraComicIcon } from './AuraComicArt.ts';

type Point = [number, number];
type Operation =
  | { kind: 'stroke'; points: Point[]; closed: boolean; width: number; color: number }
  | { kind: 'fill'; points: Point[]; closed: boolean; color: number }
  | { kind: 'circle'; x: number; y: number; radius: number; color: number }
  | { kind: 'ellipse'; x: number; y: number; width: number; height: number; color: number };

function graphicsRecorder() {
  let points: Point[] = [];
  let closed = false;
  let width = 0;
  let color = 0;
  let fill = 0;
  const operations: Operation[] = [];
  // Deliberately no rectangle, texture, clear, transform or effects methods.
  const graphics = {
    lineStyle(w: number, c: number) { width = w; color = c; return this; },
    fillStyle(c: number) { fill = c; return this; },
    beginPath() { points = []; closed = false; return this; },
    moveTo(x: number, y: number) { points.push([x, y]); return this; },
    lineTo(x: number, y: number) { points.push([x, y]); return this; },
    closePath() { closed = true; return this; },
    strokePath() {
      operations.push({ kind: 'stroke', points: [...points], closed, width, color }); return this;
    },
    fillPath() {
      operations.push({ kind: 'fill', points: [...points], closed, color: fill }); return this;
    },
    fillCircle(x: number, y: number, radius: number) {
      operations.push({ kind: 'circle', x, y, radius, color: fill }); return this;
    },
    fillEllipse(x: number, y: number, w: number, h: number) {
      operations.push({ kind: 'ellipse', x, y, width: w, height: h, color: fill }); return this;
    },
  };
  return { graphics: graphics as unknown as Parameters<typeof drawAuraComicIcon>[0], operations };
}

// Recorded from the approved art at 9a0ece1 before adding its outer contour.
const ORIGINAL_ART = [
  ['aura_unbothered', 10, 'e879b3b8aca84f94efadc5d2147a350601f9b6a859e03aa28bc93bc3765555e2'],
  ['aura_six_seven', 6, '3a2fb605590cc8eb9ba2f5f41a540c2f58a419c0454904da84de5a81b3abe1d1'],
  ['aura_mog_check', 39, '817dcabb60b6cf1ab1c00a72af90963204470b905f870c980afa0c6204335e52'],
  ['aura_glide', 13, 'a212df18fea89794755fbce3b88d24f8b7aecbcde2511e37c7a804329fdfa32e'],
  ['aura_floor_worm', 10, '5d6d8d6f7b26e00baaa5d70b2f24d9232cfd98a34c0489d32432c409ec005ab2'],
  ['aura_one_leg', 12, 'acd70b2d3718cdc7a756a276af3d750e294e7c11b5c9b9db8495b81b5d0f5adb'],
  ['aura_shrug', 13, '36d35348d973f186282f180bf60c5d66642da4cf72e04cc0ddf99653767b04f4'],
] as const;

describe('transparent Aura comic art', () => {
  it.each(ORIGINAL_ART)('outlines %s without altering its approved interior', async (name, count, sha256) => {
    const { graphics, operations } = graphicsRecorder();
    drawAuraComicIcon(graphics, name);
    const underpaint = operations.slice(0, -count);
    const original = operations.slice(-count);
    expect(underpaint.length).toBeGreaterThan(0);
    expect(underpaint.every(operation => operation.color === 0xfff4d6)).toBe(true);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(original)));
    const actualHash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    expect(actualHash).toBe(sha256);

    // The underpaint fills only the existing icon's shapes, not a new plate.
    expect(underpaint.filter(operation => operation.kind === 'fill')).toEqual(
      original.filter(operation => operation.kind === 'fill')
        .map(operation => ({ ...operation, color: 0xfff4d6 })),
    );
    for (const operation of underpaint) {
      if (operation.kind === 'stroke') {
        expect(operation.points).toHaveLength(2);
        expect(operation.closed).toBe(false);
        expect(operation.width).toBeLessThanOrEqual(8.2);
      }
    }
  });

  it.each(ORIGINAL_ART)('keeps the complete %s contour within its floating footprint', name => {
    const { graphics, operations } = graphicsRecorder();
    drawAuraComicIcon(graphics, name);
    for (const operation of operations) {
      const extents: [x: number, y: number, padX: number, padY: number][] = [];
      if (operation.kind === 'circle') {
        extents.push([operation.x, operation.y, operation.radius, operation.radius]);
      } else if (operation.kind === 'ellipse') {
        extents.push([operation.x, operation.y, operation.width / 2, operation.height / 2]);
      } else {
        const pad = operation.kind === 'stroke' ? operation.width / 2 : 0;
        extents.push(...operation.points.map(([x, y]): [number, number, number, number] => [x, y, pad, pad]));
      }
      for (const [x, y, padX, padY] of extents) {
        expect(x - padX).toBeGreaterThanOrEqual(-38);
        expect(x + padX).toBeLessThanOrEqual(38);
        expect(y - padY).toBeGreaterThanOrEqual(-35);
        expect(y + padY).toBeLessThanOrEqual(35);
      }
    }
  });
});
