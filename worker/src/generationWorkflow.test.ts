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
import {
  downloadPixcliAuditAsset,
  isTerminalVideoProviderFailure,
  parsePixcliVideoSubmissionResponse,
} from './videoSpriteWorkflow';
import type { Env, GenerationJob } from './types';

describe('generation workflow processor failure policy', () => {
  it.each([
    'Pinned PixCLI video job terminated as failed',
    'Pinned PixCLI video response is terminal and cannot be replayed safely: provider_request_outcome_unknown',
    'Pinned PixCLI video response is terminal and cannot be replayed safely: submission returned HTTP 422',
    'Pinned PixCLI video response is terminal and cannot be replayed safely: submission returned an unusable HTTP 200 payload',
    'Pinned completed PixCLI video audit is terminal and cannot be replayed safely: PixCLI audit JSON hash changed after Canva validation',
    'Pinned completed PixCLI video audit is terminal and cannot be replayed safely: Video compiler report contract is invalid',
  ])('classifies an immutable PixCLI response as terminal: %s', (message) => {
    expect(isTerminalVideoProviderFailure(message)).toBe(true);
  });

  it.each([
    'Error: Pinned PixCLI video job terminated as failed',
    'Error: NonRetryableError: Pinned PixCLI video response is terminal and cannot be replayed safely: submission returned HTTP 422',
    'Error: TerminalVideoAuditInvariantError: Pinned completed PixCLI video audit is terminal and cannot be replayed safely: PixCLI audit asset exceeds its local download limit',
    'TerminalVideoProviderResponseError: Pinned PixCLI video response is terminal and cannot be replayed safely: provider_request_outcome_unknown',
  ])('classifies only known serialized error wrappers before a terminal prefix: %s', (message) => {
    expect(isTerminalVideoProviderFailure(message)).toBe(true);
  });

  it('keeps transport failures with no received PixCLI response resumable', () => {
    expect(isTerminalVideoProviderFailure('fetch failed before receiving a response')).toBe(false);
    expect(isTerminalVideoProviderFailure('PixCLI audit asset abc failed with HTTP 503')).toBe(false);
    expect(isTerminalVideoProviderFailure('Video compiler rejected the provider asset (503)')).toBe(false);
    expect(isTerminalVideoProviderFailure(
      'transport Error: TerminalVideoAuditInvariantError: ' +
      'Pinned completed PixCLI video audit is terminal and cannot be replayed safely: hash changed',
    )).toBe(false);
    expect(isTerminalVideoProviderFailure(
      'Error: SomeOtherError: ' +
      'Pinned completed PixCLI video audit is terminal and cannot be replayed safely: hash changed',
    )).toBe(false);
  });

  it.each([
    ['missing', undefined],
    ['blank', ''],
  ])('downloads an exact bounded audit asset with a %s Content-Length header', async (_label, header) => {
    const env = {
      ENVIRONMENT: 'development',
      GENERATION_API_BASE_URL: 'https://insert-player.example',
      GENERATION_JOB_SIGNING_SECRET: 'test-generation-signing-secret',
    } as unknown as Env;
    const job = {
      id: 'a'.repeat(32),
      user_id: 'user-1',
      provider_session_id: 'b'.repeat(32),
    } as GenerationJob;
    const bytes = new Uint8Array(12);
    bytes.set(new TextEncoder().encode('ftyp'), 4);
    const headers = new Headers({ 'Content-Type': 'video/mp4' });
    if (header !== undefined) headers.set('Content-Length', header);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes, { status: 200, headers })));
    try {
      const downloaded = await downloadPixcliAuditAsset(
        env,
        job,
        'run:test:sprite:idle',
        {
          hash: 'c'.repeat(32),
          contentSha256: null,
          sizeBytes: bytes.byteLength,
          mimeType: 'video/mp4',
        },
      );
      expect(new Uint8Array(downloaded)).toEqual(bytes);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ['zero', '0'],
    ['oversize', String(16 * 1024 * 1024 + 1)],
  ])('rejects an explicit %s audit asset Content-Length', async (_label, contentLength) => {
    const env = {
      ENVIRONMENT: 'development',
      GENERATION_API_BASE_URL: 'https://insert-player.example',
      GENERATION_JOB_SIGNING_SECRET: 'test-generation-signing-secret',
    } as unknown as Env;
    const job = {
      id: 'a'.repeat(32),
      user_id: 'user-1',
      provider_session_id: 'b'.repeat(32),
    } as GenerationJob;
    const bytes = new Uint8Array(12);
    bytes.set(new TextEncoder().encode('ftyp'), 4);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes, {
      status: 200,
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': contentLength },
    })));
    try {
      await expect(downloadPixcliAuditAsset(
        env,
        job,
        'run:test:sprite:idle',
        {
          hash: 'c'.repeat(32),
          contentSha256: null,
          sizeBytes: bytes.byteLength,
          mimeType: 'video/mp4',
        },
      )).rejects.toMatchObject({
        name: 'NonRetryableError',
        message: expect.stringContaining('exceeds its local download limit'),
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('terminalizes an immutable completed-audit size mismatch but keeps network I/O resumable', async () => {
    const env = {
      ENVIRONMENT: 'development',
      GENERATION_API_BASE_URL: 'https://insert-player.example',
      GENERATION_JOB_SIGNING_SECRET: 'test-generation-signing-secret',
    } as unknown as Env;
    const job = {
      id: 'a'.repeat(32),
      user_id: 'user-1',
      provider_session_id: 'b'.repeat(32),
    } as GenerationJob;
    const asset = {
      hash: 'c'.repeat(32),
      contentSha256: null,
      sizeBytes: 99,
      mimeType: 'video/mp4' as const,
    };
    const bytes = new Uint8Array(12);
    bytes.set(new TextEncoder().encode('ftyp'), 4);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes, {
      status: 200,
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(bytes.byteLength) },
    })));
    const immutableFailure = await downloadPixcliAuditAsset(
      env, job, 'run:test:sprite:idle', asset,
    ).then(() => null, (error: unknown) => error instanceof Error ? error : new Error(String(error)));
    expect(immutableFailure).not.toBeNull();
    expect(immutableFailure!.name).toBe('NonRetryableError');
    expect(isTerminalVideoProviderFailure(immutableFailure!.message)).toBe(true);

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network unavailable')));
    const transientFailure = await downloadPixcliAuditAsset(
      env, job, 'run:test:sprite:idle', asset,
    ).then(() => null, (error: unknown) => error instanceof Error ? error : new Error(String(error)));
    expect(transientFailure).not.toBeNull();
    expect(isTerminalVideoProviderFailure(transientFailure!.message)).toBe(false);
    vi.unstubAllGlobals();
  });

  it.each([
    [422, JSON.stringify({ code: 'provider_content_blocked' })],
    [500, JSON.stringify({ error: 'upstream failed' })],
    [409, JSON.stringify({ code: 'provider_request_outcome_unknown' })],
    [200, '{invalid-json'],
    [200, JSON.stringify({ unexpected: 'shape' })],
  ])('terminalizes a cached/unusable advanced response (%s)', async (status, body) => {
    const response = new Response(body, {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
    const failure = await parsePixcliVideoSubmissionResponse(response).then(
      () => null,
      (error: unknown) => error instanceof Error ? error : new Error(String(error)),
    );
    expect(failure).not.toBeNull();
    expect(failure!.name).toBe('NonRetryableError');
    expect(isTerminalVideoProviderFailure(failure!.message)).toBe(true);
  });

  it('keeps an explicitly not-dispatched advanced request resumable', async () => {
    const response = Response.json({ code: 'provider_request_not_dispatched' }, { status: 503 });
    const failure = await parsePixcliVideoSubmissionResponse(response).then(
      () => null,
      (error: unknown) => error instanceof Error ? error : new Error(String(error)),
    );
    expect(failure).not.toBeNull();
    expect(isTerminalVideoProviderFailure(failure!.message)).toBe(false);
  });

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
