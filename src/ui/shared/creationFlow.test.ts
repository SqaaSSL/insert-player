import { describe, expect, it } from 'vitest';
import {
  assertCreationFlowAcknowledged,
  creationFlowForResume,
  durableRecoveryFailureNeedsRetry,
  isVideoResumableJob,
  isVideoReviewOrRestartJob,
  videoReviewJobNeedsConsent,
  videoReviewDecisionNeedsConsent,
  videoCreationFlowAvailability,
} from './creationFlow';

function job(overrides: Record<string, unknown> = {}) {
  return {
    creationFlow: 'video',
    operation: 'fighter_generation',
    status: 'succeeded',
    reviewStatus: 'awaiting_review',
    resumable: false,
    fullRunRestartRequired: false,
    ...overrides,
  } as any;
}

describe('creation flow UI safeguards', () => {
  it('defaults legacy jobs to Original but preserves an explicit Video job', () => {
    expect(creationFlowForResume(undefined)).toBe('original');
    expect(creationFlowForResume('video')).toBe('video');
  });

  it('refuses to resume an unknown flow as Original', () => {
    expect(() => creationFlowForResume('future-flow')).toThrow(/unsupported .*creation flow/i);
  });

  it('keeps Original compatible with a server from before flow acknowledgements', () => {
    expect(() => assertCreationFlowAcknowledged('original', undefined)).not.toThrow();
    expect(() => assertCreationFlowAcknowledged('original', 'original')).not.toThrow();
  });

  it('requires an exact Video acknowledgement before starting a job', () => {
    expect(() => assertCreationFlowAcknowledged('video', undefined)).toThrow(/not enabled/i);
    expect(() => assertCreationFlowAcknowledged('video', 'original')).toThrow(/different creation flow/i);
    expect(() => assertCreationFlowAcknowledged('video', 'video')).not.toThrow();
  });

  it('offers Video only to signed-in Champion generations', () => {
    expect(videoCreationFlowAvailability('signed-in', 'champion')).toEqual({ available: true });
    expect(videoCreationFlowAvailability('signed-in', 'contender')).toEqual({
      available: false,
      reason: 'Choose Champion quality to use Video.',
    });
    expect(videoCreationFlowAvailability('signed-out', 'champion')).toEqual({
      available: false,
      reason: 'Sign in to use the cloud Video flow.',
    });
  });

  it('keeps review, terminal restart, and transient resume states discoverable', () => {
    expect(isVideoReviewOrRestartJob(job())).toBe(true);
    expect(isVideoReviewOrRestartJob(job({
      status: 'failed', reviewStatus: 'none', fullRunRestartRequired: true,
    }))).toBe(true);
    expect(isVideoResumableJob(job({
      status: 'failed', reviewStatus: 'none', resumable: true,
    }))).toBe(true);
    expect(isVideoReviewOrRestartJob(job({ creationFlow: 'original' }))).toBe(false);
    expect(isVideoResumableJob(job({ status: 'failed', resumable: false }))).toBe(false);
  });

  it('requires fresh consent only before a continued or restarted Video generation', () => {
    expect(videoReviewJobNeedsConsent(job())).toBe(false);
    expect(videoReviewJobNeedsConsent(job({ reviewStatus: 'approved', resumable: true }))).toBe(true);
    expect(videoReviewJobNeedsConsent(job({ reviewStatus: 'rejected' }))).toBe(true);
    expect(videoReviewJobNeedsConsent(job({ fullRunRestartRequired: true }))).toBe(true);
    expect(videoReviewJobNeedsConsent(null)).toBe(false);
    expect(videoReviewDecisionNeedsConsent({ status: 'awaiting_review', continuationAvailable: true })).toBe(false);
    expect(videoReviewDecisionNeedsConsent({ status: 'approved', continuationAvailable: true })).toBe(true);
    expect(videoReviewDecisionNeedsConsent({ status: 'approved', continuationAvailable: false })).toBe(false);
    expect(videoReviewDecisionNeedsConsent({ status: 'rejected', continuationAvailable: false })).toBe(true);
    expect(videoReviewDecisionNeedsConsent(null, true)).toBe(true);
  });

  it('keeps a discovered durable job on a recovery-only retry path', () => {
    expect(durableRecoveryFailureNeedsRetry(true, true)).toBe(true);
    expect(durableRecoveryFailureNeedsRetry(false, true)).toBe(false);
    expect(durableRecoveryFailureNeedsRetry(true, false)).toBe(false);
  });
});
