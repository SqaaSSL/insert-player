import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildGeminiProxyTarget,
  handleProxy,
  pixcliBaseUrl,
  pixcliUpstreamHeaders,
  proxyRequest,
  readResponseBytes,
  ResponseBodyTooLargeError,
} from './proxy';
import { PROVIDER_SESSION_HEADER } from './providerSessions';
import type { Env, PublicAuthContext } from './types';

const auth: PublicAuthContext = {
  userId: 'user-1',
  user: null,
  claims: null,
  rateLimitKey: 'user:user-1',
};

function fakeEnv(hasSession: boolean, artifactRunId: string | null = null) {
  const writes: Array<{ key: string; bytes: number }> = [];
  const database = {
    prepare(sql: string) {
      return {
        bind() {
          return {
            async first() {
              if (sql.includes('FROM generation_jobs')) {
                return artifactRunId ? { artifact_run_id: artifactRunId } : null;
              }
              return hasSession ? {
                id: 'session-1',
                tier: 'champion',
                purpose: 'fighter_generation',
                creation_flow: 'video',
                expires_at: new Date(Date.now() + 60_000).toISOString(),
                charge_reason: 'fighter_generation',
              } : null;
            },
          };
        },
      };
    },
    async batch() {
      return [{ results: [{ count: 1 }] }, { results: [] }];
    },
  };
  const bucket = {
    async put(key: string, value: Uint8Array) {
      writes.push({ key, bytes: value.byteLength });
    },
  };
  return {
    env: {
      DB: database as unknown as D1Database,
      SPRITES: bucket as unknown as R2Bucket,
    } as Env,
    writes,
  };
}

describe('temporary provider uploads', () => {
  it('rejects an unauthorized upload before parsing or writing its body', async () => {
    const { env, writes } = fakeEnv(false);
    const response = await handleProxy(new Request('https://api.insertplayer.ai/proxy/upload-temp', {
      method: 'POST',
      body: 'not-json',
    }), env, auth);

    expect(response?.status).toBe(402);
    expect(writes).toHaveLength(0);
  });

  it('stores a valid image for an active provider session', async () => {
    const { env, writes } = fakeEnv(true);
    const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
    const response = await handleProxy(new Request('https://api.insertplayer.ai/proxy/upload-temp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [PROVIDER_SESSION_HEADER]: 'session-1',
      },
      body: JSON.stringify({ image: tinyPng }),
    }), env, auth);

    expect(response?.status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.key).toMatch(/^temp\/[a-f0-9]{32}\.png$/);
    expect(writes[0]?.bytes).toBeGreaterThan(8);
  });

  it('uses the artifact run identity for stable uploads across continuation jobs', async () => {
    const artifactRunId = 'b'.repeat(32);
    const { env, writes } = fakeEnv(true, artifactRunId);
    const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
    const upload = (jobId: string) => handleProxy(new Request('https://api.insertplayer.ai/proxy/upload-temp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [PROVIDER_SESSION_HEADER]: 'session-1',
      },
      body: JSON.stringify({ image: tinyPng }),
    }), env, {
      ...auth,
      claims: { generation_job_id: jobId } as PublicAuthContext['claims'],
    });

    expect((await upload(artifactRunId))?.status).toBe(200);
    expect((await upload('c'.repeat(32)))?.status).toBe(200);
    expect(writes).toHaveLength(2);
    expect(writes[0]?.key).toBe(writes[1]?.key);
  });
});

describe('provider result proxy hardening', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function resultRequest(path: 'image' | 'media', target: string): Request {
    return new Request(`https://api.insertplayer.ai/proxy/${path}?url=${encodeURIComponent(target)}`, {
      headers: { [PROVIDER_SESSION_HEADER]: 'session-1' },
    });
  }

  it('blocks IPv6 and IPv4-mapped literals before any upstream fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { env } = fakeEnv(true);

    const response = await handleProxy(
      resultRequest('image', 'https://[::ffff:127.0.0.1]/private.png'),
      env,
      auth,
    );

    expect(response?.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('revalidates every redirect and blocks a public URL redirecting private', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { Location: 'https://127.0.0.1/private.png' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { env } = fakeEnv(true);

    const response = await handleProxy(
      resultRequest('image', 'https://results.example/start'),
      env,
      auth,
    );

    expect(response?.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
  });

  it('follows a bounded public redirect and requires an image content type', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { Location: 'https://cdn.example/fighter.png' },
      }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const { env } = fakeEnv(true);

    const response = await handleProxy(
      resultRequest('image', 'https://results.example/start'),
      env,
      auth,
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get('Content-Type')).toBe('image/png');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects a successful upstream response without a supported media type', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not media', { status: 200 })));
    const { env } = fakeEnv(true);

    const response = await handleProxy(
      resultRequest('media', 'https://results.example/video'),
      env,
      auth,
    );

    expect(response?.status).toBe(415);
  });

  it('cancels an upstream body as soon as the streamed byte cap is crossed', async () => {
    const response = new Response(new Uint8Array(9));

    await expect(readResponseBytes(response, 8)).rejects.toBeInstanceOf(ResponseBodyTooLargeError);
  });
});

describe('provider request proxy hardening', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts only a credential-free HTTPS PixCLI base URL', () => {
    expect(pixcliBaseUrl(undefined)?.toString()).toBe('https://pixcli.hilo.cx/');
    expect(pixcliBaseUrl('https://pixcli.example/internal')?.toString())
      .toBe('https://pixcli.example/');
    expect(pixcliBaseUrl('http://pixcli.example')).toBeNull();
    expect(pixcliBaseUrl('https://secret@pixcli.example')).toBeNull();
  });

  it('pins PixCLI advanced idempotency to the durable cache row', () => {
    const dispatchKey = `ip:${'a'.repeat(32)}`;
    expect(pixcliUpstreamHeaders(
      'pixcli-worker-secret',
      '/proxy/pixcli/api/v1/video/advanced',
      dispatchKey,
    )).toEqual({
      Authorization: 'Bearer pixcli-worker-secret',
      'Idempotency-Key': dispatchKey,
      'X-Request-Id': dispatchKey,
    });
    expect(pixcliUpstreamHeaders(
      'pixcli-worker-secret',
      '/proxy/pixcli/api/v1/video/advanced',
      `ip:${'a'.repeat(32)}:${'b'.repeat(32)}`,
    )).toBeNull();
  });

  it('proxies an allowlisted PixCLI poll without forwarding client credentials', async () => {
    const upstreamBody = JSON.stringify({ status: 'processing' });
    const fetchMock = vi.fn().mockResolvedValue(new Response(upstreamBody, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { env } = fakeEnv(true);
    Object.assign(env, {
      PIXCLI_API_KEY: 'pixcli-worker-secret',
      PIXCLI_BASE_URL: 'https://pixcli.example',
    });
    const jobId = 'a'.repeat(32);
    const response = await handleProxy(new Request(
      `https://api.insertplayer.ai/proxy/pixcli/api/v1/jobs/${jobId}`,
      {
        headers: {
          Authorization: 'Bearer attacker-client-token',
          [PROVIDER_SESSION_HEADER]: 'session-1',
        },
      },
    ), env, {
      ...auth,
      claims: { generation_creation_flow: 'video' },
    });

    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe(upstreamBody);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0]))
      .toBe(`https://pixcli.example/api/v1/jobs/${jobId}`);
    const upstreamHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(upstreamHeaders.get('Authorization')).toBe('Bearer pixcli-worker-secret');
    expect(upstreamHeaders.get('Authorization')).not.toContain('attacker-client-token');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
    expect(JSON.stringify([...response!.headers])).not.toContain('pixcli-worker-secret');
  });

  it('rejects unallowlisted PixCLI routes before upstream fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { env } = fakeEnv(true);
    Object.assign(env, {
      PIXCLI_API_KEY: 'pixcli-worker-secret',
      PIXCLI_BASE_URL: 'https://pixcli.example',
    });

    const response = await handleProxy(new Request(
      'https://api.insertplayer.ai/proxy/pixcli/api/v1/admin/keys',
      { headers: { [PROVIDER_SESSION_HEADER]: 'session-1' } },
    ), env, { ...auth, claims: { generation_creation_flow: 'video' } });

    expect(response?.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows only the exact PixCLI asset hash path without query parameters', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'Content-Type': 'video/mp4' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { env } = fakeEnv(true);
    Object.assign(env, {
      PIXCLI_API_KEY: 'pixcli-worker-secret',
      PIXCLI_BASE_URL: 'https://pixcli.example',
    });
    const assetHash = 'c'.repeat(32);

    const response = await handleProxy(new Request(
      `https://api.insertplayer.ai/proxy/pixcli/api/v1/assets/${assetHash}`,
      { headers: { [PROVIDER_SESSION_HEADER]: 'session-1' } },
    ), env, { ...auth, claims: { generation_creation_flow: 'video' } });

    expect(response?.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0]))
      .toBe(`https://pixcli.example/api/v1/assets/${assetHash}`);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });

    const withQuery = await handleProxy(new Request(
      `https://api.insertplayer.ai/proxy/pixcli/api/v1/assets/${assetHash}?url=https://evil.example`,
      { headers: { [PROVIDER_SESSION_HEADER]: 'session-1' } },
    ), env, { ...auth, claims: { generation_creation_flow: 'video' } });
    expect(withQuery?.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects PixCLI asset redirects and non-audit MIME types', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { Location: 'https://v3b.fal.media/untrusted.mp4' },
      }))
      .mockResolvedValueOnce(new Response('<html>not an audit asset</html>', {
        headers: { 'Content-Type': 'text/html' },
      }))
      .mockResolvedValueOnce(new Response(new Uint8Array([0, 1, 2]), {
        headers: { 'Content-Type': 'application/octet-stream' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const { env } = fakeEnv(true);
    Object.assign(env, {
      PIXCLI_API_KEY: 'pixcli-worker-secret',
      PIXCLI_BASE_URL: 'https://pixcli.example',
    });
    const assetPath = `https://api.insertplayer.ai/proxy/pixcli/api/v1/assets/${'d'.repeat(32)}`;
    const request = () => new Request(assetPath, {
      headers: { [PROVIDER_SESSION_HEADER]: 'session-1' },
    });
    const videoAuth = { ...auth, claims: { generation_creation_flow: 'video' as const } };

    const redirected = await handleProxy(request(), env, videoAuth);
    expect(redirected?.status).toBe(502);
    expect(await redirected?.json()).toMatchObject({ error: 'PixCLI redirects are not allowed' });

    const wrongMime = await handleProxy(request(), env, videoAuth);
    expect(wrongMime?.status).toBe(415);
    expect(await wrongMime?.json()).toMatchObject({ error: 'PixCLI asset MIME type is not allowlisted' });
    const octetStream = await handleProxy(request(), env, videoAuth);
    expect(octetStream?.status).toBe(415);
    expect(await octetStream?.json()).toMatchObject({ error: 'PixCLI asset MIME type is not allowlisted' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('streams bounded PixCLI provider audit JSON through the exact asset path', async () => {
    const audit = { model: 'grok-imagine-i2v-pinned', provider: 'fal' };
    const fetchMock = vi.fn().mockResolvedValue(Response.json(audit));
    vi.stubGlobal('fetch', fetchMock);
    const { env } = fakeEnv(true);
    Object.assign(env, {
      PIXCLI_API_KEY: 'pixcli-worker-secret',
      PIXCLI_BASE_URL: 'https://pixcli.example',
    });

    const response = await handleProxy(new Request(
      `https://api.insertplayer.ai/proxy/pixcli/api/v1/assets/${'e'.repeat(32)}`,
      { headers: { [PROVIDER_SESSION_HEADER]: 'session-1' } },
    ), env, { ...auth, claims: { generation_creation_flow: 'video' } });

    expect(response?.status).toBe(200);
    expect(response?.headers.get('Content-Type')).toBe('application/json');
    expect(await response?.json()).toEqual(audit);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
  });

  it('rejects a PixCLI video model outside the pinned 33-cent contract', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { env } = fakeEnv(true);
    Object.assign(env, {
      PIXCLI_API_KEY: 'pixcli-worker-secret',
      PIXCLI_BASE_URL: 'https://pixcli.example',
    });

    const response = await handleProxy(new Request(
      'https://api.insertplayer.ai/proxy/pixcli/api/v1/video/advanced',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [PROVIDER_SESSION_HEADER]: 'session-1',
        },
        body: JSON.stringify({
          prompt: 'Generate one bounded high kick animation from the approved canonical.',
          model: 'more-expensive-unapproved-model',
          image: 'a'.repeat(32),
          resolution: '720p',
          params: { duration: 2, resolution: '720p' },
          enrich_prompt: false,
          output_format: 'url',
          publish: false,
          publish_name: 'high-kick',
        }),
      },
    ), env, { ...auth, claims: { generation_creation_flow: 'video' } });

    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({
      error: 'PixCLI video request does not match the pinned generation contract',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires multipart transport for PixCLI uploads', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { env } = fakeEnv(true);
    Object.assign(env, {
      PIXCLI_API_KEY: 'pixcli-worker-secret',
      PIXCLI_BASE_URL: 'https://pixcli.example',
    });

    const response = await handleProxy(new Request(
      'https://api.insertplayer.ai/proxy/pixcli/api/v1/uploads',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [PROVIDER_SESSION_HEADER]: 'session-1',
        },
        body: '{}',
      },
    ), env, { ...auth, claims: { generation_creation_flow: 'video' } });

    expect(response?.status).toBe(415);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('builds the Meterkey Google AI Studio route without leaking the direct Google key', () => {
    const request = new Request(
      'https://api.insertplayer.ai/proxy/gemini/v1beta/models/gemini-3-pro-image:generateContent?key=attacker&alt=json',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Insert-Player-Provider-Request-Key': 'job:0123456789abcdef0123456789abcdef:source:side',
        },
        body: '{"contents":[]}',
      },
    );
    const upstream = buildGeminiProxyTarget(
      request,
      {
        ENVIRONMENT: 'production',
        GEMINI_TRANSPORT: 'meterkey',
        METERKEY_BASE_URL: 'https://meter.hilo.cx',
        METERKEY_API_KEY: 'mk-insert-player-test',
        GEMINI_API_KEY: 'direct-google-must-not-leak',
      } as Env,
      '/v1beta/models/gemini-3-pro-image:generateContent',
      new URL(request.url),
      'ip:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    );

    expect(upstream).toMatchObject({
      transport: 'meterkey',
      targetUrl: 'https://meter.hilo.cx/google-ai-studio/v1beta/models/gemini-3-pro-image:generateContent?alt=json',
    });
    expect(upstream?.targetUrl).not.toContain('direct-google-must-not-leak');
    expect(upstream?.targetUrl).not.toContain('attacker');
    expect(upstream?.headers).toMatchObject({
      Authorization: 'Bearer mk-insert-player-test',
      'cf-aig-collect-log-payload': 'false',
      'cf-aig-max-attempts': '1',
      'x-meterkey-no-store': 'true',
      'Idempotency-Key': 'ip:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'X-Request-Id': 'ip:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    });
  });

  it('never forwards the animation-wide request scope as Meterkey idempotency', () => {
    const request = new Request('https://api.insertplayer.ai/proxy/gemini/model', {
      method: 'POST',
      headers: {
        'X-Insert-Player-Provider-Request-Key':
          'job:0123456789abcdef0123456789abcdef:sprite:high_kick',
      },
      body: '{"frame":2}',
    });
    const upstream = buildGeminiProxyTarget(
      request,
      {
        ENVIRONMENT: 'production',
        GEMINI_TRANSPORT: 'meterkey',
        METERKEY_BASE_URL: 'https://meter.hilo.cx',
        METERKEY_API_KEY: 'mk-test',
      } as Env,
      '/v1beta/models/gemini-3-pro-image:generateContent',
      new URL(request.url),
    );

    expect(upstream?.headers['Idempotency-Key']).toMatch(/^ip:ephemeral:[0-9a-f-]{36}$/);
    expect(upstream?.headers['X-Request-Id']).toBe(upstream?.headers['Idempotency-Key']);
    expect(upstream?.headers['Idempotency-Key']).not.toContain('sprite:high_kick');
  });

  it('fails closed before session accounting or fetch when the selected Meterkey secret is absent', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { env } = fakeEnv(true);
    Object.assign(env, {
      ENVIRONMENT: 'production',
      GEMINI_TRANSPORT: 'meterkey',
      METERKEY_BASE_URL: 'https://meter.hilo.cx',
      GEMINI_API_KEY: 'legacy-direct-key',
    });

    const response = await handleProxy(new Request(
      'https://api.insertplayer.ai/proxy/gemini/v1beta/models/gemini-3-pro-image:generateContent',
      { method: 'POST', body: '{}' },
    ), env, auth);

    expect(response?.status).toBe(503);
    expect(await response?.json()).toEqual({ error: 'METERKEY_API_KEY is not configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a Meterkey rejection after exactly one upstream attempt', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"error":"quota"}', {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': '60',
        'X-Meterkey-Upstream-Outcome': 'not-dispatched',
      },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const request = new Request('https://api.insertplayer.ai/proxy/gemini/model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"contents":[]}',
    });
    const upstream = buildGeminiProxyTarget(
      request,
      {
        ENVIRONMENT: 'production',
        GEMINI_TRANSPORT: 'meterkey',
        METERKEY_BASE_URL: 'https://meter.hilo.cx',
        METERKEY_API_KEY: 'mk-test',
      } as Env,
      '/v1beta/models/gemini-3-pro-image:generateContent',
      new URL(request.url),
    );
    expect(upstream).not.toBeNull();

    const response = await proxyRequest(request, upstream!.targetUrl, upstream!.headers, 1024);

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(response.headers.get('X-Insert-Player-Upstream-Outcome')).toBe('not-dispatched');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('meter.hilo.cx/google-ai-studio');
  });

  it('propagates an ambiguous Meterkey dispatch without retrying it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'service_unavailable', message: 'upstream provider request failed' },
    }), {
      status: 503,
      headers: { 'X-Meterkey-Upstream-Outcome': 'unknown' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const request = new Request('https://api.insertplayer.ai/proxy/gemini/model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"contents":[]}',
    });

    const response = await proxyRequest(
      request,
      'https://meter.hilo.cx/google-ai-studio/v1beta/models/gemini-3-pro-image:generateContent',
      { Authorization: 'Bearer mk-test' },
      1024,
      32 * 1024 * 1024,
      'meterkey',
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('X-Insert-Player-Upstream-Outcome')).toBe('unknown');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([null, 'invalid-outcome'])(
    'fails closed when Meterkey omits a valid dispatch outcome (%s)',
    async (declaredOutcome) => {
      const headers = new Headers({ 'Content-Type': 'application/json' });
      if (declaredOutcome) headers.set('X-Meterkey-Upstream-Outcome', declaredOutcome);
      const fetchMock = vi.fn().mockResolvedValue(new Response('{"error":"edge failure"}', {
        status: 503,
        headers,
      }));
      vi.stubGlobal('fetch', fetchMock);
      const request = new Request('https://api.insertplayer.ai/proxy/gemini/model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"contents":[]}',
      });

      const response = await proxyRequest(
        request,
        'https://meter.hilo.cx/google-ai-studio/v1beta/models/gemini-3-pro-image:generateContent',
        { Authorization: 'Bearer mk-test' },
        1024,
        32 * 1024 * 1024,
        'meterkey',
      );

      expect(response.status).toBe(503);
      expect(response.headers.get('X-Insert-Player-Upstream-Outcome')).toBe('unknown');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([200, 503])('accepts Meterkey received outcome for HTTP %s', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', {
      status,
      headers: { 'X-Meterkey-Upstream-Outcome': 'received' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const request = new Request('https://api.insertplayer.ai/proxy/gemini/model', {
      method: 'POST',
      body: '{}',
    });

    const response = await proxyRequest(
      request,
      'https://meter.hilo.cx/google-ai-studio/v1beta/models/gemini-3-pro-image:generateContent',
      { Authorization: 'Bearer mk-test' },
      1024,
      32 * 1024 * 1024,
      'meterkey',
    );

    expect(response.headers.get('X-Insert-Player-Upstream-Outcome')).toBe('received');
  });

  it('keeps the legacy received default for non-Meterkey providers without an outcome header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"error":"provider failure"}', {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const request = new Request('https://api.insertplayer.ai/proxy/provider/model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    const response = await proxyRequest(request, 'https://provider.example/model', {}, 1024);

    expect(response.headers.get('X-Insert-Player-Upstream-Outcome')).toBe('received');
  });

  it('rejects a declared oversized provider body before fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const request = new Request('https://api.insertplayer.ai/proxy/gemini/model', {
      method: 'POST',
      headers: { 'Content-Length': '9', 'Content-Type': 'application/json' },
      body: '{}',
    });

    const response = await proxyRequest(request, 'https://provider.example/model', {}, 8);

    expect(response.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts a chunked provider body as soon as its streaming cap is crossed', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      await new Response(init?.body).arrayBuffer();
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);
    const request = new Request('https://api.insertplayer.ai/proxy/gemini/model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(8));
          controller.enqueue(new Uint8Array(1));
          controller.close();
        },
      }),
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    const response = await proxyRequest(request, 'https://provider.example/model', {}, 8);

    expect(response.status).toBe(413);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('streams provider responses through a byte cap instead of buffering them', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array(9), {
      headers: { 'Content-Type': 'application/json' },
    })));
    const request = new Request('https://api.insertplayer.ai/proxy/gemini/model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    const response = await proxyRequest(
      request,
      'https://provider.example/model',
      {},
      8,
      8,
    );

    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toBeInstanceOf(ResponseBodyTooLargeError);
  });
});
