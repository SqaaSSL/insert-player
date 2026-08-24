import {
  GeminiRequestError,
  isApprovedGeminiImageModel,
} from '../../src/services/GeminiRequestPolicy.ts';

export interface ProcessorErrorResponse {
  status: number;
  body: {
    error: string;
    code?: string;
    provider?: 'gemini';
    model?: string;
    retryAfterSeconds?: number;
  };
}

const DEFAULT_DAILY_QUOTA_RETRY_SECONDS = 24 * 60 * 60;
const MAX_DAILY_QUOTA_RETRY_SECONDS = 48 * 60 * 60;
const MIN_DAILY_QUOTA_RETRY_SECONDS = 60;
const NON_RETRYABLE_METERKEY_CODES = new Set([
  'provider_request_not_dispatched',
  'provider_request_outcome_unknown',
  'daily_cap_exceeded',
  'monthly_cap_exceeded',
]);

function dailyQuotaRetrySeconds(error: GeminiRequestError): number {
  const upstreamSeconds = error.retryAfterMs === null
    ? DEFAULT_DAILY_QUOTA_RETRY_SECONDS
    : Math.ceil(error.retryAfterMs / 1_000);
  return Math.min(
    MAX_DAILY_QUOTA_RETRY_SECONDS,
    Math.max(MIN_DAILY_QUOTA_RETRY_SECONDS, upstreamSeconds),
  );
}

export function processorErrorResponse(error: unknown): ProcessorErrorResponse {
  if (
    error instanceof GeminiRequestError &&
    error.code !== null &&
    NON_RETRYABLE_METERKEY_CODES.has(error.code)
  ) {
    return {
      status: Number.isInteger(error.status) && error.status >= 400 && error.status <= 599
        ? error.status
        : 502,
      body: {
        error: error.message,
        code: error.code,
        provider: 'gemini',
        ...(isApprovedGeminiImageModel(error.model) ? { model: error.model } : {}),
      },
    };
  }

  if (error instanceof GeminiRequestError && error.dailyQuotaExhausted) {
    if (!isApprovedGeminiImageModel(error.model)) {
      return {
        status: 500,
        body: {
          error: 'The image processor could not verify an approved Gemini model',
          code: 'provider_model_unapproved',
        },
      };
    }
    return {
      status: 429,
      body: {
        error: 'Gemini daily image capacity is exhausted for this model',
        code: 'provider_daily_quota_exhausted',
        provider: 'gemini',
        model: error.model,
        retryAfterSeconds: dailyQuotaRetrySeconds(error),
      },
    };
  }

  if (error instanceof GeminiRequestError && error.code === 'provider_model_unapproved') {
    return {
      status: 500,
      body: {
        error: 'The requested image model is not approved for production',
        code: 'provider_model_unapproved',
      },
    };
  }

  const message = error instanceof Error ? error.message : 'Unknown image processor error';
  const contentBlocked = error instanceof Error && error.name === 'GeminiContentBlockedError';
  const qualityRejected = error instanceof Error && error.name === 'GeminiOfficialSpriteQualityError';
  if (message === 'REQUEST_TOO_LARGE') return { status: 413, body: { error: message } };
  if (contentBlocked) {
    return { status: 422, body: { error: message, code: 'provider_content_blocked' } };
  }
  if (qualityRejected) {
    return { status: 422, body: { error: message, code: 'official_quality_rejected' } };
  }
  return { status: 500, body: { error: message } };
}
