import { parseProviderDailyQuotaFailure } from './providerCapacity';

export interface GenerationFailureDetails {
  errorCode: string;
  errorMessage: string;
}

const OFFICIAL_QUALITY_MARKER = 'Official roster quality gate rejected the generated asset:';

function officialQualityDetail(message: string): string | null {
  const markerIndex = message.indexOf(OFFICIAL_QUALITY_MARKER);
  if (markerIndex < 0) return null;
  const rawDetail = message.slice(markerIndex + OFFICIAL_QUALITY_MARKER.length).trim();
  try {
    const payload = JSON.parse(rawDetail) as { error?: unknown };
    if (typeof payload.error === 'string' && payload.error.trim()) {
      return payload.error.replace(/\s+/g, ' ').trim().slice(0, 300);
    }
  } catch {
    // Keep a stable public message when the processor detail is not JSON.
  }
  return 'Official roster quality review rejected the generated asset; no new version was published';
}

export function generationFailureDetails(
  workflowErrorMessage: string,
  releasedBeforeProviderStart: boolean,
): GenerationFailureDetails {
  const dailyCapacity = parseProviderDailyQuotaFailure(workflowErrorMessage);
  if (dailyCapacity) {
    return {
      errorCode: 'provider_daily_quota_exhausted',
      errorMessage: `Image generation is at daily capacity; try again after ${new Date(
        dailyCapacity.retryAtEpoch * 1_000,
      ).toISOString()}`,
    };
  }

  const qualityDetail = officialQualityDetail(workflowErrorMessage);
  if (qualityDetail) {
    return {
      errorCode: 'qa_rejected_output',
      errorMessage: qualityDetail,
    };
  }

  if (workflowErrorMessage.includes('The image provider declined this transformation')) {
    return {
      errorCode: 'provider_content_blocked',
      errorMessage: 'The image provider declined this transformation without returning an image',
    };
  }

  return {
    errorCode: 'generation_failed',
    errorMessage: releasedBeforeProviderStart
      ? 'Generation could not start external processing; the unused reservation was released'
      : 'Generation stopped after external processing began; contact support if it cannot be repaired',
  };
}
