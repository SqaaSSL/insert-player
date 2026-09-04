import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { processorErrorResponse } from './providerErrorResponse.ts';
import { compileVideoSprite } from './videoSpriteCompiler.ts';
import { VIDEO_SPRITE_PROCESSING_VERSION } from './videoSpriteContract.ts';
import {
  VideoSpriteCompileError,
  parseVideoSpriteCompileRequest,
  type VideoSpriteCompileRequest,
} from './videoSpriteContract.ts';
import { parseVideoSpriteProbe, type VideoSpriteMediaAdapter } from './videoSpriteMedia.ts';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function framePng(armExtension: number, y = 46): Promise<Buffer> {
  const canvas = createCanvas(192, 256);
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#b85c39';
  context.fillRect(62, y, 58, 166);
  context.fillRect(120, y + 62, armExtension, 18);
  return canvas.encode('png');
}

async function archivalPng(bytes: Buffer): Promise<Buffer> {
  const image = await loadImage(bytes);
  const canvas = createCanvas(768, 1024);
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.encode('png');
}

function mp4Fixture(): Buffer {
  return Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from('ftypisom'),
    Buffer.from('synthetic-mp4-fixture'),
  ]);
}

async function syntheticAdapter(videoSize: number): Promise<VideoSpriteMediaAdapter> {
  const canonicalPng = await framePng(0);
  const videoFramePngs = await Promise.all(Array.from({ length: 24 }, (_, index) => (
    framePng(Math.min(52, Math.floor(index / 2) * 5))
  )));
  const archivalCanonicalPng = await archivalPng(canonicalPng);
  return {
    async extract() {
      return {
        probe: {
          codecName: 'h264',
          pixelFormat: 'yuv420p',
          width: 816,
          height: 1104,
          sourceFps: 24,
          durationMs: 1000,
          declaredFrameCount: 24,
          sizeBytes: videoSize,
        },
        toolchain: {
          ffmpegVersion: 'ffmpeg synthetic-fixture',
          ffprobeVersion: 'ffprobe synthetic-fixture',
          sampleFps: 24,
          normalizeFilter: 'synthetic-fixture-filter',
        },
        canonicalPng,
        videoFramePngs,
        async extractArchival(selectedVideoIndices) {
          return {
            canonicalPng: archivalCanonicalPng,
            selectedVideoFramePngs: await Promise.all(
              selectedVideoIndices.map((index) => archivalPng(videoFramePngs[index])),
            ),
          };
        },
      };
    },
  };
}

function request(video: Buffer, canonical: Buffer): VideoSpriteCompileRequest {
  return {
    schemaVersion: 1,
    action: 'high_punch',
    expectedFacing: 'right',
    videoBase64: video.toString('base64'),
    canonicalFrameBase64: canonical.toString('base64'),
    lineage: {
      jobId: 'job-fixture-1',
      provider: 'fal',
      modelId: 'grok-imagine-i2v-pinned',
      providerRequestId: 'provider-fixture-1',
      videoSha256: sha256(video),
      canonicalSha256: sha256(canonical),
      promptSha256: 'a'.repeat(64),
    },
  };
}

test('compiles an extracted video into a reproducible dense sheet and hash-bound report', async () => {
  const video = mp4Fixture();
  const canonical = Buffer.from('synthetic canonical input');
  const mediaAdapter = await syntheticAdapter(video.byteLength);
  const body = request(video, canonical);
  const first = await compileVideoSprite(body, { mediaAdapter });
  const second = await compileVideoSprite(body, { mediaAdapter });
  assert.equal(first.animationFormat, 'video-dense-v1');
  assert.equal(first.processingVersion, VIDEO_SPRITE_PROCESSING_VERSION);
  assert.equal(first.frameW, 192);
  assert.equal(first.frameH, 256);
  assert.equal(first.frameCount, 11);
  assert.equal(first.rawFrameW, 768);
  assert.equal(first.rawFrameH, 1024);
  assert.equal(first.rawFrameCount, 6);
  assert.equal(first.spriteBase64, second.spriteBase64);
  assert.equal(first.report.reportSha256, second.report.reportSha256);
  assert.deepEqual(first.report, second.report);

  const sprite = await loadImage(Buffer.from(first.spriteBase64, 'base64'));
  assert.equal(sprite.width, 1536);
  assert.equal(sprite.height, 512);
  const raw = await loadImage(Buffer.from(first.rawBase64, 'base64'));
  assert.equal(raw.width, 3072);
  assert.equal(raw.height, 2048);
  assert.equal((first.report.artifacts as {
    rawUniqueFramesSheet: { sha256: string; width: number; height: number };
  }).rawUniqueFramesSheet.sha256, sha256(Buffer.from(first.rawBase64, 'base64')));
  const decision = first.report.decision as { outcome: string; semanticPromotionApproved: boolean };
  assert.ok(['technical_pass', 'needs_review', 'reject'].includes(decision.outcome));
  assert.equal(decision.semanticPromotionApproved, false);
  assert.deepEqual(first.report.manualReviewLimitations, [
    'identity_equivalence',
    'anatomy_and_limb_correctness',
    'action_semantics',
    'absolute_facing_requires_approved_canonical',
    'legal_or_likeness_clearance',
  ]);
});

test('records and applies the guided temporal selector without changing the compile schema', async () => {
  const video = mp4Fixture();
  const canonical = Buffer.from('synthetic canonical input');
  const mediaAdapter = await syntheticAdapter(video.byteLength);
  const compiled = await compileVideoSprite({
    ...request(video, canonical),
    automaticSelectionPolicy: 'action-profile-temporal-anchors-v1',
  }, { mediaAdapter });
  const extraction = compiled.report.extraction as {
    selectionAlgorithm: string;
    selectedVideoIndices: number[];
  };
  assert.equal(compiled.schemaVersion, 1);
  assert.equal(extraction.selectionAlgorithm, 'action-profile-temporal-anchors-v1');
  assert.deepEqual(extraction.selectedVideoIndices, [5, 9, 14, 18, 23]);
});

test('rejects stale lineage hashes before invoking media tools', async () => {
  const video = mp4Fixture();
  const canonical = Buffer.from('synthetic canonical input');
  let invoked = false;
  const mediaAdapter: VideoSpriteMediaAdapter = {
    async extract() {
      invoked = true;
      throw new Error('must not run');
    },
  };
  const body = request(video, canonical);
  body.lineage = { ...body.lineage, videoSha256: '0'.repeat(64) };
  await assert.rejects(
    compileVideoSprite(body, { mediaAdapter }),
    (error: unknown) => error instanceof VideoSpriteCompileError && error.code === 'video_hash_mismatch',
  );
  assert.equal(invoked, false);
});

test('validates the bounded request and maps compiler failures to stable API responses', () => {
  assert.throws(
    () => parseVideoSpriteCompileRequest({
      schemaVersion: 1,
      action: 'high_kick',
      expectedFacing: 'up',
      videoBase64: 'AAAA',
      canonicalFrameBase64: 'AAAA',
    }),
    (error: unknown) => error instanceof VideoSpriteCompileError && error.code === 'invalid_facing',
  );
  assert.deepEqual(
    processorErrorResponse(new VideoSpriteCompileError('unsupported_video', 'bad video', 422)),
    { status: 422, body: { error: 'bad video', code: 'unsupported_video' } },
  );
  assert.throws(
    () => parseVideoSpriteCompileRequest({
      ...request(mp4Fixture(), Buffer.from('canonical')),
      automaticSelectionPolicy: 'model-decides',
    }),
    (error: unknown) => error instanceof VideoSpriteCompileError &&
      error.code === 'invalid_automatic_selection_policy',
  );
});

test('parses the pinned ffprobe shape and rejects oversized decode workloads', () => {
  const valid = {
    streams: [{
      codec_name: 'h264', pix_fmt: 'yuv420p', width: 816, height: 1104,
      r_frame_rate: '24/1', avg_frame_rate: '24/1', nb_frames: '49',
    }],
    format: { duration: '2.041667', size: '689506' },
  };
  assert.deepEqual(parseVideoSpriteProbe(valid, 689506), {
    codecName: 'h264',
    pixelFormat: 'yuv420p',
    width: 816,
    height: 1104,
    sourceFps: 24,
    durationMs: 2042,
    declaredFrameCount: 49,
    sizeBytes: 689506,
  });
  assert.throws(
    () => parseVideoSpriteProbe({
      ...valid,
      format: { duration: '8', size: '689506' },
    }, 689506),
    (error: unknown) => error instanceof VideoSpriteCompileError && error.code === 'too_many_decoded_frames',
  );
});
