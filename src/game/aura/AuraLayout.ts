import type { AuraSlot } from './AuraChart.ts';

export interface AuraPerformerPlacement {
  x: number;
  footY: number;
  height: number;
  visible: boolean;
}

/** Each turn gets one body and one stable instrument. Desktop gives the
 * performer the left stage and the controls the right; portrait stacks them. */
export function createAuraLayout(width = 1024, height = 576) {
  const portrait = height > width;
  // Reserve a move rail on the left; portrait lanes still have 88px centres
  // (about 60 CSS pixels on a 390px phone), with unchanged note travel time.
  const highwayX = portrait ? width - 206 : width * 0.75;
  const laneOffsets = portrait ? [-132, -44, 44, 132] : [-144, -48, 48, 144];
  const laneStartY = portrait ? 620 : 210;
  const keyLabelY = portrait ? 892 : 480;
  const instrumentLeft = highwayX + laneOffsets[0] - 42;
  const instrumentRight = highwayX + laneOffsets[3] + 42;
  return {
    width, height, portrait,
    hudHeight: portrait ? 160 : 128,
    highwayX,
    laneOffsets,
    laneStartY,
    laneTargetY: portrait ? 850 : 442,
    keyLabelY,
    instrument: {
      left: instrumentLeft, right: instrumentRight, top: laneStartY - 30, bottom: keyLabelY + 82,
      comboX: instrumentRight - 12, comboY: laneStartY - 21,
      // Touch buttons occupy the portrait footer, so its compact crowd meter
      // shares the header between the rhythm title and FLOW.
      crowdX: portrait ? highwayX + 60 : instrumentRight - 12,
      crowdY: portrait ? laneStartY - 21 : keyLabelY + 59,
      crowdMeterY: portrait ? laneStartY - 10 : keyLabelY + 70,
      crowdSegmentWidth: portrait ? 12 : 22,
    },
    stage: { x: 0, y: portrait ? 160 : 128, width, height: portrait ? 364 : height - 128 },
    active: { x: portrait ? 240 : width * 0.234375, footY: portrait ? 494 : 536, height: portrait ? 300 : 352, visible: true },
    inactive: { x: 76, footY: portrait ? 494 : 536, height: 110, visible: false },
    // Only a tied finale shows both bodies, after the notes/controls have gone.
    finaleSeats: [
      { x: width * 0.3125, footY: portrait ? 494 : 536, height: portrait ? 230 : 352, visible: true },
      { x: width * 0.6875, footY: portrait ? 494 : 536, height: portrait ? 230 : 352, visible: true },
    ] as const,
    performerLabel: { x: portrait ? 240 : width * 0.234375, y: portrait ? 180 : 150 },
    feedback: { x: highwayX, y: portrait ? 531 : 144 },
    moveRail: { left: instrumentLeft - 172, right: instrumentLeft - 12, top: laneStartY + 22, bottom: keyLabelY + 82 },
    comic: { x: instrumentLeft - 92, moveY: (portrait ? 850 : 442) - 110, streakY: keyLabelY + 40 },
    balance: { left: 24, right: width - 24, y: portrait ? 114 : 90, height: 24 },
  };
}

export type AuraLayout = ReturnType<typeof createAuraLayout>;

export function auraPerformerPlacement(layout: AuraLayout, slot: AuraSlot, active: AuraSlot | null, sharedFinale = false): AuraPerformerPlacement {
  if (sharedFinale) return layout.finaleSeats[slot];
  // During count-in, the first performer already owns the stage.
  return slot === (active ?? 0) ? layout.active : layout.inactive;
}

export function auraComicAnchor(layout: AuraLayout, _slot: AuraSlot) {
  return { ...layout.comic, moveRise: 0, streakRise: 0, docked: true };
}

/** Transform the complete calibrated rig around its stable idle foot. This
 * preserves intentional crouches, jumps and per-frame authored offsets. */
export function auraPerformerTransform(
  body: { rootX: number; rootY: number; height: number },
  placement: AuraPerformerPlacement,
) {
  const scale = placement.height / Math.max(1, body.height);
  return { x: placement.x - body.rootX * scale, y: placement.footY - body.rootY * scale, scale };
}
