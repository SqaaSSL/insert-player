import type { AuraSlot } from './AuraChart.ts';
import type { AuraLayout, AuraPerformerPlacement } from './AuraLayout.ts';

export const AURA_CAMERA_HANDOFF_MS = 720;
export const AURA_CAMERA_FINALE_MS = 800;

export interface AuraCameraInput {
  /** The last/current camera subject, independent of who wins the match. */
  activeSlot: AuraSlot | null;
  fromSlot?: AuraSlot | null;
  /** Linear elapsed time / AURA_CAMERA_HANDOFF_MS; the helper applies easing. */
  transitionProgress?: number;
  /** Opening two-shot at one; pan/zoom to the active player as it reaches zero. */
  introProgress?: number;
  /** Present only for the finale. Zero starts from the exact current framing. */
  finaleProgress?: number;
  /** Use the compact victory/defeat framing. */
  resultTableau?: boolean;
  /** Move the finished tableau beside the controls only after capture stops. */
  resultDockProgress?: number;
  reducedMotion?: boolean;
}

export interface AuraCameraPerformer extends AuraPerformerPlacement {
  alpha: number;
}

export interface AuraCameraComposition {
  performers: [AuraCameraPerformer, AuraCameraPerformer];
  camera: { focusX: number; anchorX: number; zoom: number };
  /** Presentation-only parallax in canvas pixels. Never translate the UI layer. */
  backdropOffsetX: number;
  /** Apply after cover sizing, keeping the authored floor under the feet. */
  backdropScale: number;
  transitioning: boolean;
  finale: boolean;
}

function progress(value: number): number {
  return Number.isNaN(value) ? 0 : Math.min(1, Math.max(0, value));
}

function ease(value: number): number {
  const t = progress(value);
  return t * t * (3 - 2 * t);
}

function mix(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

/** Project two fixed marks through one camera, so actors retain their physical
 * order during a handoff instead of exchanging the same screen position.
 * Notes, controls, scores and feedback remain in the unchanged AuraLayout.
 *
 * All progress inputs are linear and deterministic: callers may seek, pause or
 * sample at any frame rate. When a finale interrupts a handoff, preserve that
 * handoff's progress as its starting frame while advancing finaleProgress.
 * Celebration/defeat poses belong to the caller; the camera treats both equally.
 */
export function auraCameraComposition(layout: AuraLayout, input: AuraCameraInput): AuraCameraComposition {
  const subject = input.activeSlot ?? input.fromSlot ?? 0;
  const previous = input.fromSlot ?? subject;
  const reducedMotion = input.reducedMotion === true;
  const turning = previous !== subject;
  const turnProgress = reducedMotion || !turning ? 1 : progress(input.transitionProgress ?? 1);
  const turnEase = ease(turnProgress);
  let distance = Math.min(layout.width * (layout.portrait ? 0.42 : 0.24), layout.active.height * 0.75);
  let marks: readonly [number, number] = [0, distance];

  let focusX = mix(marks[previous], marks[subject], turnEase);
  let anchorX = layout.active.x;
  // Pull back just enough for the two bodies to coexist during the pan. The
  // feet stay on one plane; neither rig gets a per-frame pose normalization.
  const pullback = turning ? Math.sin(Math.PI * turnEase) ** 2 : 0;
  let zoom = 1 - pullback * 0.10;
  let alphas: [number, number] = subject === 0 ? [1, 0] : [0, 1];
  if (turning) {
    alphas = [0, 0];
    alphas[subject] = ease(turnProgress / 0.36);
    alphas[previous] = 1 - ease((turnProgress - 0.64) / 0.36);
  }

  const finale = input.finaleProgress !== undefined;
  const intro = !finale && input.introProgress !== undefined;
  const requestedIntroProgress = progress(input.introProgress ?? 0);
  // Hold the opening pose, then cut to the player when its handoff starts.
  // Reusing the finale's reduced-motion endpoint would keep both actors shown.
  const introProgress = reducedMotion && requestedIntroProgress < 1 ? 0 : requestedIntroProgress;
  if (intro && introProgress > 0) {
    const introEase = ease(introProgress);
    const introHeight = layout.portrait ? 230 : layout.active.height * 0.96;
    const introZoom = introHeight / layout.active.height;
    const introSpacing = layout.width * (layout.portrait ? 0.44 : 0.34);
    const widerDistance = mix(distance, introSpacing / introZoom, introEase);
    focusX = mix(focusX / distance, 0.5, introEase) * widerDistance;
    distance = widerDistance;
    marks = [0, distance];
    anchorX = mix(anchorX, layout.width / 2, introEase);
    zoom = mix(zoom, introZoom, introEase);
    alphas = [mix(alphas[0], 1, introEase), mix(alphas[1], 1, introEase)];
  }
  const finaleProgress = reducedMotion ? 1 : progress(input.finaleProgress ?? 0);
  if (finale) {
    const finaleEase = ease(finaleProgress);
    focusX = mix(focusX, distance / 2, finaleEase);
    const result = input.resultTableau === true;
    const dock = result && !layout.portrait ? ease(reducedMotion && input.resultDockProgress !== undefined
      ? 1 : input.resultDockProgress ?? 0) : 0;
    const finalAnchor = mix(layout.width / 2, layout.width * 0.28, dock);
    const finalHeight = result ? layout.portrait ? 260 : 270 : layout.portrait ? 230 : layout.active.height * 0.96;
    anchorX = mix(anchorX, finalAnchor, finaleEase);
    zoom = mix(zoom, finalHeight / layout.active.height, finaleEase);
    alphas = [mix(alphas[0], 1, finaleEase), mix(alphas[1], 1, finaleEase)];
  }

  const performers = marks.map((mark, slot) => ({
    x: anchorX + (mark - focusX) * zoom,
    footY: layout.active.footY,
    height: layout.active.height * zoom,
    alpha: alphas[slot],
    visible: alphas[slot] > 0,
  })) as [AuraCameraPerformer, AuraCameraPerformer];

  return {
    performers,
    camera: { focusX, anchorX, zoom },
    backdropOffsetX: (distance / 2 - focusX) * 0.18,
    backdropScale: 1.14 + (zoom - 1) * 0.24,
    transitioning: !reducedMotion && (finale ? finaleProgress < 1
      : intro && introProgress > 0 ? introProgress < 1 : turning && turnProgress < 1),
    finale,
  };
}
