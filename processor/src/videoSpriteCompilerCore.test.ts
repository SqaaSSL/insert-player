import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  buildVideoSpritePlayback,
  compileVideoSpriteFrames,
  measureVideoSpriteFrame,
  mirrorVideoSpriteFrame,
  type VideoSpriteRgbaFrame,
} from './videoSpriteCompilerCore.ts';
import type { VideoSpriteAction, VideoSpriteDecision } from './videoSpriteContract.ts';

interface GoldenCase {
  id: string;
  action: VideoSpriteAction;
  frameCount: number;
  motion: 'static' | 'arm-extension' | 'blank';
  expectedSelectedIndices: number[];
  expectedDecision: VideoSpriteDecision;
}

interface GoldenManifest {
  schemaVersion: number;
  frame: { width: number; height: number };
  cases: GoldenCase[];
}

function drawSubject(
  width: number,
  height: number,
  options: { armExtension?: number; x?: number; y?: number; blank?: boolean; detachedPixels?: number } = {},
): VideoSpriteRgbaFrame {
  const data = new Uint8ClampedArray(width * height * 4);
  if (!options.blank) {
    const x = options.x ?? 11;
    const y = options.y ?? 8;
    const color = [184, 92, 57, 255];
    const paint = (px: number, py: number) => {
      if (px < 0 || py < 0 || px >= width || py >= height) return;
      const offset = (py * width + px) * 4;
      data.set(color, offset);
    };
    for (let py = y; py < y + 30; py += 1) {
      for (let px = x; px < x + 9; px += 1) paint(px, py);
    }
    for (let py = y + 11; py < y + 14; py += 1) {
      for (let px = x + 9; px < x + 9 + (options.armExtension ?? 0); px += 1) paint(px, py);
    }
    for (let pixel = 0; pixel < (options.detachedPixels ?? 0); pixel += 1) {
      paint(2 + (pixel % 5), 16 + Math.floor(pixel / 5));
    }
  }
  return { width, height, data, sourceIndex: null };
}

function fixtureFrames(manifest: GoldenManifest, fixture: GoldenCase): {
  canonical: VideoSpriteRgbaFrame;
  frames: VideoSpriteRgbaFrame[];
} {
  const { width, height } = manifest.frame;
  const canonical = drawSubject(width, height, { blank: fixture.motion === 'blank' });
  const frames = Array.from({ length: fixture.frameCount }, (_, sourceIndex) => {
    const armExtension = fixture.motion === 'arm-extension' ? Math.min(10, Math.floor(sourceIndex / 2)) : 0;
    return {
      ...drawSubject(width, height, {
        armExtension,
        blank: fixture.motion === 'blank',
      }),
      sourceIndex,
    };
  });
  return { canonical, frames };
}

async function loadGoldens(): Promise<GoldenManifest> {
  const path = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../test-fixtures/video-sprite/gold-cases.json',
  );
  return JSON.parse(await readFile(path, 'utf8')) as GoldenManifest;
}

test('builds the exact dense physical playback contracts', () => {
  assert.deepEqual(buildVideoSpritePlayback(8, 'loop'), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(buildVideoSpritePlayback(4, 'timeline-hold'), [0, 1, 2, 3]);
  assert.deepEqual(buildVideoSpritePlayback(6, 'forward-ping-pong'), [
    0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 0,
  ]);
});

test('matches the committed deterministic selection and decision goldens', async () => {
  const manifest = await loadGoldens();
  assert.equal(manifest.schemaVersion, 1);
  for (const fixture of manifest.cases) {
    const { canonical, frames } = fixtureFrames(manifest, fixture);
    const first = compileVideoSpriteFrames(fixture.action, canonical, frames);
    const second = compileVideoSpriteFrames(fixture.action, canonical, frames);
    assert.deepEqual(first.selectedVideoIndices, fixture.expectedSelectedIndices, fixture.id);
    assert.equal(first.decision, fixture.expectedDecision, fixture.id);
    assert.deepEqual(second.selectedVideoIndices, first.selectedVideoIndices, fixture.id);
    assert.deepEqual(
      second.uniqueFrames.map((frame) => measureVideoSpriteFrame(frame).pixelSha256),
      first.uniqueFrames.map((frame) => measureVideoSpriteFrame(frame).pixelSha256),
      fixture.id,
    );
  }
});

test('uses video raws only for loops and reserves canonical F0 for non-loop actions', () => {
  const width = 32;
  const height = 48;
  const canonical = drawSubject(width, height);
  const frames = Array.from({ length: 24 }, (_, sourceIndex) => ({
    ...drawSubject(width, height, { armExtension: Math.min(8, Math.floor(sourceIndex / 3)) }),
    sourceIndex,
  }));
  const loop = compileVideoSpriteFrames('idle', canonical, frames);
  const attack = compileVideoSpriteFrames('high_punch', canonical, frames);
  assert.equal(loop.uniqueFrames.length, 8);
  assert.ok(loop.uniqueFrames.every((frame) => frame.sourceIndex !== null));
  assert.equal(loop.uniqueFrames[0].sourceIndex, loop.selectedVideoIndices[0]);
  assert.equal(attack.uniqueFrames.length, 6);
  assert.equal(attack.uniqueFrames[0].sourceIndex, null);
  assert.deepEqual(
    attack.uniqueFrames.slice(1).map((frame) => frame.sourceIndex),
    attack.selectedVideoIndices,
  );
});

test('root-registers vertical video motion with bounded integer translations', () => {
  const width = 32;
  const height = 48;
  const canonical = drawSubject(width, height);
  const frames = Array.from({ length: 24 }, (_, sourceIndex) => ({
    ...drawSubject(width, height, { y: 8 - Math.round(Math.sin(sourceIndex / 23 * Math.PI) * 7) }),
    sourceIndex,
  }));
  const compiled = compileVideoSpriteFrames('jump', canonical, frames);
  assert.ok(compiled.translations.some(({ dy }) => dy >= 6));
  const registeredRoots = compiled.selectedMetrics.map((metric) => metric.root?.y);
  assert.equal(new Set(registeredRoots).size, 1);
  assert.notEqual(compiled.decision, 'reject');
});

test('routes disconnected foreground to review and edge-cropped foreground to reject', () => {
  const width = 32;
  const height = 48;
  const canonical = drawSubject(width, height);
  const detached = Array.from({ length: 24 }, (_, sourceIndex) => ({
    ...drawSubject(width, height, { armExtension: Math.min(8, Math.floor(sourceIndex / 3)), detachedPixels: 42 }),
    sourceIndex,
  }));
  const review = compileVideoSpriteFrames('high_punch', canonical, detached);
  assert.equal(review.decision, 'needs_review');
  assert.ok(review.reasonCodes.includes('foreground_cohesion_review'));

  const croppedCanonical = drawSubject(width, height, { x: 0 });
  const cropped = compileVideoSpriteFrames('idle', croppedCanonical, Array.from({ length: 24 }, (_, sourceIndex) => ({
    ...drawSubject(width, height, { x: 0 }),
    sourceIndex,
  })));
  assert.equal(cropped.decision, 'reject');
  assert.ok(cropped.reasonCodes.includes('subject_not_cropped'));
});

test('downgrades a horizontal flip relative to the approved canonical', () => {
  const width = 32;
  const height = 48;
  const canonical = drawSubject(width, height, { armExtension: 9 });
  const frames = Array.from({ length: 24 }, (_, sourceIndex) => ({
    ...mirrorVideoSpriteFrame(canonical),
    sourceIndex,
  }));
  const compiled = compileVideoSpriteFrames('idle', canonical, frames);
  assert.equal(compiled.decision, 'needs_review', JSON.stringify(compiled.sequenceMetrics));
  assert.ok(compiled.reasonCodes.includes('facing_consistency_to_canonical'));
  assert.ok(compiled.sequenceMetrics.medianFacingConsistencyScore < 0);
});
