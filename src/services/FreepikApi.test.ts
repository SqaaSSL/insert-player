import { describe, expect, it, vi } from 'vitest';

vi.mock('./ApiClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ApiClient')>();
  return {
    ...actual,
    apiFetch: vi.fn(),
  };
});

import { apiFetch } from './ApiClient';
import { blobToBase64, urlToBase64 } from './FreepikApi';

describe('runtime-neutral provider image downloads', () => {
  it('converts Blob bytes without the browser-only FileReader API', async () => {
    expect(await blobToBase64(new Blob([Uint8Array.of(0, 255, 16)]))).toBe('AP8Q');
  });

  it('returns image bytes from the authenticated result proxy', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(
      Uint8Array.of(137, 80, 78, 71),
      { status: 200, headers: { 'Content-Type': 'image/png' } },
    ));

    await expect(urlToBase64('https://media.example.test/result.png')).resolves.toBe('iVBORw==');
  });

  it('does not disguise proxy errors as base64 image data', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(Response.json(
      { error: 'Upstream image unavailable' },
      { status: 502 },
    ));

    await expect(urlToBase64('https://media.example.test/result.png')).rejects.toThrow(
      'Image download failed (502)',
    );
  });
});
