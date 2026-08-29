import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..');
const capturesDir = resolve(projectRoot, 'assets/captures');
const captureSuffix = String(process.env.INSERT_PLAYER_CAPTURE_SUFFIX ?? '').trim();
const captureIdOverrides = (() => {
  const value = String(process.env.INSERT_PLAYER_CAPTURE_ID_OVERRIDES ?? '').trim();
  if (!value) return {};

  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('INSERT_PLAYER_CAPTURE_ID_OVERRIDES must be a JSON object');
  }

  return Object.fromEntries(Object.entries(parsed).map(([id, captureId]) => {
    if (typeof captureId !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(captureId)) {
      throw new Error(`Invalid capture ID override for ${id}`);
    }
    return [id, captureId];
  }));
})();
const outputPath = resolve(
  process.argv[2] ?? resolve(projectRoot, 'assets/fight-montage-four-stages.mp4'),
);
const manifestPath = outputPath.replace(/\.mp4$/i, '.json');
const leadInSeconds = 0.45;
const requestedClipDurationSeconds = Number(
  process.env.INSERT_PLAYER_CLIP_DURATION_SECONDS ?? 1,
);
const clipDurationSeconds = Number.isFinite(requestedClipDurationSeconds)
  ? Math.min(2, Math.max(0.75, requestedClipDurationSeconds))
  : 1;
const transitionHoldSeconds = 0.25;
const outputFrameRate = 30;
const clipFrameCount = Math.round(clipDurationSeconds * outputFrameRate);
const renderedClipDurationSeconds = clipFrameCount / outputFrameRate;
const transitionHoldFrameCount = Math.round(transitionHoldSeconds * outputFrameRate);
const renderedTransitionHoldSeconds = transitionHoldFrameCount / outputFrameRate;

const fights = [
  { id: 'trump', expectedOpponents: ['Donald Trump'] },
  { id: 'lamine', expectedOpponents: ['Lamine Yamal'] },
  { id: 'rosalia', expectedOpponents: ['Rosalía', 'Rosalía V2'] },
  { id: 'elon', expectedOpponents: ['Elon Musk'] },
];

const unknownOverride = Object.keys(captureIdOverrides)
  .find((id) => !fights.some((fight) => fight.id === id));
if (unknownOverride) {
  throw new Error(`Unknown fight capture override: ${unknownOverride}`);
}

function firstDamageEvent(events) {
  return events.find((event) => {
    if (event.type !== 'asf-hud-state') return false;
    const { maxHealth, p1Health, p2Health } = event.detail ?? {};
    return Number.isFinite(maxHealth)
      && (p1Health < maxHealth || p2Health < maxHealth);
  });
}

const clips = fights.map(({ id, expectedOpponents }) => {
  const captureId = captureIdOverrides[id] ?? `${id}${captureSuffix}`;
  const eventsPath = resolve(capturesDir, `${captureId}-events.json`);
  const masterPath = resolve(capturesDir, `${captureId}-master.webm`);
  const capture = JSON.parse(readFileSync(eventsPath, 'utf8'));
  const damage = firstDamageEvent(capture.events);

  if (!damage) throw new Error(`No damage event found for ${id}`);
  if (!expectedOpponents.includes(capture.opponent)) {
    throw new Error(
      `Expected ${expectedOpponents.join(' or ')} for ${id}, received ${capture.opponent}`,
    );
  }

  const damageOffsetSeconds = Number(
    ((damage.at - capture.videoStartedAt) / 1000).toFixed(3),
  );
  const sourceStartSeconds = Number(
    Math.max(0, damageOffsetSeconds - leadInSeconds).toFixed(3),
  );

  return {
    id,
    captureId,
    opponent: capture.opponent,
    stage: String(damage.detail?.matchLabel ?? '').replace(/ · SIGNATURE MATCH$/, ''),
    source: masterPath,
    sourceFile: basename(masterPath),
    sourceStartSeconds,
    damageOffsetSeconds,
    clipDurationSeconds,
  };
});

const inputArgs = clips.flatMap((clip) => [
  '-ss',
  clip.sourceStartSeconds.toFixed(3),
  '-t',
  (clipDurationSeconds + 0.1).toFixed(3),
  '-i',
  clip.source,
]);
const filters = clips.map(
  (_, index) =>
    `[${index}:v]fps=${outputFrameRate},trim=start_frame=0:end_frame=${clipFrameCount},`
    + `setpts=N/(${outputFrameRate}*TB),scale=1920:1080:flags=lanczos,setsar=1[v${index}]`,
);
const totalFrameCount = clips.length * clipFrameCount + transitionHoldFrameCount;
filters.push(
  `${clips.map((_, index) => `[v${index}]`).join('')}concat=n=${clips.length}:v=1:a=0[montage]`,
  `[montage]tpad=stop_mode=clone:stop_duration=${renderedTransitionHoldSeconds},`
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
    '12',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    outputPath,
  ],
  { encoding: 'utf8' },
);

if (result.status !== 0) {
  throw new Error(`ffmpeg failed: ${result.stderr.trim()}`);
}

writeFileSync(
  manifestPath,
  `${JSON.stringify({
    outputFile: basename(outputPath),
    contentDurationSeconds: clips.length * renderedClipDurationSeconds,
    captureSuffix,
    captureIdOverrides,
    transitionHoldSeconds: renderedTransitionHoldSeconds,
    totalDurationSeconds: totalFrameCount / outputFrameRate,
    outputFrameRate,
    clipFrameCount,
    transitionHoldFrameCount,
    leadInSeconds,
    clips: clips.map(({ source, ...clip }) => clip),
  }, null, 2)}\n`,
);

console.log(JSON.stringify({ outputPath, manifestPath, clips }, null, 2));
