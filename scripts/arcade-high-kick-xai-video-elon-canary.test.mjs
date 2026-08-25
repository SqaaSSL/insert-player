import { describe, expect, it } from 'vitest';
import {
  XAI_ELON_HIGH_KICK_VIDEO_CANONICAL,
  XAI_ELON_HIGH_KICK_VIDEO_CONFIRMATION,
  XAI_ELON_HIGH_KICK_VIDEO_EXPERIMENT_ID,
  XAI_ELON_HIGH_KICK_VIDEO_PLAYBACK,
  XAI_ELON_HIGH_KICK_VIDEO_SAMPLE_FPS,
  XAI_ELON_HIGH_KICK_VIDEO_UNIQUE_FRAMES,
  buildXaiElonHighKickVideoPayload,
  buildXaiElonHighKickVideoPlan,
  buildXaiElonHighKickVideoPrompt,
} from './arcade-high-kick-xai-video-elon-canary.mjs';

describe('XAI Elon dense-frame HIGH_KICK video canary', () => {
  it('is additive, right-facing, dense-frame, and exactly one pinned paid call', () => {
    const plan = buildXaiElonHighKickVideoPlan();
    expect(plan).toMatchObject({
      experimentId: XAI_ELON_HIGH_KICK_VIDEO_EXPERIMENT_ID,
      fighter: 'elon-musk',
      action: 'high_kick',
      canonical: XAI_ELON_HIGH_KICK_VIDEO_CANONICAL,
      extraction: {
        sampleFps: XAI_ELON_HIGH_KICK_VIDEO_SAMPLE_FPS,
        uniqueFrames: XAI_ELON_HIGH_KICK_VIDEO_UNIQUE_FRAMES,
        playback: XAI_ELON_HIGH_KICK_VIDEO_PLAYBACK,
      },
      policy: {
        expectedPaidCalls: 1,
        providerRetries: 0,
        fallback: 'none',
        activation: false,
        productionPointers: false,
      },
    });
    expect(XAI_ELON_HIGH_KICK_VIDEO_PLAYBACK).toHaveLength(23);
    expect(XAI_ELON_HIGH_KICK_VIDEO_PLAYBACK.slice(0, 12)).toEqual(
      Array.from({ length: 12 }, (_, index) => index),
    );
    expect(XAI_ELON_HIGH_KICK_VIDEO_PLAYBACK.at(-1)).toBe(0);
    expect(XAI_ELON_HIGH_KICK_VIDEO_CONFIRMATION).toBe(
      'ARCADE_HIGH_KICK_XAI_VIDEO_ELON_V1',
    );

    const prompt = buildXaiElonHighKickVideoPrompt();
    expect(prompt).toContain('LEFT-TO-RIGHT');
    expect(prompt).toContain('RIGHT EDGE OF THE IMAGE');
    expect(prompt).toContain('never turns toward the camera');
    expect(prompt).toContain('Never recenter or enlarge him');
    expect(prompt).toContain('hold that strongest impact pose through the final frame');

    const payload = buildXaiElonHighKickVideoPayload('a'.repeat(32));
    expect(payload).toMatchObject({
      prompt,
      model: 'grok-imagine-i2v-pinned',
      image: 'a'.repeat(32),
      resolution: '720p',
      params: { duration: 2, resolution: '720p' },
      enrich_prompt: false,
      publish: false,
      publish_name: 'ip-elon-musk-high-kick-xai-video-v1',
    });
    expect(JSON.stringify(payload)).not.toMatch(/allow_fallback|retry/i);
  });
});
