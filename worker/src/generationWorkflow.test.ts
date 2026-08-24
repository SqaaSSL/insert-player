import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class {
    protected env: unknown;

    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));
vi.mock('cloudflare:workflows', () => ({
  NonRetryableError: class NonRetryableError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'NonRetryableError';
    }
  },
}));

import {
  FighterGenerationWorkflow,
  nonRetryableProcessorProviderMessage,
} from './generationWorkflow';
import type { Env, GenerationJob } from './types';

describe('generation workflow processor failure policy', () => {
  it.each([
    'provider_request_not_dispatched',
    'provider_request_outcome_unknown',
    'daily_cap_exceeded',
    'monthly_cap_exceeded',
  ])('marks %s as unsafe to retry', (code) => {
    expect(nonRetryableProcessorProviderMessage(code, JSON.stringify({ code })))
      .toContain(`(${code})`);
  });

  it('leaves the direct-Google daily-quota signal to the capacity-window path', () => {
    expect(nonRetryableProcessorProviderMessage(
      'provider_daily_quota_exhausted',
      JSON.stringify({ code: 'provider_daily_quota_exhausted' }),
    )).toBeNull();
  });

  it.each([
    ['provider_request_not_dispatched', 503],
    ['provider_request_outcome_unknown', 503],
    ['daily_cap_exceeded', 429],
    ['monthly_cap_exceeded', 429],
  ])('throws NonRetryableError for a Processor %s response without writing a capacity window', async (
    code,
    status,
  ) => {
    const dbPrepare = vi.fn(() => {
      throw new Error('capacity storage must not be reached');
    });
    const containerFetch = vi.fn().mockResolvedValue(Response.json({
      error: 'request rejected by Meterkey',
      code,
      provider: 'gemini',
      model: 'gemini-3-pro-image',
    }, { status }));
    const env = {
      DB: { prepare: dbPrepare },
      ENVIRONMENT: 'production',
      GENERATION_API_BASE_URL: 'https://insert-player.example',
      GENERATION_JOB_SIGNING_SECRET: 'test-generation-signing-secret',
      IMAGE_PROCESSOR: {
        getByName: vi.fn(() => ({ fetch: containerFetch })),
      },
    } as unknown as Env;
    const workflow = new FighterGenerationWorkflow({} as ExecutionContext, env);
    const job = {
      id: 'a'.repeat(32),
      user_id: 'user-1',
      provider_session_id: 'b'.repeat(32),
    } as GenerationJob;
    const callProcessor = (workflow as unknown as {
      callProcessor<T>(
        generationJob: GenerationJob,
        path: string,
        body: Record<string, unknown>,
      ): Promise<T>;
    }).callProcessor.bind(workflow);

    await expect(callProcessor(job, '/v1/generate-source', {})).rejects.toMatchObject({
      name: 'NonRetryableError',
      message: expect.stringContaining(`(${code})`),
    });
    expect(containerFetch).toHaveBeenCalledOnce();
    expect(dbPrepare).not.toHaveBeenCalled();
  });
});
