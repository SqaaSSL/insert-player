import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const project = resolve(import.meta.dirname, '..');
const output = resolve(project, 'assets/three-games-aura-v19.mp4');
if (existsSync(output)) throw new Error('Version already exists; create a new version instead.');
const work = resolve(project, 'assets/captures/montage-v19-frame-exact');
mkdirSync(work, { recursive: true });
const aura = 'assets/captures/aura-trump-lamine-v1/master.webm';
const rosalia = 'assets/captures/aura-rosalia-trump-v1/master.webm';
const rush = 'assets/captures/rush-player-one-elon-v5/master.webm';
const fight = 'assets/captures/fight-player-one-trump-v2/screen.mp4';
const legacy = 'assets/fight-montage-player-one-vs-casual-v15.mp4';
const cuts = [
  { game: 'aura', source: aura, start: 9, duration: 1.4 },
  { game: 'rush', source: rush, start: 13, duration: 0.8 },
  { game: 'fight', source: fight, start: 22, duration: 0.8 },
  { game: 'fight-loading', source: legacy, start: 0, duration: 2.4, retained: true },
  { game: 'fight', source: legacy, start: 2.4, duration: 1, retained: true },
  { game: 'fight', source: fight, start: 21, duration: 2.6 },
  { game: 'rush', source: rush, start: 11.7, duration: 4.5 },
  { game: 'aura', source: aura, start: 8.2, duration: 4.5 },
  { game: 'aura', source: rosalia, start: 9.3, duration: 4.5 },
  { game: 'aura', source: aura, start: 16.5, duration: 4.0 },
];
const sources = Object.fromEntries([...new Set(cuts.map(c => c.source))].map(path => [path, createHash('sha256').update(readFileSync(resolve(project, path))).digest('hex')]));
let time = 0;
for (const [index, cut] of cuts.entries()) {
  cut.montageStart = time;
  time += cut.duration;
  cut.file = `${String(index).padStart(2, '0')}.mp4`;
  const frames = Math.round(cut.duration * 30) + (index === cuts.length - 1 ? 8 : 0);
  execFileSync('ffmpeg', ['-v', 'error', '-ss', String(cut.start), '-i', resolve(project, cut.source), '-an', '-vf',
    `trim=duration=${cut.duration},setpts=PTS-STARTPTS,fps=30,setpts=N/(30*TB),scale=1920:1080:flags=lanczos,setsar=1,format=yuv420p,tpad=stop_mode=clone:stop_duration=0.3`,
    '-frames:v', String(frames), '-c:v', 'libx264', '-preset', 'fast', '-crf', '16', '-g', '30', '-keyint_min', '30', resolve(work, cut.file)]);
}
writeFileSync(resolve(work, 'cuts.ffconcat'), cuts.map(c => `file '${c.file}'`).join('\n') + '\n');
execFileSync('ffmpeg', ['-v', 'error', '-f', 'concat', '-safe', '0', '-i', resolve(work, 'cuts.ffconcat'), '-c', 'copy', '-movflags', '+faststart', output]);
writeFileSync(resolve(project, 'provenance/aura-launch-v19-cuts.json'), JSON.stringify({
  sourceCommit: 'f559090', cuts, sources, duration: time + 8 / 30,
  note: 'Real local gameplay with public assets, no production mutations or inference. The approved loading curtain and one Casual exchange are retained from v15. Native canvas captures are upscaled, not claimed as native 1080p. Fight includes its DOM HUD. Full private masters remain in assets/captures.',
}, null, 2) + '\n');
console.log(output);
