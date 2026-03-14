export interface AnimationProfile {
  targetHeightRatio: number;
  targetWidthRatio: number;
  baselineRatio: number;
  lockScaleAcrossFrames?: boolean;
  promptRules: string[];
}

const DEFAULT_PROFILE: AnimationProfile = {
  targetHeightRatio: 0.84,
  targetWidthRatio: 0.8,
  baselineRatio: 0.95,
  promptRules: [
    'Keep the character full-size in every frame with no camera zoom changes.',
    'Keep the feet aligned to the same ground line unless the move explicitly falls to the floor.',
  ],
};

const PROFILES: Record<string, AnimationProfile> = {
  idle: {
    targetHeightRatio: 0.84,
    targetWidthRatio: 0.76,
    baselineRatio: 0.95,
    promptRules: [
      'This is a grounded standing stance. Both feet stay planted on the floor.',
      'Only tiny breathing and weight-shift changes are allowed. No crouching and no hopping.',
    ],
  },
  walk: {
    targetHeightRatio: 0.84,
    targetWidthRatio: 0.8,
    baselineRatio: 0.95,
    promptRules: [
      'This is a grounded fighting-game walk cycle, not a run and not a hop.',
      'The body stays at the same apparent size in every frame.',
    ],
  },
  high_punch: {
    targetHeightRatio: 0.84,
    targetWidthRatio: 0.82,
    baselineRatio: 0.95,
    promptRules: [
      'This is a regular standing punch only. The move must stay fully grounded.',
      'No jump, no hop, no knee-up leap, and no airborne frame.',
      'The support stance stays close to the idle pose while the punching arm extends and retracts.',
    ],
  },
  high_kick: {
    targetHeightRatio: 0.84,
    targetWidthRatio: 0.84,
    baselineRatio: 0.95,
    promptRules: [
      'This is a standing kick only. The move must stay grounded throughout.',
      'The support foot remains planted. No flying kick, no jump, and no hop.',
    ],
  },
  low_punch: {
    targetHeightRatio: 0.64,
    targetWidthRatio: 0.8,
    baselineRatio: 0.95,
    promptRules: [
      'Start and stay in a deep crouch for the entire move.',
      'Hips stay low, knees stay deeply bent, and the torso never rises back toward standing height.',
      'This is crouch plus punch, not a standing punch.',
    ],
  },
  low_kick: {
    targetHeightRatio: 0.64,
    targetWidthRatio: 0.84,
    baselineRatio: 0.95,
    promptRules: [
      'Start and stay in a deep crouch for the entire move.',
      'Keep the center of gravity low throughout. Do not stand up during the kick.',
      'This is a grounded crouching sweep, not a jumping kick.',
    ],
  },
  jump: {
    targetHeightRatio: 0.84,
    targetWidthRatio: 0.8,
    baselineRatio: 0.95,
    promptRules: [
      'This jump is exactly four key poses: anticipation, lift-off, apex, and landing.',
      'Keep the character the same apparent size as the standing pose in every frame.',
      'Do not animate the character physically traveling upward inside the frame.',
      'The game engine handles vertical movement. Only show the pose progression of anticipation, airborne posture, and landing.',
      'Every frame must stay inside its own cell with margin on the left and right. Never let the body cross a cell boundary.',
      'Each frame must contain exactly one complete character silhouette. No duplicate limbs, no echo trails, and no detached body fragments.',
    ],
  },
  crouch: {
    targetHeightRatio: 0.84,
    targetWidthRatio: 0.78,
    baselineRatio: 0.95,
    lockScaleAcrossFrames: true,
    promptRules: [
      'This is a true transition from the standing pose down into the crouch pose.',
      'Frame 1 should stay at standing scale and closely match the standing reference pose.',
      'The final frame should closely match the crouch reference pose with hips and head physically lower than the starting frame.',
      'The body should compress downward over the sequence instead of the camera zooming out or shrinking the whole character.',
    ],
  },
  hit: {
    targetHeightRatio: 0.84,
    targetWidthRatio: 0.8,
    baselineRatio: 0.95,
    promptRules: [
      'This is a grounded hit reaction only, not an aerial launch.',
      'The character stays at full size with no camera zoom change.',
      'Use exactly four readable key poses: impact, recoil, stagger, and recovery.',
      'Keep the full body visible in each frame with no cropping and no frame-to-frame layout shifts.',
      'Each frame must contain exactly one complete character silhouette. No detached limbs or partial bodies.',
    ],
  },
  ko: {
    targetHeightRatio: 0.84,
    targetWidthRatio: 0.84,
    baselineRatio: 0.95,
    promptRules: [
      'Keep the character full-size as they collapse. Do not make the figure shrink.',
      'Show a fall to the ground, ending in a downed pose.',
    ],
  },
};

export function getAnimationProfile(name: string): AnimationProfile {
  return PROFILES[name] ?? DEFAULT_PROFILE;
}
