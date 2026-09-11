import { describe, expect, it, vi } from 'vitest';

vi.mock('phaser', () => ({ default: {} }));

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
    expect(laneXs[0] - 30).toBeGreaterThanOrEqual(0);
    expect(laneXs[3] + 30).toBeLessThanOrEqual(width);
    for (let lane = 1; lane < laneXs.length; lane++) expect(laneXs[lane] - laneXs[lane - 1]).toBeGreaterThan(60);
  });

  it('puts the portrait performer above the instrument and hides only the inactive body', () => {
    const layout = createAuraLayout(576, 1024);
    expect(layout.stage.y + layout.stage.height).toBeLessThan(layout.laneStartY);
    expect(layout.feedback.y).toBeGreaterThan(layout.stage.y + layout.stage.height);
    expect(layout.feedback.y).toBeLessThan(layout.laneStartY);
    expect(layout.active).toEqual({ x: 240, footY: 494, height: 300, visible: true });
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

  it.each([[1024, 576], [576, 1024]])('docks either performer to the same move rail beside the instrument at %i×%i', (width, height) => {
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

  it('moves the portrait feedback below the performer and preserves four usable touch columns', () => {
    const layout = createAuraLayout(576, 1024);
    const laneCenters = layout.laneOffsets.map(offset => layout.highwayX + offset);
    expect(laneCenters).toEqual([238, 326, 414, 502]);
    expect(layout.moveRail.top).toBeGreaterThan(layout.stage.y + layout.stage.height);
    expect(layout.instrument.right).toBeLessThan(layout.width);
    const cellWidth = laneCenters[1] - laneCenters[0];
    // The controls have 2px margins on each side; even a 320px-wide phone
    // retains a 44px touch target without intruding into the move rail.
    expect(cellWidth / layout.width * 320 - 4).toBeGreaterThanOrEqual(44);
    expect(laneCenters[0] - cellWidth / 2).toBeGreaterThan(layout.moveRail.right);
    expect(laneCenters.at(-1)! + cellWidth / 2).toBeLessThan(layout.width);
  });

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
