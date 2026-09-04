import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const defaultStart = resolve(projectRoot, 'assets/generated/omni-start.png');
const defaultEnd = resolve(projectRoot, 'assets/generated/omni-end.png');
const defaultPrompt = resolve(projectRoot, 'prompts/omni-photo-to-fighter-v1.txt');
const defaultOutput = resolve(projectRoot, 'assets/generated/omni-photo-to-fighter-v1.mp4');

const startPath = resolve(process.argv[2] ?? defaultStart);
const endPath = resolve(process.argv[3] ?? defaultEnd);
const outputPath = resolve(process.argv[4] ?? defaultOutput);
const promptPath = resolve(process.env.OMNI_PROMPT_PATH ?? defaultPrompt);
const apiKey = String(process.env.GEMINI_API_KEY ?? '').trim();

if (!apiKey) throw new Error('GEMINI_API_KEY is required in the environment');

const [startBytes, endBytes, promptBytes] = await Promise.all([
  readFile(startPath),
  readFile(endPath),
  readFile(promptPath),
]);
const prompt = promptBytes.toString('utf8').trim();

const requestBody = {
  model: 'gemini-omni-1.1-flash',
  input: [
    { type: 'image', data: startBytes.toString('base64'), mime_type: 'image/png' },
    { type: 'image', data: endBytes.toString('base64'), mime_type: 'image/png' },
    { type: 'text', text: prompt },
  ],
  response_format: {
    type: 'video',
    aspect_ratio: '16:9',
    resolution: '720p',
  },
  background: false,
  store: false,
  stream: false,
};

const interactionResponse = await fetch(
  'https://generativelanguage.googleapis.com/v1beta/interactions',
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(requestBody),
  },
);

const responseText = await interactionResponse.text();
let interaction;
try {
  interaction = JSON.parse(responseText);
} catch {
  throw new Error(`Gemini Omni returned non-JSON (${interactionResponse.status})`);
}

if (!interactionResponse.ok) {
  const message = interaction?.error?.message ?? interaction?.message ?? 'unknown error';
  throw new Error(`Gemini Omni failed (${interactionResponse.status}): ${message}`);
}

const content = (interaction.steps ?? [])
  .flatMap((step) => step.content ?? [])
  .find((item) => item.type === 'video');

let videoBytes;
if (content?.data) {
  videoBytes = Buffer.from(content.data, 'base64');
} else if (content?.uri) {
  const uri = new URL(content.uri);
  if (!uri.searchParams.has('key')) uri.searchParams.set('key', apiKey);
  const downloadResponse = await fetch(uri);
  if (!downloadResponse.ok) {
    throw new Error(`Gemini video download failed (${downloadResponse.status})`);
  }
  videoBytes = Buffer.from(await downloadResponse.arrayBuffer());
} else {
  throw new Error('Gemini Omni returned no video payload');
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, videoBytes);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const metadata = {
  status: 'candidate',
  model: 'gemini-omni-1.1-flash',
  accessPath: 'gemini-interactions-api',
  interactionId: interaction.id ?? null,
  promptFile: basename(promptPath),
  promptSha256: sha256(promptBytes),
  sourceFiles: [basename(startPath), basename(endPath)],
  sourceSha256: [sha256(startBytes), sha256(endBytes)],
  outputFile: basename(outputPath),
  outputSha256: sha256(videoBytes),
  responseFormat: requestBody.response_format,
  store: false,
};
await writeFile(`${outputPath}.meta.json`, `${JSON.stringify(metadata, null, 2)}\n`);

console.log(JSON.stringify(metadata, null, 2));
