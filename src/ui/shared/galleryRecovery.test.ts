import { describe, expect, it } from 'vitest';
import type { GenerationJob } from '../../services/GenerationJobs.ts';
import {
  activeGalleryRecoveryJobs,
  recoverableFighterGenerationIds,
  resumableGalleryRecoveryJobs,
} from './galleryRecovery.ts';

function job(overrides: Partial<GenerationJob> = {}): GenerationJob {
  return {
    id: 'job-1',
    fighterId: 'fighter-1',
    tier: 'champion',
    creationFlow: 'original',
    operation: 'fighter_generation',
    targetKind: null,
    targetName: null,
    artifactRunId: 'run-1',
    resumedFromJobId: null,
    status: 'running',
    reviewStatus: 'none',
    fullRunRestartRequired: false,
    stage: 'initializing',
    failureStage: null,
    progressCurrent: 0,
    progressTotal: 14,
    errorCode: null,
    errorMessage: null,
    startedAt: null,
    finishedAt: null,
    createdAt: '',
    updatedAt: '',
    resumable: false,
    completedStages: [],
    pendingStages: [],
    preservedArtifactCount: 0,
    events: [],
    ...overrides,
  };
}

describe('Gallery durable recovery selection', () => {
  it('retains every active job instead of collapsing recovery to one fighter', () => {
    const first = job({ id: 'job-a', fighterId: 'fighter-a' });
    const second = job({ id: 'job-b', fighterId: 'fighter-b', status: 'queued' });

    expect(activeGalleryRecoveryJobs([first, second])).toEqual([first, second]);
  });

  it('includes failed resumable Original fighter generation', () => {
    const original = job({ status: 'failed', resumable: true });
    const video = job({
      id: 'job-video',
      fighterId: 'fighter-video',
      creationFlow: 'video',
      status: 'cancelled',
      resumable: true,
    });

    expect(resumableGalleryRecoveryJobs([original, video])).toEqual([original, video]);
    expect(recoverableFighterGenerationIds([original, video])).toEqual([
      'fighter-1',
      'fighter-video',
    ]);
  });

  it('keeps resumable retries actionable without hydrating them as draft fighters', () => {
    const retry = job({
      operation: 'fighter_retry_animation',
      status: 'failed',
      resumable: true,
    });

    expect(resumableGalleryRecoveryJobs([retry])).toEqual([retry]);
    expect(recoverableFighterGenerationIds([retry])).toEqual([]);
  });
});
