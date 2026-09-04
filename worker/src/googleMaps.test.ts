import { describe, expect, it, vi } from 'vitest';
import { captureStreetViewImage } from './googleMaps';
import type { Env } from './types';

const validBody = {
  panoId: 'abc_123-Z',
  latitude: 38.541,
  longitude: -0.123,
  heading: 185.5,
  pitch: -2,
  fov: 90,
};

function request(body: unknown = validBody): Request {
  return new Request('https://api.example.com/api/maps/street-view/capture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function env(key = 'server-secret'): Env {
  return { GOOGLE_MAPS_SERVER_KEY: key } as Env;
}

describe('captureStreetViewImage', () => {
  it('keeps the server key upstream and returns only the image', async () => {
    const image = new Uint8Array([137, 80, 78, 71]);
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(image, {
      status: 200,
      headers: { 'Content-Type': 'image/png' },
    }));

    const response = await captureStreetViewImage(request(), env(), fetchMock);

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const upstream = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(upstream.origin).toBe('https://maps.googleapis.com');
    expect(upstream.searchParams.get('key')).toBe('server-secret');
    expect(upstream.searchParams.get('pano')).toBe(validBody.panoId);
    expect(upstream.searchParams.get('size')).toBe('640x360');
    expect(upstream.searchParams.get('scale')).toBe('2');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'follow' });
  });

  it('falls back to the exact coordinates for a photosphere ID rejected by Static Street View', async () => {
    const image = new Uint8Array([255, 216, 255, 217]);
    let requestCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      requestCount += 1;
      return requestCount === 1
        ? new Response(null, { status: 404 })
        : new Response(image, {
            status: 200,
            headers: { 'Content-Type': 'image/jpeg' },
          });
    });

    const response = await captureStreetViewImage(request(), env(), fetchMock);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const fallback = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(fallback.searchParams.has('pano')).toBe(false);
    expect(fallback.searchParams.get('location')).toBe(`${validBody.latitude},${validBody.longitude}`);
    expect(fallback.searchParams.get('radius')).toBe('25');
    expect(fallback.searchParams.get('key')).toBe('server-secret');
  });

  it('refuses capture when the server key is missing', async () => {
    const response = await captureStreetViewImage(request(), env(''), vi.fn());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(/configured/i) });
  });

  it('rejects malformed capture parameters before contacting Google', async () => {
    const fetchMock = vi.fn();
    const response = await captureStreetViewImage(request({ ...validBody, panoId: 'bad pano!' }), env(), fetchMock);
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps missing imagery and quota failures to useful responses', async () => {
    const missing = await captureStreetViewImage(
      request(),
      env(),
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    expect(missing.status).toBe(404);

    const quota = await captureStreetViewImage(
      request(),
      env(),
      vi.fn(async () => new Response(null, { status: 429 })),
    );
    expect(quota.status).toBe(429);
  });

  it('rejects non-image upstream responses', async () => {
    const response = await captureStreetViewImage(
      request(),
      env(),
      vi.fn(async () => Response.json({ error: 'bad key' })),
    );
    expect(response.status).toBe(502);
  });

  it('rejects active image formats and oversized captures', async () => {
    const svg = await captureStreetViewImage(
      request(),
      env(),
      vi.fn(async () => new Response('<svg/>', {
        headers: { 'Content-Type': 'image/svg+xml' },
      })),
    );
    expect(svg.status).toBe(502);

    const oversized = await captureStreetViewImage(
      request(),
      env(),
      vi.fn(async () => new Response(new Uint8Array(5 * 1024 * 1024 + 1), {
        headers: { 'Content-Type': 'image/jpeg' },
      })),
    );
    expect(oversized.status).toBe(502);
  });
});
