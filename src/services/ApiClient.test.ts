import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiSessionChangedError,
  apiFetch,
  captureApiRequestContext,
  configureApiAuth,
  createDetachedApiRequestContext,
  withProviderSession,
} from './ApiClient';

describe('ApiClient request contexts', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { location: { href: 'https://insertplayer.ai/gallery' } });
  });

  afterEach(() => {
    configureApiAuth(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps concurrent provider sessions attached to their own requests', async () => {
    configureApiAuth(async () => 'token-a');
    const base = captureApiRequestContext();
    const first = withProviderSession(base, 'provider-a');
    const second = withProviderSession(base, 'provider-b');
    const seen: Array<{ authorization: string | null; provider: string | null }> = [];

    vi.stubGlobal('fetch', vi.fn(async (_input: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({
        authorization: headers.get('Authorization'),
        provider: headers.get('X-ASF-Provider-Session'),
      });
      return new Response('{}');
    }));

    await Promise.all([
      apiFetch('/proxy/gemini/test-a', {}, first),
      apiFetch('/proxy/gemini/test-b', {}, second),
    ]);

    expect(seen).toEqual([
      { authorization: 'Bearer token-a', provider: 'provider-a' },
      { authorization: 'Bearer token-a', provider: 'provider-b' },
    ]);
  });

  it('uses a stable semantic request key for parallel durable provider calls', async () => {
    const context = createDetachedApiRequestContext({
      apiBaseUrl: 'https://api.insertplayer.ai',
      authorizationToken: 'generation-token',
      authorizationScheme: 'Generation',
      providerSessionId: 'provider-job',
      providerRequestScope: 'job:abc:sprite:walk',
    });
    const seen: Array<{ authorization: string | null; key: string | null }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({
        authorization: headers.get('Authorization'),
        key: headers.get('X-Insert-Player-Provider-Request-Key'),
      });
      return new Response('{}');
    }));

    await Promise.all([
      apiFetch('/proxy/gemini/frame-a', { method: 'POST', body: 'a' }, context),
      apiFetch('/proxy/gemini/frame-b', { method: 'POST', body: 'b' }, context),
    ]);

    expect(seen).toEqual([
      { authorization: 'Generation generation-token', key: 'job:abc:sprite:walk' },
      { authorization: 'Generation generation-token', key: 'job:abc:sprite:walk' },
    ]);
  });

  it('rejects an operation context after the Clerk session changes', async () => {
    configureApiAuth(async () => 'token-a');
    const stale = captureApiRequestContext();
    configureApiAuth(async () => 'token-b');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiFetch('/api/fighters', {}, stale)).rejects.toBeInstanceOf(ApiSessionChangedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rechecks the session after awaiting Clerk token retrieval', async () => {
    let releaseToken!: (token: string) => void;
    const pendingToken = new Promise<string>((resolve) => { releaseToken = resolve; });
    configureApiAuth(() => pendingToken);
    const stale = captureApiRequestContext();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const request = apiFetch('/api/fighters', {}, stale);
    configureApiAuth(async () => 'token-b');
    releaseToken('token-a');

    await expect(request).rejects.toBeInstanceOf(ApiSessionChangedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
