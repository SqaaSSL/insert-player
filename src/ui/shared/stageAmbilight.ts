/**
 * Stage ambilight: projects the live match colours onto the letterbox pillars
 * beside the combat canvas, the way a TV lights the wall behind it.
 *
 * A tiny canvas (48×27) receives a copy of the Phaser canvas a few times per
 * second; CSS stretches it across the whole combat frame behind the real stage
 * and blurs it heavily, so only colour survives: no figures, no detail, nothing
 * for the eye to track. Sampling happens inside Phaser's `postrender` event,
 * the one moment a WebGL canvas can be read without `preserveDrawingBuffer`.
 */

export const AMBILIGHT_SAMPLE_WIDTH = 48;
export const AMBILIGHT_SAMPLE_HEIGHT = 27;
/** Copy one frame out of every N rendered frames (~10 fps at 60 Hz). */
export const AMBILIGHT_FRAME_INTERVAL = 6;
/** Phaser.Core.Events.POST_RENDER, spelled out so this module never imports Phaser. */
const PHASER_POST_RENDER_EVENT = 'postrender';

export interface AmbilightEnvironment {
  sceneKey: string;
  coarsePointer: boolean;
  reducedMotion: boolean;
}

/** Desktop only: touch shells have no letterbox to light. Fight, Rush and Aura all keep their aspect on wide screens. */
export function ambilightEnabled(env: AmbilightEnvironment): boolean {
  if (env.coarsePointer || env.reducedMotion) return false;
  return env.sceneKey === 'FightScene' || env.sceneKey === 'RushScene' || env.sceneKey === 'AuraScene';
}

export function readAmbilightEnvironment(sceneKey: string): AmbilightEnvironment {
  const matches = (query: string) => typeof window !== 'undefined' && Boolean(window.matchMedia?.(query).matches);
  return {
    sceneKey,
    coarsePointer: matches('(pointer: coarse)'),
    reducedMotion: matches('(prefers-reduced-motion: reduce)'),
  };
}

export function shouldSampleAmbilightFrame(frame: number, interval = AMBILIGHT_FRAME_INTERVAL): boolean {
  return frame % interval === 0;
}

interface AmbilightGameLike {
  canvas: HTMLCanvasElement | CanvasImageSource;
  events: {
    on(event: string, handler: () => void): unknown;
    off(event: string, handler: () => void): unknown;
  };
}

export interface AmbilightSurface {
  drawImage(image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void;
}

export interface AttachAmbilightOptions {
  /** Called once the first frame has been projected, so the shell can fade the light in. */
  onFirstFrame?: () => void;
  isHidden?: () => boolean;
  interval?: number;
}

/**
 * Starts projecting `game.canvas` into `surface` and returns the detach function.
 * The surface is expected to be the 2D context of a canvas sized
 * AMBILIGHT_SAMPLE_WIDTH × AMBILIGHT_SAMPLE_HEIGHT.
 */
export function attachStageAmbilight(
  game: AmbilightGameLike,
  surface: AmbilightSurface,
  options: AttachAmbilightOptions = {},
): () => void {
  const interval = options.interval ?? AMBILIGHT_FRAME_INTERVAL;
  const isHidden = options.isHidden ?? (() => typeof document !== 'undefined' && document.hidden);
  let frame = 0;
  let projected = false;
  const onPostRender = () => {
    frame += 1;
    if (!shouldSampleAmbilightFrame(frame, interval) || isHidden()) return;
    try {
      surface.drawImage(game.canvas, 0, 0, AMBILIGHT_SAMPLE_WIDTH, AMBILIGHT_SAMPLE_HEIGHT);
    } catch {
      // A detached or tainted canvas must never break the match; the light just stays off.
      return;
    }
    if (!projected) {
      projected = true;
      options.onFirstFrame?.();
    }
  };
  game.events.on(PHASER_POST_RENDER_EVENT, onPostRender);
  return () => {
    game.events.off(PHASER_POST_RENDER_EVENT, onPostRender);
  };
}
