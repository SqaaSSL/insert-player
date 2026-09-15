import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const hash = path => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
const aura = 'assets/captures/aura-active-hud-v23/master.mp4';
const fight = 'assets/captures/fight-review-hud-v23/master.mp4';
const rush = 'assets/captures/rush-review-hud-v23/master.mp4';
const legacy = 'assets/three-games-aura-v21.mp4';
const take = JSON.parse(readFileSync(resolve(root, 'assets/captures/aura-active-hud-v23/capture.json')));
const auraCuts = [[0, 1.2], [8, 2], [2.5, 3], [10, 3.5], [17.5, 4], [23.2, 3.3], [27, 1.5]];
const main = auraCuts.map(([start, duration]) => ({ source: aura, start, duration }));
const optional = [
  { source: legacy, start: 3, duration: 3.4, note: 'Approved loading curtain and one-second Casual/Player One exchange retained.' },
  { source: fight, start: 2, duration: 2.1 },
  { source: rush, start: 3, duration: 3.5 },
];
const reprise = [{ source: aura, start: 25.3, duration: 3.25 }];

// Audit the performer's actual sprite, not the notes, effects or elapsed timer.
function movementEvidence(clip) {
  const frames = take.frames.slice(Math.round(clip.start * 30), Math.round((clip.start + clip.duration) * 30));
  let held = 0; let longestHold = 0; let rest = 0; let longestRest = 0; let previous;
  const poses = new Set();
  for (const frame of frames) {
    const actor = frame.actors[frame.slot];
    const pose = [frame.slot, actor.animation, actor.frame].join(':');
    held = pose === previous ? held + 1 : 1;
    rest = actor.resting ? rest + 1 : 0;
    longestHold = Math.max(longestHold, held);
    longestRest = Math.max(longestRest, rest);
    previous = pose; poses.add(pose);
  }
  assert(longestHold / 30 <= 0.5, 'Do not use a held sprite in this action edit.');
  assert(longestRest / 30 <= 0.3, 'Exclude count-ins and turn waiting.');
  assert(poses.size >= 6);
  return { uniquePoses: poses.size, longestHeldPoseSeconds: longestHold / 30, longestRestSeconds: longestRest / 30 };
}

function render(name, clips) {
  const output = `assets/${name}.mp4`;
  assert(!existsSync(resolve(root, output)), 'Versioned assets must not be overwritten.');
  const sources = [...new Set(clips.map(clip => clip.source))];
  const filters = clips.map((clip, index) => `[${sources.indexOf(clip.source)}:v]trim=start=${clip.start}:duration=${clip.duration},setpts=PTS-STARTPTS,setsar=1,fps=30[v${index}]`);
  filters.push(`${clips.map((_, i) => `[v${i}]`).join('')}concat=n=${clips.length}:v=1:a=0[out]`);
  execFileSync('ffmpeg', ['-v', 'error', '-n', ...sources.flatMap(source => ['-i', resolve(root, source)]),
    '-filter_complex', filters.join(';'), '-map', '[out]', '-an', '-c:v', 'libx264', '-crf', '17',
    '-preset', 'slow', '-pix_fmt', 'yuv420p', '-g', '30', '-movflags', '+faststart', resolve(root, output)], { stdio: 'inherit' });
  return { output, sha256: hash(output), clips: clips.map(clip => ({ ...clip, sourceSha256: hash(clip.source),
    ...(clip.source === aura ? { movement: movementEvidence(clip) } : {}) })) };
}

for (const clip of [...main, ...reprise]) movementEvidence(clip);
const manifest = {
  revision: 23, duration: 40.15, primaryGame: 'aura', auraSeconds: 21.5,
  narration: { source: 'assets/generated/launch-voice-aura-v22.wav', sha256: hash('assets/generated/launch-voice-aura-v22.wav'), changed: false },
  music: { source: 'assets/generated/launch-bed-aura-v21.wav', sha256: hash('assets/generated/launch-bed-aura-v21.wav'), changed: false },
  sections: [
    { at: 4.65, duration: 18.5, ...render('aura-action-hud-v23-review', main) },
    { at: 23.15, duration: 9, ...render('optional-games-hud-v23-review', optional) },
    { at: 32.15, duration: 3.25, ...render('aura-return-hud-v23-review', reprise) },
  ],
  note: 'New 30fps clock-stepped real-game captures. No interpolation, acceleration, AI video, new voice or music. Original v22 audio markup and mix are preserved. The approved Casual loader/exchange remains legacy; every other gameplay section uses the new game HUD. Lamine omitted pending Spain-kit approval, not replaced by an unapproved skin.',
};
writeFileSync(resolve(root, 'provenance/identity-gameplay-v23-review.json'), JSON.stringify(manifest, null, 2) + '\n');
