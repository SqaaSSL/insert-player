export const VIDEO_SPRITE_COMPILE_SCHEMA_VERSION = 1 as const;
export const VIDEO_SPRITE_REPORT_SCHEMA = 'video-sprite-compile-report.v1' as const;
export const VIDEO_SPRITE_COMPILER_VERSION = '1.0.0' as const;
export const VIDEO_SPRITE_POLICY_VERSION = 'video-sprite-policy.v1' as const;
export const VIDEO_SPRITE_ANIMATION_FORMAT = 'video-dense-v1' as const;
export const VIDEO_SPRITE_PROCESSING_VERSION = 6 as const;
export const VIDEO_SPRITE_FRAME_WIDTH = 192 as const;
export const VIDEO_SPRITE_FRAME_HEIGHT = 256 as const;
export const VIDEO_SPRITE_SAMPLE_FPS = 24 as const;

export const VIDEO_SPRITE_ACTIONS = [
  'idle', 'walk', 'high_punch', 'high_kick', 'low_punch', 'low_kick',
  'jump', 'crouch', 'hit', 'ko', 'victory',
] as const;

export type VideoSpriteAction = typeof VIDEO_SPRITE_ACTIONS[number];
export type VideoSpriteSequenceFormat = 'loop' | 'forward-ping-pong' | 'timeline-hold';
export type VideoSpriteFacing = 'left' | 'right';
export type VideoSpriteDecision = 'auto_pass' | 'needs_review' | 'reject';

export interface VideoSpriteActionProfile {
  action: VideoSpriteAction;
  uniqueFrameCount: number;
  sequenceFormat: VideoSpriteSequenceFormat;
  allowStatic: boolean;
  registration: 'root' | 'vertical-root' | 'none';
  maxReviewTranslationXRatio: number;
  maxReviewTranslationYRatio: number;
  maxReviewScaleStepRatio: number;
  maxReviewMotionStep: number;
  maxReviewLoopSeam: number | null;
  minReviewTotalMotion: number;
}

export const VIDEO_SPRITE_ACTION_PROFILES: Readonly<Record<VideoSpriteAction, VideoSpriteActionProfile>> =
  Object.freeze({
    idle: {
      action: 'idle', uniqueFrameCount: 8, sequenceFormat: 'loop', allowStatic: true, registration: 'root',
      maxReviewTranslationXRatio: 0.15, maxReviewTranslationYRatio: 0.15,
      maxReviewScaleStepRatio: 0.16, maxReviewMotionStep: 0.30,
      maxReviewLoopSeam: 0.20, minReviewTotalMotion: 0,
    },
    walk: {
      action: 'walk', uniqueFrameCount: 12, sequenceFormat: 'loop', allowStatic: false, registration: 'root',
      maxReviewTranslationXRatio: 0.20, maxReviewTranslationYRatio: 0.18,
      maxReviewScaleStepRatio: 0.18, maxReviewMotionStep: 0.34,
      maxReviewLoopSeam: 0.26, minReviewTotalMotion: 0.04,
    },
    high_punch: {
      action: 'high_punch', uniqueFrameCount: 6, sequenceFormat: 'forward-ping-pong', allowStatic: false, registration: 'root',
      maxReviewTranslationXRatio: 0.22, maxReviewTranslationYRatio: 0.22,
      maxReviewScaleStepRatio: 0.20, maxReviewMotionStep: 0.38,
      maxReviewLoopSeam: null, minReviewTotalMotion: 0.04,
    },
    high_kick: {
      action: 'high_kick', uniqueFrameCount: 12, sequenceFormat: 'forward-ping-pong', allowStatic: false, registration: 'root',
      maxReviewTranslationXRatio: 0.28, maxReviewTranslationYRatio: 0.30,
      maxReviewScaleStepRatio: 0.22, maxReviewMotionStep: 0.42,
      maxReviewLoopSeam: null, minReviewTotalMotion: 0.06,
    },
    low_punch: {
      action: 'low_punch', uniqueFrameCount: 7, sequenceFormat: 'forward-ping-pong', allowStatic: false, registration: 'root',
      maxReviewTranslationXRatio: 0.22, maxReviewTranslationYRatio: 0.22,
      maxReviewScaleStepRatio: 0.20, maxReviewMotionStep: 0.38,
      maxReviewLoopSeam: null, minReviewTotalMotion: 0.04,
    },
    low_kick: {
      action: 'low_kick', uniqueFrameCount: 9, sequenceFormat: 'forward-ping-pong', allowStatic: false, registration: 'root',
      maxReviewTranslationXRatio: 0.28, maxReviewTranslationYRatio: 0.28,
      maxReviewScaleStepRatio: 0.22, maxReviewMotionStep: 0.42,
      maxReviewLoopSeam: null, minReviewTotalMotion: 0.05,
    },
    jump: {
      action: 'jump', uniqueFrameCount: 8, sequenceFormat: 'timeline-hold', allowStatic: false, registration: 'root',
      maxReviewTranslationXRatio: 0.25, maxReviewTranslationYRatio: 0.42,
      maxReviewScaleStepRatio: 0.24, maxReviewMotionStep: 0.45,
      maxReviewLoopSeam: null, minReviewTotalMotion: 0.06,
    },
    crouch: {
      action: 'crouch', uniqueFrameCount: 6, sequenceFormat: 'timeline-hold', allowStatic: false, registration: 'root',
      maxReviewTranslationXRatio: 0.20, maxReviewTranslationYRatio: 0.25,
      maxReviewScaleStepRatio: 0.22, maxReviewMotionStep: 0.40,
      maxReviewLoopSeam: null, minReviewTotalMotion: 0.03,
    },
    hit: {
      action: 'hit', uniqueFrameCount: 6, sequenceFormat: 'timeline-hold', allowStatic: false, registration: 'root',
      maxReviewTranslationXRatio: 0.24, maxReviewTranslationYRatio: 0.24,
      maxReviewScaleStepRatio: 0.22, maxReviewMotionStep: 0.42,
      maxReviewLoopSeam: null, minReviewTotalMotion: 0.04,
    },
    ko: {
      action: 'ko', uniqueFrameCount: 12, sequenceFormat: 'timeline-hold', allowStatic: false, registration: 'none',
      maxReviewTranslationXRatio: 0.30, maxReviewTranslationYRatio: 0.36,
      maxReviewScaleStepRatio: 0.28, maxReviewMotionStep: 0.48,
      maxReviewLoopSeam: null, minReviewTotalMotion: 0.07,
    },
    victory: {
      action: 'victory', uniqueFrameCount: 12, sequenceFormat: 'timeline-hold', allowStatic: false, registration: 'root',
      maxReviewTranslationXRatio: 0.24, maxReviewTranslationYRatio: 0.24,
      maxReviewScaleStepRatio: 0.22, maxReviewMotionStep: 0.42,
      maxReviewLoopSeam: null, minReviewTotalMotion: 0.05,
    },
  });

export interface VideoSpriteLineage {
  jobId?: string;
  runId?: string;
  fighterId?: string;
  provider?: string;
  modelId?: string;
  providerRequestId?: string;
  promptSha256?: string;
  videoSha256?: string;
  canonicalSha256?: string;
}

export interface VideoSpriteCompileRequest {
  schemaVersion: typeof VIDEO_SPRITE_COMPILE_SCHEMA_VERSION;
  action: VideoSpriteAction;
  expectedFacing: VideoSpriteFacing;
  videoBase64: string;
  canonicalFrameBase64: string;
  lineage?: VideoSpriteLineage;
}

export interface VideoSpriteCompileResponse {
  schemaVersion: typeof VIDEO_SPRITE_COMPILE_SCHEMA_VERSION;
  animationFormat: typeof VIDEO_SPRITE_ANIMATION_FORMAT;
  processingVersion: typeof VIDEO_SPRITE_PROCESSING_VERSION;
  frameW: typeof VIDEO_SPRITE_FRAME_WIDTH;
  frameH: typeof VIDEO_SPRITE_FRAME_HEIGHT;
  frameCount: number;
  spriteBase64: string;
  allFramesContactSheetBase64: string;
  uniqueFramesSheetBase64: string;
  report: {
    schema: typeof VIDEO_SPRITE_REPORT_SCHEMA;
    schemaVersion: 1;
    compilerVersion: string;
    policyVersion: string;
    reportSha256: string;
    action: VideoSpriteAction;
    expectedFacing: VideoSpriteFacing;
    decision: {
      outcome: VideoSpriteDecision;
      reasonCodes: string[];
      semanticPromotionApproved: false;
    };
    [key: string]: unknown;
  };
}
