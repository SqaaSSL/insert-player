import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const hash = path => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
const previous = JSON.parse(readFileSync(resolve(root, 'provenance/aura-launch-v24-edit.json')));
const source = previous.source;
const voiceSource = previous.voice.source;
const voiceOutput = 'assets/generated/launch-voice-aura-v25.wav';
const manifestPath = 'provenance/aura-launch-v25-edit.json';
const captionPath = 'provenance/aura-launch-v25-en.vtt';
assert.equal(hash(source), previous.sourceSha256);
assert.equal(hash(voiceSource), previous.voice.sourceSha256);
for (const path of [voiceOutput, manifestPath, captionPath]) {
  assert(!existsSync(resolve(root, path)), `Preserve existing version: ${path}`);
}

const frames = JSON.parse(readFileSync(resolve(root, 'assets/captures/aura-active-hud-v23/capture.json'))).frames;
const selections = [[27, 2, 1], [2.1, 1.6, 0], [22.8, 2.2, 1], [0.3, 1.6, 0], [11.6, 1.9, 1]];
let at = 4.65;
const clips = selections.map(([start, duration, slot], index) => {
  const selected = frames.slice(Math.round(start * 30), Math.round((start + duration) * 30));
  assert.equal(selected.length, Math.round(duration * 30));
  assert(selected.every(frame => frame.slot === slot && !frame.actors[slot].resting));
  const poses = new Set();
  const animations = new Set();
  let prior; let held = 0; let longestHold = 0;
  for (const frame of selected) {
    const actor = frame.actors[slot];
    const pose = `${actor.animation}:${actor.frame}`;
    poses.add(pose); animations.add(actor.animation);
    held = prior === pose ? held + 1 : 1;
    prior = pose; longestHold = Math.max(longestHold, held);
  }
  assert(poses.size >= 6 && longestHold <= 15);
  assert.equal(animations.size, 1);
  const clip = { id: `aura-cut-${String(index + 1).padStart(2, '0')}`, at, start, duration, slot,
    character: slot === 0 ? 'Donald Trump' : 'Rosalia', animations: [...animations],
    uniquePoses: poses.size, longestHoldSeconds: longestHold / 30, restingFrames: 0 };
  at = Number((at + duration).toFixed(2));
  return clip;
});
assert.equal(at, 13.95);
assert.equal(new Set(clips.flatMap(clip => clip.animations)).size, 5);

// Freeze the exact audible voice before carving: the carve decoder does not
// respect source trims on separate audio tags. All edits land in source silence.
const ranges = [
  { start: 0, end: 5.65, at: 0 },
  { start: 10.75, end: 15.5, at: 5.65 },
  { start: 23.15, end: 31.9, at: 13.95 },
  { start: 35.15, end: 40.15, at: 22.7 },
];
const filters = ranges.map((range, i) =>
  `[0:a]atrim=start=${range.start}:end=${range.end},asetpts=PTS-STARTPTS[v${i}]`);
filters.push('anullsrc=r=48000:cl=stereo,atrim=duration=3.55[pause]');
filters.push('[v0][v1][pause][v2][v3]concat=n=5:v=0:a=1[out]');
execFileSync('ffmpeg', ['-v', 'error', '-n', '-i', resolve(root, voiceSource),
  '-filter_complex', filters.join(';'), '-map', '[out]', '-c:a', 'pcm_s16le',
  resolve(root, voiceOutput)], { stdio: 'inherit' });

const originalCaptions = JSON.parse(readFileSync(resolve(root, 'provenance/aura-launch-v22-cues.json'))).captions;
const round = number => Number(number.toFixed(2));
const captions = ranges.flatMap(range => originalCaptions
  .filter(caption => caption.start >= range.start && caption.end <= range.end)
  .map(caption => ({ ...caption, start: round(range.at + caption.start - range.start),
    end: round(range.at + caption.end - range.start) })));
const manifest = {
  revision: 25, duration: 27.7, primaryGame: 'aura', auraSeconds: 9.3,
  source, sourceSha256: hash(source), clips,
  optional: { ...previous.optional, at: 13.95 },
  closing: { at: 22.7, duration: 5, overlapWithRush: 0.25 },
  voice: { source: voiceSource, sourceSha256: hash(voiceSource), output: voiceOutput,
    sha256: hash(voiceOutput), ranges, silence: [10.4, 13.95], newInference: false, playbackRate: 1 },
  music: { ...previous.music, duration: 27.7, terminalFade: [27.4, 27.7] },
  captions,
};
writeFileSync(resolve(root, manifestPath), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
const stamp = seconds => `00:${String(Math.floor(seconds)).padStart(2, '0')}.${String(Math.round(seconds * 1000) % 1000).padStart(3, '0')}`;
writeFileSync(resolve(root, captionPath), 'WEBVTT\n\n' + captions
  .map(caption => `${stamp(caption.start)} --> ${stamp(caption.end)}\n${caption.text}`).join('\n\n') + '\n', { flag: 'wx' });
console.log('v25: Aura 9.3s; Rosalia Six Seven + worm; five unique moves; film 27.7s. No inference.');
