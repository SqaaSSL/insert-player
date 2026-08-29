import {
  DEFAULT_VIDEO_SPRITE_AUTOMATIC_SELECTION_POLICY,
  type VideoSpriteAutomaticSelectionPolicy,
} from './VideoSpriteCompileContract';

export const STUDIO_CURATED_VIDEO_POLICY = 'studio_curated_v1' as const;
export const SELF_SERVICE_VIDEO_POLICY = 'self_service_v1' as const;

export const VIDEO_GENERATION_POLICIES = [
  STUDIO_CURATED_VIDEO_POLICY,
  SELF_SERVICE_VIDEO_POLICY,
] as const;

export type VideoGenerationPolicy = typeof VIDEO_GENERATION_POLICIES[number];

export interface VideoGenerationPolicyContract {
  promptVersion: 'studio-video-prompt.v1' | 'self-service-video-prompt.v2';
  automaticSelectionPolicy: VideoSpriteAutomaticSelectionPolicy;
  humanReviewRequired: true;
}

const POLICY_CONTRACTS: Readonly<Record<VideoGenerationPolicy, VideoGenerationPolicyContract>> =
  Object.freeze({
    [STUDIO_CURATED_VIDEO_POLICY]: {
      promptVersion: 'studio-video-prompt.v1',
      automaticSelectionPolicy: DEFAULT_VIDEO_SPRITE_AUTOMATIC_SELECTION_POLICY,
      humanReviewRequired: true,
    },
    [SELF_SERVICE_VIDEO_POLICY]: {
      promptVersion: 'self-service-video-prompt.v2',
      automaticSelectionPolicy: 'action-profile-temporal-anchors-v1',
      humanReviewRequired: true,
    },
  });

export function isVideoGenerationPolicy(value: unknown): value is VideoGenerationPolicy {
  return value === STUDIO_CURATED_VIDEO_POLICY || value === SELF_SERVICE_VIDEO_POLICY;
}

/**
 * Rows created before the policy split deliberately retain the exact former
 * Video behavior. New runs must always persist an explicit policy.
 */
export function storedVideoGenerationPolicy(value: unknown): VideoGenerationPolicy {
  if (value === undefined || value === null || value === '') {
    return STUDIO_CURATED_VIDEO_POLICY;
  }
  if (isVideoGenerationPolicy(value)) return value;
  throw new Error('Unsupported persisted video generation policy');
}

export function videoGenerationPolicyContract(
  policy: VideoGenerationPolicy,
): VideoGenerationPolicyContract {
  return POLICY_CONTRACTS[policy];
}
