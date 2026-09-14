import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'provenance/identity-gameplay-v23-review.json')));
// v23 is preserved history; v24 intentionally changes its edit and voice timing.
const html = execFileSync('git', ['show', '718de2c:videos/insert-player-launch/index.html'], { encoding: 'utf8', cwd: root });
const approved = execFileSync('git', ['show', '1cc0ba6:videos/insert-player-launch/index.html'], { encoding: 'utf8', cwd: root });
const hash = path => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');

test('approved audio assets, mix markup, duration and intro remain unchanged', () => {
  assert.deepEqual(html.match(/<audio\b[^>]*>/g), approved.match(/<audio\b[^>]*>/g));
  for (const audio of [manifest.narration, manifest.music]) assert.equal(hash(audio.source), audio.sha256);
  assert.match(html, /data-duration="40.15"/);
  assert.equal(hash('compositions/frames/01-transform.html'), 'cee7b4a4914eb814a70e7bd716da5d118acbdac659305075ece7e4cdf6b5aa2f');
});

test('Aura remains first and dominant, with continuous scene timing', () => {
  assert.equal(manifest.primaryGame, 'aura');
  assert.equal(manifest.auraSeconds, 21.5);
  let end = 4.65;
  for (const section of manifest.sections) {
    assert(Math.abs(section.at - end) < 0.001);
    end += section.duration;
    assert.equal(hash(section.output), section.sha256);
    assert(html.includes(`src="${section.output}"`));
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', resolve(root, section.output)]));
    assert(probe.streams.every(stream => stream.codec_type === 'video'), 'No capture audio can replace approved narration');
    assert(Number(probe.streams[0].duration) >= section.duration - 0.001);
  }
  assert.equal(end, 35.4);
});

test('new Aura cuts show changing performer poses, not seven seconds of a static body', () => {
  for (const section of [manifest.sections[0], manifest.sections[2]]) for (const clip of section.clips) {
    assert(clip.movement.uniquePoses >= 6);
    assert(clip.movement.longestHeldPoseSeconds <= 0.5);
    assert(clip.movement.longestRestSeconds <= 0.3);
  }
});
