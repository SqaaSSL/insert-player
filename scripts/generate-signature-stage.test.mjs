import { describe, expect, it } from 'vitest';
import {
  backendAuthHeaders,
  parseGeminiStageImage,
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
  },
};

describe('signature stage production generator', () => {
  it('accepts only the sealed one-call Flash transform contract', () => {
    expect(validateStagePublicationRequest(structuredClone(validRequest))).toEqual(validRequest);
    expect(() => validateStagePublicationRequest({ ...validRequest, model: 'gemini-3-pro-image' }))
      .toThrow('Stage model must be gemini-3.1-flash-image');
    expect(() => validateStagePublicationRequest({ ...validRequest, sourceMode: 'inspire' }))
      .toThrow('Only transform-scene publication is allowed');
  });

  it('uses the established Clerk backend bridge for server-to-server requests', () => {
    expect(backendAuthHeaders('jwt', 'b'.repeat(32))).toEqual({
      Authorization: 'Bearer jwt',
      'X-Insert-Player-Admin-Seed': 'clerk-backend',
      'X-Insert-Player-Clerk-Backend-Auth': 'b'.repeat(32),
    });
    expect(() => backendAuthHeaders('jwt', 'short')).toThrow('bridge secret is invalid');
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
