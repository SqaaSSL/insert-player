import { describe, expect, it } from 'vitest';
import type { GenerationJob } from '../../services/GenerationJobs.ts';
import { describeGenerationJob, generationPreviewCheckpoint, generationProgress } from './generationProgress.ts';

const job = (values: Partial<GenerationJob> = {}) => ({
  id: 'job', status: 'running', creationFlow: 'original', stage: 'initializing',
  progressCurrent: 0, progressTotal: 24, completedStages: [], ...values,
} as GenerationJob);

describe('durable creation progress', () => {
  it('shows actual completed checkpoints, not invented percentages', () => {
    expect(generationProgress(job({ progressCurrent: 3 }))).toEqual({ completed: 3, total: 24, fraction: 3 / 24 });
    expect(generationProgress(job({ progressTotal: 0 }))).toEqual({ completed: 0, total: 0, fraction: null });
    expect(generationProgress(job({ progressCurrent: Number.NaN }))).toEqual({ completed: 0, total: 24, fraction: 0 });
  });
  it('distinguishes provider work from downloaded images and playable output', () => {
    expect(describeGenerationJob(job({ stage: 'atlas:two-01:generating' }))).toContain('Creating your moves');
    expect(describeGenerationJob(job({ stage: 'atlas:two-01:ready' }))).toContain('Finishing the cutouts');
    expect(describeGenerationJob(job({ stage: 'sprite:high_kick', completedStages: ['sprite:high_kick'] }))).toContain('saved');
    expect(describeGenerationJob(job({ stage: 'sprite:high_kick' }))).toContain('Finishing');
    expect(describeGenerationJob(job({ stage: 'source:upright' }))).toContain('Preparing');
    expect(generationPreviewCheckpoint(job({ stage: 'sprite:high_kick' }))).toBeNull();
    expect(describeGenerationJob(job({ status: 'succeeded' }))).toContain('Downloading');
  });
  it('does not label a provider image or an unchanged poll as a new preview', () => {
    expect(generationPreviewCheckpoint(job({ stage: 'atlas:two-01:ready' }))).toBeNull();
    const values = { stage: 'source:upright', completedStages: ['source:side', 'source:upright'] };
    expect(generationPreviewCheckpoint(job(values))).toBe(generationPreviewCheckpoint(job({ ...values, progressCurrent: 5 })));
    expect(generationPreviewCheckpoint(job({ ...values, completedStages: [...values.completedStages].reverse() })))
      .toBe(generationPreviewCheckpoint(job(values)));
  });
  it('does not treat stopped jobs or legacy video reviews as complete characters', () => {
    expect(generationPreviewCheckpoint(job({ status: 'failed', stage: 'sprite:idle' }))).toBeNull();
    expect(describeGenerationJob(job({ creationFlow: 'video', status: 'succeeded', reviewStatus: 'awaiting_review' })))
      .toContain('Paused safely for your review');
    expect(describeGenerationJob(job({ status: 'failed', errorMessage: 'Request outcome unknown' })))
      .toBe('Request outcome unknown');
  });
});
