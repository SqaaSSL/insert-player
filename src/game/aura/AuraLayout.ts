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
  // Portrait gives all four lanes the usable width. The move card lives in
  // the stage, leaving the instrument and touch pads on the same four centres.
  const highwayX = portrait ? width / 2 : width * 0.75;
  const laneCellWidth = portrait ? (width - 48) / 4 : 96;
  const laneOffsets = [-1.5, -0.5, 0.5, 1.5].map(cell => cell * laneCellWidth);
  const laneHalfWidth = portrait ? laneCellWidth / 2 - 8 : 30;
  const laneStartY = portrait ? 620 : 210;
  const keyLabelY = portrait ? 892 : 480;
  const instrumentLeft = highwayX + laneOffsets[0] - laneHalfWidth - 12;
  const instrumentRight = highwayX + laneOffsets[3] + laneHalfWidth + 12;
  return {
    width, height, portrait,
    hudHeight: portrait ? 160 : 128,
    highwayX,
    laneOffsets,
    laneHalfWidth,
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
    active: { x: portrait ? 216 : width * 0.234375, footY: portrait ? 494 : 536, height: portrait ? 300 : 352, visible: true },
    inactive: { x: 76, footY: portrait ? 494 : 536, height: 110, visible: false },
    // Shared framing gives each performer an equal seat in the stage.
    finaleSeats: [
      { x: width * 0.3125, footY: portrait ? 494 : 536, height: portrait ? 230 : 352, visible: true },
      { x: width * 0.6875, footY: portrait ? 494 : 536, height: portrait ? 230 : 352, visible: true },
    ] as const,
    performerLabel: { x: portrait ? 216 : width * 0.234375, y: portrait ? 180 : 150 },
    feedback: { x: highwayX, y: portrait ? 531 : 144 },
    moveRail: portrait
      ? { left: width - 160, right: width - 16, top: 198, bottom: 434 }
      : { left: instrumentLeft - 172, right: instrumentLeft - 12, top: laneStartY + 22, bottom: keyLabelY + 82 },
    comic: portrait
      ? { x: width - 88, moveY: 270, streakY: 409, scale: 0.85, stageCard: true }
      : { x: instrumentLeft - 92, moveY: 332, streakY: keyLabelY + 40, scale: 1, stageCard: false },
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
