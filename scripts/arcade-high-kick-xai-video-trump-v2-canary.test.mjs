import { describe, expect, it } from 'vitest';
import { XAI_HIGH_KICK_VIDEO_MODEL } from './arcade-high-kick-xai-video-canary.mjs';
import {
  XAI_TRUMP_HIGH_KICK_VIDEO_CANONICAL,
  XAI_TRUMP_HIGH_KICK_VIDEO_CONFIRMATION,
  XAI_TRUMP_HIGH_KICK_VIDEO_EXPERIMENT_ID,
  XAI_TRUMP_HIGH_KICK_VIDEO_PATHS,
  XAI_TRUMP_HIGH_KICK_VIDEO_PLAYBACK,
  XAI_TRUMP_HIGH_KICK_VIDEO_PUBLISH_NAME,
  XAI_TRUMP_HIGH_KICK_VIDEO_SAMPLE_FPS,
  XAI_TRUMP_HIGH_KICK_VIDEO_UNIQUE_FRAMES,
  buildXaiTrumpHighKickVideoPayload,
  buildXaiTrumpHighKickVideoPlan,
  buildXaiTrumpHighKickVideoPrompt,
} from './arcade-high-kick-xai-video-trump-v2-canary.mjs';

describe('XAI Trump V4 dense-frame HIGH_KICK video canary', () => {
  it('pins the approved V4 canonical and isolates every V2 run namespace', () => {
    expect(XAI_TRUMP_HIGH_KICK_VIDEO_EXPERIMENT_ID).toBe(
      'arcade-high-kick-xai-video-trump-v2',
    );
    expect(XAI_TRUMP_HIGH_KICK_VIDEO_CONFIRMATION).toBe(
      'ARCADE_HIGH_KICK_XAI_VIDEO_TRUMP_V2',
    );
    expect(XAI_TRUMP_HIGH_KICK_VIDEO_PUBLISH_NAME).toBe(
      'ip-trump-high-kick-xai-video-v2',
    );
    expect(XAI_TRUMP_HIGH_KICK_VIDEO_CANONICAL).toEqual({
      id: 'xai-trump-side-profile-v4',
      slug: 'canonical-trump-xai-side-profile-v4',
      contentSha256: 'fb0ab93907e853cf7cfe00378d10a612d3271a2d98f6f04ad15fda9acacd85bd',
    });
    expect(XAI_TRUMP_HIGH_KICK_VIDEO_PATHS.canonical).toMatch(
      /arcade-side-xai-trump-profile-v4\/donald-trump--grok-imagine-image-2-edit--image\.png$/,
    );
    expect(XAI_TRUMP_HIGH_KICK_VIDEO_PATHS.canonicalUploadState).toMatch(
      /trump-profile-v4-video-v2-canonical-upload-state\.json$/,
    );
    expect(XAI_TRUMP_HIGH_KICK_VIDEO_PATHS.outputDir).toMatch(
      /arcade-high-kick-xai-video-trump-v2-canary$/,
    );
    expect(XAI_TRUMP_HIGH_KICK_VIDEO_PATHS.state).toMatch(
      /arcade-high-kick-xai-video-trump-v2-canary-state\.json$/,
    );
    expect(new Set(Object.values(XAI_TRUMP_HIGH_KICK_VIDEO_PATHS)).size).toBe(4);
  });

  it('keeps one pinned 2s/720p call and produces 12 forward poses plus 23 playback frames', () => {
    const plan = buildXaiTrumpHighKickVideoPlan();
    expect(plan).toMatchObject({
      experimentId: XAI_TRUMP_HIGH_KICK_VIDEO_EXPERIMENT_ID,
      fighter: 'donald-trump',
      action: 'high_kick',
      canonical: XAI_TRUMP_HIGH_KICK_VIDEO_CANONICAL,
      model: XAI_HIGH_KICK_VIDEO_MODEL,
      extraction: {
        sampleFps: XAI_TRUMP_HIGH_KICK_VIDEO_SAMPLE_FPS,
        uniqueFrames: XAI_TRUMP_HIGH_KICK_VIDEO_UNIQUE_FRAMES,
        playback: XAI_TRUMP_HIGH_KICK_VIDEO_PLAYBACK,
      },
      policy: {
        expectedPaidCalls: 1,
        providerRetries: 0,
        fallback: 'none',
        promptEnrichment: false,
        activation: false,
        productionPointers: false,
      },
    });
    expect(plan.model).toMatchObject({
      id: 'grok-imagine-i2v-pinned',
      endpoint: 'xai/grok-imagine-video/v1.5/image-to-video',
      durationSeconds: 2,
      resolution: '720p',
    });
    expect(XAI_TRUMP_HIGH_KICK_VIDEO_PLAYBACK).toHaveLength(23);
    expect(XAI_TRUMP_HIGH_KICK_VIDEO_PLAYBACK.slice(0, 12)).toEqual(
      Array.from({ length: 12 }, (_, index) => index),
    );
    expect(XAI_TRUMP_HIGH_KICK_VIDEO_PLAYBACK.slice(12)).toEqual(
      [10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
    );
  });

  it('hard-locks accepted facing, attack direction, root, guard, peak timing, and camera', () => {
    const prompt = buildXaiTrumpHighKickVideoPrompt();
    expect(prompt).toContain('LEFT-TO-RIGHT');
    expect(prompt).toContain('RIGHT EDGE OF THE IMAGE');
    expect(prompt).toContain('currently accepted right-facing head-and-body orientation');
    expect(prompt).toContain('Do not correct, square, reinterpret, or reverse this orientation');
    expect(prompt).toContain('NO YAW — HARD CONSTRAINT');
    expect(prompt).toContain('exact same lower-left position');
    expect(prompt).toContain('NO ROOT DRIFT — HARD CONSTRAINT');
    expect(prompt).toContain('support foot planted on one fixed floor point');
    expect(prompt).toContain('near 1.7 seconds');
    expect(prompt).toContain('hold that peak pose through the final frame');
    expect(prompt).toContain('Both hands remain in the same compact fighting guard throughout');
    expect(prompt).toContain('FIXED CAMERA — HARD CONSTRAINT');
    expect(prompt).toContain('No crop, zoom, pan, tilt, roll, reframe');
  });

  it('keeps the PixCLI payload explicit, non-publishing, and fallback-free', () => {
    const assetHash = 'a'.repeat(32);
    const prompt = buildXaiTrumpHighKickVideoPrompt();
    const payload = buildXaiTrumpHighKickVideoPayload(assetHash);
    expect(payload).toEqual({
      prompt,
      model: 'grok-imagine-i2v-pinned',
      image: assetHash,
      resolution: '720p',
      params: { duration: 2, resolution: '720p' },
      enrich_prompt: false,
      output_format: 'url',
      publish: false,
      publish_name: XAI_TRUMP_HIGH_KICK_VIDEO_PUBLISH_NAME,
    });
    expect(JSON.stringify(payload)).not.toMatch(/allow_fallback|retry/i);
  });
});
