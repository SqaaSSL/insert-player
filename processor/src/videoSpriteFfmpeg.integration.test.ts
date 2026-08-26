import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { compileVideoSprite } from './videoSpriteCompiler.ts';
import { runMediaCommand } from './videoSpriteMedia.ts';

async function greenFrame(extension: number): Promise<Buffer> {
  const canvas = createCanvas(192, 256);
  const context = canvas.getContext('2d');
  context.fillStyle = '#00ff00';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#b85c39';
  context.fillRect(62, 46, 58, 166);
  context.fillRect(120, 108, extension, 18);
  return canvas.encode('png');
}

test('runs the real bounded FFmpeg adapter end to end', {
  skip: process.env.VIDEO_SPRITE_TEST_FFMPEG !== '1',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'insert-player-video-sprite-integration-'));
  try {
    const framesDir = join(root, 'frames');
    await mkdir(framesDir);
    for (let index = 0; index < 24; index += 1) {
      const name = `frame-${String(index + 1).padStart(4, '0')}.png`;
      await writeFile(join(framesDir, name), await greenFrame(Math.min(52, Math.floor(index / 2) * 5)));
    }
    const canonical = await greenFrame(0);
    const videoPath = join(root, 'fixture.mp4');
    await runMediaCommand('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-threads', '1', '-filter_threads', '1',
      '-framerate', '24', '-i', join(framesDir, 'frame-%04d.png'),
      '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      videoPath,
    ]);
    const video = await readFile(videoPath);
    const result = await compileVideoSprite({
      schemaVersion: 1,
      action: 'high_punch',
      expectedFacing: 'right',
      videoBase64: video.toString('base64'),
      canonicalFrameBase64: canonical.toString('base64'),
    });
    assert.equal(result.frameCount, 11);
    assert.equal(result.animationFormat, 'video-dense-v1');
    assert.match(result.report.reportSha256, /^[a-f0-9]{64}$/);
    assert.notEqual(result.report.decision.outcome, 'reject');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
