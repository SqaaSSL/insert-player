import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const path = resolve(root, '../../public/assets/insert-player-launch-aura-v25.mp4');
const plan = JSON.parse(readFileSync(resolve(root, 'provenance/aura-launch-v25-edit.json')));
const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path]));
const video = probe.streams.find(s => s.codec_type === 'video');
const audio = probe.streams.find(s => s.codec_type === 'audio');
assert.equal(video.width, 1920);
assert.equal(video.height, 1080);
assert.equal(video.r_frame_rate, '30/1');
assert.equal(audio.codec_name, 'aac');
assert(Math.abs(Number(probe.format.duration) - plan.duration) < 0.04);
assert(Number(probe.format.size) < 12 * 1024 * 1024);
const ffmpeg = args => {
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 8 << 20 });
  assert.equal(r.status, 0, r.stderr);
  return r;
};
const loudness = ffmpeg(['-hide_banner', '-i', path, '-af', 'loudnorm=print_format=json', '-f', 'null', '-']);
const levels = JSON.parse(loudness.stderr.match(/\{\s*"input_i"[\s\S]*?\}/)[0]);
assert(Number(levels.input_tp) < 0, 'No clipped mix');
const windows = [5, 8, 11, 14, 17, 20, 23, 25, 26.3].map(at => {
  const r = ffmpeg(['-hide_banner', '-ss', String(at), '-t', '1', '-i', path, '-af', 'volumedetect', '-f', 'null', '-']);
  const rmsDb = Number(r.stderr.match(/mean_volume: ([\d.-]+) dB/)[1]);
  const peakDb = Number(r.stderr.match(/max_volume: ([\d.-]+) dB/)[1]);
  const bed = ffmpeg(['-hide_banner', '-ss', String(at), '-t', '1', '-i', resolve(root, plan.music.source),
    '-af', 'volumedetect', '-f', 'null', '-']);
  const sourceBedRmsDb = Number(bed.stderr.match(/mean_volume: ([\d.-]+) dB/)[1]);
  // The approved intro handoff is quiet already; compare against that source,
  // allowing the existing 6dB carve plus 2dB for spectral shaping.
  assert(rmsDb > -50 && rmsDb >= sourceBedRmsDb - 8 && peakDb < 0, `Dropout or clipping at ${at}s`);
  return { at, rmsDb, peakDb, sourceBedRmsDb };
});
const decodedAudio = input => execFileSync('ffmpeg', ['-v', 'error', '-i', input, '-vn', '-f', 's16le', '-'], { maxBuffer: 16 << 20 });
assert.deepEqual(decodedAudio(path), decodedAudio(resolve(root, 'renders/insert-player-launch-aura-v25-delivery.mp4')),
  'Web optimization must preserve the rendered audio exactly');
const motion = plan.clips.map(clip => {
  const r = ffmpeg(['-v', 'error', '-ss', String(clip.at + 0.35), '-t', String(clip.duration - 0.4), '-i', path,
    '-vf', 'crop=740:700:40:280,scale=185:175', '-an', '-f', 'framemd5', '-']);
  const hashes = r.stdout.split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split(',').at(-1).trim());
  assert(new Set(hashes).size >= 6, `${clip.id}: frozen character region`);
  return { id: clip.id, character: clip.character, animations: clip.animations, decodedFrames: hashes.length, distinctCharacterFrames: new Set(hashes).size };
});
const result = {
  revision: 25, duration: Number(probe.format.duration), bytes: Number(probe.format.size),
  sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), width: video.width, height: video.height,
  fps: video.r_frame_rate, audioCodec: audio.codec_name, mixLufs: Number(levels.input_i), truePeakDb: Number(levels.input_tp),
  windows, motion, webAudioIdenticalToRender: true, renderQuality: 'delivery', webCrf: 22,
  userApproved: true, newInference: false,
};
writeFileSync(resolve(root, 'provenance/aura-launch-v25-qa.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
