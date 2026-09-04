import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const musicPath = resolve(
  process.argv[2] ??
    join(projectRoot, 'assets/generated/lyria-launch-bed-v2-neon-reference.mp3'),
);
const voicePath = resolve(
  process.argv[3] ?? join(projectRoot, 'assets/generated/tts-announcer-v1.wav'),
);
const effectsPath = resolve(
  process.argv[4] ?? join(projectRoot, 'assets/launch-mix.wav'),
);
const outputPath = resolve(
  process.argv[5] ??
    join(projectRoot, 'assets/generated/launch-mix-google-v2-neon-reference.wav'),
);

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

const workDir = mkdtempSync(join(tmpdir(), 'insert-player-audio-'));
const premixPath = join(workDir, 'premix.wav');

try {
  const arrangement = [
    '[0:a]asplit=2[music_intro_source][music_groove_source]',
    '[music_intro_source]atrim=start=0:end=4.65,asetpts=PTS-STARTPTS,volume=2dB,volume=\'if(between(t,0.45,4.15),0.5,1)\':eval=frame,afade=t=out:st=4.50:d=0.15[music_intro]',
    '[music_groove_source]atrim=start=13.24:end=20.59,asetpts=PTS-STARTPTS,volume=-3dB,volume=\'if(gte(t,3.25),0.72,1)\':eval=frame,afade=t=in:st=0:d=0.12,afade=t=out:st=6.20:d=1.15,adelay=4650:all=1[music_groove]',
    '[1:a]atrim=start=0:end=3.4,asetpts=PTS-STARTPTS,volume=-1.5dB,afade=t=in:st=0:d=0.03,afade=t=out:st=3.25:d=0.15,adelay=550:all=1[voice]',
    '[2:a]atrim=start=0:end=12,asetpts=PTS-STARTPTS,volume=4dB[effects]',
    '[music_intro][music_groove][voice][effects]amix=inputs=4:duration=longest:dropout_transition=0,highpass=f=45,acompressor=threshold=-12dB:ratio=2:attack=10:release=120:makeup=2,atrim=start=0:end=12,asetpts=PTS-STARTPTS[premix]',
  ].join(';');

  runFfmpeg([
    '-y',
    '-v',
    'error',
    '-i',
    musicPath,
    '-i',
    voicePath,
    '-i',
    effectsPath,
    '-filter_complex',
    arrangement,
    '-map',
    '[premix]',
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
      'loudnorm=I=-16:LRA=10:TP=-1.5:print_format=json',
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
    'loudnorm=I=-16:LRA=10:TP=-1.5',
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
    normalize,
    '-t',
    '12',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-c:a',
    'pcm_s16le',
    outputPath,
  ]);

  const size = readFileSync(outputPath).byteLength;
  console.log(
    JSON.stringify(
      {
        output: outputPath,
        outputFile: basename(outputPath),
        bytes: size,
        durationSeconds: 12,
        integratedLoudnessTargetLufs: -16,
        truePeakTargetDbfs: -1.5,
        musicIntroSeconds: [0, 4.65],
        musicGrooveSourceSeconds: [13.24, 20.59],
        musicGrooveTimelineSeconds: [4.65, 12],
        voiceTimelineSeconds: [0.55, 3.95],
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
