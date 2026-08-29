export interface BflFlux2FramePromptInput {
  /** A frame-specific pose description authored by the animation plan. */
  pose: string;
  /** Optional positive rendering description that is unique to this character. */
  appearance?: string;
}

/**
 * Prompt contract for BFL FLUX.2 image editing.
 *
 * This module intentionally has no dependency on GeminiApi, AnimationProfiles,
 * or the Gemini generation workflow. Provider tuning must stay isolated.
 * IMAGE 1 is the appearance reference and IMAGE 2 is the pose reference.
 */
export function buildBflFlux2FramePrompt({
  pose,
  appearance = 'the same face, hair, apparent age, skin tone, body proportions, clothing, footwear, materials, and realistic 2.5D console fighting-game rendering',
}: BflFlux2FramePromptInput): string {
  const normalizedPose = pose.replace(/\s+/g, ' ').trim();
  if (!normalizedPose) {
    throw new Error('BFL FLUX.2 requires an explicit frame-specific pose.');
  }

  const normalizedAppearance = appearance.replace(/\s+/g, ' ').trim();
  if (!normalizedAppearance) {
    throw new Error('BFL FLUX.2 requires an explicit appearance contract.');
  }

  return [
    `Replace the person in IMAGE 2 with the person from IMAGE 1.`,
    `Keep IMAGE 2 as the exact structural template: ${normalizedPose} Match its silhouette, arm positions, leg positions, body angle, gaze direction, balance, framing, camera distance, and floor contact.`,
    `Use IMAGE 1 only for appearance: ${normalizedAppearance}.`,
    `The result contains exactly one complete, continuous adult human body with one head, one torso, two shoulders, two arms ending in two hands, and two legs ending in two feet. Each limb connects once to the torso.`,
    `Show the complete body from hair to shoe soles, centered and facing right, as one sharp static fighting-game frame.`,
    `Place the person on a perfectly flat, uniform pure chroma green #00FF00 background. The background contains only that solid color.`,
  ].join(' ');
}
