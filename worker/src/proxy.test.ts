import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleProxy, proxyRequest, readResponseBytes, ResponseBodyTooLargeError } from './proxy';
import { PROVIDER_SESSION_HEADER } from './providerSessions';
import type { Env, PublicAuthContext } from './types';

const auth: PublicAuthContext = {
  userId: 'user-1',
  user: null,
  claims: null,
  rateLimitKey: 'user:user-1',
};

function fakeEnv(hasSession: boolean) {
  const writes: Array<{ key: string; bytes: number }> = [];
  const database = {
    prepare() {
      return {
        bind() {
          return {
            async first() {
              return hasSession ? { id: 'session-1' } : null;
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
});
