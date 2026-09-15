import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const plan = JSON.parse(readFileSync(resolve(root, 'provenance/aura-launch-v24-edit.json')));
const html = readFileSync(resolve(root, 'scripts/fixtures/v24-index.html'), 'utf8');
const labels = readFileSync(resolve(root, 'scripts/fixtures/v24-games.html'), 'utf8');
const hash = path => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
const tag = id => [...html.matchAll(/<(?:video|audio|div)\b[^>]*>/g)]
  .map(match => match[0]).find(value => value.includes(` id="${id}"`));
const attr = (element, name) => element.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
const decode = path => execFileSync('ffmpeg', ['-v', 'error', '-i', resolve(root, path), '-f', 's16le', '-c:a', 'pcm_s16le', '-'], { maxBuffer: 16 << 20 });

test('ten short shots alternate both performers and five distinct moves each', () => {
  assert.equal(plan.clips.length, 10);
  assert.equal(hash(plan.source), plan.sourceSha256);
  let end = 4.65;
  for (const [i, clip] of plan.clips.entries()) {
    assert.equal(clip.slot, i % 2);
    assert(clip.duration >= 1.6 && clip.duration <= 2);
    assert(Math.abs(clip.at - end) < 1e-6);
    assert(clip.uniquePoses >= 6 && clip.longestHoldSeconds <= 0.5);
    assert.equal(clip.restingFrames, 0);
    const element = tag(clip.id);
    assert.equal(attr(element, 'src'), plan.source);
    assert.equal(Number(attr(element, 'data-start')), clip.at);
    assert.equal(Number(attr(element, 'data-duration')), clip.duration);
    assert.equal(Number(attr(element, 'data-media-start')), clip.start);
    end = clip.at + clip.duration;
  }
  assert.equal(end, 23.15);
  for (const slot of [0, 1]) {
    assert.equal(new Set(plan.clips.filter(c => c.slot === slot).flatMap(c => c.animations)).size, 5);
  }
  for (const [i, a] of plan.clips.entries()) for (const b of plan.clips.slice(i + 1)) {
    assert(a.start + a.duration <= b.start || b.start + b.duration <= a.start, 'No source frame repeated');
  }
});

test('Fight and Rush are unchanged and lead straight into the five-second close', () => {
  assert.equal(hash(plan.optional.source), plan.optional.sha256);
  assert.equal(attr(tag('optional-games-video'), 'src'), plan.optional.source);
  assert.equal(Number(attr(tag('optional-games-video'), 'data-start')), 23.15);
  assert.equal(Number(attr(tag('optional-games-video'), 'data-duration')), 9);
  assert.doesNotMatch(html + labels, /aura-return|KEEP FARMING AURA/);
  assert.equal(Number(attr(tag('el-03-insert-player'), 'data-start')), 31.9);
  assert.equal(Number(attr(tag('el-03-insert-player'), 'data-duration')), 5);
  assert.equal(Number(attr(tag('root'), 'data-duration')), 36.9);
  assert.equal(plan.closing.at + plan.closing.duration, plan.duration);
  assert(Math.abs(plan.optional.at + plan.optional.duration - plan.closing.at - 0.25) < 1e-6);
  assert.equal(hash('compositions/frames/01-transform.html'), 'cee7b4a4914eb814a70e7bd716da5d118acbdac659305075ece7e4cdf6b5aa2f');
});

test('voice is sample-identical to approved sentences, without the Aura return', () => {
  assert.equal(hash(plan.voice.source), plan.voice.sourceSha256);
  assert.equal(hash(plan.voice.output), plan.voice.sha256);
  const original = decode(plan.voice.source);
  const edited = decode(plan.voice.output);
  const bytesPerSecond = 48000 * 2 * 2;
  const expected = Buffer.concat(plan.voice.ranges.map(([start, end]) =>
    original.subarray(Math.round(start * bytesPerSecond), Math.round(end * bytesPerSecond))));
  assert.deepEqual(edited, expected);
  assert.equal(edited.length, Math.round(plan.duration * bytesPerSecond));
  assert.equal(plan.voice.newInference, false);
  assert.equal(plan.voice.playbackRate, 1);
  assert.doesNotMatch(plan.captions.map(c => c.text).join(' '), /Then get back/);
  assert.equal(plan.captions.at(-1).text, 'Ready? Insert Player.');
  assert.equal(plan.captions.at(-1).start, 32.25);
  for (const seconds of [31.9, 35.15]) {
    const sample = original.subarray(Math.round((seconds - 0.01) * bytesPerSecond), Math.round((seconds + 0.01) * bytesPerSecond));
    for (let i = 0; i < sample.length; i += 2) assert(Math.abs(sample.readInt16LE(i)) < 100, 'Voice edits must land in silence');
  }
});

test('original music is continuous with only a short terminal fade', () => {
  assert.equal(hash(plan.music.source), '249bd37bd3e1497f2600edc51c3e51c88471f4b98a78c0362eae67557cc23fca');
  const bed = tag('launch-bed');
  assert.equal(attr(bed, 'src'), plan.music.source);
  assert.equal(Number(attr(bed, 'data-duration')), plan.duration);
  assert(!attr(bed, 'data-media-start') || Number(attr(bed, 'data-media-start')) === 0);
  assert(!/\bloop\b/.test(bed));
  const automation = JSON.parse(attr(bed, 'data-automation').replaceAll('&quot;', '"'));
  assert.deepEqual(automation.lanes.find(lane => lane.target === 'volume').points,
    [{ t: 0, v: 1 }, { t: 36.6, v: 1 }, { t: 36.9, v: 0 }]);
  const carve = JSON.parse(attr(bed, 'data-fx-carve').replaceAll('&quot;', '"'));
  assert.equal(carve.strength, 0.25);
  assert.equal(attr(tag('launch-voiceover'), 'data-volume'), '0.82');
});
