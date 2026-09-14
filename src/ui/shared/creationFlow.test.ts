import { describe, expect, it } from 'vitest';
import {
  assertCreationFlowAcknowledged,
  creationFlowForResume,
  durableRecoveryFailureNeedsRetry,
  isVideoResumableJob,
  isVideoReviewOrRestartJob,
  videoReviewJobNeedsConsent,
  videoReviewDecisionNeedsConsent,
  isRecoverableVideoReviewJob,
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

  it('recovers paid reviews while leaving terminal archived runs out of new character creation', () => {
    expect(isRecoverableVideoReviewJob(job())).toBe(true);
    expect(isRecoverableVideoReviewJob(job({ reviewStatus: 'approved', resumable: true }))).toBe(true);
    expect(isRecoverableVideoReviewJob(job({ reviewStatus: 'rejected' }))).toBe(false);
    expect(isRecoverableVideoReviewJob(job({ fullRunRestartRequired: true }))).toBe(false);
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

  it('requires fresh consent only before a paid Video continuation', () => {
    expect(videoReviewJobNeedsConsent(job())).toBe(false);
    expect(videoReviewJobNeedsConsent(job({ reviewStatus: 'approved', resumable: true }))).toBe(true);
    expect(videoReviewJobNeedsConsent(job({ reviewStatus: 'rejected' }))).toBe(false);
    expect(videoReviewJobNeedsConsent(job({ fullRunRestartRequired: true }))).toBe(false);
    expect(videoReviewJobNeedsConsent(null)).toBe(false);
    expect(videoReviewDecisionNeedsConsent({ status: 'awaiting_review', continuationAvailable: true })).toBe(false);
    expect(videoReviewDecisionNeedsConsent({ status: 'approved', continuationAvailable: true })).toBe(true);
    expect(videoReviewDecisionNeedsConsent({ status: 'approved', continuationAvailable: false })).toBe(false);
    expect(videoReviewDecisionNeedsConsent({ status: 'rejected', continuationAvailable: false })).toBe(false);
    expect(videoReviewDecisionNeedsConsent(null, true)).toBe(false);
  });

  it('keeps a discovered durable job on a recovery-only retry path', () => {
    expect(durableRecoveryFailureNeedsRetry(true, true)).toBe(true);
    expect(durableRecoveryFailureNeedsRetry(false, true)).toBe(false);
    expect(durableRecoveryFailureNeedsRetry(true, false)).toBe(false);
  });
});
