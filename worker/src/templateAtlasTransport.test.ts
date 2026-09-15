import { describe, expect, it } from 'vitest';
import { handleProxy, validateTemplateAtlasTransportRequest } from './proxy';
import type { Env, PublicAuthContext } from './types';

const VALID_ATLAS_BODY = {
  sync_mode: false, num_images: 1, resolution: '4K', aspect_ratio: '1:1', output_format: 'png',
  limit_generations: true, enable_web_search: false,
  prompt: 'Edit the immutable pose template using only the prepared upright identity.',
  image_urls: Array(2).fill('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'),
};
const path = '/proxy/fal/fal-ai/nano-banana-2/edit';
function request(body: unknown, query = '') {
  return new Request(`https://api.insertplayer.ai${path}${query}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}
const auth: PublicAuthContext = {
  userId: 'test-user', user: null, rateLimitKey: 'user:test-user',
  claims: { generation_job_id: '1'.repeat(32), generation_renderer_version: 'rookie-two-atlas-v1' },
};

describe('Template Atlas strict proxy contract', () => {
  it('accepts only the fixed two-reference 4K PNG payload', async () => {
    expect(await validateTemplateAtlasTransportRequest(request(VALID_ATLAS_BODY))).toBeNull();
  });
  it.each([
    { num_images: 2 }, { resolution: '2K' }, { output_format: 'jpeg' }, { aspect_ratio: '3:4' },
    { sync_mode: true }, { enable_web_search: true }, { limit_generations: false },
    { image_urls: [...VALID_ATLAS_BODY.image_urls, VALID_ATLAS_BODY.image_urls[0]] },
    { image_urls: ['https://untrusted.test/template.png', VALID_ATLAS_BODY.image_urls[0]] },
    { image_urls: ['data:image/jpeg;base64,AAAA', VALID_ATLAS_BODY.image_urls[0]] },
    { prompt: 'short' }, { fallback: true }, { model: 'other' }, { originalPhoto: 'extra' },
  ])('rejects payload expansion before reserving provider spend (%j)', async changed => {
    expect((await validateTemplateAtlasTransportRequest(request({ ...VALID_ATLAS_BODY, ...changed })))?.status).toBe(400);
  });
  it('never falls back to a configured FAL or PixCLI key when Meterkey is missing', async () => {
    const env = { METERKEY_BASE_URL: 'https://meter.hilo.cx', FAL_API_KEY: 'unused-test-direct-key', PIXCLI_API_KEY: 'unused-test-pixcli-key' } as Env;
    const response = await handleProxy(request(VALID_ATLAS_BODY), env, auth);
    expect(response?.status).toBe(503);
    expect(await response?.json()).toEqual({ error: 'METERKEY_API_KEY / METERKEY_BASE_URL is not configured' });
  });
  it('denies unsigned/legacy jobs, query parameters, unsupported model paths and write methods', async () => {
    const env = { METERKEY_BASE_URL: 'https://meter.hilo.cx', METERKEY_API_KEY: 'unused-test-meterkey-key' } as Env;
    for (const claims of [null, {}, { generation_job_id: '1'.repeat(32), generation_renderer_version: 'legacy-v1' },
      { generation_renderer_version: 'rookie-two-atlas-v1' }]) {
      expect((await handleProxy(request(VALID_ATLAS_BODY), env, { ...auth, claims }))?.status).toBe(403);
    }
    expect((await handleProxy(request(VALID_ATLAS_BODY, '?fallback=true'), env, auth))?.status).toBe(400);
    expect((await handleProxy(new Request('https://api.insertplayer.ai/proxy/fal/fal-ai/nano-banana-2/other', { method: 'POST' }), env, auth))?.status).toBe(404);
    expect((await handleProxy(new Request(`https://api.insertplayer.ai${path}`, { method: 'DELETE' }), env, auth))?.status).toBe(405);
  });
  it('fails closed for direct Gemini configuration and other fallback providers on template jobs', async () => {
    const env = { GEMINI_TRANSPORT: 'google-direct', GEMINI_API_KEY: 'unused-direct-test-key',
      FREEPIK_API_KEY: 'unused-test-key', PIXCLI_API_KEY: 'unused-test-key', FAL_API_KEY: 'unused-test-key' } as Env;
    const gemini = await handleProxy(new Request('https://api.insertplayer.ai/proxy/gemini/v1beta/models/gemini-3-pro-image:generateContent', { method: 'POST', body: '{}' }), env, auth);
    expect(gemini?.status).toBe(503);
    for (const route of ['/proxy/freepik/v1/ai/beta/remove-background', '/proxy/pixcli/api/v1/video/advanced',
      '/proxy/fal/fal-ai/ltx-2.3/image-to-video/fast', '/proxy/runway/v1/image_to_video', '/proxy/ludo/assets/sprite/pose']) {
      expect((await handleProxy(new Request(`https://api.insertplayer.ai${route}`, { method: 'POST', body: '{}' }), env, auth))?.status).toBe(403);
    }
  });
});
