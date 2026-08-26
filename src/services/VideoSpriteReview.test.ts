import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from './ApiClient';
import {
  adjustVideoSpriteReview,
  getVideoSpriteReviewAsset,
  rejectVideoSpriteReview,
  videoSpriteReasonCodes,
  type VideoSpriteReview,
} from './VideoSpriteReview';

vi.mock('./ApiClient', () => ({ apiFetch: vi.fn() }));

const REVIEW: VideoSpriteReview = {
  jobId: 'a'.repeat(32),
  artifactRunId: 'b'.repeat(32),
  candidateId: 'c'.repeat(32),
  action: 'high_kick',
  sequenceOrder: 3,
  status: 'awaiting_review',
  revision: 2,
  reportSha256: 'd'.repeat(64),
  technicalOutcome: 'needs_review',
  semanticPromotionApproved: false,
  selectedVideoIndices: [1, 4, 8],
  pendingAdjustmentIndices: null,
  frameCount: 5,
  rawFrameCount: 3,
  sourceFrameCount: 49,
  animationFormat: 'video-dense-v1',
  processingVersion: 5,
  createdAt: '2026-08-27T00:00:00Z',
  reviewedAt: null,
  continuationAvailable: false,
  fullRunRestartRequired: false,
  assets: {
    runtime: `/api/generation-jobs/${'a'.repeat(32)}/video-review/assets/runtime?revision=2`,
    contactSheet: `/api/generation-jobs/${'a'.repeat(32)}/video-review/assets/contact-sheet?revision=2`,
    uniqueSheet: `/api/generation-jobs/${'a'.repeat(32)}/video-review/assets/unique-sheet?revision=2`,
    report: `/api/generation-jobs/${'a'.repeat(32)}/video-review/assets/report?revision=2`,
    video: `/api/generation-jobs/${'a'.repeat(32)}/video-review/assets/video?revision=2`,
  },
};

describe('VideoSpriteReview', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it('binds an adjustment to the exact immutable revision', async () => {
    vi.mocked(apiFetch).mockResolvedValue(Response.json({
      review: { ...REVIEW, revision: 3, selectedVideoIndices: [2, 5, 9] },
    }));

    await expect(adjustVideoSpriteReview(REVIEW, [2, 5, 9])).resolves.toMatchObject({ revision: 3 });
    const [, init] = vi.mocked(apiFetch).mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({
      candidateId: REVIEW.candidateId,
      revision: 2,
      reportSha256: REVIEW.reportSha256,
      selectedVideoIndices: [2, 5, 9],
    });
  });

  it('keeps rejection explicit and reason-bound', async () => {
    vi.mocked(apiFetch).mockResolvedValue(Response.json({ review: { ...REVIEW, status: 'rejected' } }));
    await rejectVideoSpriteReview(REVIEW, 'The kick never reaches impact.');
    expect(JSON.parse(String(vi.mocked(apiFetch).mock.calls[0][1]?.body))).toMatchObject({
      reason: 'The kick never reaches impact.',
    });
  });

  it('loads private assets through authenticated API fetch only', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(new Blob(['video']), {
      headers: { 'Content-Type': 'video/mp4' },
    }));
    await expect(getVideoSpriteReviewAsset(REVIEW.assets.video)).resolves.toBeInstanceOf(Blob);
    await expect(getVideoSpriteReviewAsset('https://evil.example/video.mp4')).rejects.toThrow(/invalid/i);
  });

  it('extracts bounded technical reason codes from the sealed report', () => {
    expect(videoSpriteReasonCodes({ decision: {
      reasonCodes: ['loop_seam_review', 'loop_seam_review', '../unsafe', 3],
    } })).toEqual(['loop_seam_review']);
  });
});
