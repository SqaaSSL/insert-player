export interface AnimationProfile {
  targetHeightRatio: number;
  targetWidthRatio: number;
  baselineRatio: number;
  lockScaleAcrossFrames?: boolean;
  promptRules: string[];
}

export const JUMP_ANIMATION_MOTION =
  'four clear vertical-movement key poses: balanced bent-knee preparation, upward body extension, a compact highest-point pose with both feet visibly clear of the floor, and a balanced grounded recovery guard; keep the apparent body size constant and let the game engine handle on-screen height';

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
      'The uploaded side-view reference already has the correct full-body framing. Preserve that exact camera distance, scale, and overall body crop.',
      'The character stays at full size with no camera zoom change.',
      'Do not crop closer than the reference image in any frame. If needed, make the character slightly smaller instead.',
      'Keep the full body visible in each frame with no cropping and no frame-to-frame layout shifts.',
      'Every frame must stay inside its own cell with margin on the left and right. Never let the body cross a cell boundary.',
      'Each frame must contain exactly one complete character silhouette. No detached limbs, partial bodies, or torso-only frames.',
    ],
  },
  walk: {
    targetHeightRatio: 0.84,
    targetWidthRatio: 0.8,
    baselineRatio: 0.95,
    promptRules: [
      'This is a grounded fighting-game walk cycle, not a run and not a hop.',
      'The body stays at the same apparent size in every frame.',
      'Keep the full body visible in each frame with no cropping and no frame-to-frame layout shifts.',
      'Every frame must stay inside its own cell with margin on the left and right. Never let the body cross a cell boundary.',
      'Each frame must contain exactly one complete character silhouette. No detached limbs, partial bodies, or torso-only frames.',
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
    targetHeightRatio: 0.74,
    targetWidthRatio: 0.8,
    baselineRatio: 0.98,
    lockScaleAcrossFrames: true,
    promptRules: [
      'Start and stay in an extreme classic 2D fighting-game crouch-block defensive guard for the entire move.',
      'Keep the hips extremely low, the knees completely bent, and the buttocks almost onto the ground in a deep full squat.',
      'Keep the torso tightly folded down and the head dramatically lower than the standing pose.',
      'Keep the elbows tucked in and the non-punching arm in a protective guard near the chest or face.',
      'Keep the head and neck orientation natural and consistent with the standing reference. No head turn and no twisted neck.',
      'Maintain roughly the same camera distance and overall body scale as the crouch reference pose.',
      'This is crouch plus punch from a low defensive guard, not a standing punch.',
    ],
  },
  low_kick: {
    targetHeightRatio: 0.76,
    targetWidthRatio: 0.84,
    baselineRatio: 0.98,
    lockScaleAcrossFrames: true,
    promptRules: [
      'Start and stay in an extreme classic 2D fighting-game crouch-block defensive guard for the entire move.',
      'Keep the hips extremely low, the knees completely bent, and the buttocks almost onto the ground in a deep full squat.',
      'Keep the torso tightly folded down and the head dramatically lower than the standing pose.',
      'Keep the center of gravity extremely low throughout and keep one arm guarding the upper body. Do not stand up during the kick.',
      'Keep the head and neck orientation natural and consistent with the standing reference. No head turn and no twisted neck.',
      'Maintain roughly the same camera distance and overall body scale as the crouch reference pose.',
      'This is a grounded low sweep from a crouched stance, not a jumping kick.',
    ],
  },
  jump: {
    targetHeightRatio: 0.84,
    targetWidthRatio: 0.8,
    baselineRatio: 0.95,
    promptRules: [
      'Use exactly four athletic key poses: bent-knee preparation, upward body extension, compact highest point, and balanced grounded recovery.',
      'Keep the character the same apparent size as the standing pose in every frame.',
      'Keep every pose at the same vertical registration inside its cell; gameplay applies the on-screen height change.',
      'In pose three, show both complete feet visibly clear of the floor while the character remains centered and controlled.',
      'This is a benign athletic game-animation reference with no contact, injury, distress, or real-world event.',
      'Every frame must stay inside its own cell with margin on the left and right. Never let the body cross a cell boundary.',
      'Each frame must contain exactly one complete character silhouette. No duplicate limbs, no echo trails, and no detached body fragments.',
    ],
  },
  crouch: {
    targetHeightRatio: 0.74,
    targetWidthRatio: 0.82,
    baselineRatio: 0.98,
    lockScaleAcrossFrames: true,
    promptRules: [
      'This is a true transition from the standing pose down into an extreme classic 2D fighting-game crouch-block defensive guard.',
      'Frame 1 should stay at standing scale and closely match the standing reference pose.',
      'The final frame should closely match the crouch reference pose with the head, shoulders, and hips physically much lower than the starting frame.',
      'By the end, the knees should be completely bent in a deep full squat, the buttocks should be almost onto the ground, and the torso should be tightly folded into a compact defensive posture.',
      'It should read like an extreme arcade down-arrow crouch-block / low guard, not like a smaller standing pose and not like a medium squat.',
      'Keep the head and neck orientation natural and consistent with the starting pose. No sideways head turn.',
      'Keep the feet planted while the body compresses downward; do not solve this by shrinking the whole character.',
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
      'Use exactly eight readable key poses from standing impact through the final grounded hold.',
      'Show a fall to the ground, ending in a compact downed pose with bent knees so the entire body fits inside one cell.',
      'Every frame must contain exactly one complete character from head to feet with visible green margin on every side.',
      'Never let the falling or downed body cross a cell boundary, span adjacent cells, or split into separate torso and leg cells.',
      'Angle or foreshorten the final grounded pose diagonally inside its own cell instead of laying the body horizontally across the grid.',
    ],
  },
  victory: {
    targetHeightRatio: 0.86,
    targetWidthRatio: 0.82,
    baselineRatio: 0.95,
    promptRules: [
      'This is a grounded victory celebration only. The character stays standing, fully visible, and clearly reads as the winner.',
      'Make the celebration obvious and energetic: triumphant body language, lifted chest, strong silhouette, and a big celebratory beat.',
      'Use unmistakable winning gestures such as a raised fist, both arms lifted, a strong fist pump, or a proud champion pose.',
      'Do not make this subtle, neutral, or close to the idle stance. It must look clearly more cheerful and victorious than the standing pose.',
      'Keep the move grounded throughout. No jump, no crouch, and no knockdown.',
      'The final frame should read as a strong held champion pose that can freeze on screen cleanly after the celebration.',
      'Every frame must show the complete character from head to feet at the same camera distance as the reference.',
      'Leave visible green margin above the head, below both feet, and on both sides in every cell. No waist-up or torso-only framing.',
    ],
  },
};

export function getAnimationProfile(name: string): AnimationProfile {
  return PROFILES[name] ?? DEFAULT_PROFILE;
}
