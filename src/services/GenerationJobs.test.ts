import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, configureApiAuth } from './ApiClient';
import {
  GenerationJobNotFoundError,
  startGenerationJob,
  waitForGenerationJob,
  type GenerationJob,
} from './GenerationJobs';

vi.mock('./ApiClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ApiClient')>();
  return { ...actual, apiFetch: vi.fn() };
});

const JOB: GenerationJob = {
  id: '11111111111111111111111111111111',
  fighterId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  tier: 'rookie',
  operation: 'fighter_generation',
  targetKind: null,
  targetName: null,
  artifactRunId: '11111111111111111111111111111111',
  resumedFromJobId: null,
  status: 'queued',
  stage: 'queued',
  failureStage: null,
  progressCurrent: 0,
  progressTotal: 14,
  errorCode: null,
  errorMessage: null,
  startedAt: null,
  finishedAt: null,
  createdAt: '2026-08-22T00:00:00.000Z',
  updatedAt: '2026-08-22T00:00:00.000Z',
  resumable: false,
  completedStages: [],
  pendingStages: [],
  preservedArtifactCount: 0,
  events: [],
};

describe('durable generation browser recovery', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.insertplayer.ai');
    configureApiAuth(async () => 'clerk-token');
    vi.mocked(apiFetch).mockReset();
  });

  afterEach(() => {
    configureApiAuth(null);
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('recovers an accepted POST by looking up its purchase id after a connection loss', async () => {
    vi.mocked(apiFetch)
      .mockRejectedValueOnce(new TypeError('connection reset'))
      .mockResolvedValueOnce(Response.json({ job: JOB }));

    const recovered = await startGenerationJob({
      fighterId: JOB.fighterId,
      purchaseId: JOB.id,
      providerSessionId: '22222222222222222222222222222222',
    });

    expect(recovered).toEqual(JOB);
    expect(apiFetch).toHaveBeenNthCalledWith(
      2,
      `/api/generation-jobs/${JOB.id}`,
      {},
      undefined,
    );
  });

  it('reconnects to the existing fighter job when a duplicate reservation loses the start race', async () => {
    const running = { ...JOB, status: 'running' as const, stage: 'sprite:idle', progressCurrent: 4 };
    vi.mocked(apiFetch).mockResolvedValueOnce(Response.json({
      error: 'A generation is already running for this fighter; the unused reservation was released',
      job: running,
    }, { status: 409 }));

    await expect(startGenerationJob({
      fighterId: JOB.fighterId,
      purchaseId: '33333333333333333333333333333333',
      providerSessionId: '44444444444444444444444444444444',
    })).resolves.toEqual(running);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('stops after repeated definitive 404 responses instead of polling forever', async () => {
    vi.useFakeTimers();
    vi.mocked(apiFetch).mockResolvedValue(new Response(null, { status: 404 }));

    const result = waitForGenerationJob(JOB.id);
    const assertion = expect(result).rejects.toBeInstanceOf(GenerationJobNotFoundError);
    await vi.runAllTimersAsync();
    await assertion;
    expect(apiFetch).toHaveBeenCalledTimes(3);
  });

  it('returns a completed cloud job without asking the browser to settle billing', async () => {
    const succeeded = { ...JOB, status: 'succeeded' as const, stage: 'complete', progressCurrent: 14 };
    vi.mocked(apiFetch).mockResolvedValue(Response.json({ job: succeeded }));

    await expect(waitForGenerationJob(JOB.id)).resolves.toEqual(succeeded);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });
});
