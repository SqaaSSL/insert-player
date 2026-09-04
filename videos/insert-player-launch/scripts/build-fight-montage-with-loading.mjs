import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const capturesDir = resolve(projectRoot, 'assets/captures');
const outputPath = resolve(
  process.argv[2] ?? resolve(projectRoot, 'assets/fight-montage-player-one-vs-casual-v15.mp4'),
);
const manifestPath = outputPath.replace(/\.mp4$/i, '.json');
const outputFrameRate = 30;
const loadingFrameCount = 72;
const defaultFightFrameCount = 30;
const transitionHoldFrameCount = 8;
const fightLeadSeconds = 0.4;
const openingCaptureId = 'casual-vs-player-one-executive-v3';
const openingDerived = JSON.parse(
  readFileSync(resolve(capturesDir, `${openingCaptureId}.json`), 'utf8'),
);

const fights = [
  {
    id: 'casual-player-one',
    captureId: openingCaptureId,
    prebuilt: {
      fighter: 'Casual',
      opponent: 'Player One',
      stage: openingDerived.stage,
      sourceFile: openingDerived.fight.outputFile,
      sourceStartSeconds: 0,
    },
  },
  {
    id: 'casual-trump',
    captureId: 'casual-vs-player-one-arena',
    expectedFighters: ['Casual'],
    expectedOpponents: ['Donald Trump'],
  },
  {
    id: 'player-one-rosalia',
    captureId: 'rosalia-current2',
    expectedFighters: ['Player One'],
    expectedOpponents: ['Rosalía', 'Rosalía V2'],
  },
  {
    id: 'casual-rosalia',
    captureId: 'rosalia-vs-casual-tablao',
    expectedFighters: ['Rosalía'],
    expectedOpponents: ['Casual'],
  },
  {
    id: 'player-one-elon',
    captureId: 'elon-current2',
    expectedFighters: ['Player One'],
    expectedOpponents: ['Elon Musk'],
  },
  {
    id: 'casual-elon',
    captureId: 'elon-vs-casual-mars',
    expectedFighters: ['Elon Musk'],
    expectedOpponents: ['Casual'],
  },
  {
    id: 'player-one-lamine',
    captureId: 'lamine-current2',
    expectedFighters: ['Player One'],
    expectedOpponents: ['Lamine Yamal'],
  },
  {
    id: 'casual-lamine',
    captureId: 'lamine-vs-casual-jaula',
    expectedFighters: ['Lamine Yamal'],
    expectedOpponents: ['Casual'],
  },
];

function readCapture(captureId) {
  return JSON.parse(readFileSync(resolve(capturesDir, `${captureId}-events.json`), 'utf8'));
}

function firstDamageEvent(events) {
  return events.find((event) => {
    if (event.type !== 'asf-hud-state') return false;
    const { maxHealth, p1Health, p2Health } = event.detail ?? {};
    return Number.isFinite(maxHealth) && (p1Health < maxHealth || p2Health < maxHealth);
  });
}

const loadingClip = {
  id: 'loading-player-one-vs-casual',
  captureId: openingCaptureId,
  fighter: 'Casual',
  opponent: 'Player One',
  stage: openingDerived.stage,
  source: resolve(capturesDir, openingDerived.loader.outputFile),
  sourceFile: openingDerived.loader.outputFile,
  sourceStartSeconds: 0,
  frameCount: loadingFrameCount,
  durationSeconds: loadingFrameCount / outputFrameRate,
};

const fightClips = fights.map(({
  id,
  captureId,
  frameCount = defaultFightFrameCount,
  expectedFighters,
  expectedOpponents,
  prebuilt,
}) => {
  if (prebuilt) {
    return {
      id,
      captureId,
      ...prebuilt,
      source: resolve(capturesDir, prebuilt.sourceFile),
      frameCount,
      durationSeconds: frameCount / outputFrameRate,
    };
  }
  const capture = readCapture(captureId);
  const damage = firstDamageEvent(capture.events);
  if (!damage) throw new Error(`No damage event found for ${id}`);
  if (expectedFighters && !expectedFighters.includes(capture.fighter)) {
    throw new Error(`Expected ${expectedFighters.join(' or ')} as fighter for ${id}, received ${capture.fighter}`);
  }
  if (!expectedOpponents.includes(capture.opponent)) {
    throw new Error(`Expected ${expectedOpponents.join(' or ')} for ${id}, received ${capture.opponent}`);
  }

  const damageOffsetSeconds = Number(((damage.at - capture.videoStartedAt) / 1000).toFixed(3));
  return {
    id,
    captureId,
    fighter: capture.fighter,
    opponent: capture.opponent,
    stage: String(damage.detail?.matchLabel ?? '').replace(/ · SIGNATURE MATCH$/, ''),
    source: resolve(capturesDir, `${captureId}-master.webm`),
    sourceFile: `${captureId}-master.webm`,
    sourceStartSeconds: Number(Math.max(0, damageOffsetSeconds - fightLeadSeconds).toFixed(3)),
    damageOffsetSeconds,
    frameCount,
    durationSeconds: frameCount / outputFrameRate,
  };
});

const clips = [loadingClip, ...fightClips];
const inputArgs = clips.flatMap((clip) => [
  '-ss',
  clip.sourceStartSeconds.toFixed(3),
  '-t',
  (clip.durationSeconds + 0.1).toFixed(3),
  '-i',
  clip.source,
]);
const filters = clips.map(
  (clip, index) =>
    `[${index}:v]fps=${outputFrameRate},trim=start_frame=0:end_frame=${clip.frameCount},`
    + `setpts=N/(${outputFrameRate}*TB),scale=1920:1080:flags=lanczos,setsar=1[v${index}]`,
);
const contentFrameCount = loadingFrameCount
  + fightClips.reduce((total, clip) => total + clip.frameCount, 0);
const totalFrameCount = contentFrameCount + transitionHoldFrameCount;
filters.push(
  `${clips.map((_, index) => `[v${index}]`).join('')}concat=n=${clips.length}:v=1:a=0[montage]`,
  `[montage]tpad=stop_mode=clone:stop_duration=${transitionHoldFrameCount / outputFrameRate},`
    + `trim=start_frame=0:end_frame=${totalFrameCount},setpts=N/(${outputFrameRate}*TB)[vout]`,
);

const result = spawnSync(
  'ffmpeg',
  [
    '-y',
    '-v',
    'error',
    ...inputArgs,
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[vout]',
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '8',
    '-g',
    String(outputFrameRate),
    '-keyint_min',
    String(outputFrameRate),
    '-sc_threshold',
    '0',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    outputPath,
  ],
  { encoding: 'utf8' },
);
if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr.trim()}`);

writeFileSync(manifestPath, `${JSON.stringify({
  outputFile: basename(outputPath),
  outputFrameRate,
  loadingFrameCount,
  defaultFightFrameCount,
  transitionHoldFrameCount,
  totalFrameCount,
  totalDurationSeconds: totalFrameCount / outputFrameRate,
  clips: clips.map(({ source, ...clip }) => clip),
}, null, 2)}\n`);

console.log(JSON.stringify({ outputPath, manifestPath, totalFrameCount, clips }, null, 2));
