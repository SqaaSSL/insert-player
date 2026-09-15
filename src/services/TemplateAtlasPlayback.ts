import type { TemplateAtlasAnimationName, TemplateAtlasRendererVersion } from './TemplateAtlasContract';

/** Binds the Worker playback contract to the frozen private processor bundle. */
export const TEMPLATE_ATLAS_MANIFEST_SHA256 = 'd352bb3fd4151673a4739ebf6e4cad2211bce6ae1f5b06ddbdccd7bb46ef8de8';
const MASTER_SEQUENCE: Record<TemplateAtlasAnimationName, readonly number[]> = {
  idle: [1, 2, 3, 4, 5, 6, 7, 8],
  walk: [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
  high_punch: [21, 22, 23, 24, 25, 24, 23, 22, 21],
  high_kick: [26, 27, 28, 29, 30, 31, 32, 32, 33, 34, 34, 34, 33, 32, 32, 31, 30, 29, 28, 27, 26],
  low_punch: [35, 36, 37, 38, 39, 39, 39, 38, 37, 36, 35],
  low_kick: [35, 40, 41, 42, 43, 44, 45, 46, 45, 44, 43, 42, 41, 40, 35],
  jump: [47, 48, 49, 50, 51, 52, 47],
  crouch: [26, 53, 54, 55, 56, 35],
  hit: [57, 58, 59, 60, 61, 62],
  ko: [21, 21, 63, 64, 65, 66, 67, 68, 68, 69, 69, 69],
  victory: [47, 70, 71, 72, 73, 74, 75, 75, 75, 75, 75, 75],
  uppercut: [76, 77, 78, 79, 21],
  fireball: [80, 81, 82, 21],
  aura_unbothered: [83, 84, 85, 86, 87, 88, 89, 90],
  aura_six_seven: [91, 92, 93, 94, 95, 92, 96, 94],
  aura_mog_check: [97, 98, 99, 100, 101, 102, 103, 104],
  aura_glide: [105, 106, 107, 108, 109, 110, 111, 112],
  aura_floor_worm: [113, 114, 115, 116, 117, 118, 119, 120],
  aura_one_leg: [121, 122, 123, 124, 125, 126, 127, 128],
  aura_shrug: [129, 130, 129, 131, 129, 130, 129, 131],
};
export function templateAtlasPlayback(name: TemplateAtlasAnimationName) {
  return { sequence: MASTER_SEQUENCE[name].map(id => `master-${String(id).padStart(3, '0')}`),
    fps: 8, loop: name === 'idle' || name === 'walk' || name.startsWith('aura_') };
}

/** Only atlas pages actually read by this animation, not every compile RPC input. */
export function templateAtlasSourcePlanIds(renderer: TemplateAtlasRendererVersion, name: TemplateAtlasAnimationName) {
  if (renderer === 'champion-animation-sheet-v1') return [`${renderer}:${name}`];
  const sequence = MASTER_SEQUENCE[name];
  return [sequence.some(id => id <= 66) ? `${renderer}:two-01` : null,
    sequence.some(id => id >= 67) ? `${renderer}:two-02` : null].filter((id): id is string => id !== null);
}
