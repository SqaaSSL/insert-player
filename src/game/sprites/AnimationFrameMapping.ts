import type { AttackData } from '../constants.ts';
import type { SpritePlaybackMode } from './SpriteGenerator.ts';

interface ActionFrameMappingInput {
  stateFrame: number;
  frameCount: number;
  totalDuration: number;
  playbackMode: SpritePlaybackMode;
  attack?: Pick<AttackData, 'startup' | 'active' | 'recovery'>;
}

/**
 * Maps deterministic combat ticks to visual cells without changing combat timing.
 * Dense attacks store only their forward keyframes; recovery walks those cells
 * backwards while legacy full-cycle sheets keep their original timeline mapping.
 */
export function getActionAnimationFrame({
  stateFrame,
  frameCount,
  totalDuration,
  playbackMode,
  attack,
}: ActionFrameMappingInput): number {
  if (frameCount <= 1 || totalDuration <= 1) return 0;

  const tick = Math.max(0, Math.min(Math.floor(stateFrame), totalDuration - 1));

  if (playbackMode === 'forward-ping-pong' && attack) {
    const forwardTicks = Math.max(
      1,
      Math.min(totalDuration, attack.startup + attack.active),
    );

    if (tick < forwardTicks) {
      if (forwardTicks === 1) return frameCount - 1;
      return Math.round((tick / (forwardTicks - 1)) * (frameCount - 1));
    }

    const recoveryTicks = Math.max(1, totalDuration - forwardTicks);
    const recoveryTick = tick - forwardTicks;
    const recoveryStartFrame = Math.max(0, frameCount - 2);
    if (recoveryTicks === 1) return 0;
    return recoveryStartFrame - Math.round(
      (recoveryTick / (recoveryTicks - 1)) * recoveryStartFrame,
    );
  }

  const framesPerAnimationFrame = Math.max(1, Math.floor(totalDuration / frameCount));
  return Math.min(
    Math.floor(tick / framesPerAnimationFrame),
    frameCount - 1,
  );
}
