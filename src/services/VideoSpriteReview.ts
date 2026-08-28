import { apiFetch, type ApiRequestContext } from './ApiClient';

export type VideoSpriteReviewStatus = 'awaiting_review' | 'approved' | 'rejected';
export type VideoSpriteTechnicalOutcome = 'technical_pass' | 'needs_review' | 'reject';

export interface VideoSpriteReview {
  jobId: string;
  artifactRunId: string;
  candidateId: string;
  action: string;
  sequenceOrder: number;
  status: VideoSpriteReviewStatus;
  revision: number;
  reportSha256: string;
  technicalOutcome: VideoSpriteTechnicalOutcome;
  semanticPromotionApproved: false;
  selectedVideoIndices: number[];
  pendingAdjustmentIndices: number[] | null;
  frameCount: number;
  rawFrameCount: number;
  sourceFrameCount: number;
  animationFormat: 'video-dense-v1';
  processingVersion: 5 | 6;
  createdAt: string;
  reviewedAt: string | null;
  continuationAvailable: boolean;
  fullRunRestartRequired: boolean;
  assets: {
    runtime: string;
    contactSheet: string;
    uniqueSheet: string;
    report: string;
    video: string;
  };
}

interface ReviewResponse {
  review?: VideoSpriteReview;
  error?: string;
}

function errorMessage(body: ReviewResponse, fallback: string): Error {
  return new Error(typeof body.error === 'string' && body.error.trim() ? body.error.trim() : fallback);
}

async function readResponse(response: Response): Promise<ReviewResponse> {
  return response.json().catch(() => ({})) as Promise<ReviewResponse>;
}

export async function getVideoSpriteReview(
  jobId: string,
  context?: ApiRequestContext,
): Promise<VideoSpriteReview> {
  const response = await apiFetch(
    `/api/generation-jobs/${encodeURIComponent(jobId)}/video-review`,
    { headers: { Accept: 'application/json' } },
    context,
  );
  const body = await readResponse(response);
  if (!response.ok || !body.review) {
    throw errorMessage(body, `Video review could not be loaded (${response.status})`);
  }
  return body.review;
}

export async function getVideoSpriteReviewAsset(
  assetUrl: string,
  context?: ApiRequestContext,
): Promise<Blob> {
  const match = assetUrl.match(
    /^\/api\/generation-jobs\/[a-f0-9]{32}\/video-review\/assets\/(runtime|contact-sheet|unique-sheet|report|video)\?revision=\d+$/,
  );
  if (!match) {
    throw new Error('Video review asset URL is invalid');
  }
  const response = await apiFetch(assetUrl, { headers: { Accept: '*/*' } }, context);
  if (!response.ok) {
    const body = await readResponse(response);
    throw errorMessage(body, `Video review asset could not be loaded (${response.status})`);
  }
  const blob = await response.blob();
  const expectedType = match[1] === 'video'
    ? 'video/mp4'
    : match[1] === 'report' ? 'application/json' : 'image/png';
  if (blob.type.split(';', 1)[0].trim().toLowerCase() !== expectedType) {
    throw new Error('Video review asset returned an unexpected content type');
  }
  return blob;
}

function exactBinding(review: VideoSpriteReview) {
  return {
    candidateId: review.candidateId,
    revision: review.revision,
    reportSha256: review.reportSha256,
  };
}

async function decideVideoSpriteReview(
  review: VideoSpriteReview,
  decision: 'approve' | 'reject' | 'adjust',
  extra: Record<string, unknown>,
  context?: ApiRequestContext,
): Promise<VideoSpriteReview> {
  const response = await apiFetch(
    `/api/generation-jobs/${encodeURIComponent(review.jobId)}/video-review/${decision}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ...exactBinding(review), ...extra }),
    },
    context,
  );
  const body = await readResponse(response);
  if (!response.ok || !body.review) {
    throw errorMessage(body, `Video review ${decision} failed (${response.status})`);
  }
  return body.review;
}

export function approveVideoSpriteReview(
  review: VideoSpriteReview,
  context?: ApiRequestContext,
): Promise<VideoSpriteReview> {
  return decideVideoSpriteReview(review, 'approve', {}, context);
}

export function adjustVideoSpriteReview(
  review: VideoSpriteReview,
  selectedVideoIndices: number[],
  context?: ApiRequestContext,
): Promise<VideoSpriteReview> {
  return decideVideoSpriteReview(review, 'adjust', { selectedVideoIndices }, context);
}

export function rejectVideoSpriteReview(
  review: VideoSpriteReview,
  reason: string,
  context?: ApiRequestContext,
): Promise<VideoSpriteReview> {
  return decideVideoSpriteReview(review, 'reject', { reason }, context);
}

export function videoSpriteReasonCodes(report: unknown): string[] {
  if (!report || typeof report !== 'object') return [];
  const decision = (report as { decision?: unknown }).decision;
  if (!decision || typeof decision !== 'object') return [];
  const codes = (decision as { reasonCodes?: unknown }).reasonCodes;
  return Array.isArray(codes)
    ? [...new Set(codes.filter((code): code is string => (
        typeof code === 'string' && /^[a-z0-9_-]{2,80}$/.test(code)
      )))]
    : [];
}
