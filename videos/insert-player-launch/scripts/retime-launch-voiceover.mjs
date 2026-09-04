import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const inputPath = resolve(
  process.argv[2] ?? resolve(projectRoot, 'assets/generated/tts-launch-friends-v4.wav'),
);
const inputTranscriptPath = resolve(
  process.argv[3] ?? resolve(projectRoot, 'assets/generated/tts-launch-friends-v4.transcript.json'),
);
const outputPath = resolve(
  process.argv[4] ?? resolve(projectRoot, 'assets/generated/tts-launch-friends-v5-retimed.wav'),
);
const outputTranscriptPath = outputPath.replace(/\.wav$/i, '.transcript.json');
const finalLockupStartSeconds = 9.58;
const insertedPauseSeconds = 5;
const totalDurationSeconds = 17;

const result = spawnSync(
  'ffmpeg',
  [
    '-y',
    '-v',
    'error',
    '-i',
    inputPath,
    '-filter_complex',
    [
      `[0:a]atrim=start=0:end=${finalLockupStartSeconds},asetpts=PTS-STARTPTS[first]`,
      `anullsrc=r=24000:cl=mono,atrim=duration=${insertedPauseSeconds},asetpts=PTS-STARTPTS[pause]`,
      `[0:a]atrim=start=${finalLockupStartSeconds},asetpts=PTS-STARTPTS[lockup]`,
      `[first][pause][lockup]concat=n=3:v=0:a=1,apad=whole_dur=${totalDurationSeconds},atrim=end=${totalDurationSeconds}[out]`,
    ].join(';'),
    '-map',
    '[out]',
    '-ar',
    '24000',
    '-ac',
    '1',
    '-c:a',
    'pcm_s16le',
    outputPath,
  ],
  { encoding: 'utf8' },
);

if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr.trim()}`);

const transcript = JSON.parse(readFileSync(inputTranscriptPath, 'utf8')).map((word) => {
  if (word.start < finalLockupStartSeconds) return word;
  return {
    ...word,
    start: Number((word.start + insertedPauseSeconds).toFixed(3)),
    end: Number((word.end + insertedPauseSeconds).toFixed(3)),
  };
});
writeFileSync(outputTranscriptPath, `${JSON.stringify(transcript, null, 2)}\n`);

console.log(JSON.stringify({
  outputPath,
  outputTranscriptPath,
  finalLockupStartSeconds: finalLockupStartSeconds + insertedPauseSeconds,
  totalDurationSeconds,
}, null, 2));
