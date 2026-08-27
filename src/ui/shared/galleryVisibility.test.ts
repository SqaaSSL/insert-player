import { describe, expect, it } from 'vitest';
import type { CloudFighter } from '../../services/CloudFighters.ts';
import { CACHE_VERSION, type CachedMeta } from '../../services/SpriteCache.ts';
import type { GenerationJob } from '../../services/GenerationJobs.ts';
import { visibleGalleryMetasForJobs } from './galleryVisibility.ts';

function meta(overrides: Partial<CachedMeta> = {}): CachedMeta {
  return {
    photoHash: 'photo-1',
    version: CACHE_VERSION,
    originalPhotoBlob: null,
    sideViewBlob: null,
    sideViewRawBlob: null,
    uprightViewBlob: null,
    uprightViewRawBlob: null,
    sideViewCleanBlob: null,
    crouchViewBlob: null,
    crouchViewRawBlob: null,
    crouchViewCleanBlob: null,
    noBgBlob: null,
    characterName: 'Player One',
    qualityTier: 'champion',
    status: 'ready',
    animationsReady: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function job(overrides: Partial<GenerationJob> = {}): GenerationJob {
  return {
    id: 'job-1',
    fighterId: 'fighter-1',
    tier: 'champion',
    creationFlow: 'video',
    operation: 'fighter_generation',
    targetKind: null,
    targetName: null,
    artifactRunId: 'run-1',
    resumedFromJobId: null,
    status: 'succeeded',
    reviewStatus: 'awaiting_review',
    fullRunRestartRequired: false,
    stage: 'review',
    failureStage: null,
    progressCurrent: 1,
    progressTotal: 11,
    errorCode: null,
    errorMessage: null,
    startedAt: null,
    finishedAt: null,
    createdAt: '',
    updatedAt: '',
    resumable: false,
    completedStages: [],
    pendingStages: [],
    preservedArtifactCount: 1,
    events: [],
    ...overrides,
  };
}

describe('visibleGalleryMetasForJobs', () => {
  it('keeps a Video review fighter visible across every Gallery refresh', () => {
    const draft = meta({
      status: 'sprites_generating',
      cloudFighterId: 'fighter-1',
    });

    expect(visibleGalleryMetasForJobs([draft], [] as CloudFighter[], [job()])).toEqual([draft]);
  });

  it('keeps active and resumable Video fighters, but hides unrelated incomplete cache rows', () => {
    const active = meta({
      photoHash: 'active',
      status: 'sprites_generating',
      cloudFighterId: 'fighter-active',
    });
    const resumable = meta({
      photoHash: 'resumable',
      status: 'error',
      cloudFighterId: 'fighter-resumable',
    });
    const stale = meta({
      photoHash: 'stale',
      status: 'error',
      cloudFighterId: 'fighter-stale',
    });

    expect(visibleGalleryMetasForJobs([active, resumable, stale], [], [
      job({ fighterId: 'fighter-active', status: 'running', reviewStatus: 'none' }),
      job({
        fighterId: 'fighter-resumable',
        status: 'failed',
        reviewStatus: 'none',
        resumable: true,
      }),
    ])).toEqual([active, resumable]);
  });

  it('always keeps a ready fighter even when no durable job exists', () => {
    const ready = meta();
    expect(visibleGalleryMetasForJobs([ready], [], [])).toEqual([ready]);
  });
});
