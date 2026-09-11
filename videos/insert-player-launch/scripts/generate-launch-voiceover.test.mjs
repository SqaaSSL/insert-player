import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const runner = resolve(import.meta.dirname, 'generate-launch-voiceover.mjs');
const prompt = 'One character. Three games.';
const requestHash = createHash('sha256').update(JSON.stringify({ text: prompt, voice: 'Orus', engine: 'gemini', language: 'en' })).digest('hex');

test('an uncertain submission fails closed without a second provider request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'voiceover-journal-'));
  try {
    const input = join(dir, 'prompt.txt');
    const output = join(dir, 'take-v1.wav');
    writeFileSync(input, prompt);
    writeFileSync(`${output}.submission.json`, JSON.stringify({ baseUrl: 'http://127.0.0.1:1', requestHash, state: 'submitting' }));
    const result = await run(input, output, 'http://127.0.0.1:1');
    assert.equal(result.code, 1);
    assert.match(result.text, /Submission outcome is unknown/);
    assert.doesNotMatch(result.text, /fetch failed/);
  } finally { rmSync(dir, { recursive: true }); }
});

test('resume downloads the already-paid job with GET only, then reuses the local file', async () => {
  const requests = [];
  let baseUrl;
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.url === '/audio.wav') {
      const wav = Buffer.alloc(44 + 4800);
      wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
      wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
      wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
      wav.write('data', 36); wav.writeUInt32LE(4800, 40);
      res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(wav); return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url.endsWith('/result')
      ? { assets: [{ kind: 'audio', url: `${baseUrl}/audio.wav` }] }
      : { status: 'completed', cost: 60000 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), 'voiceover-resume-'));
  try {
    const input = join(dir, 'prompt.txt');
    const output = join(dir, 'take-v1.wav');
    writeFileSync(input, prompt);
    writeFileSync(`${output}.submission.json`, JSON.stringify({ baseUrl, requestHash, submission: { job_id: 'paid-job', model: 'gemini-tts' } }));
    assert.equal((await run(input, output, baseUrl)).code, 0);
    assert.deepEqual(requests, ['GET /api/v1/jobs/paid-job', 'GET /api/v1/jobs/paid-job/result', 'GET /audio.wav']);
    assert.equal(JSON.parse(readFileSync(`${output}.meta.json`)).providerJobId, 'paid-job');
    assert.equal((await run(input, output, baseUrl)).code, 0);
    assert.equal(requests.length, 3);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true });
  }
});

function run(input, output, baseUrl) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [runner, input, output], { env: { ...process.env, METERKEY_API_KEY: 'mock-not-a-key', PIXCLI_BASE_URL: baseUrl } });
    let text = '';
    child.stdout.on('data', chunk => { text += chunk; });
    child.stderr.on('data', chunk => { text += chunk; });
    child.on('close', code => resolve({ code, text }));
  });
}
