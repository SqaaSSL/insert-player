import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const hash = path => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
const source = 'assets/aura-active-hud-v23-source.mp4';
const sourceSha256 = 'be2118337fecc6eb2725097aca8a108e63d688ab3964fc1f172b063d75589566';
const voiceSource = 'assets/generated/launch-voice-aura-v22.wav';
const voiceSourceSha256 = '22a486755fa901652ede60640ad4f3f532a7c438fec8db51d9b322854e515d31';
const voiceOutput = 'assets/generated/launch-voice-aura-v24.wav';
assert.equal(hash(source), sourceSha256);
assert.equal(hash(voiceSource), voiceSourceSha256);
assert(!existsSync(resolve(root, voiceOutput)), 'Preserve every approved voice version.');
const frames = JSON.parse(readFileSync(resolve(root, 'assets/captures/aura-active-hud-v23/capture.json'))).frames;
const cuts = [[0, 1.8], [9.8, 1.7], [3.8, 1.8], [23, 2], [19.3, 1.8], [7.4, 1.9], [2.1, 1.6], [11.6, 1.9], [30.6, 2], [27, 2]];
let at = 4.65;
const clips = cuts.map(([start, duration], index) => {
  const selected = frames.slice(Math.round(start * 30), Math.round((start + duration) * 30));
  const slot = index % 2;
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
  const clip = { id: `aura-cut-${String(index + 1).padStart(2, '0')}`, at, start, duration, slot,
    character: slot === 0 ? 'Donald Trump' : 'Rosalia', animations: [...animations],
    uniquePoses: poses.size, longestHoldSeconds: longestHold / 30, restingFrames: 0 };
  at = Number((at + duration).toFixed(2));
  return clip;
});
assert.equal(at, 23.15);

// Freeze only the approved sentence edit. The carve CLI ignores media-start
// and duration on split voice clips, so it must analyse this exact audible PCM.
execFileSync('ffmpeg', ['-v', 'error', '-n', '-i', resolve(root, voiceSource), '-filter_complex',
  '[0:a]atrim=start=0:end=31.9,asetpts=PTS-STARTPTS[body];[0:a]atrim=start=35.15:end=40.15,asetpts=PTS-STARTPTS[close];[body][close]concat=n=2:v=0:a=1[out]',
  '-map', '[out]', '-c:a', 'pcm_s16le', resolve(root, voiceOutput)], { stdio: 'inherit' });

const oldVoice = JSON.parse(readFileSync(resolve(root, 'provenance/aura-launch-v22-cues.json')));
const captions = oldVoice.captions.filter(caption => caption.start < 32 || caption.start >= 35.15)
  .map(caption => caption.start >= 35.15
    ? { ...caption, start: Number((caption.start - 3.25).toFixed(2)), end: Number((caption.end - 3.25).toFixed(2)) }
    : caption);
const manifest = {
  revision: 24, duration: 36.9, primaryGame: 'aura', auraSeconds: 18.5,
  source, sourceSha256, clips, optional: { source: 'assets/optional-games-hud-v23-review.mp4',
    sha256: hash('assets/optional-games-hud-v23-review.mp4'), at: 23.15, duration: 9, unchanged: true },
  closing: { at: 31.9, duration: 5, overlapWithRush: 0.25 },
  voice: { source: voiceSource, sourceSha256: voiceSourceSha256, output: voiceOutput, sha256: hash(voiceOutput),
    ranges: [[0, 31.9], [35.15, 40.15]], newInference: false, playbackRate: 1 },
  music: { source: 'assets/generated/launch-bed-aura-v21.wav', sha256: hash('assets/generated/launch-bed-aura-v21.wav'),
    mediaStart: 0, duration: 36.9, terminalFade: [36.6, 36.9], continuous: true },
  captions,
};
writeFileSync(resolve(root, 'provenance/aura-launch-v24-edit.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
const stamp = seconds => `00:${String(Math.floor(seconds)).padStart(2, '0')}.${String(Math.round(seconds * 1000) % 1000).padStart(3, '0')}`;
writeFileSync(resolve(root, 'provenance/aura-launch-v24-en.vtt'), 'WEBVTT\n\n' + captions
  .map(caption => `${stamp(caption.start)} --> ${stamp(caption.end)}\n${caption.text}`).join('\n\n') + '\n', { flag: 'wx' });
console.log('v24: ten alternating Aura cuts, unchanged Fight/Rush, direct five-second ending. No inference.');
