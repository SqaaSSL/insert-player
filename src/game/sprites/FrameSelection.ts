import { FighterState } from '../constants.ts';

interface ExactFrameSelection {
  sourceFrameCount: number;
  targetFrameCount: number;
  sourceIndices: readonly number[];
}

// Generated attacks are seven-frame temporal palindromes:
// rest, windup, strike, impact, strike, windup, rest.
// Their runtime slots have different gameplay meanings, so preserve those
// meanings explicitly instead of uniformly resampling the source timeline.
const ATTACK_FRAME_SELECTIONS: Partial<Record<FighterState, ExactFrameSelection>> = {
  [FighterState.HIGH_PUNCH]: {
    sourceFrameCount: 7,
    targetFrameCount: 3,
    sourceIndices: [0, 3, 6],
  },
  [FighterState.LOW_PUNCH]: {
    sourceFrameCount: 7,
    targetFrameCount: 3,
    sourceIndices: [0, 3, 6],
  },
  [FighterState.HIGH_KICK]: {
    sourceFrameCount: 7,
    targetFrameCount: 4,
    // Slot 1 overlaps HIGH_KICK's active combat frames, so it must show impact.
    // Slot 2 begins recovery and therefore uses the first post-impact pose.
    sourceIndices: [0, 3, 4, 6],
  },
  [FighterState.LOW_KICK]: {
    sourceFrameCount: 7,
    targetFrameCount: 3,
    sourceIndices: [0, 3, 6],
  },
};

const LOOPING_STATES = new Set<FighterState>([
  FighterState.IDLE,
  FighterState.WALK_FORWARD,
  FighterState.WALK_BACKWARD,
]);

export function selectSourceFrameIndex(
  state: FighterState,
  isDirectAnimation: boolean,
  frameIndex: number,
  targetFrameCount: number,
  sourceFrameCount: number,
): number {
  if (sourceFrameCount <= 1) return 0;

  const exactSelection = ATTACK_FRAME_SELECTIONS[state];
  if (
    isDirectAnimation &&
    exactSelection &&
    sourceFrameCount === exactSelection.sourceFrameCount &&
    targetFrameCount === exactSelection.targetFrameCount
  ) {
    return exactSelection.sourceIndices[Math.min(frameIndex, exactSelection.sourceIndices.length - 1)];
  }

  if (targetFrameCount <= 1) {
    return LOOPING_STATES.has(state) ? 0 : sourceFrameCount - 1;
  }

  if (LOOPING_STATES.has(state)) {
    return Math.min(
      Math.floor((frameIndex / targetFrameCount) * sourceFrameCount),
      sourceFrameCount - 1,
    );
  }

  return Math.min(
    Math.round((frameIndex / (targetFrameCount - 1)) * (sourceFrameCount - 1)),
    sourceFrameCount - 1,
  );
}
