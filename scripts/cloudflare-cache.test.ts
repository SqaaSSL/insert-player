import { describe, expect, it, vi } from 'vitest';
import { purgeExactCloudflareFiles } from './cloudflare-cache.mjs';

describe('Cloudflare exact asset cache purge', () => {
  it('reports a successful purge without exposing the token', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    }));

    const result = await purgeExactCloudflareFiles({
      token: 'private-token',
      zoneId: 'zone-id',
      files: ['https://insertplayer.ai/assets/index-current.js'],
      fetchImpl,
    });

    expect(result).toEqual({ purged: true, warning: '' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/zones/zone-id/purge_cache',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ files: ['https://insertplayer.ai/assets/index-current.js'] }),
      }),
    );
  });

  it('returns a safe warning so canonical smoke can decide release readiness', async () => {
    const result = await purgeExactCloudflareFiles({
      token: 'private-token',
      zoneId: 'zone-id',
      files: ['https://insertplayer.ai/assets/index-current.js'],
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        json: async () => ({ errors: [{ message: 'Authentication error' }] }),
      }),
    });

    expect(result).toEqual({
      purged: false,
      warning: 'Cloudflare exact asset cache purge failed (401): Authentication error',
    });
    expect(result.warning).not.toContain('private-token');
  });
});
