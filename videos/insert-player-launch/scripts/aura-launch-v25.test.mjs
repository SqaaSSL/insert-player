import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const plan = JSON.parse(readFileSync(resolve(root, 'provenance/aura-launch-v25-edit.json')));
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const labels = readFileSync(resolve(root, 'compositions/frames/02-games.html'), 'utf8');
const hash = path => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
const tag = id => [...html.matchAll(/<(?:video|audio|div)\b[^>]*>/g)]
  .map(match => match[0]).find(value => value.includes(` id="${id}"`));
const attr = (element, name) => element.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
const decode = path => execFileSync('ffmpeg', ['-v', 'error', '-i', resolve(root, path), '-f', 's16le', '-c:a', 'pcm_s16le', '-'], { maxBuffer: 16 << 20 });

test('Aura is halved with five different moves, opening Six Seven and closing worm by Rosalia', () => {
  assert.equal(plan.auraSeconds, 9.3);
  assert(Math.abs(plan.auraSeconds - 18.5 / 2) < 0.1);
  assert.equal(plan.clips.length, 5);
  assert.equal(hash(plan.source), plan.sourceSha256);
  assert.equal(plan.clips[0].character, 'Rosalia');
  assert.deepEqual(plan.clips[0].animations, ['aura_six_seven']);
  assert.equal(plan.clips.at(-1).character, 'Rosalia');
  assert.deepEqual(plan.clips.at(-1).animations, ['aura_floor_worm']);
  assert.equal(new Set(plan.clips.flatMap(c => c.animations)).size, 5);
  let end = 4.65;
  for (const [i, clip] of plan.clips.entries()) {
    assert.equal(clip.slot, (i + 1) % 2);
    assert(Math.abs(clip.at - end) < 1e-6);
    assert(clip.uniquePoses >= 6 && clip.longestHoldSeconds <= 0.5);
    assert.equal(clip.restingFrames, 0);
    const element = tag(clip.id);
    assert.equal(attr(element, 'src'), plan.source);
    assert.equal(Number(attr(element, 'data-start')), clip.at);
    assert.equal(Number(attr(element, 'data-duration')), clip.duration);
    assert.equal(Number(attr(element, 'data-media-start')), clip.start);
    assert(!attr(element, 'data-playback-rate'));
    end = clip.at + clip.duration;
  }
  assert(Math.abs(end - 13.95) < 1e-6);
  assert.equal([...html.matchAll(/id="aura-cut-\d+"/g)].length, 5);
  for (const [i, a] of plan.clips.entries()) for (const b of plan.clips.slice(i + 1)) {
    assert(a.start + a.duration <= b.start || b.start + b.duration <= a.start);
  }
});

test('optional games and five-second closing are intact, only advanced 9.2 seconds', () => {
  assert.equal(hash(plan.optional.source), plan.optional.sha256);
  assert.equal(attr(tag('optional-games-video'), 'src'), plan.optional.source);
  assert.equal(Number(attr(tag('optional-games-video'), 'data-start')), 13.95);
  assert.equal(Number(attr(tag('optional-games-video'), 'data-duration')), 9);
  assert.equal(Number(attr(tag('el-02-games'), 'data-duration')), 18.3);
  assert.equal(Number(attr(tag('el-03-insert-player'), 'data-start')), 22.7);
  assert.equal(Number(attr(tag('el-03-insert-player'), 'data-duration')), 5);
  assert.equal(Number(attr(tag('root'), 'data-duration')), 27.7);
  assert.doesNotMatch(html + labels, /aura-return|KEEP FARMING AURA/);
  assert.match(labels, /data-start="9.5"/);
  assert.match(labels, /data-start="14.8"/);
  assert.equal(hash('compositions/frames/01-transform.html'), 'cee7b4a4914eb814a70e7bd716da5d118acbdac659305075ece7e4cdf6b5aa2f');
});

test('voice retains original samples and friends message, removes surplus Aura sentences', () => {
  assert.equal(hash(plan.voice.source), plan.voice.sourceSha256);
  assert.equal(hash(plan.voice.output), plan.voice.sha256);
  const original = decode(plan.voice.source);
  const edited = decode(plan.voice.output);
  const bytesPerSecond = 48000 * 2 * 2;
  const expected = Buffer.alloc(Math.round(plan.duration * bytesPerSecond));
  for (const range of plan.voice.ranges) {
    original.subarray(Math.round(range.start * bytesPerSecond), Math.round(range.end * bytesPerSecond))
      .copy(expected, Math.round(range.at * bytesPerSecond));
    for (const seconds of [range.start, range.end].filter(t => t > 0 && t < 40)) {
      const sample = original.subarray(Math.round((seconds - 0.01) * bytesPerSecond), Math.round((seconds + 0.01) * bytesPerSecond));
      for (let i = 0; i < sample.length; i += 2) assert(Math.abs(sample.readInt16LE(i)) < 100, 'Cut only in silence');
    }
  }
  assert.deepEqual(edited, expected);
  assert.equal(plan.voice.playbackRate, 1);
  assert.equal(plan.voice.newInference, false);
  assert.equal(attr(tag('launch-voiceover'), 'src'), plan.voice.output);
  assert.equal(Number(attr(tag('launch-voiceover'), 'data-duration')), plan.duration);
  const text = plan.captions.map(c => c.text).join(' ');
  assert.match(text, /Start farming Aura/);
  assert.match(text, /Challenge your friends/);
  assert.doesNotMatch(text, /Hit the beat|group chat|Then get back/);
  assert.equal(plan.captions.at(-1).start, 23.05);
  assert(plan.captions.every(c => c.end <= plan.duration));
});

test('music remains continuous, with approved gains and terminal fade at new ending', () => {
  assert.equal(hash(plan.music.source), '249bd37bd3e1497f2600edc51c3e51c88471f4b98a78c0362eae67557cc23fca');
  const bed = tag('launch-bed');
  assert.equal(attr(bed, 'src'), plan.music.source);
  assert.equal(Number(attr(bed, 'data-duration')), 27.7);
  assert(!attr(bed, 'data-media-start') || Number(attr(bed, 'data-media-start')) === 0);
  assert(!/\bloop\b/.test(bed));
  const automation = JSON.parse(attr(bed, 'data-automation').replaceAll('&quot;', '"'));
  assert.deepEqual(automation.lanes.find(lane => lane.target === 'volume').points,
    [{ t: 0, v: 1 }, { t: 27.4, v: 1 }, { t: 27.7, v: 0 }]);
  assert.equal(JSON.parse(attr(bed, 'data-fx-carve').replaceAll('&quot;', '"')).strength, 0.25);
  assert.equal(attr(tag('launch-voiceover'), 'data-volume'), '0.82');
});
