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
const introPath = resolve(
  process.argv[3] ??
    join(projectRoot, 'assets/generated/launch-mix-google-v2-neon-reference.wav'),
);
const effectsPath = resolve(
  process.argv[4] ?? join(projectRoot, 'assets/launch-mix.wav'),
);
const outputPath = resolve(
  process.argv[5] ??
    join(projectRoot, 'assets/generated/launch-mix-original-neon-gameplay-v3.wav'),
);
const expectedMusicSha256 =
  '0a0ae79a32b00c3b68099a83d09b9044f9debede8130370ce8ce185d51c78b05';
const musicSha256 = createHash('sha256').update(readFileSync(musicPath)).digest('hex');
const audibleFloorDb = -50;

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
  if (!match) {
    throw new Error(`Could not measure mean volume for ${basename(filePath)}`);
  }
  return Number(match[1]);
}

function assertAudibleWindow(filePath, startSeconds, durationSeconds, label) {
  const meanVolumeDb = measureMeanVolumeDb(filePath, startSeconds, durationSeconds);
  if (meanVolumeDb <= audibleFloorDb) {
    throw new Error(
      `${label} is effectively silent (${meanVolumeDb.toFixed(1)} dBFS; expected above ${audibleFloorDb} dBFS)`,
    );
  }
  return { label, startSeconds, durationSeconds, meanVolumeDb };
}

const workDir = mkdtempSync(join(tmpdir(), 'insert-player-audio-'));
const gameplayPremixPath = join(workDir, 'gameplay-premix.wav');
const gameplayNormalizedPath = join(workDir, 'gameplay-normalized.wav');

try {
  const gameplayArrangement = [
    '[0:a]atrim=start=0:end=7.35,asetpts=PTS-STARTPTS,volume=-2dB,afade=t=in:st=0:d=0.04,afade=t=out:st=6.50:d=0.85[neon]',
    '[1:a]atrim=start=4.65:end=12,asetpts=PTS-STARTPTS,volume=4dB[gameplay_effects]',
    '[neon][gameplay_effects]amix=inputs=2:duration=longest:dropout_transition=0,highpass=f=45,acompressor=threshold=-12dB:ratio=2:attack=10:release=120:makeup=2,apad=pad_dur=7.35,atrim=end_sample=352800,asetpts=PTS-STARTPTS[gameplay]',
  ].join(';');

  runFfmpeg([
    '-y',
    '-v',
    'error',
    '-i',
    musicPath,
    '-i',
    effectsPath,
    '-filter_complex',
    gameplayArrangement,
    '-map',
    '[gameplay]',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-c:a',
    'pcm_s16le',
    gameplayPremixPath,
  ]);

  const analysis = runFfmpeg(
    [
      '-hide_banner',
      '-nostats',
      '-i',
      gameplayPremixPath,
      '-af',
      'loudnorm=I=-16.3:LRA=10:TP=-1.5:print_format=json',
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
    'loudnorm=I=-16.3:LRA=10:TP=-1.5',
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
    gameplayPremixPath,
    '-af',
    `${normalize},aresample=48000,apad=whole_dur=7.35,atrim=end=7.35`,
    '-t',
    '7.35',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-map_metadata',
    '-1',
    '-c:a',
    'pcm_s16le',
    gameplayNormalizedPath,
  ]);

  const continuityChecks = [
    assertAudibleWindow(
      gameplayNormalizedPath,
      5.15,
      0.5,
      'Neon Arena late-gameplay window',
    ),
  ];

  runFfmpeg([
    '-y',
    '-v',
    'error',
    '-i',
    introPath,
    '-i',
    gameplayNormalizedPath,
    '-filter_complex',
    '[0:a]atrim=end_sample=223200,asetpts=PTS-STARTPTS[intro];[1:a]atrim=end_sample=352800,asetpts=PTS-STARTPTS,adelay=4650:all=1[gameplay];[intro][gameplay]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,apad=pad_dur=12,atrim=end_sample=576000[out]',
    '-map',
    '[out]',
    '-t',
    '12',
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

  continuityChecks.push(
    assertAudibleWindow(outputPath, 10.2, 0.5, 'Final mix late-gameplay window'),
    assertAudibleWindow(outputPath, 11.25, 0.4, 'Final mix closing-fade window'),
  );

  const size = readFileSync(outputPath).byteLength;
  console.log(
    JSON.stringify(
      {
        output: outputPath,
        outputFile: basename(outputPath),
        bytes: size,
        durationSeconds: 12,
        gameplayIntegratedLoudnessTargetLufs: -16.3,
        truePeakTargetDbfs: -1.5,
        musicSourceSha256: musicSha256,
        preservedIntroSeconds: [0, 4.65],
        musicSourceSeconds: [0, 7.35],
        musicTimelineSeconds: [4.65, 12],
        audibleFloorDb,
        continuityChecks,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
