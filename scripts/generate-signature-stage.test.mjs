import { describe, expect, it } from 'vitest';
import {
  backendAuthHeaders,
  buildPanelCleanupFilter,
  parseGeminiStageImage,
  validateFfmpegVersionOutput,
  validateStagePublicationRequest,
} from './generate-signature-stage.mjs';

const validRequest = {
  schemaVersion: 1,
  id: 'insert-player-arena',
  label: 'INSERT PLAYER ARENA',
  blurb: 'Red corner, blue corner, and main-event lights.',
  legalVersion: '2026-08-23.1',
  sourceMode: 'transform-scene',
  model: 'gemini-3.1-flash-image',
  seed: {
    path: 'arcade/stage-publication-seeds/insert-player-arena-seed-v1.png',
    mime: 'image/png',
    sha256: 'a'.repeat(64),
  },
  output: {
    baseName: 'insert-player-arena-pipeline-v1',
    format: 'png',
    width: 1024,
    height: 576,
    normalization: { bottomShadeAlpha: 0.04, verticalBias: 0.92 },
    cleanup: {
      method: 'interpolate-empty-panels-v1',
      regions: [
        { x: 184, y: 177, width: 184, height: 50 },
        { x: 668, y: 177, width: 170, height: 50 },
      ],
    },
  },
};

describe('signature stage production generator', () => {
  it('accepts only the sealed one-call Flash transform contract', () => {
    expect(validateStagePublicationRequest(structuredClone(validRequest))).toEqual(validRequest);
    expect(() => validateStagePublicationRequest({ ...validRequest, model: 'gemini-3-pro-image' }))
      .toThrow('Stage model must be gemini-3.1-flash-image');
    expect(() => validateStagePublicationRequest({ ...validRequest, sourceMode: 'inspire' }))
      .toThrow('Only transform-scene publication is allowed');
    expect(() => validateStagePublicationRequest({
      ...validRequest,
      output: {
        ...validRequest.output,
        cleanup: {
          method: 'interpolate-empty-panels-v1',
          regions: [{ x: 1000, y: 0, width: 40, height: 20 }],
        },
      },
    })).toThrow('cleanup region exceeds output width');
  });

  it('uses the established Clerk backend bridge for server-to-server requests', () => {
    expect(backendAuthHeaders('jwt', 'b'.repeat(32))).toEqual({
      Authorization: 'Bearer jwt',
      'X-Insert-Player-Admin-Seed': 'clerk-backend',
      'X-Insert-Player-Clerk-Backend-Auth': 'b'.repeat(32),
    });
    expect(() => backendAuthHeaders('jwt', 'short')).toThrow('bridge secret is invalid');
  });

  it('fails before generation when the deterministic encoder is unavailable', () => {
    expect(validateFfmpegVersionOutput('ffmpeg version 7.1 Copyright')).toBe('ffmpeg version 7.1 Copyright');
    expect(() => validateFfmpegVersionOutput('command not found')).toThrow('ffmpeg runtime is unavailable');
  });

  it('builds a bounded deterministic empty-panel cleanup filter', () => {
    expect(buildPanelCleanupFilter(validRequest.output.cleanup.regions)).toBe(
      '[0:v]split=5[base][top0][bottom0][top1][bottom1];'
      + '[top0]crop=184:1:184:177[topCrop0];'
      + '[bottom0]crop=184:1:184:226[bottomCrop0];'
      + '[topCrop0][bottomCrop0]vstack=inputs=2,scale=184:50:flags=bilinear,gblur=sigma=1.5[patch0];'
      + '[top1]crop=170:1:668:177[topCrop1];'
      + '[bottom1]crop=170:1:668:226[bottomCrop1];'
      + '[topCrop1][bottomCrop1]vstack=inputs=2,scale=170:50:flags=bilinear,gblur=sigma=1.5[patch1];'
      + '[base][patch0]overlay=184:177[clean0];'
      + '[clean0][patch1]overlay=668:177[out]',
    );
    expect(buildPanelCleanupFilter([])).toBeNull();
  });

  it('accepts exactly one supported image from Gemini', () => {
    const parsed = parseGeminiStageImage({
      candidates: [{
        finishReason: 'STOP',
        content: { parts: [{ text: 'done' }, { inlineData: { mimeType: 'image/png', data: 'c3RhZ2U=' } }] },
      }],
    });
    expect(parsed).toMatchObject({ mime: 'image/png', finishReason: 'STOP' });
    expect(parsed.bytes.toString()).toBe('stage');
  });

  it('fails closed on zero, duplicate, or unsupported image outputs', () => {
    expect(() => parseGeminiStageImage({ candidates: [{ content: { parts: [{ text: 'none' }] } }] }))
      .toThrow('exactly one is required');
    expect(() => parseGeminiStageImage({
      candidates: [{ content: { parts: [
        { inlineData: { mimeType: 'image/png', data: 'YQ==' } },
        { inlineData: { mimeType: 'image/png', data: 'Yg==' } },
      ] } }],
    })).toThrow('exactly one is required');
    expect(() => parseGeminiStageImage({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/svg+xml', data: 'YQ==' } }] } }],
    })).toThrow('Unsupported Gemini image MIME');
  });
});
