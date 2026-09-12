import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'assets/three-games-aura-v21.mp4');
assert(!existsSync(output), 'Preserve all versions.');
const work = resolve(root, 'assets/captures/montage-v21-frame-exact');
mkdirSync(work, { recursive: true });
const aura = 'assets/captures/aura-trump-lamine-v1/master.webm';
const rosalia = 'assets/captures/aura-rosalia-trump-v1/master.webm';
const rush = 'assets/captures/rush-player-one-elon-v5/master.webm';
const fight = 'assets/captures/fight-player-one-trump-v21/master.mp4';
const legacy = 'assets/fight-montage-player-one-vs-casual-v15.mp4';
const capture = JSON.parse(readFileSync(resolve(root, 'assets/captures/fight-player-one-trump-v21/capture.json')));
assert.equal(capture.fps, 30);
assert.equal(capture.frames.length, capture.seconds * capture.fps);
capture.frames.forEach((frame, i) => assert(Math.abs(frame.simulationTime - Math.round(i * 1000 / 30)) < 1));
const cuts = [
  { game: 'aura', source: aura, start: 9, duration: 1.4 },
  { game: 'rush', source: rush, start: 13, duration: 0.8 },
  { game: 'fight', source: fight, start: 1.1, duration: 0.8 },
  { game: 'fight-loading', source: legacy, start: 0, duration: 2.4, retained: true },
  { game: 'fight', source: legacy, start: 2.4, duration: 1, retained: true },
  { game: 'fight', source: fight, start: 2.4, duration: 2.1 },
  { game: 'rush', source: rush, start: 12.2, duration: 3.5 },
  { game: 'aura', source: aura, start: 8.2, duration: 6 },
  { game: 'aura', source: rosalia, start: 9.3, duration: 6.5 },
  { game: 'aura', source: aura, start: 17, duration: 6 },
];
const sources = Object.fromEntries([...new Set(cuts.map(c => c.source))].map(path => [path, createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')]));
let time = 0;
for (const [index, cut] of cuts.entries()) {
  cut.montageStart = time;
  time = Math.round((time + cut.duration) * 30) / 30;
  cut.file = `${String(index).padStart(2, '0')}.mp4`;
  const frames = Math.round(cut.duration * 30) + (index === cuts.length - 1 ? 8 : 0);
  execFileSync('ffmpeg', ['-v', 'error', '-n', '-ss', String(cut.start), '-i', resolve(root, cut.source), '-an', '-vf',
    `trim=duration=${cut.duration},setpts=PTS-STARTPTS,fps=30,setpts=N/(30*TB),scale=1920:1080:flags=lanczos,setsar=1,format=yuv420p,tpad=stop_mode=clone:stop_duration=0.3`,
    '-frames:v', String(frames), '-c:v', 'libx264', '-preset', 'fast', '-crf', '16', '-g', '30', '-keyint_min', '30', resolve(work, cut.file)]);
}
assert.equal(time, 30.5);
writeFileSync(resolve(work, 'cuts.ffconcat'), cuts.map(c => `file '${c.file}'`).join('\n') + '\n');
execFileSync('ffmpeg', ['-v', 'error', '-n', '-f', 'concat', '-safe', '0', '-i', resolve(work, 'cuts.ffconcat'), '-c', 'copy', '-movflags', '+faststart', output]);
writeFileSync(resolve(root, 'provenance/aura-launch-v21-cuts.json'), JSON.stringify({
  cuts, sources, duration: time + 8 / 30, auraMainSeconds: 18.5, auraTotalSeconds: 19.9,
  fightCapture: { sourceCommit: capture.sourceCommit, fps: capture.fps, frames: capture.frames.length, method: capture.method },
  note: 'Replaces both low-cadence Trump excerpts. Retains the approved Casual/Player One loading and one-second exchange. Aura extended with real continuous score-building, not loops or time-stretch. Eight hold frames are hidden under the end-card reveal. No production mutation or image/video inference.',
}, null, 2) + '\n');
console.log(output);
