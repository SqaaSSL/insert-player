import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(projectRoot, '../..');
const capturesDir = resolve(projectRoot, 'assets/captures');
const sourceCapture = resolve(capturesDir, 'casual-vs-player-one-master.webm');
const loaderLabelCapture = resolve(capturesDir, 'trump-loader-current-master.webm');
const fightLabelCapture = resolve(capturesDir, 'trump-current2-master.webm');
const stageImage = resolve(
  repoRoot,
  'public/assets/stages/signature/executive-rumble-pipeline-v1.png',
);
const segmentationScript = resolve(import.meta.dirname, 'segment-people.swift');
const loaderOutput = resolve(
  process.argv[2] ?? resolve(capturesDir, 'casual-vs-player-one-executive-loader.mp4'),
);
const fightOutput = resolve(
  process.argv[3] ?? resolve(capturesDir, 'casual-vs-player-one-executive-fight.mp4'),
);
const manifestOutput = resolve(
  process.argv[4] ?? resolve(capturesDir, 'casual-vs-player-one-executive.json'),
);

const frameRate = 30;
const loaderStartSeconds = 7.35;
const loaderFrameCount = 72;
const fightStartSeconds = 12.616;
const fightFrameCount = 30;
const loaderLabelSourceSeconds = 11.3;
const fightLabelSourceSeconds = 13.2;
const loaderLabelCrop = '500x70+710+60';
const fightLabelCrop = '500x32+710+32';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.status !== 0) {
    const detail = options.capture ? result.stderr.trim() : '';
    throw new Error(`${command} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function extractFrame(source, atSeconds, output) {
  run('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-ss',
    String(atSeconds),
    '-i',
    source,
    '-frames:v',
    '1',
    output,
  ]);
}

const workDir = mkdtempSync(join(tmpdir(), 'insert-player-executive-rumble-'));

try {
  const loaderLabelFrame = join(workDir, 'loader-label-source.png');
  const loaderLabelPatch = join(workDir, 'loader-label-patch.png');
  const fightLabelFrame = join(workDir, 'fight-label-source.png');
  const fightLabelPatch = join(workDir, 'fight-label-patch.png');
  const neutralStage = join(workDir, 'neutral-stage.png');
  const framesDir = join(workDir, 'frames');

  run('mkdir', ['-p', framesDir]);
  extractFrame(loaderLabelCapture, loaderLabelSourceSeconds, loaderLabelFrame);
  extractFrame(fightLabelCapture, fightLabelSourceSeconds, fightLabelFrame);
  run('magick', [
    loaderLabelFrame,
    '-crop',
    loaderLabelCrop,
    '+repage',
    loaderLabelPatch,
  ]);
  run('magick', [
    fightLabelFrame,
    '-crop',
    fightLabelCrop,
    '+repage',
    fightLabelPatch,
  ]);

  run('magick', [
    '(',
    '-size',
    '1024x480',
    'gradient:#09111b-#162131',
    ')',
    '(',
    '-size',
    '1024x96',
    'xc:#102030',
    ')',
    '-append',
    '-stroke',
    '#60758d',
    '-strokewidth',
    '3',
    '-draw',
    'line 0,480 1024,480',
    '-filter',
    'triangle',
    '-resize',
    '1920x1080!',
    neutralStage,
  ]);

  run('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-ss',
    String(loaderStartSeconds),
    '-t',
    String(loaderFrameCount / frameRate + 0.1),
    '-i',
    sourceCapture,
    '-loop',
    '1',
    '-framerate',
    String(frameRate),
    '-i',
    loaderLabelPatch,
    '-filter_complex',
    `[0:v]fps=${frameRate},trim=start_frame=0:end_frame=${loaderFrameCount},`
      + `setpts=N/(${frameRate}*TB),scale=1920:1080:flags=lanczos[loader];`
      + '[1:v]format=rgba[patch];'
      + '[loader][patch]overlay=x=710:y=60:shortest=1,format=yuv420p[v]',
    '-map',
    '[v]',
    '-an',
    '-frames:v',
    String(loaderFrameCount),
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '12',
    '-g',
    String(frameRate),
    '-keyint_min',
    String(frameRate),
    '-sc_threshold',
    '0',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    loaderOutput,
  ]);

  run('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-ss',
    String(fightStartSeconds),
    '-t',
    String(fightFrameCount / frameRate + 0.1),
    '-i',
    sourceCapture,
    '-vf',
    `fps=${frameRate},scale=1920:1080:flags=lanczos`,
    '-frames:v',
    String(fightFrameCount),
    join(framesDir, 'source-%03d.png'),
  ]);

  const sourceFrames = readdirSync(framesDir)
    .filter((name) => /^source-\d{3}\.png$/.test(name))
    .sort();
  if (sourceFrames.length !== fightFrameCount) {
    throw new Error(`Expected ${fightFrameCount} fight frames, received ${sourceFrames.length}`);
  }

  for (const sourceFrameName of sourceFrames) {
    const suffix = sourceFrameName.match(/(\d{3})\.png$/)?.[1];
    const sourceFrame = join(framesDir, sourceFrameName);
    const foregroundMask = join(framesDir, `foreground-${suffix}.png`);
    const detailMask = join(framesDir, `detail-${suffix}.png`);
    const combinedMask = join(framesDir, `combined-${suffix}.png`);
    const outputFrame = join(framesDir, `output-${suffix}.png`);

    run('swift', [segmentationScript, sourceFrame, foregroundMask, 'foreground']);
    run('magick', [
      sourceFrame,
      neutralStage,
      '-compose',
      'difference',
      '-composite',
      '-colorspace',
      'gray',
      '-threshold',
      '3%',
      '-morphology',
      'Dilate',
      'Disk:2',
      '-blur',
      '0x0.7',
      detailMask,
    ]);
    run('magick', [
      foregroundMask,
      detailMask,
      '-evaluate-sequence',
      'max',
      combinedMask,
    ]);
    run('magick', [
      sourceFrame,
      combinedMask,
      '-alpha',
      'off',
      '-compose',
      'CopyOpacity',
      '-composite',
      stageImage,
      '-resize',
      '1920x1080!',
      '-compose',
      'DstOver',
      '-composite',
      fightLabelPatch,
      '-geometry',
      '+710+32',
      '-compose',
      'Over',
      '-composite',
      outputFrame,
    ]);
  }

  run('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-framerate',
    String(frameRate),
    '-i',
    join(framesDir, 'output-%03d.png'),
    '-frames:v',
    String(fightFrameCount),
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '12',
    '-g',
    String(frameRate),
    '-keyint_min',
    String(frameRate),
    '-sc_threshold',
    '0',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    fightOutput,
  ]);

  const manifest = {
    sourceCapture: basename(sourceCapture),
    stage: 'EXECUTIVE RUMBLE',
    stageImage: stageImage.replace(`${repoRoot}/`, ''),
    frameRate,
    loader: {
      outputFile: basename(loaderOutput),
      sourceStartSeconds: loaderStartSeconds,
      frameCount: loaderFrameCount,
      durationSeconds: loaderFrameCount / frameRate,
      sha256: sha256(loaderOutput),
    },
    fight: {
      outputFile: basename(fightOutput),
      sourceStartSeconds: fightStartSeconds,
      frameCount: fightFrameCount,
      durationSeconds: fightFrameCount / frameRate,
      sha256: sha256(fightOutput),
      foregroundExtraction: 'Vision foreground instance mask plus high-contrast HUD and effects detail mask',
    },
  };
  writeFileSync(manifestOutput, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ loaderOutput, fightOutput, manifestOutput, ...manifest }, null, 2));
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
