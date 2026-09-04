import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const inputPath = resolve(
  process.argv[2] ?? resolve(projectRoot, 'assets/generated/launch-bed-original-neon-v9.wav'),
);
const outputPath = resolve(
  process.argv[3] ?? resolve(projectRoot, 'assets/generated/launch-bed-original-neon-v10.wav'),
);
const totalDurationSeconds = 20.05;
const sourceTailStartSeconds = 17.1;
const reverbPlacementSeconds = 17.55;
const finalFadeSeconds = 0.34;
const finalFadeStartSeconds = totalDurationSeconds - finalFadeSeconds;

function runFfmpeg(args, capture = false) {
  const result = spawnSync('ffmpeg', args, {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed${capture ? `: ${result.stderr.trim()}` : ''}`);
  }
  return result;
}

function measureMeanVolumeDb(filePath, startSeconds, durationSeconds) {
  const result = runFfmpeg([
    '-hide_banner',
    '-nostats',
    '-ss',
    String(startSeconds),
    '-t',
    String(durationSeconds),
    '-i',
    filePath,
    '-vn',
    '-af',
    'volumedetect',
    '-f',
    'null',
    '-',
  ], true);
  const match = result.stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s+dB/i);
  if (!match) throw new Error(`Could not measure mean volume for ${basename(filePath)}`);
  return Number(match[1]);
}

const tailDelayMs = Math.round(reverbPlacementSeconds * 1000);
const filter = [
  `[0:a]apad=whole_dur=${totalDurationSeconds},atrim=end=${totalDurationSeconds}[main]`,
  `[0:a]atrim=start=${sourceTailStartSeconds}:end=18,asetpts=PTS-STARTPTS,aecho=0.8:0.86:420|840|1260|1680:0.3|0.22|0.15|0.1,volume=-5dB,adelay=${tailDelayMs}:all=1[tail]`,
  `[main][tail]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,highpass=f=42,alimiter=limit=0.89,afade=t=out:st=${finalFadeStartSeconds}:d=${finalFadeSeconds},apad=whole_dur=${totalDurationSeconds},atrim=end=${totalDurationSeconds}[out]`,
].join(';');

runFfmpeg([
  '-y',
  '-v',
  'error',
  '-i',
  inputPath,
  '-filter_complex',
  filter,
  '-map',
  '[out]',
  '-t',
  String(totalDurationSeconds),
  '-ar',
  '48000',
  '-ac',
  '2',
  '-map_metadata',
  '-1',
  '-c:a',
  'pcm_s16le',
  outputPath,
]);

const continuityChecks = [17.4, 18.2, 19.0, 19.5].map((startSeconds) => ({
  startSeconds,
  durationSeconds: 0.3,
  meanVolumeDb: measureMeanVolumeDb(outputPath, startSeconds, 0.3),
}));

for (const check of continuityChecks) {
  if (check.meanVolumeDb <= -50) {
    throw new Error(`Extended launch bed is effectively silent at ${check.startSeconds}s`);
  }
}

console.log(JSON.stringify({
  input: inputPath,
  output: outputPath,
  bytes: readFileSync(outputPath).byteLength,
  durationSeconds: totalDurationSeconds,
  extension: 'short branded reverb tail from the approved v9 close',
  continuityChecks,
}, null, 2));
