import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const plan = JSON.parse(readFileSync(resolve(root, 'provenance/aura-launch-v21-cues.json')));
const music = process.argv[2];
assert(music, 'Pass the original private Neon Arena.mp3.');
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
assert.equal(sha256(music), '0a0ae79a32b00c3b68099a83d09b9044f9debede8130370ce8ce185d51c78b05');
const fresh = resolve(root, 'assets/generated/tts-launch-aura-farming-v21.wav');
assert.equal(sha256(fresh), '7a2e9517c5451e2088f842a33e3034c8b5dbed8652ee4986e7fa346ba2de538e');
const matched = resolve(root, plan.sources.aura);
const voice = resolve(root, 'assets/generated/launch-voice-aura-v21.wav');
const bed = resolve(root, 'assets/generated/launch-bed-aura-v21.wav');
for (const output of [matched, voice, bed]) assert(!existsSync(output), 'Keep all existing audio versions.');
const ffmpeg = args => execFileSync('ffmpeg', ['-v', 'error', '-n', ...args], { stdio: 'inherit' });
const target = 'loudnorm=I=-16.64:TP=-1.35:LRA=11';
const measurement = spawnSync('ffmpeg', ['-hide_banner', '-i', fresh, '-af', `${target}:print_format=json`, '-f', 'null', '-'], { encoding: 'utf8' });
assert.equal(measurement.status, 0);
const levels = JSON.parse(measurement.stderr.match(/\{\s*"input_i"[\s\S]*?\}/)[0]);
const normalization = `${target}:measured_I=${levels.input_i}:measured_TP=${levels.input_tp}:measured_LRA=${levels.input_lra}:measured_thresh=${levels.input_thresh}:offset=${levels.target_offset}:linear=true`;
ffmpeg(['-i', fresh, '-af', normalization, '-ar', '48000', '-ac', '1', matched]);

const names = Object.keys(plan.sources);
const inputs = names.flatMap(name => ['-i', resolve(root, plan.sources[name])]);
let end = 0;
const filters = plan.cues.map((cue, i) => {
  assert(cue.at >= end && cue.range[1] > cue.range[0]);
  end = cue.at + cue.range[1] - cue.range[0];
  assert(end <= plan.duration);
  return `[${names.indexOf(cue.source)}:a]atrim=start=${cue.range[0]}:end=${cue.range[1]},asetpts=PTS-STARTPTS,adelay=${Math.round(cue.at * 1000)}:all=1[c${i}]`;
});
filters.push(`${plan.cues.map((_, i) => `[c${i}]`).join('')}amix=inputs=${plan.cues.length}:normalize=0,apad=whole_dur=${plan.duration},atrim=end=${plan.duration}[out]`);
ffmpeg([...inputs, '-filter_complex', filters.join(';'), '-map', '[out]', '-ar', '48000', '-ac', '2', voice]);
const musicDuration = plan.duration - 4.65;
ffmpeg(['-i', resolve(root, 'assets/generated/launch-bed-original-neon-v11.wav'), '-i', music,
  '-filter_complex', `[0:a]atrim=0:4.65,asetpts=PTS-STARTPTS,afade=t=out:st=4.61:d=0.04[intro];[1:a]atrim=0:${musicDuration},asetpts=PTS-STARTPTS,volume=-4.1dB,afade=t=in:d=0.04,afade=t=out:st=${musicDuration - 0.3}:d=0.3[neon];[intro][neon]concat=n=2:v=0:a=1[out]`,
  '-map', '[out]', '-ar', '48000', '-ac', '2', bed]);
writeFileSync(resolve(root, '../../public/assets/insert-player-launch-aura-v21-en.vtt'), `WEBVTT\n\n${plan.captions.map(c => `${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}`).join('\n\n')}\n`, { flag: 'wx' });
writeFileSync(resolve(root, 'provenance/aura-launch-v21-audio.json'), JSON.stringify({ duration: plan.duration, sourceMusicSha256: sha256(music), sourceRange: [0, musicDuration], musicStart: 4.65, loops: 0, newTakes: 1, playbackRate: 1, measurement: levels, normalization, voiceSha256: sha256(voice), bedSha256: sha256(bed), sources: Object.fromEntries(names.map(name => [name, sha256(resolve(root, plan.sources[name]))])) }, null, 2) + '\n', { flag: 'wx' });
console.log(`Built ${plan.duration}s narration and original music bed.`);

function stamp(seconds) {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}
