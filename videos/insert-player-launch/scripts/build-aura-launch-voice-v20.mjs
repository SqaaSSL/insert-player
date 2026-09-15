import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const plan = JSON.parse(readFileSync(resolve(root, 'provenance/aura-launch-v20-cues.json')));
const output = resolve(root, 'assets/generated/launch-voice-aura-v20.wav');
const normalized = resolve(root, 'assets/generated/tts-launch-three-games-v20-matched.wav');
assert(!existsSync(output) && !existsSync(normalized), 'Preserve existing versions; do not overwrite.');
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const old = resolve(root, plan.oldVoice);
const fresh = resolve(root, plan.newVoice);
assert.equal(sha256(old), '8bfd6efccb2351ccbb926435f638bb349838e2826cc5d9491914c8a1aacd03dc');
assert.equal(sha256(fresh), '13273f782c3e9eef80f216d2274cbe736bd1044f1a3cef515f25e08876294a81');
const target = `loudnorm=I=${plan.newVoiceLoudnessTarget}:TP=${plan.newVoiceTruePeakCeiling}:LRA=11`;
const measured = spawnSync('ffmpeg', ['-hide_banner', '-i', fresh, '-af', `${target}:print_format=json`, '-f', 'null', '-'], { encoding: 'utf8' });
assert.equal(measured.status, 0);
const levels = JSON.parse(measured.stderr.match(/\{\s*"input_i"[\s\S]*?\}/)[0]);
const normalization = `${target}:measured_I=${levels.input_i}:measured_TP=${levels.input_tp}:measured_LRA=${levels.input_lra}:measured_thresh=${levels.input_thresh}:offset=${levels.target_offset}:linear=true`;
const ffmpeg = args => execFileSync('ffmpeg', ['-v', 'error', '-n', ...args], { stdio: 'inherit' });
ffmpeg(['-i', fresh, '-af', normalization, '-ar', '48000', '-ac', '1', normalized]);

let previousEnd = 0;
const filters = plan.cues.map((cue, i) => {
  const [start, end] = cue.range;
  assert(start >= 0 && end > start && cue.at >= previousEnd, `Invalid/overlapping cue ${i}`);
  previousEnd = cue.at + end - start;
  assert(previousEnd <= plan.duration, `Cue ${i} exceeds the film`);
  const input = cue.source === 'old' ? 0 : 1;
  return `[${input}:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,adelay=${Math.round(cue.at * 1000)}:all=1[c${i}]`;
});
filters.push(`${plan.cues.map((_, i) => `[c${i}]`).join('')}amix=inputs=${plan.cues.length}:normalize=0,apad=whole_dur=${plan.duration},atrim=end=${plan.duration}[out]`);
ffmpeg(['-i', old, '-i', normalized, '-filter_complex', filters.join(';'), '-map', '[out]', '-ar', '48000', '-ac', '2', output]);

const transcripts = {
  old: JSON.parse(readFileSync(resolve(root, 'assets/generated/tts-launch-friends-v4.transcript.json'))),
  new: JSON.parse(readFileSync(resolve(root, 'assets/generated/tts-launch-three-games-v20.transcript.json'))),
};
const captions = plan.cues.map(cue => {
  const words = transcripts[cue.source].filter(word => word.start >= cue.range[0] && word.end <= cue.range[1]);
  assert(words.length > 0);
  const start = cue.at + words[0].start - cue.range[0];
  const end = cue.at + words.at(-1).end - cue.range[0];
  const lines = [''];
  for (const word of cue.text.split(' ')) {
    if (lines.at(-1).length + word.length + 1 > 48) lines.push('');
    lines[lines.length - 1] += `${lines.at(-1) ? ' ' : ''}${word}`;
  }
  return `${stamp(start)} --> ${stamp(end)}\n${lines.join('\n')}`;
});
writeFileSync(resolve(root, '../../public/assets/insert-player-launch-aura-v20-en.vtt'), `WEBVTT\n\n${captions.join('\n\n')}\n`, { flag: 'wx' });
writeFileSync(resolve(root, 'provenance/aura-launch-v20-audio.json'), `${JSON.stringify({
  duration: plan.duration, newTakes: 1, playbackRate: 1, loops: 0,
  originalIntroAndEndPreserved: true, musicUnchanged: true,
  musicSha256: sha256(resolve(root, plan.music)), oldVoiceSha256: sha256(old), newVoiceSha256: sha256(fresh),
  voiceSha256: sha256(output), measurement: levels, normalization,
  narration: 'New Orus middle section; Fight, CPU-ally Rush, Aura rhythm and friend rivalry.',
}, null, 2)}\n`, { flag: 'wx' });
console.log(`Built ${output}`);

function stamp(seconds) {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}
