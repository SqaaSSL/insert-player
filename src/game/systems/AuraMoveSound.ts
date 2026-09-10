import type { AuraAnimationName } from '../../services/FighterAssetPacks.ts';

export interface AuraMoveTone {
  wave: OscillatorType;
  fromHz: number;
  toHz: number;
  delayMs: number;
  durationMs: number;
  gain: number;
}

/** Tiny arcade signatures for a newly displayed move bubble. Gains are before
 * SoundManager's 0.4 master; no motif exceeds 0.16 even with overlapping voices. */
export const AURA_MOVE_SOUNDS: Readonly<Record<AuraAnimationName, readonly AuraMoveTone[]>> = {
  // A smooth, glassy lift.
  aura_glide: [
    { wave: 'sine', fromHz: 260, toHz: 780, delayMs: 0, durationMs: 250, gain: 0.085 },
    { wave: 'triangle', fromHz: 520, toHz: 1040, delayMs: 45, durationMs: 210, gain: 0.035 },
  ],
  // Two dry syllables: six, seven.
  aura_six_seven: [
    { wave: 'square', fromHz: 660, toHz: 630, delayMs: 0, durationMs: 85, gain: 0.065 },
    { wave: 'square', fromHz: 770, toHz: 740, delayMs: 130, durationMs: 115, gain: 0.07 },
  ],
  // A confident, rounded power chord.
  aura_mog_check: [
    { wave: 'triangle', fromHz: 196, toHz: 174, delayMs: 0, durationMs: 290, gain: 0.09 },
    { wave: 'sine', fromHz: 294, toHz: 261, delayMs: 8, durationMs: 260, gain: 0.045 },
  ],
  // Rubber bending down, then back up.
  aura_floor_worm: [
    { wave: 'triangle', fromHz: 320, toHz: 115, delayMs: 0, durationMs: 150, gain: 0.095 },
    { wave: 'triangle', fromHz: 115, toHz: 250, delayMs: 140, durationMs: 150, gain: 0.055 },
  ],
  // A springy boing with a short landing.
  aura_one_leg: [
    { wave: 'sine', fromHz: 190, toHz: 720, delayMs: 0, durationMs: 105, gain: 0.095 },
    { wave: 'sine', fromHz: 640, toHz: 210, delayMs: 90, durationMs: 175, gain: 0.055 },
  ],
  // A little descending hesitation, then a questioning rise.
  aura_shrug: [
    { wave: 'triangle', fromHz: 440, toHz: 330, delayMs: 0, durationMs: 100, gain: 0.065 },
    { wave: 'triangle', fromHz: 330, toHz: 590, delayMs: 125, durationMs: 170, gain: 0.075 },
  ],
  // Quiet confidence: one low, unhurried pluck.
  aura_unbothered: [
    { wave: 'sine', fromHz: 392, toHz: 349, delayMs: 0, durationMs: 180, gain: 0.07 },
  ],
};
