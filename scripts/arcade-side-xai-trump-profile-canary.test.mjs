import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  XAI_TRUMP_PROFILE_EXPERIMENT_ID,
  XAI_TRUMP_PROFILE_MAX_COST_USD,
  XAI_TRUMP_PROFILE_MODEL,
  buildXaiTrumpProfilePayload,
  buildXaiTrumpProfilePlan,
  buildXaiTrumpProfilePrompt,
  runXaiTrumpProfileCanary,
} from './arcade-side-xai-trump-profile-canary.mjs';

const manifest = JSON.parse(readFileSync(new URL('../arcade/roster-2026.json', import.meta.url), 'utf8'));

describe('XAI Trump strict-profile canary', () => {
  it('seals identity after pose and requires a vertical strict screen-right profile', () => {
    const plan = buildXaiTrumpProfilePlan(manifest);
    const prompt = buildXaiTrumpProfilePrompt();
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      slotKey: `${XAI_TRUMP_PROFILE_EXPERIMENT_ID}:grok-imagine-image-2-edit`,
      fighter: { slug: 'donald-trump' },
      model: {
        endpoint: 'xai/grok-imagine-image/v2.0/edit',
        params: { aspect_ratio: '3:4', resolution: '2k', num_images: 1 },
      },
    });
    expect(prompt).toContain('75–90 degree strict side profile facing the RIGHT EDGE');
    expect(prompt).toContain('far eye is absent or only a narrow sliver');
    expect(prompt).toContain('No beautification, rejuvenation, caricature');
    expect(prompt).toContain('1) Strict 75–90 degree screen-right profile');
    expect(prompt).not.toContain('eye spacing');
    expect(prompt).not.toContain('3/4 view facing right');

    const payload = buildXaiTrumpProfilePayload({
      ...plan[0],
      sourceAssetHash: 'a'.repeat(32),
      poseMasterAssetHash: 'b'.repeat(32),
      prompt,
    });
    expect(payload.image).toEqual(['b'.repeat(32), 'a'.repeat(32)]);
    expect(payload).toMatchObject({
      model: XAI_TRUMP_PROFILE_MODEL.id,
      enrich_prompt: false,
      publish: false,
      publish_name: 'ip-trump-side-profile-xai-v4',
      params: { aspect_ratio: '3:4', quality: 'medium' },
    });
    expect(JSON.stringify(payload)).not.toMatch(/fallback|retry/i);
  });

  it('blocks before catalog, uploads, or inference without the exact cost authorization', async () => {
    const fetchImpl = vi.fn();
    await expect(runXaiTrumpProfileCanary({
      apiKey: 'test-key',
      fetchImpl,
      maxCostUsd: XAI_TRUMP_PROFILE_MAX_COST_USD - 0.01,
    })).rejects.toThrow(/requires maxCostUsd=0\.12/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('blocks on model contract drift before uploads or inference', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ models: [{
      id: XAI_TRUMP_PROFILE_MODEL.id,
      provider: 'xai',
      backend: 'fal',
      cost_per_image: 70000,
      advanced_mode: false,
      capabilities: ['edit', 'image-to-image'],
    }] }), { status: 200 }));
    await expect(runXaiTrumpProfileCanary({
      apiKey: 'test-key',
      apiBase: 'https://pixcli.example',
      fetchImpl,
      maxCostUsd: XAI_TRUMP_PROFILE_MAX_COST_USD,
    })).rejects.toThrow(/contract changed/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('blocks a price drift before uploads or inference', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ models: [{
      id: XAI_TRUMP_PROFILE_MODEL.id,
      provider: 'xai',
      backend: 'fal',
      cost_per_image: 70001,
      advanced_mode: true,
      capabilities: ['edit', 'image-to-image'],
    }] }), { status: 200 }));
    await expect(runXaiTrumpProfileCanary({
      apiKey: 'test-key',
      apiBase: 'https://pixcli.example',
      fetchImpl,
      maxCostUsd: XAI_TRUMP_PROFILE_MAX_COST_USD,
    })).rejects.toThrow(/contract changed/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
