import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = resolve(import.meta.dirname, '..');
const baseUrl = (process.env.PIXCLI_BASE_URL ?? 'https://pixcli.hilo.cx').replace(/\/$/, '');
const apiKey = process.env.METERKEY_API_KEY;
const promptPath = resolve(
  process.argv[2] ?? join(projectRoot, 'prompts/tts-launch-explainer-v2.txt'),
);
const outputPath = resolve(
  process.argv[3] ?? join(projectRoot, 'assets/generated/tts-launch-explainer-v2.wav'),
);
const metadataPath = `${outputPath}.meta.json`;
const journalPath = `${outputPath}.submission.json`;
if (process.argv.includes('--force')) throw new Error('Choose a new version; never overwrite or resubmit an existing take.');

if (!apiKey) {
  throw new Error('METERKEY_API_KEY is required');
}

if (existsSync(outputPath) && existsSync(metadataPath)) {
  console.log(readFileSync(metadataPath, 'utf8'));
  process.exit(0);
}

const prompt = readFileSync(promptPath, 'utf8').trim();
const requestBody = {
  text: prompt,
  voice: 'Orus',
  engine: 'gemini',
  language: 'en',
};

const requestHash = sha256(Buffer.from(JSON.stringify(requestBody)));
let journal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) : null;
if (journal && (journal.requestHash !== requestHash || journal.baseUrl !== baseUrl)) {
  throw new Error('The saved submission belongs to a different request. Choose a new output version.');
}
if (journal && !journal.submission?.job_id) {
  throw new Error('Submission outcome is unknown. Investigate read-only; do not submit again.');
}
if (!journal) {
  journal = { baseUrl, requestHash, requestedAt: new Date().toISOString(), state: 'submitting' };
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, { flag: 'wx' });
  journal.submission = await request('/api/v1/audio/voice', {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
  journal.state = 'submitted';
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
}
const submission = journal.submission;
console.log(`Resumable voiceover job: ${submission.job_id}`);

if (submission.model !== 'gemini-tts') {
  throw new Error(`PixCLI selected unexpected model ${submission.model ?? 'unknown'}`);
}

const deadline = Date.now() + 10 * 60_000;
let status;
do {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  status = await request(`/api/v1/jobs/${encodeURIComponent(submission.job_id)}`);
  if (status.status === 'failed' || status.status === 'cancelled') {
    throw new Error(`Voiceover job ${status.status}: ${status.error ?? 'unknown error'}`);
  }
} while (status.status !== 'completed' && status.status !== 'completed_with_fallback' && Date.now() < deadline);

if (status.status !== 'completed') {
  throw new Error(
    status.status === 'completed_with_fallback'
      ? 'Voiceover completed with a fallback; refusing the result'
      : 'Voiceover job timed out',
  );
}

const result = await request(`/api/v1/jobs/${encodeURIComponent(submission.job_id)}/result`);
journal.state = status.status;
journal.status = status;
writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
const asset = result.assets?.find((candidate) => candidate.kind === 'audio');
if (!asset?.url) {
  throw new Error('Voiceover job returned no audio asset');
}

const audioResponse = await fetch(asset.url, {
  headers: asset.url.startsWith(baseUrl) ? authHeaders(false) : undefined,
});
if (!audioResponse.ok) {
  throw new Error(`Voiceover download failed (${audioResponse.status})`);
}

const audio = Buffer.from(await audioResponse.arrayBuffer());
writeFileSync(outputPath, audio);

const probe = spawnSync(
  'ffprobe',
  [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    outputPath,
  ],
  { encoding: 'utf8' },
);
if (probe.status !== 0) {
  throw new Error(`ffprobe failed for ${basename(outputPath)}`);
}

const metadata = {
  version: Number(outputPath.match(/-v(\d+)\.wav$/)?.[1] ?? 1),
  role: 'launch explainer voiceover',
  model: submission.model,
  upstreamModel: 'gemini-3.1-flash-tts-preview',
  accessPath: 'PixCLI through Meterkey',
  providerJobId: submission.job_id,
  voice: requestBody.voice,
  language: requestBody.language,
  meteredCostMicrocredits: status.cost ?? null,
  promptFile: promptPath.slice(projectRoot.length + 1),
  promptSha256: sha256(Buffer.from(prompt)),
  outputFile: outputPath.slice(projectRoot.length + 1),
  outputSha256: sha256(audio),
  durationSeconds: Number(Number(probe.stdout.trim()).toFixed(3)),
  retries: 0,
  fallbacks: 0,
  published: false,
};

writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
console.log(JSON.stringify(metadata, null, 2));

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...authHeaders(init.body !== undefined),
      ...(init.headers ?? {}),
    },
  });
  const responseText = await response.text();
  const data = responseText ? JSON.parse(responseText) : null;
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} failed (${response.status}): ${responseText.slice(0, 400)}`);
  }
  return data;
}

function authHeaders(json) {
  return {
    authorization: `Bearer ${apiKey}`,
    ...(json ? { 'content-type': 'application/json' } : {}),
  };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
