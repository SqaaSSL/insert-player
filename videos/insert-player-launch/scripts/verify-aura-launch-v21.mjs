import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const path = resolve(root, '../../public/assets/insert-player-launch-aura-v21.mp4');
const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path]));
const video = probe.streams.find(s => s.codec_type === 'video');
const audio = probe.streams.find(s => s.codec_type === 'audio');
assert.equal(video.width, 1920);
assert.equal(video.height, 1080);
assert.equal(video.r_frame_rate, '30/1');
assert.equal(audio.codec_name, 'aac');
assert(Number(probe.format.duration) > 40.1 && Number(probe.format.duration) < 40.3);
assert(Number(probe.format.size) < 12 * 1024 * 1024);

const ffmpeg = args => {
  const result = spawnSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  return result;
};
const loudness = ffmpeg(['-hide_banner', '-i', path, '-af', 'loudnorm=print_format=json', '-f', 'null', '-']);
const levels = JSON.parse(loudness.stderr.match(/\{\s*"input_i"[\s\S]*?\}/)[0]);
assert(Number(levels.input_tp) < 0, 'No clipped mix');
const windows = [5, 9, 14, 18, 22, 26, 30, 34, 36, 38, 39].map(at => {
  const result = ffmpeg(['-hide_banner', '-ss', String(at), '-t', '1', '-i', path, '-af', 'volumedetect', '-f', 'null', '-']);
  const rmsDb = Number(result.stderr.match(/mean_volume: ([\d.-]+) dB/)[1]);
  const peakDb = Number(result.stderr.match(/max_volume: ([\d.-]+) dB/)[1]);
  assert(rmsDb > -30 && peakDb < 0, `Dropout or clipping at ${at}s`);
  return { at, rmsDb, peakDb };
});

// Check the delivered clip, not just the uncompressed capture or montage.
const frameLog = ffmpeg(['-v', 'error', '-i', path, '-vf', 'trim=start_frame=332:end_frame=395,setpts=PTS-STARTPTS', '-an', '-f', 'framemd5', '-']).stdout;
const hashes = frameLog.split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split(',').at(-1).trim());
assert.equal(hashes.length, 63);
assert.equal(new Set(hashes).size, 63);
const transcript = JSON.parse(readFileSync(resolve(root, 'assets/captures/final-audio-v21/transcript.json')));
const text = transcript.map(w => w.text).join(' ');
assert.match(text, /Aura farming/i);
assert.match(text, /Challenge your friends/i);
assert.match(text, /CPU ally/i);
assert.match(text, /Insert Player/i);
assert.doesNotMatch(text, /ridiculous|absurd|silly/i);
const result = {
  duration: Number(probe.format.duration), bytes: Number(probe.format.size),
  sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  width: video.width, height: video.height, fps: video.r_frame_rate, audioCodec: audio.codec_name,
  mixLufs: Number(levels.input_i), truePeakDb: Number(levels.input_tp), windows,
  fight: { range: [11.05, 13.15], frames: hashes.length, distinctDecodedFrames: new Set(hashes).size },
  transcript: text, newTtsRequests: 1, retries: 0, fallbacks: 0, published: false,
};
writeFileSync(resolve(root, 'provenance/aura-launch-v21-qa.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
