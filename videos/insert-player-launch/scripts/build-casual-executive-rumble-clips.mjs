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
  process.argv[2] ?? resolve(capturesDir, 'casual-vs-player-one-executive-loader-v3.mkv'),
);
const fightOutput = resolve(
  process.argv[3] ?? resolve(capturesDir, 'casual-vs-player-one-executive-fight-v3.mkv'),
);
const manifestOutput = resolve(
  process.argv[4] ?? resolve(capturesDir, 'casual-vs-player-one-executive-v3.json'),
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
    'ffv1',
    '-level',
    '3',
    '-coder',
    '1',
    '-context',
    '1',
    '-g',
    '1',
    '-pix_fmt',
    'yuv444p',
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
    const differenceMask = join(framesDir, `difference-${suffix}.png`);
    const brightMask = join(framesDir, `bright-${suffix}.png`);
    const saturationMask = join(framesDir, `saturation-${suffix}.png`);
    const visibleMask = join(framesDir, `visible-${suffix}.png`);
    const chromaMask = join(framesDir, `chroma-${suffix}.png`);
    const effectColorMask = join(framesDir, `effect-color-${suffix}.png`);
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
      '-fill',
      'black',
      '-draw',
      'rectangle 0,928 1919,952',
      differenceMask,
    ]);
    run('magick', [
      sourceFrame,
      '-colorspace',
      'gray',
      '-threshold',
      '42%',
      brightMask,
    ]);
    run('magick', [
      sourceFrame,
      '-colorspace',
      'HSL',
      '-channel',
      'G',
      '-separate',
      '+channel',
      '-threshold',
      '32%',
      saturationMask,
    ]);
    run('magick', [
      sourceFrame,
      '-colorspace',
      'gray',
      '-threshold',
      '18%',
      visibleMask,
    ]);
    run('magick', [
      saturationMask,
      visibleMask,
      '-compose',
      'multiply',
      '-composite',
      chromaMask,
    ]);
    run('magick', [
      brightMask,
      chromaMask,
      '-evaluate-sequence',
      'max',
      effectColorMask,
    ]);
    run('magick', [
      differenceMask,
      effectColorMask,
      '-compose',
      'multiply',
      '-composite',
      '-morphology',
      'Dilate',
      'Disk:1',
      '-blur',
      '0x0.45',
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
    'ffv1',
    '-level',
    '3',
    '-coder',
    '1',
    '-context',
    '1',
    '-g',
    '1',
    '-pix_fmt',
    'yuv444p',
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
      foregroundExtraction: 'Vision foreground instance mask plus luminance/chroma-gated HUD and effects detail mask',
      detailMaskThresholds: {
        differencePercent: 3,
        brightPercent: 42,
        saturationPercent: 32,
        visibilityPercent: 18,
      },
      excludedDetailBands: [{ y: 928, height: 25, reason: 'placeholder stage floor rule' }],
    },
    intermediateEncoding: 'FFV1 lossless yuv444p',
  };
  writeFileSync(manifestOutput, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ loaderOutput, fightOutput, manifestOutput, ...manifest }, null, 2));
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
