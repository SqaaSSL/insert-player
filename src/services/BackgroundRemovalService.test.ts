import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./FreepikApi', () => ({
  freepikRemoveBackground: vi.fn(),
  resizeImageForApi: vi.fn(),
  urlToBase64: vi.fn(),
}));

vi.mock('./ApiClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ApiClient')>();
  return {
    ...actual,
    apiFetch: vi.fn(),
  };
});

import { ApiSessionChangedError, apiFetch } from './ApiClient';
import { freepikRemoveBackground, resizeImageForApi } from './FreepikApi';
import { removeBackgroundWithConfiguredProvider } from './BackgroundRemovalService';

describe('background removal provider fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('VITE_BG_REMOVAL_PROVIDER', 'fal');
    vi.mocked(resizeImageForApi).mockResolvedValue('resized-image');
  });

  it('uses Freepik DNN when fal is rate-limited', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(Response.json({ url: 'https://api.example.test/temp-assets/input' }))
      .mockResolvedValueOnce(Response.json({ error: 'Rate limit exceeded' }, { status: 429 }));
    vi.mocked(freepikRemoveBackground).mockResolvedValue('freepik-cutout');

    await expect(removeBackgroundWithConfiguredProvider('input-image')).resolves.toBe('freepik-cutout');
    expect(freepikRemoveBackground).toHaveBeenCalledWith('input-image', undefined);
  });

  it('does not cross account boundaries when the request context changes', async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce(new ApiSessionChangedError());

    await expect(removeBackgroundWithConfiguredProvider('input-image')).rejects.toBeInstanceOf(ApiSessionChangedError);
    expect(freepikRemoveBackground).not.toHaveBeenCalled();
  });

  it('reports both provider failures so the caller can use chroma safely', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(Response.json({ url: 'https://api.example.test/temp-assets/input' }))
      .mockResolvedValueOnce(Response.json({ error: 'Rate limit exceeded' }, { status: 429 }));
    vi.mocked(freepikRemoveBackground).mockRejectedValue(new Error('Freepik unavailable'));

    await expect(removeBackgroundWithConfiguredProvider('input-image')).rejects.toThrow(
      'fal failed (fal bg-remove create failed (429)',
    );
    expect(freepikRemoveBackground).toHaveBeenCalledOnce();
  });
});
