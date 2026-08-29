import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..');
const capturesDir = resolve(projectRoot, 'assets/captures');
const outputPath = resolve(
  process.argv[2] ?? resolve(projectRoot, 'assets/fight-montage-four-stages.mp4'),
);
const manifestPath = outputPath.replace(/\.mp4$/i, '.json');
const leadInSeconds = 0.45;
const clipDurationSeconds = 1;
const transitionHoldSeconds = 0.25;

const fights = [
  { id: 'trump', expectedOpponent: 'Donald Trump' },
  { id: 'lamine', expectedOpponent: 'Lamine Yamal' },
  { id: 'rosalia', expectedOpponent: 'Rosalía V2' },
  { id: 'elon', expectedOpponent: 'Elon Musk' },
];

function firstDamageEvent(events) {
  return events.find((event) => {
    if (event.type !== 'asf-hud-state') return false;
    const { maxHealth, p1Health, p2Health } = event.detail ?? {};
    return Number.isFinite(maxHealth)
      && (p1Health < maxHealth || p2Health < maxHealth);
  });
}

const clips = fights.map(({ id, expectedOpponent }) => {
  const eventsPath = resolve(capturesDir, `${id}-events.json`);
  const masterPath = resolve(capturesDir, `${id}-master.webm`);
  const capture = JSON.parse(readFileSync(eventsPath, 'utf8'));
  const damage = firstDamageEvent(capture.events);

  if (!damage) throw new Error(`No damage event found for ${id}`);
  if (capture.opponent !== expectedOpponent) {
    throw new Error(
      `Expected ${expectedOpponent} for ${id}, received ${capture.opponent}`,
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
    `[${index}:v]trim=start=0:duration=${clipDurationSeconds},setpts=PTS-STARTPTS,`
    + `fps=30,scale=1920:1080:flags=lanczos,setsar=1[v${index}]`,
);
filters.push(
  `${clips.map((_, index) => `[v${index}]`).join('')}concat=n=${clips.length}:v=1:a=0[montage]`,
  `[montage]tpad=stop_mode=clone:stop_duration=${transitionHoldSeconds}[vout]`,
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
    contentDurationSeconds: clips.length * clipDurationSeconds,
    transitionHoldSeconds,
    totalDurationSeconds: clips.length * clipDurationSeconds + transitionHoldSeconds,
    leadInSeconds,
    clips: clips.map(({ source, ...clip }) => clip),
  }, null, 2)}\n`,
);

console.log(JSON.stringify({ outputPath, manifestPath, clips }, null, 2));
