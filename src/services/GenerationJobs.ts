import {
  ApiSessionChangedError,
  apiFetch,
  type ApiRequestContext,
} from './ApiClient';
import type { GenerationBillingOperation, QualityTier } from './QualityTiers';
import type { GenerationCreationFlow } from './GenerationCreationFlow';

export type GenerationJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type GenerationJobReviewStatus = 'none' | 'awaiting_review' | 'approved' | 'rejected';

export interface GenerationJobEvent {
  stage: string;
  status: string;
  detail: string | null;
  createdAt: string;
}

export interface GenerationJob {
  id: string;
  fighterId: string;
  tier: QualityTier;
  creationFlow: GenerationCreationFlow;
  operation: GenerationBillingOperation;
  targetKind: 'animation' | 'source' | null;
  targetName: string | null;
  artifactRunId: string | null;
  resumedFromJobId: string | null;
  status: GenerationJobStatus;
  reviewStatus: GenerationJobReviewStatus;
  fullRunRestartRequired: boolean;
  stage: string;
  failureStage: string | null;
  progressCurrent: number;
  progressTotal: number;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  resumable: boolean;
  completedStages: string[];
  pendingStages: string[];
  preservedArtifactCount: number;
  events: GenerationJobEvent[];
}

export class GenerationJobNotFoundError extends Error {
  constructor(jobId: string) {
    super(`Generation job ${jobId} was not found`);
    this.name = 'GenerationJobNotFoundError';
  }
}

interface JobResponseBody {
  job?: GenerationJob;
  error?: string;
}

function isLocalDevWithoutApi(): boolean {
  return !String(import.meta.env.VITE_API_BASE_URL ?? '').trim() && import.meta.env.DEV;
}

async function responseBody(response: Response): Promise<JobResponseBody> {
  try {
    const body = await response.json();
    return body && typeof body === 'object' ? body as JobResponseBody : {};
  } catch {
    return {};
  }
}

function jobError(body: JobResponseBody, fallback: string): Error {
  return new Error(typeof body.error === 'string' && body.error.trim() ? body.error.trim() : fallback);
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException('Polling stopped', 'AbortError'));
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }, ms);
    const aborted = () => {
      globalThis.clearTimeout(timeout);
      reject(new DOMException('Polling stopped', 'AbortError'));
    };
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

export async function getGenerationJob(
  jobId: string,
  context?: ApiRequestContext,
): Promise<GenerationJob | null> {
  if (isLocalDevWithoutApi()) return null;
  const response = await apiFetch(`/api/generation-jobs/${encodeURIComponent(jobId)}`, {}, context);
  if (response.status === 404) return null;
  const body = await responseBody(response);
  if (!response.ok) throw jobError(body, `Generation status failed (${response.status})`);
  return body.job ?? null;
}

export async function listGenerationJobs(context?: ApiRequestContext): Promise<GenerationJob[]> {
  if (isLocalDevWithoutApi()) return [];
  const response = await apiFetch('/api/generation-jobs', {}, context);
  const body = await response.json().catch(() => ({})) as { jobs?: GenerationJob[]; error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? `Generation jobs failed (${response.status})`);
  }
  return Array.isArray(body.jobs) ? body.jobs : [];
}

export async function startGenerationJob(
  params: {
    fighterId: string;
    purchaseId: string;
    providerSessionId: string;
    creationFlow?: GenerationCreationFlow;
    targetKind?: 'animation' | 'source';
    targetName?: string;
  },
  context?: ApiRequestContext,
): Promise<GenerationJob> {
  if (isLocalDevWithoutApi()) throw new Error('Durable generation is unavailable in local-only mode');

  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await apiFetch('/api/generation-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      }, context);
      const body = await responseBody(response);
      if (body.job && (response.ok || response.status === 409)) return body.job;
      throw jobError(body, `Generation could not start (${response.status})`);
    } catch (error) {
      if (error instanceof ApiSessionChangedError) throw error;
      lastError = error;
      try {
        const existing = await getGenerationJob(params.purchaseId, context);
        if (existing) return existing;
      } catch (lookupError) {
        if (lookupError instanceof ApiSessionChangedError) throw lookupError;
      }
      if (attempt < 3) await wait(750 * (attempt + 1));
    }
  }
  const detail = lastError instanceof Error ? lastError.message : 'network unavailable';
  throw new Error(`Could not confirm the backend job (${detail}). Reopen the app to reconnect; any accepted job keeps running.`);
}

export async function waitForGenerationJob(
  jobId: string,
  options: {
    context?: ApiRequestContext;
    signal?: AbortSignal;
    onUpdate?: (job: GenerationJob) => void;
    onConnectionIssue?: (attempt: number) => void;
  } = {},
): Promise<GenerationJob> {
  let connectionFailures = 0;
  let notFoundFailures = 0;
  while (true) {
    if (options.signal?.aborted) throw new DOMException('Polling stopped', 'AbortError');
    try {
      const job = await getGenerationJob(jobId, options.context);
      if (!job) {
        notFoundFailures += 1;
        if (notFoundFailures >= 3) throw new GenerationJobNotFoundError(jobId);
        options.onConnectionIssue?.(notFoundFailures);
        await wait(1_500 * notFoundFailures, options.signal);
        continue;
      }
      notFoundFailures = 0;
      connectionFailures = 0;
      options.onUpdate?.(job);
      if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') {
        return job;
      }
      await wait(2_500, options.signal);
    } catch (error) {
      if (
        error instanceof ApiSessionChangedError
        || error instanceof GenerationJobNotFoundError
        || (error instanceof DOMException && error.name === 'AbortError')
      ) {
        throw error;
      }
      connectionFailures += 1;
      options.onConnectionIssue?.(connectionFailures);
      await wait(Math.min(15_000, 1_500 * 2 ** Math.min(connectionFailures, 4)), options.signal);
    }
  }
}
