import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const musicArgument = process.argv[2];

if (!musicArgument) {
  throw new Error(
    'Pass the private Neon Arena.mp3 source as the first argument. The source is intentionally not stored in the repository.',
  );
}

const musicPath = resolve(musicArgument);
const introMusicPath = resolve(
  process.argv[3] ?? join(projectRoot, 'assets/generated/lyria-launch-bed-v2-neon-reference.mp3'),
);
const effectsPath = resolve(
  process.argv[4] ?? join(projectRoot, 'assets/launch-mix.wav'),
);
const outputPath = resolve(
  process.argv[5] ?? join(projectRoot, 'assets/generated/launch-bed-original-neon-v11.wav'),
);
const expectedMusicSha256 =
  '0a0ae79a32b00c3b68099a83d09b9044f9debede8130370ce8ce185d51c78b05';
const musicSha256 = createHash('sha256').update(readFileSync(musicPath)).digest('hex');
const introDurationSeconds = 4.65;
const totalDurationSeconds = 20.05;
const neonDurationSeconds = totalDurationSeconds - introDurationSeconds;
const musicFadeDurationSeconds = 0.3;
const musicFadeStartSeconds = neonDurationSeconds - musicFadeDurationSeconds;

if (musicSha256 !== expectedMusicSha256) {
  throw new Error(
    `Unexpected music source SHA-256: ${musicSha256}. Expected ${expectedMusicSha256}.`,
  );
}

function runFfmpeg(args, options = {}) {
  const result = spawnSync('ffmpeg', args, {
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.status !== 0) {
    const detail = options.capture ? result.stderr.trim() : '';
    throw new Error(`ffmpeg failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function measureMeanVolumeDb(filePath, startSeconds, durationSeconds) {
  const measurement = runFfmpeg(
    [
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
    ],
    { capture: true },
  );
  const match = measurement.stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s+dB/i);
  if (!match) throw new Error(`Could not measure mean volume for ${basename(filePath)}`);
  return Number(match[1]);
}

const workDir = mkdtempSync(join(tmpdir(), 'insert-player-bed-'));
const premixPath = join(workDir, 'launch-bed-premix.wav');

try {
  const arrangement = [
    `[0:a]atrim=start=0:end=${introDurationSeconds},asetpts=PTS-STARTPTS,volume=2dB,afade=t=out:st=4.50:d=0.15[intro]`,
    `[1:a]atrim=start=0:end=${neonDurationSeconds},asetpts=PTS-STARTPTS,volume=-2dB,afade=t=in:st=0:d=0.04,afade=t=out:st=${musicFadeStartSeconds}:d=${musicFadeDurationSeconds},adelay=4650:all=1[neon]`,
    `[2:a]atrim=start=0:end=${totalDurationSeconds},asetpts=PTS-STARTPTS,volume=4dB[effects]`,
    `[intro][neon][effects]amix=inputs=3:duration=longest:dropout_transition=0:normalize=0,highpass=f=45,acompressor=threshold=-12dB:ratio=2:attack=10:release=120:makeup=2,apad=whole_dur=${totalDurationSeconds},atrim=end=${totalDurationSeconds},asetpts=PTS-STARTPTS[bed]`,
  ].join(';');

  runFfmpeg([
    '-y',
    '-v',
    'error',
    '-i',
    introMusicPath,
    '-i',
    musicPath,
    '-i',
    effectsPath,
    '-filter_complex',
    arrangement,
    '-map',
    '[bed]',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-c:a',
    'pcm_s16le',
    premixPath,
  ]);

  const analysis = runFfmpeg(
    [
      '-hide_banner',
      '-nostats',
      '-i',
      premixPath,
      '-af',
      'loudnorm=I=-20:LRA=10:TP=-4:print_format=json',
      '-f',
      'null',
      '-',
    ],
    { capture: true },
  );
  const match = analysis.stderr.match(/\{[\s\S]*?"target_offset"\s*:\s*"[^"]+"[\s\S]*?\}/);
  if (!match) throw new Error('Could not parse loudnorm analysis');
  const measured = JSON.parse(match[0]);
  const normalize = [
    'loudnorm=I=-20:LRA=10:TP=-4',
    `measured_I=${measured.input_i}`,
    `measured_LRA=${measured.input_lra}`,
    `measured_TP=${measured.input_tp}`,
    `measured_thresh=${measured.input_thresh}`,
    `offset=${measured.target_offset}`,
    'linear=true',
    'print_format=summary',
  ].join(':');

  runFfmpeg([
    '-y',
    '-v',
    'error',
    '-i',
    premixPath,
    '-af',
    `${normalize},aresample=48000,apad=whole_dur=${totalDurationSeconds},atrim=end=${totalDurationSeconds}`,
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

  const continuityChecks = [0.5, 5.15, 7.25, 9.25, 11.8, 13.2, 15.2, 17.4, 18.2, 19, 19.5].map((startSeconds) => ({
    startSeconds,
    durationSeconds: 0.4,
    meanVolumeDb: measureMeanVolumeDb(outputPath, startSeconds, 0.4),
  }));
  for (const check of continuityChecks) {
    if (check.meanVolumeDb <= -50) {
      throw new Error(`Launch bed is effectively silent at ${check.startSeconds}s`);
    }
  }

  console.log(JSON.stringify({
    output: outputPath,
    outputFile: basename(outputPath),
    bytes: readFileSync(outputPath).byteLength,
    durationSeconds: totalDurationSeconds,
    integratedLoudnessTargetLufs: -20,
    truePeakTargetDbfs: -4,
    musicSourceSha256: musicSha256,
    neonSourceSeconds: [0, neonDurationSeconds],
    neonTimelineSeconds: [introDurationSeconds, totalDurationSeconds],
    repeatedTailSeconds: 0,
    continuityChecks,
  }, null, 2));
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
