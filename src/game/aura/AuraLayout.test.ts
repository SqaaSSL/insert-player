import { describe, expect, it, vi } from 'vitest';

vi.mock('phaser', () => ({ default: {} }));

import { getAuraCanvasSize } from './AuraViewport.ts';
import { auraComicAnchor, auraPerformerPlacement, auraPerformerTransform, createAuraLayout } from './AuraLayout.ts';

describe('Aura stage layout', () => {
  it.each([[1024, 576], [576, 1024]])('keeps stage, lanes and controls inside the %i×%i canvas', (width, height) => {
    const layout = createAuraLayout(width, height);
    expect(layout.portrait).toBe(height > width);
    expect(layout.stage.y).toBeGreaterThanOrEqual(layout.hudHeight);
    expect(layout.stage.x).toBeGreaterThanOrEqual(0);
    expect(layout.stage.x + layout.stage.width).toBeLessThanOrEqual(width);
    expect(layout.stage.y + layout.stage.height).toBeLessThanOrEqual(height);
    for (const slot of [0, 1] as const) {
      const placement = auraPerformerPlacement(layout, slot, 0);
      expect(placement.footY - placement.height).toBeGreaterThanOrEqual(layout.hudHeight);
      expect(placement.footY).toBeLessThanOrEqual(layout.stage.y + layout.stage.height);
    }
    expect(layout.laneStartY).toBeGreaterThan(layout.hudHeight);
    expect(layout.laneTargetY).toBeGreaterThan(layout.laneStartY);
    expect(layout.keyLabelY).toBeGreaterThan(layout.laneTargetY);
    expect(layout.keyLabelY + 17).toBeLessThan(height);
    const laneXs = layout.laneOffsets.map(offset => layout.highwayX + offset);
    expect(laneXs).toHaveLength(4);
    expect(new Set(laneXs).size).toBe(4);
    expect(laneXs[0] - layout.laneHalfWidth).toBeGreaterThanOrEqual(0);
    expect(laneXs[3] + layout.laneHalfWidth).toBeLessThanOrEqual(width);
    for (let lane = 1; lane < laneXs.length; lane++) expect(laneXs[lane] - laneXs[lane - 1]).toBeGreaterThan(60);
  });

  it('puts the portrait performer above the instrument and hides only the inactive body', () => {
    const layout = createAuraLayout(576, 1024);
    expect(layout.stage.y + layout.stage.height).toBeLessThan(layout.laneStartY);
    expect(layout.feedback.y).toBeGreaterThan(layout.stage.y + layout.stage.height);
    expect(layout.feedback.y).toBeLessThan(layout.laneStartY);
    expect(layout.active).toEqual({ x: 216, footY: 494, height: 300, visible: true });
    expect(layout.inactive.visible).toBe(false);
  });

  it('gives the active desktop body the left stage and the four-lane instrument the right', () => {
    const layout = createAuraLayout();
    expect(layout.active).toEqual({ x: 240, footY: 536, height: 352, visible: true });
    expect(layout.highwayX).toBe(768);
    expect(layout.laneOffsets).toEqual([-144, -48, 48, 144]);
    expect([layout.laneStartY, layout.laneTargetY, layout.keyLabelY]).toEqual([210, 442, 480]);
    expect(layout.active.x).toBeLessThan(layout.width * 0.45);
    expect(layout.highwayX + layout.laneOffsets[0] - 42).toBeGreaterThan(layout.width / 2);
    expect(layout.feedback.x).toBe(layout.highwayX);
  });

  it('hands the same desktop stage mark to either slot without moving rails or keeping the rival visible', () => {
    const layout = createAuraLayout();
    const laneXs = layout.laneOffsets.map(offset => layout.highwayX + offset);
    for (const active of [null, 0, 1, 0, null] as const) {
      expect(auraPerformerPlacement(layout, active ?? 0, active)).toBe(layout.active);
      expect(auraPerformerPlacement(layout, active === 1 ? 0 : 1, active)).toBe(layout.inactive);
      expect([0, 1].filter(slot => auraPerformerPlacement(layout, slot as 0 | 1, active).visible)).toEqual([active ?? 0]);
      expect(layout.laneOffsets.map(offset => layout.highwayX + offset)).toEqual(laneXs);
    }
  });

  it('keeps the portrait active-above-lanes composition through handoffs', () => {
    const layout = createAuraLayout(576, 1024);
    expect(auraPerformerPlacement(layout, 0, null)).toBe(layout.active);
    expect(auraPerformerPlacement(layout, 1, null)).toBe(layout.inactive);
    expect(auraPerformerPlacement(layout, 0, 0)).toBe(layout.active);
    expect(auraPerformerPlacement(layout, 1, 0)).toBe(layout.inactive);
    expect(auraPerformerPlacement(layout, 0, 1)).toBe(layout.inactive);
    expect(auraPerformerPlacement(layout, 1, 1)).toBe(layout.active);
  });

  it('keeps the desktop input history beside the instrument at the receptor height', () => {
    const width = 1024, height = 576;
    const layout = createAuraLayout(width, height);
    const { moveRail, instrument } = layout;
    expect(auraComicAnchor(layout, 0)).toEqual(auraComicAnchor(layout, 1));
    expect(moveRail.left).toBeGreaterThanOrEqual(24);
    expect(moveRail.right).toBeLessThan(instrument.left);
    expect(instrument.left - moveRail.right).toBe(12);
    expect(moveRail.right - moveRail.left).toBe(160);
    expect(moveRail.top).toBeGreaterThan(layout.hudHeight);
    expect(moveRail.bottom).toBeLessThan(height);
    for (const slot of [0, 1] as const) {
      const anchor = auraComicAnchor(layout, slot);
      expect(anchor).toMatchObject({ docked: true, moveRise: 0, streakRise: 0 });
      // Card title, icon, keycaps and streak stay inside the reserved rail.
      expect(anchor.x - 70).toBeGreaterThan(moveRail.left);
      expect(anchor.x + 70).toBeLessThan(moveRail.right);
      expect(anchor.moveY - 78).toBeGreaterThanOrEqual(moveRail.top);
      expect(anchor.moveY + 125).toBeLessThan(anchor.streakY - 18);
      expect(anchor.streakY + 18).toBeLessThan(moveRail.bottom);
      // Key history lines up with the actual hit receptor, making the link visible.
      expect(anchor.moveY + 110).toBe(layout.laneTargetY);
    }
  });

  it('keeps compact portrait move and streak cards in the upper-right stage, away from labels and instrument', () => {
    const layout = createAuraLayout(576, 1024);
    const rail = layout.moveRail;
    const anchor = auraComicAnchor(layout, 0);
    expect(anchor).toEqual(auraComicAnchor(layout, 1));
    expect(anchor).toMatchObject({ docked: true, stageCard: true, moveRise: 0, streakRise: 0 });
    expect(rail.top).toBeGreaterThan(layout.stage.y);
    expect(rail.bottom).toBeLessThan(layout.stage.y + layout.stage.height);
    expect(rail.bottom).toBeLessThan(layout.instrument.top);
    // The performer label's maximum width is 256px. The pocket also leaves
    // 200px to the right of the active mark for broad authored moves.
    expect(rail.left).toBeGreaterThan(layout.performerLabel.x + 128);
    expect(rail.left - layout.active.x).toBeGreaterThanOrEqual(200);
    expect(anchor.x - 80 * anchor.scale).toBeGreaterThanOrEqual(rail.left);
    expect(anchor.x + 80 * anchor.scale).toBeLessThanOrEqual(rail.right);
    expect(anchor.moveY - 84 * anchor.scale).toBeGreaterThanOrEqual(rail.top);
    expect(anchor.moveY + 134 * anchor.scale).toBeLessThan(anchor.streakY - 25 * anchor.scale);
    expect(anchor.streakY + 25 * anchor.scale).toBeLessThan(rail.bottom);
  });

  it.each([[320, 568], [390, 844], [432, 768], [767, 1024]])(
    'fills the usable width with four lanes aligned to touch pads at %i×%i', (viewportWidth, viewportHeight) => {
      const canvas = getAuraCanvasSize(viewportWidth, viewportHeight);
      const layout = createAuraLayout(canvas.width, canvas.height);
      expect(layout.portrait).toBe(true);
      const centers = layout.laneOffsets.map(offset => layout.highwayX + offset);
      expect(centers).toEqual([90, 222, 354, 486]);
      const cellWidth = centers[1] - centers[0];
      // Four evenly sized touch cells use the whole interior (24px per side).
      expect(centers[0] - cellWidth / 2).toBe(24);
      expect(centers[3] + cellWidth / 2).toBe(layout.width - 24);
      expect(layout.laneHalfWidth * 2).toBe(cellWidth - 16);
      expect(layout.instrument.left).toBe(20);
      expect(layout.instrument.right).toBe(layout.width - 20);
      const cssScale = Math.min(viewportWidth / canvas.width, viewportHeight / canvas.height);
      expect(cellWidth * cssScale - 4).toBeGreaterThanOrEqual(44);
      // Mirrored in styles.css: left 4.166667%, width 91.666667%, gap zero.
      const renderedWidth = canvas.width * cssScale;
      centers.forEach((center, lane) => {
        const buttonCenter = renderedWidth * (0.04166667 + 0.91666667 * (lane + 0.5) / 4);
        expect(Math.abs(buttonCenter - center * cssScale)).toBeLessThan(0.01);
      });
    },
  );

  it.each([[1024, 576], [576, 1024]])('shows two separated equal bodies only for a shared finale at %i×%i', (width, height) => {
    const layout = createAuraLayout(width, height);
    const left = auraPerformerPlacement(layout, 0, null, true);
    const right = auraPerformerPlacement(layout, 1, null, true);
    expect(left.visible && right.visible).toBe(true);
    expect(left.x).toBeLessThan(right.x);
    expect(left.height).toBe(right.height);
    expect(left.footY).toBe(right.footY);
    expect(left.footY - left.height).toBeGreaterThan(layout.hudHeight);
    expect(right.footY).toBeLessThan(layout.stage.y + layout.stage.height);
    expect(auraPerformerPlacement(layout, 1, null).visible).toBe(false);
  });
});

describe('Aura calibrated whole-rig placement', () => {
  const placement = auraPerformerPlacement(createAuraLayout(), 0, 0);
  const body = { rootX: 253.75, rootY: 456.5, height: 231.25 };

  it('maps the exclusive physical foot and stable visible idle height to the chosen stage placement', () => {
    const original = { ...body };
    const transform = auraPerformerTransform(body, placement);
    expect(body.rootX * transform.scale + transform.x).toBeCloseTo(placement.x, 10);
    expect(body.rootY * transform.scale + transform.y).toBeCloseTo(placement.footY, 10);
    expect(body.height * transform.scale).toBeCloseTo(placement.height, 10);
    expect(body).toEqual(original);
  });

  it('preserves a deliberately low pose and airborne offset instead of normalizing each animation to idle', () => {
    const transform = auraPerformerTransform(body, placement);
    const crouchHead = body.rootY - body.height * 0.55;
    const airborneFoot = body.rootY - 28;
    expect(placement.footY - (crouchHead * transform.scale + transform.y))
      .toBeCloseTo(placement.height * 0.55, 10);
    expect(airborneFoot * transform.scale + transform.y)
      .toBeCloseTo(placement.footY - 28 * transform.scale, 10);
  });

  it('produces the same visible points for equivalent 1× and 4× calibrated source geometry', () => {
    const point = { x: body.rootX + 43, y: body.rootY - 112 };
    const normal = auraPerformerTransform(body, placement);
    const hq = auraPerformerTransform({ rootX: body.rootX * 4, rootY: body.rootY * 4, height: body.height * 4 }, placement);
    expect(point.x * normal.scale + normal.x).toBeCloseTo(point.x * 4 * hq.scale + hq.x, 10);
    expect(point.y * normal.scale + normal.y).toBeCloseTo(point.y * 4 * hq.scale + hq.y, 10);
  });

  it('anchors either asymmetric facing root without moving or mutating the fighter', () => {
    const flippedBody = { ...body, rootX: body.rootX + 7.25 };
    const normal = auraPerformerTransform(body, placement);
    const flipped = auraPerformerTransform(flippedBody, placement);
    expect(normal.scale).toBe(flipped.scale);
    expect(body.rootX * normal.scale + normal.x).toBeCloseTo(placement.x, 10);
    expect(flippedBody.rootX * flipped.scale + flipped.x).toBeCloseTo(placement.x, 10);
    expect(normal.y).toBe(flipped.y);
  });
});
