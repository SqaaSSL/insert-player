import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import {
  BENCHMARK_HARD_CAP_USD,
  BENCHMARK_RUN_ID,
  EXPECTED_INPUTS,
  benchmarkPlanFingerprint,
  buildBenchmarkRequests,
  buildBudgetSummary,
  buildHighKickRefinePrompt,
  buildWalkPrompt,
  type BenchmarkRequestSpec,
  sha256Text,
  validateBenchmarkPlan,
} from './rosterProviderBenchmark.ts';

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SOURCE_DIR, '../../..');
const RUN_DIR = resolve(PROJECT_ROOT, '.qa/provider-benchmark', BENCHMARK_RUN_ID);
const MANIFEST_PATH = resolve(RUN_DIR, 'manifest.json');
const LEDGER_PATH = resolve(RUN_DIR, 'execution-ledger.json');
const REPORT_PATH = resolve(RUN_DIR, 'report.json');
const PRICING_PATH = resolve(RUN_DIR, 'pricing-preflight.json');
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
const FAL_POLL_TIMEOUT_MS = 12 * 60_000;

type JsonRecord = Record<string, unknown>;
type LedgerStatus = 'planned' | 'submitting' | 'queued' | 'completed' | 'failed' | 'unknown';

interface LedgerEntry {
  id: string;
  status: LedgerStatus;
  estimatedFixedUsd: number;
  guardedMaxUsd: number;
  submitStartedAt?: string;
  submittedAt?: string;
  completedAt?: string;
  requestId?: string;
  statusUrl?: string;
  responseUrl?: string;
  providerStatus?: string;
  durationMs?: number;
  outputPath?: string;
  normalizedPath?: string;
  error?: string;
}

interface ExecutionLedger {
  schemaVersion: 1;
  runId: string;
  planFingerprint: string;
  confirmedMaxCostUsd: number;
  maxPaidSubmissions: number;
  submittedCount: number;
  transportRejectedCount?: number;
  transportRejections?: Array<{
    requestId: string;
    rejectedAt: string;
    endpoint: string;
    error: string;
    billedInference: false;
  }>;
  createdAt: string;
  updatedAt: string;
  entries: Record<string, LedgerEntry>;
}

interface ImageMetrics {
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  foregroundFraction: number;
  greenFraction: number;
  transparentFraction: number;
  bbox: { x: number; y: number; width: number; height: number } | null;
  centroid: { x: number; y: number } | null;
}

interface PoseMetrics {
  silhouetteIou: number;
  bboxHeightRatio: number | null;
  centroidDistanceNormalized: number | null;
}

interface CompletedOutput {
  rawPath: string;
  normalizedPath?: string;
  durationMs: number;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function round(value: number, digits = 6): number {
  return Number(value.toFixed(digits));
}

function relativeToProject(path: string): string {
  return relative(PROJECT_ROOT, path).split('\\').join('/');
}

function sha256Buffer(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function assertFrozenSource(
  path: string,
  expected: { width: number; height: number; sha256: string },
): Promise<Buffer> {
  const buffer = await readFile(path);
  const hash = sha256Buffer(buffer);
  if (hash !== expected.sha256) {
    throw new Error(`Fixture hash changed for ${relativeToProject(path)}: ${hash}`);
  }
  const image = await loadImage(buffer);
  if (image.width !== expected.width || image.height !== expected.height) {
    throw new Error(
      `Fixture dimensions changed for ${relativeToProject(path)}: ${image.width}x${image.height}`,
    );
  }
  return buffer;
}

async function prepareFrozenInputs(): Promise<{ impactSha256: string }> {
  const identitySource = resolve(PROJECT_ROOT, EXPECTED_INPUTS.identity.sourcePath);
  const highKickSource = resolve(PROJECT_ROOT, EXPECTED_INPUTS.highKickSheet.sourcePath);
  const walkSource = resolve(PROJECT_ROOT, EXPECTED_INPUTS.currentWalkBaseline.sourcePath);
  const identityTarget = resolve(RUN_DIR, EXPECTED_INPUTS.identity.frozenPath);
  const impactTarget = resolve(RUN_DIR, EXPECTED_INPUTS.highKickImpact.frozenPath);
  const walkTarget = resolve(RUN_DIR, EXPECTED_INPUTS.currentWalkBaseline.frozenPath);

  await mkdir(dirname(identityTarget), { recursive: true });
  await mkdir(dirname(walkTarget), { recursive: true });

  await assertFrozenSource(identitySource, EXPECTED_INPUTS.identity);
  const highKickBuffer = await assertFrozenSource(highKickSource, EXPECTED_INPUTS.highKickSheet);
  await assertFrozenSource(walkSource, EXPECTED_INPUTS.currentWalkBaseline);

  await copyFile(identitySource, identityTarget);
  await copyFile(walkSource, walkTarget);

  const sourceImage = await loadImage(highKickBuffer);
  const crop = EXPECTED_INPUTS.highKickImpact.sourceCrop;
  const canvas = createCanvas(crop.width, crop.height);
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, crop.width, crop.height);
  context.drawImage(
    sourceImage,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    crop.width,
    crop.height,
  );
  const impactBuffer = canvas.toBuffer('image/png');
  await writeFile(impactTarget, impactBuffer, { mode: 0o600 });

  return { impactSha256: sha256Buffer(impactBuffer) };
}

async function buildManifest(): Promise<JsonRecord> {
  const requests = buildBenchmarkRequests();
  validateBenchmarkPlan(requests);
  const budget = buildBudgetSummary(requests);
  const { impactSha256 } = await prepareFrozenInputs();
  const promptDir = resolve(RUN_DIR, 'prompts');
  await mkdir(promptDir, { recursive: true });
  await writeFile(resolve(promptDir, 'walk.txt'), buildWalkPrompt(), { mode: 0o600 });
  await writeFile(resolve(promptDir, 'high-kick-refine.txt'), buildHighKickRefinePrompt(), { mode: 0o600 });

  const sourceFiles = ['src/services/GeminiApi.ts', 'src/services/AnimationProfiles.ts'];
  const sourceFingerprints: Record<string, string> = {};
  for (const sourceFile of sourceFiles) {
    sourceFingerprints[sourceFile] = sha256Buffer(await readFile(resolve(PROJECT_ROOT, sourceFile)));
  }

  const manifest: JsonRecord = {
    schemaVersion: 1,
    runId: BENCHMARK_RUN_ID,
    generatedAt: new Date().toISOString(),
    planFingerprint: benchmarkPlanFingerprint(requests),
    scope: {
      planA: 'Current Gemini provider; one WALK 4x4 sheet at 4K. Architecture experiment only.',
      planB: 'Unchanged refined architecture; same HIGH_KICK identity and pose inputs across six renderers.',
      productionArchitectureChanged: false,
      testSubjects: 'synthetic QA assets only',
    },
    safety: {
      hardCapUsd: BENCHMARK_HARD_CAP_USD,
      maxPaidSubmissions: 7,
      automaticGenerationRetries: 0,
      requiresExecuteFlag: true,
      requiresRunConfirmation: BENCHMARK_RUN_ID,
      durablePreSubmitLedger: true,
    },
    budget,
    inputs: {
      identity: { ...EXPECTED_INPUTS.identity },
      highKickImpact: {
        ...EXPECTED_INPUTS.highKickImpact,
        sha256: impactSha256,
      },
      currentWalkBaseline: { ...EXPECTED_INPUTS.currentWalkBaseline },
    },
    prompts: {
      walk: {
        path: 'prompts/walk.txt',
        characters: buildWalkPrompt().length,
        sha256: sha256Text(buildWalkPrompt()),
      },
      highKickRefine: {
        path: 'prompts/high-kick-refine.txt',
        characters: buildHighKickRefinePrompt().length,
        sha256: sha256Text(buildHighKickRefinePrompt()),
      },
    },
    sourceFingerprints,
    requests,
    notes: [
      'BFL and Seedream are executed through fal because direct BFL/BytePlus keys are not present locally.',
      'The guarded budget uses fal distributor pricing, not lower BFL direct pricing.',
      'Gemini input reserves are deliberately conservative and are not quoted fixed charges.',
      'Plan B outputs are normalized locally to 768x1024 for visual comparison.',
      'Queue status polling and result downloads may repeat; generation submissions may not.',
      'Every fal submit sets X-Fal-No-Retry: 1 to disable provider-side automatic queue retries.',
      'fal FLUX.2 Flash currently bills per compute-second; its USD 0.050 guard is intentionally above the page estimate.',
    ],
  };

  await atomicWriteJson(MANIFEST_PATH, manifest);
  return manifest;
}

function parseEnv(contents: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

async function loadSecrets(): Promise<{ gemini: string; fal: string }> {
  const dotenv = parseEnv(await readFile(resolve(PROJECT_ROOT, '.env'), 'utf8'));
  const gemini = process.env.GEMINI_API_KEY?.trim() || dotenv.GEMINI_API_KEY?.trim();
  const fal = process.env.FAL_API_KEY?.trim() || dotenv.FAL_API_KEY?.trim();
  if (!gemini || gemini.toLowerCase().includes('replace_me')) {
    throw new Error('GEMINI_API_KEY is missing. No paid requests were sent.');
  }
  if (!fal || fal.toLowerCase().includes('replace_me')) {
    throw new Error('FAL_API_KEY is missing. No paid requests were sent.');
  }
  return { gemini, fal };
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[A-Za-z0-9_-]{32,}/g, '<redacted>').slice(0, 600);
}

function sanitizeRemoteUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '<invalid-url>';
  }
}

function requireFalUrl(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`fal ${label} is missing`);
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'queue.fal.run') {
    throw new Error(`fal returned an unexpected ${label} host`);
  }
  return url.toString();
}

async function pricingPreflight(falKey: string): Promise<JsonRecord> {
  const requests = buildBenchmarkRequests().filter((request) => request.adapter === 'fal');
  const byModel: Record<string, unknown> = {};
  for (const request of requests) {
    const url = new URL('https://api.fal.ai/v1/models/pricing');
    url.searchParams.set('endpoint_id', request.model);
    const response = await fetch(url, {
      headers: { Authorization: `Key ${falKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();
    let parsed: unknown = body;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      // Keep the bounded text for diagnostics.
    }
    byModel[request.model] = {
      httpStatus: response.status,
      ok: response.ok,
      response: typeof parsed === 'string' ? parsed.slice(0, 1_000) : parsed,
    };
  }
  const result: JsonRecord = {
    checkedAt: new Date().toISOString(),
    paidInferenceCalls: 0,
    source: 'https://api.fal.ai/v1/models/pricing',
    models: byModel,
  };
  await atomicWriteJson(PRICING_PATH, result);
  return result;
}

function assertPricingPreflight(value: unknown): void {
  if (!isRecord(value) || !isRecord(value.models)) {
    throw new Error('fal pricing preflight is malformed. No paid requests were sent.');
  }
  const maximumUnitPrices: Record<string, { price: number; unit: string }> = {
    'fal-ai/flux-2/klein/4b/edit': { price: 0.009, unit: 'megapixels' },
    'fal-ai/flux-2/klein/9b/edit': { price: 0.011, unit: 'megapixels' },
    'fal-ai/flux-2-pro/edit': { price: 0.03, unit: 'processed megapixels' },
    'fal-ai/flux-2/flash/edit': { price: 0.0008, unit: 'compute seconds' },
    'fal-ai/bytedance/seedream/v4/edit': { price: 0.03, unit: 'images' },
  };
  for (const [model, maximum] of Object.entries(maximumUnitPrices)) {
    const modelEntry = value.models[model];
    if (!isRecord(modelEntry) || modelEntry.ok !== true || !isRecord(modelEntry.response)) {
      throw new Error(`fal pricing preflight did not succeed for ${model}. No paid requests were sent.`);
    }
    const prices = Array.isArray(modelEntry.response.prices) ? modelEntry.response.prices : [];
    const price = prices[0];
    if (!isRecord(price) || typeof price.unit_price !== 'number' || typeof price.unit !== 'string') {
      throw new Error(`fal pricing preflight returned no usable price for ${model}. No paid requests were sent.`);
    }
    if (price.currency !== 'USD' || price.unit !== maximum.unit || price.unit_price > maximum.price) {
      throw new Error(
        `fal pricing changed for ${model} (${String(price.unit_price)} ${String(price.currency)} per ${price.unit}). No paid requests were sent.`,
      );
    }
  }
}

function hydrateTemplate(value: unknown, replacements: Record<string, string>): unknown {
  if (typeof value === 'string') return replacements[value] ?? value;
  if (Array.isArray(value)) return value.map((item) => hydrateTemplate(item, replacements));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, hydrateTemplate(item, replacements)]),
  );
}

function buildRequestBody(
  request: BenchmarkRequestSpec,
  identityBase64: string,
  impactBase64: string,
): JsonRecord {
  const prompt = request.plan === 'A' ? buildWalkPrompt() : buildHighKickRefinePrompt();
  const hydrated = hydrateTemplate(request.payloadTemplate, {
    '{{IDENTITY_PNG_BASE64}}': identityBase64,
    '{{HIGH_KICK_IMPACT_PNG_BASE64}}': impactBase64,
    '{{IDENTITY_PNG_DATA_URI}}': `data:image/png;base64,${identityBase64}`,
    '{{HIGH_KICK_IMPACT_PNG_DATA_URI}}': `data:image/png;base64,${impactBase64}`,
    '{{PROMPT_FROM:prompts/walk.txt}}': prompt,
    '{{PROMPT_FROM:prompts/high-kick-refine.txt}}': prompt,
  });
  if (!isRecord(hydrated)) throw new Error(`Could not hydrate payload for ${request.id}`);
  return hydrated;
}

function extensionForMime(mimeType: string): string {
  const normalized = mimeType.toLowerCase().split(';')[0]?.trim();
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return '.jpg';
  if (normalized === 'image/webp') return '.webp';
  return '.png';
}

async function writeRawOutput(
  request: BenchmarkRequestSpec,
  bytes: Buffer,
  mimeType: string,
): Promise<{ rawPath: string; normalizedPath?: string }> {
  if (bytes.byteLength <= 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`Unexpected output size for ${request.id}: ${bytes.byteLength} bytes`);
  }
  const outputDir = resolve(RUN_DIR, 'outputs', request.id);
  await mkdir(outputDir, { recursive: true });
  const rawPath = resolve(outputDir, `raw${extensionForMime(mimeType)}`);
  await writeFile(rawPath, bytes, { mode: 0o600 });

  let normalizedPath: string | undefined;
  if (request.output.normalizeWidth && request.output.normalizeHeight) {
    const image = await loadImage(bytes);
    const canvas = createCanvas(request.output.normalizeWidth, request.output.normalizeHeight);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    normalizedPath = resolve(outputDir, 'normalized.png');
    await writeFile(normalizedPath, canvas.toBuffer('image/png'), { mode: 0o600 });
  }
  return { rawPath, normalizedPath };
}

function findGeminiImage(json: unknown): { bytes: Buffer; mimeType: string; metadata: JsonRecord } {
  if (!isRecord(json)) throw new Error('Gemini returned a non-object response');
  const candidates = Array.isArray(json.candidates) ? json.candidates : [];
  const candidate = candidates[0];
  if (!isRecord(candidate) || !isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) {
    throw new Error(`Gemini returned no usable candidate (finishReason: ${String(candidate && isRecord(candidate) ? candidate.finishReason : 'unknown')})`);
  }
  let imageData: { data: string; mimeType: string } | undefined;
  let text = '';
  for (const part of candidate.content.parts) {
    if (!isRecord(part)) continue;
    if (typeof part.text === 'string') text += part.text;
    if (isRecord(part.inlineData) && typeof part.inlineData.data === 'string') {
      imageData = {
        data: part.inlineData.data,
        mimeType: typeof part.inlineData.mimeType === 'string' ? part.inlineData.mimeType : 'image/png',
      };
    }
  }
  if (!imageData) throw new Error(`Gemini returned no image${text ? `: ${text.slice(0, 160)}` : ''}`);
  return {
    bytes: Buffer.from(imageData.data, 'base64'),
    mimeType: imageData.mimeType,
    metadata: {
      finishReason: candidate.finishReason ?? null,
      modelVersion: json.modelVersion ?? null,
      usageMetadata: json.usageMetadata ?? null,
      text: text.slice(0, 500),
    },
  };
}

async function submitGemini(
  request: BenchmarkRequestSpec,
  body: JsonRecord,
  geminiKey: string,
): Promise<CompletedOutput> {
  const startedAt = Date.now();
  const response = await fetch(request.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': geminiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const responseText = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(responseText) as unknown;
  } catch {
    throw new Error(`Gemini HTTP ${response.status}: non-JSON response`);
  }
  if (!response.ok) {
    const message = isRecord(json) && isRecord(json.error) ? json.error.message : responseText;
    throw new Error(`Gemini HTTP ${response.status}: ${String(message).slice(0, 300)}`);
  }
  const output = findGeminiImage(json);
  const paths = await writeRawOutput(request, output.bytes, output.mimeType);
  await atomicWriteJson(resolve(dirname(paths.rawPath), 'provider-metadata.json'), output.metadata);
  return { ...paths, durationMs: Date.now() - startedAt };
}

function extractFalImage(json: unknown): { url: string; mimeType?: string; metadata: JsonRecord } {
  if (!isRecord(json)) throw new Error('fal returned a non-object result');
  const images = Array.isArray(json.images) ? json.images : [];
  const first = images[0];
  if (!isRecord(first) || typeof first.url !== 'string') {
    throw new Error('fal completed but returned no output image URL');
  }
  return {
    url: first.url,
    mimeType: typeof first.content_type === 'string' ? first.content_type : undefined,
    metadata: {
      seed: json.seed ?? null,
      timings: json.timings ?? null,
      hasNsfwConcepts: json.has_nsfw_concepts ?? null,
      prompt: typeof json.prompt === 'string' ? json.prompt.slice(0, 500) : null,
      output: {
        width: first.width ?? null,
        height: first.height ?? null,
        contentType: first.content_type ?? null,
        fileSize: first.file_size ?? null,
        remoteUrl: sanitizeRemoteUrl(first.url),
      },
    },
  };
}

async function downloadFalResult(
  request: BenchmarkRequestSpec,
  resultJson: unknown,
  startedAt: number,
): Promise<CompletedOutput> {
  const image = extractFalImage(resultJson);
  const url = new URL(image.url);
  if (url.protocol !== 'https:') throw new Error('fal returned a non-HTTPS output URL');
  const response = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw new Error(`fal output download failed with HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const mimeType = response.headers.get('content-type') || image.mimeType || 'image/png';
  if (!mimeType.toLowerCase().startsWith('image/')) {
    throw new Error(`fal output has unexpected content type: ${mimeType}`);
  }
  const paths = await writeRawOutput(request, bytes, mimeType);
  await atomicWriteJson(resolve(dirname(paths.rawPath), 'provider-metadata.json'), image.metadata);
  return { ...paths, durationMs: Date.now() - startedAt };
}

function falFailureStatus(status: string): boolean {
  return ['FAILED', 'ERROR', 'CANCELLED', 'CANCELED'].includes(status.toUpperCase());
}

async function pollFal(
  request: BenchmarkRequestSpec,
  ledger: ExecutionLedger,
  falKey: string,
  startedAt: number,
): Promise<CompletedOutput> {
  const entry = ledger.entries[request.id];
  if (!entry?.requestId) throw new Error(`Missing fal request id for ${request.id}`);
  const modelPath = request.model;
  const statusUrl = entry.statusUrl || `https://queue.fal.run/${modelPath}/requests/${entry.requestId}/status?logs=1`;
  const responseUrl = entry.responseUrl || `https://queue.fal.run/${modelPath}/requests/${entry.requestId}`;
  requireFalUrl(statusUrl, 'status URL');
  requireFalUrl(responseUrl, 'response URL');
  const deadline = Date.now() + FAL_POLL_TIMEOUT_MS;
  let consecutivePollErrors = 0;

  while (Date.now() < deadline) {
    let response: Response;
    try {
      response = await fetch(statusUrl, {
        headers: { Authorization: `Key ${falKey}` },
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      consecutivePollErrors += 1;
      if (consecutivePollErrors >= 5) throw new Error('fal status polling failed five times; request was not resubmitted');
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000));
      continue;
    }

    if (!response.ok) {
      consecutivePollErrors += 1;
      if (consecutivePollErrors >= 5) {
        throw new Error(`fal status polling repeatedly returned HTTP ${response.status}; request was not resubmitted`);
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000));
      continue;
    }
    consecutivePollErrors = 0;
    const statusJson = await response.json() as unknown;
    const status = isRecord(statusJson) && typeof statusJson.status === 'string'
      ? statusJson.status.toUpperCase()
      : 'UNKNOWN';
    entry.providerStatus = status;
    entry.status = 'queued';
    ledger.updatedAt = new Date().toISOString();
    await atomicWriteJson(LEDGER_PATH, ledger);

    if (falFailureStatus(status)) throw new Error(`fal generation ended with status ${status}`);
    if (status === 'COMPLETED') {
      const resultResponse = await fetch(responseUrl, {
        headers: { Authorization: `Key ${falKey}` },
        signal: AbortSignal.timeout(60_000),
      });
      if (!resultResponse.ok) throw new Error(`fal result fetch failed with HTTP ${resultResponse.status}`);
      return downloadFalResult(request, await resultResponse.json() as unknown, startedAt);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
  }
  throw new Error('fal polling timed out; the queued request remains resumable and was not resubmitted');
}

async function submitFal(
  request: BenchmarkRequestSpec,
  body: JsonRecord,
  ledger: ExecutionLedger,
  falKey: string,
): Promise<CompletedOutput> {
  const startedAt = Date.now();
  const response = await fetch(request.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Key ${falKey}`,
      'Content-Type': 'application/json',
      'X-Fal-No-Retry': '1',
      'X-Fal-Store-IO': '0',
      'X-Fal-Object-Lifecycle-Preference': JSON.stringify({
        expiration_duration_seconds: 3_600,
      }),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const responseText = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(responseText) as unknown;
  } catch {
    throw new Error(`fal submit HTTP ${response.status}: non-JSON response`);
  }
  if (!response.ok || !isRecord(json)) {
    const detail = isRecord(json) ? json.detail ?? json.error ?? json.message : responseText;
    throw new Error(`fal submit HTTP ${response.status}: ${String(detail).slice(0, 300)}`);
  }
  if (typeof json.request_id !== 'string') throw new Error('fal submit returned no request_id');
  const entry = ledger.entries[request.id];
  if (!entry) throw new Error(`Missing ledger entry for ${request.id}`);
  entry.requestId = json.request_id;
  entry.statusUrl = typeof json.status_url === 'string'
    ? requireFalUrl(json.status_url, 'status URL')
    : `https://queue.fal.run/${request.model}/requests/${json.request_id}/status?logs=1`;
  entry.responseUrl = typeof json.response_url === 'string'
    ? requireFalUrl(json.response_url, 'response URL')
    : `https://queue.fal.run/${request.model}/requests/${json.request_id}`;
  entry.status = 'queued';
  entry.submittedAt = new Date().toISOString();
  ledger.updatedAt = entry.submittedAt;
  await atomicWriteJson(LEDGER_PATH, ledger);
  return pollFal(request, ledger, falKey, startedAt);
}

async function loadOrCreateLedger(confirmedMaxCostUsd: number): Promise<ExecutionLedger> {
  const requests = buildBenchmarkRequests();
  const fingerprint = benchmarkPlanFingerprint(requests);
  if (await exists(LEDGER_PATH)) {
    const existing = await readJson(LEDGER_PATH);
    if (!isRecord(existing) || existing.planFingerprint !== fingerprint || existing.runId !== BENCHMARK_RUN_ID) {
      throw new Error('Existing execution ledger does not match this frozen benchmark. Refusing to submit.');
    }
    return existing as unknown as ExecutionLedger;
  }
  const now = new Date().toISOString();
  const entries = Object.fromEntries(requests.map((request) => [
    request.id,
    {
      id: request.id,
      status: 'planned',
      estimatedFixedUsd: request.estimatedFixedUsd,
      guardedMaxUsd: request.guardedMaxUsd,
    } satisfies LedgerEntry,
  ]));
  const ledger: ExecutionLedger = {
    schemaVersion: 1,
    runId: BENCHMARK_RUN_ID,
    planFingerprint: fingerprint,
    confirmedMaxCostUsd,
    maxPaidSubmissions: requests.length,
    submittedCount: 0,
    createdAt: now,
    updatedAt: now,
    entries,
  };
  await atomicWriteJson(LEDGER_PATH, ledger);
  return ledger;
}

function parseMask(imageData: Uint8ClampedArray, width: number, height: number): {
  foreground: Uint8Array;
  foregroundCount: number;
  greenCount: number;
  transparentCount: number;
  bbox: { x: number; y: number; width: number; height: number } | null;
  centroid: { x: number; y: number } | null;
} {
  const foreground = new Uint8Array(width * height);
  let foregroundCount = 0;
  let greenCount = 0;
  let transparentCount = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let sumX = 0;
  let sumY = 0;

  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    const red = imageData[offset] ?? 0;
    const green = imageData[offset + 1] ?? 0;
    const blue = imageData[offset + 2] ?? 0;
    const alpha = imageData[offset + 3] ?? 0;
    const transparent = alpha < 32;
    const chromaGreen = alpha >= 32 && green >= 145 && green > red * 1.32 && green > blue * 1.32;
    if (transparent) transparentCount += 1;
    if (chromaGreen) greenCount += 1;
    if (transparent || chromaGreen) continue;

    foreground[index] = 1;
    foregroundCount += 1;
    const x = index % width;
    const y = Math.floor(index / width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    sumX += x;
    sumY += y;
  }
  return {
    foreground,
    foregroundCount,
    greenCount,
    transparentCount,
    bbox: foregroundCount > 0
      ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
      : null,
    centroid: foregroundCount > 0
      ? { x: sumX / foregroundCount, y: sumY / foregroundCount }
      : null,
  };
}

async function imageMetrics(path: string): Promise<{ metrics: ImageMetrics; mask: Uint8Array }> {
  const bytes = await readFile(path);
  const image = await loadImage(bytes);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const parsed = parseMask(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
  const pixelCount = canvas.width * canvas.height;
  return {
    metrics: {
      width: canvas.width,
      height: canvas.height,
      bytes: bytes.byteLength,
      sha256: sha256Buffer(bytes),
      foregroundFraction: round(parsed.foregroundCount / pixelCount),
      greenFraction: round(parsed.greenCount / pixelCount),
      transparentFraction: round(parsed.transparentCount / pixelCount),
      bbox: parsed.bbox,
      centroid: parsed.centroid
        ? { x: round(parsed.centroid.x), y: round(parsed.centroid.y) }
        : null,
    },
    mask: parsed.foreground,
  };
}

function comparePose(
  candidate: { metrics: ImageMetrics; mask: Uint8Array },
  pose: { metrics: ImageMetrics; mask: Uint8Array },
): PoseMetrics {
  if (
    candidate.metrics.width !== pose.metrics.width ||
    candidate.metrics.height !== pose.metrics.height ||
    candidate.mask.length !== pose.mask.length
  ) {
    throw new Error('Pose masks have different dimensions');
  }
  let intersection = 0;
  let union = 0;
  for (let index = 0; index < candidate.mask.length; index += 1) {
    const a = candidate.mask[index] === 1;
    const b = pose.mask[index] === 1;
    if (a && b) intersection += 1;
    if (a || b) union += 1;
  }
  const candidateBbox = candidate.metrics.bbox;
  const poseBbox = pose.metrics.bbox;
  const candidateCentroid = candidate.metrics.centroid;
  const poseCentroid = pose.metrics.centroid;
  return {
    silhouetteIou: union > 0 ? round(intersection / union) : 0,
    bboxHeightRatio: candidateBbox && poseBbox && poseBbox.height > 0
      ? round(candidateBbox.height / poseBbox.height)
      : null,
    centroidDistanceNormalized: candidateCentroid && poseCentroid
      ? round(Math.hypot(
        candidateCentroid.x - poseCentroid.x,
        candidateCentroid.y - poseCentroid.y,
      ) / Math.hypot(candidate.metrics.width, candidate.metrics.height))
      : null,
  };
}

async function analyzeWalk(path: string): Promise<JsonRecord> {
  const bytes = await readFile(path);
  const image = await loadImage(bytes);
  const cols = 4;
  const rows = 4;
  const cellWidth = Math.floor(image.width / cols);
  const cellHeight = Math.floor(image.height / rows);
  const cellDir = resolve(dirname(path), 'cells');
  await mkdir(cellDir, { recursive: true });
  const cells: JsonRecord[] = [];

  for (let index = 0; index < cols * rows; index += 1) {
    const canvas = createCanvas(cellWidth, cellHeight);
    const context = canvas.getContext('2d');
    const column = index % cols;
    const row = Math.floor(index / cols);
    context.drawImage(
      image,
      column * cellWidth,
      row * cellHeight,
      cellWidth,
      cellHeight,
      0,
      0,
      cellWidth,
      cellHeight,
    );
    const cellPath = resolve(cellDir, `${String(index).padStart(2, '0')}.png`);
    await writeFile(cellPath, canvas.toBuffer('image/png'), { mode: 0o600 });
    const metrics = (await imageMetrics(cellPath)).metrics;
    cells.push({
      index,
      path: relativeToProject(cellPath),
      occupied: metrics.foregroundFraction >= 0.015,
      metrics,
    });
  }
  const occupiedCells = cells.filter((cell) => cell.occupied === true).length;
  return {
    requestedFrames: 16,
    productionMinimumReliableFrames: 12,
    grid: { cols, rows },
    rawDimensions: { width: image.width, height: image.height },
    cellDimensions: { width: cellWidth, height: cellHeight },
    occupiedCells,
    exact16Occupied: occupiedCells === 16,
    passesProductionCountThreshold: occupiedCells >= 12,
    cells,
  };
}

async function createPlanBContactSheet(completed: Array<{ request: BenchmarkRequestSpec; path: string }>): Promise<string | null> {
  if (completed.length === 0) return null;
  const cardWidth = 384;
  const imageHeight = 512;
  const labelHeight = 44;
  const columns = 3;
  const rows = Math.ceil(completed.length / columns);
  const canvas = createCanvas(columns * cardWidth, rows * (imageHeight + labelHeight));
  const context = canvas.getContext('2d');
  context.fillStyle = '#101010';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.font = '18px sans-serif';
  context.textBaseline = 'middle';

  for (let index = 0; index < completed.length; index += 1) {
    const item = completed[index];
    if (!item) continue;
    const x = (index % columns) * cardWidth;
    const y = Math.floor(index / columns) * (imageHeight + labelHeight);
    const image = await loadImage(await readFile(item.path));
    context.drawImage(image, x, y, cardWidth, imageHeight);
    context.fillStyle = '#101010';
    context.fillRect(x, y + imageHeight, cardWidth, labelHeight);
    context.fillStyle = '#ffffff';
    context.fillText(item.request.id.replace(/^plan-b-/, ''), x + 12, y + imageHeight + labelHeight / 2);
  }
  const path = resolve(RUN_DIR, 'plan-b-contact-sheet.png');
  await writeFile(path, canvas.toBuffer('image/png'), { mode: 0o600 });
  return path;
}

async function createPlanBBlindContactSheet(
  completed: Array<{ request: BenchmarkRequestSpec; path: string }>,
): Promise<string | null> {
  if (completed.length === 0) return null;
  const blindOrder = [
    'plan-b-seedream-4-via-fal',
    'plan-b-bfl-klein-9b-via-fal',
    'plan-b-gemini-flash-control',
    'plan-b-flux2-flash-via-fal',
    'plan-b-bfl-pro-via-fal',
    'plan-b-bfl-klein-4b-via-fal',
  ];
  const byId = new Map(completed.map((item) => [item.request.id, item]));
  const ordered = blindOrder.map((id) => byId.get(id)).filter((item) => item !== undefined);
  const cardWidth = 384;
  const imageHeight = 512;
  const labelHeight = 44;
  const columns = 3;
  const rows = Math.ceil(ordered.length / columns);
  const canvas = createCanvas(columns * cardWidth, rows * (imageHeight + labelHeight));
  const context = canvas.getContext('2d');
  context.fillStyle = '#101010';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.font = 'bold 22px sans-serif';
  context.textBaseline = 'middle';
  const mapping: Record<string, string> = {};

  for (let index = 0; index < ordered.length; index += 1) {
    const item = ordered[index];
    if (!item) continue;
    const code = String.fromCharCode(65 + index);
    mapping[code] = item.request.id;
    const x = (index % columns) * cardWidth;
    const y = Math.floor(index / columns) * (imageHeight + labelHeight);
    const image = await loadImage(await readFile(item.path));
    context.drawImage(image, x, y, cardWidth, imageHeight);
    context.fillStyle = '#101010';
    context.fillRect(x, y + imageHeight, cardWidth, labelHeight);
    context.fillStyle = '#ffffff';
    context.fillText(`Candidate ${code}`, x + 12, y + imageHeight + labelHeight / 2);
  }
  const path = resolve(RUN_DIR, 'plan-b-blind-contact-sheet.png');
  await writeFile(path, canvas.toBuffer('image/png'), { mode: 0o600 });
  await atomicWriteJson(resolve(RUN_DIR, 'plan-b-blind-map.json'), mapping);
  return path;
}

async function createPlanAComparison(newWalkPath: string): Promise<string> {
  const baselinePath = resolve(RUN_DIR, EXPECTED_INPUTS.currentWalkBaseline.frozenPath);
  const items = [
    { label: 'Current WALK baseline', path: baselinePath },
    { label: 'Plan A: Gemini 4K sheet', path: newWalkPath },
  ];
  const cardWidth = 512;
  const imageHeight = 683;
  const labelHeight = 48;
  const canvas = createCanvas(cardWidth * items.length, imageHeight + labelHeight);
  const context = canvas.getContext('2d');
  context.fillStyle = '#101010';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.font = '19px sans-serif';
  context.textBaseline = 'middle';
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item) continue;
    const image = await loadImage(await readFile(item.path));
    const x = index * cardWidth;
    context.drawImage(image, x, 0, cardWidth, imageHeight);
    context.fillStyle = '#101010';
    context.fillRect(x, imageHeight, cardWidth, labelHeight);
    context.fillStyle = '#ffffff';
    context.fillText(item.label, x + 12, imageHeight + labelHeight / 2);
  }
  const path = resolve(RUN_DIR, 'plan-a-comparison.png');
  await writeFile(path, canvas.toBuffer('image/png'), { mode: 0o600 });
  return path;
}

async function rebuildReport(ledger: ExecutionLedger): Promise<JsonRecord> {
  const requests = buildBenchmarkRequests();
  const impactPath = resolve(RUN_DIR, EXPECTED_INPUTS.highKickImpact.frozenPath);
  const pose = await imageMetrics(impactPath);
  const results: JsonRecord[] = [];
  const planBCompleted: Array<{ request: BenchmarkRequestSpec; path: string }> = [];
  let planAComparisonPath: string | null = null;

  for (const request of requests) {
    const entry = ledger.entries[request.id];
    const result: JsonRecord = {
      id: request.id,
      plan: request.plan,
      supplier: request.supplier,
      distributor: request.distributor,
      model: request.model,
      status: entry?.status ?? 'missing',
      estimatedFixedUsd: request.estimatedFixedUsd,
      guardedMaxUsd: request.guardedMaxUsd,
      durationMs: entry?.durationMs ?? null,
      error: entry?.error ?? null,
    };
    if (entry?.status === 'completed' && entry.outputPath) {
      const rawPath = resolve(PROJECT_ROOT, entry.outputPath);
      result.rawPath = entry.outputPath;
      result.rawMetrics = (await imageMetrics(rawPath)).metrics;
      if (request.plan === 'A') {
        result.walkContract = await analyzeWalk(rawPath);
        planAComparisonPath = await createPlanAComparison(rawPath);
      }
      if (entry.normalizedPath) {
        const normalizedPath = resolve(PROJECT_ROOT, entry.normalizedPath);
        const candidate = await imageMetrics(normalizedPath);
        result.normalizedPath = entry.normalizedPath;
        result.normalizedMetrics = candidate.metrics;
        result.poseMetrics = comparePose(candidate, pose);
        planBCompleted.push({ request, path: normalizedPath });
      }
    }
    results.push(result);
  }

  const contactSheetPath = await createPlanBContactSheet(planBCompleted);
  const blindContactSheetPath = await createPlanBBlindContactSheet(planBCompleted);
  const report: JsonRecord = {
    schemaVersion: 1,
    runId: BENCHMARK_RUN_ID,
    generatedAt: new Date().toISOString(),
    budget: buildBudgetSummary(requests),
    ledger: {
      submittedCount: ledger.submittedCount,
      completedCount: Object.values(ledger.entries).filter((entry) => entry.status === 'completed').length,
      failedCount: Object.values(ledger.entries).filter((entry) => entry.status === 'failed').length,
      unknownCount: Object.values(ledger.entries).filter((entry) => entry.status === 'unknown').length,
    },
    comparisons: {
      planA: planAComparisonPath ? relativeToProject(planAComparisonPath) : null,
      planB: contactSheetPath ? relativeToProject(contactSheetPath) : null,
      planBBlind: blindContactSheetPath ? relativeToProject(blindContactSheetPath) : null,
    },
    metricsCaveat: 'Silhouette metrics measure pose/framing only. Identity, hands, clothing fidelity, and visual quality require blind visual review.',
    results,
  };
  await atomicWriteJson(REPORT_PATH, report);
  return report;
}

function parseMaxCost(args: string[]): number {
  const value = args.find((arg) => arg.startsWith('--max-cost-usd='))?.split('=')[1];
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('--max-cost-usd must be a positive number');
  return parsed;
}

function assertPaidConfirmation(args: string[], maxCostUsd: number): void {
  if (!args.includes('--execute')) {
    throw new Error('Paid execution requires the explicit --execute flag.');
  }
  if (!args.includes(`--confirm-paid-benchmark=${BENCHMARK_RUN_ID}`)) {
    throw new Error(`Paid execution requires --confirm-paid-benchmark=${BENCHMARK_RUN_ID}.`);
  }
  const guarded = buildBudgetSummary().combinedGuardedUsd;
  if (maxCostUsd > BENCHMARK_HARD_CAP_USD) {
    throw new Error(`Refusing a cap above the approved USD ${BENCHMARK_HARD_CAP_USD.toFixed(2)}.`);
  }
  if (maxCostUsd < guarded) {
    throw new Error(`The supplied cap is below the guarded plan estimate of USD ${guarded.toFixed(3)}.`);
  }
}

async function executeBenchmark(args: string[]): Promise<void> {
  await buildManifest();
  const maxCostUsd = parseMaxCost(args);
  assertPaidConfirmation(args, maxCostUsd);
  const secrets = await loadSecrets();
  if (!(await exists(PRICING_PATH))) {
    await pricingPreflight(secrets.fal);
  }
  assertPricingPreflight(await readJson(PRICING_PATH));
  const ledger = await loadOrCreateLedger(maxCostUsd);
  const requests = buildBenchmarkRequests();
  const identityBase64 = (await readFile(resolve(RUN_DIR, EXPECTED_INPUTS.identity.frozenPath))).toString('base64');
  const impactBase64 = (await readFile(resolve(RUN_DIR, EXPECTED_INPUTS.highKickImpact.frozenPath))).toString('base64');

  for (const request of requests) {
    const entry = ledger.entries[request.id];
    if (!entry) throw new Error(`Ledger entry missing for ${request.id}`);
    if (entry.status === 'completed' || entry.status === 'failed') {
      console.log(`[skip] ${request.id}: ${entry.status}`);
      continue;
    }
    if (entry.status === 'submitting' || entry.status === 'unknown') {
      entry.status = 'unknown';
      entry.error = 'Submission outcome is unknown; automatic resubmission is forbidden.';
      ledger.updatedAt = new Date().toISOString();
      await atomicWriteJson(LEDGER_PATH, ledger);
      console.log(`[blocked] ${request.id}: previous submission outcome unknown; not resubmitted`);
      continue;
    }

    try {
      let completed: CompletedOutput;
      if (entry.status === 'queued') {
        if (request.adapter !== 'fal') throw new Error('Only fal queue entries can resume polling');
        console.log(`[resume] ${request.id}: polling existing request ${entry.requestId ?? '<missing>'}`);
        completed = await pollFal(request, ledger, secrets.fal, Date.now());
      } else {
        if (ledger.submittedCount >= ledger.maxPaidSubmissions) {
          throw new Error('Paid submission count guard reached; no request sent.');
        }
        entry.status = 'submitting';
        entry.submitStartedAt = new Date().toISOString();
        entry.error = undefined;
        ledger.submittedCount += 1;
        ledger.updatedAt = entry.submitStartedAt;
        await atomicWriteJson(LEDGER_PATH, ledger);
        console.log(`[submit ${ledger.submittedCount}/${ledger.maxPaidSubmissions}] ${request.id} (guarded USD ${request.guardedMaxUsd.toFixed(3)})`);
        const body = buildRequestBody(request, identityBase64, impactBase64);
        completed = request.adapter === 'gemini'
          ? await submitGemini(request, body, secrets.gemini)
          : await submitFal(request, body, ledger, secrets.fal);
      }

      entry.status = 'completed';
      entry.completedAt = new Date().toISOString();
      entry.durationMs = completed.durationMs;
      entry.outputPath = relativeToProject(completed.rawPath);
      entry.normalizedPath = completed.normalizedPath ? relativeToProject(completed.normalizedPath) : undefined;
      entry.error = undefined;
      ledger.updatedAt = entry.completedAt;
      await atomicWriteJson(LEDGER_PATH, ledger);
      await rebuildReport(ledger);
      console.log(`[completed] ${request.id} in ${(completed.durationMs / 1_000).toFixed(1)}s`);
    } catch (error) {
      const message = safeError(error);
      if (entry.status === 'submitting' && request.adapter === 'gemini') {
        entry.status = 'failed';
      } else if (entry.status === 'submitting') {
        entry.status = 'unknown';
      } else if (entry.status === 'queued' && /timed out|polling failed|result fetch|download/i.test(message)) {
        entry.status = 'queued';
      } else {
        entry.status = 'failed';
      }
      entry.error = message;
      ledger.updatedAt = new Date().toISOString();
      await atomicWriteJson(LEDGER_PATH, ledger);
      await rebuildReport(ledger);
      console.error(`[${entry.status}] ${request.id}: ${message}`);
    }
  }

  const report = await rebuildReport(ledger);
  console.log(JSON.stringify({
    runId: BENCHMARK_RUN_ID,
    runDirectory: relativeToProject(RUN_DIR),
    report: relativeToProject(REPORT_PATH),
    submittedCount: ledger.submittedCount,
    completedCount: Object.values(ledger.entries).filter((entry) => entry.status === 'completed').length,
    failedCount: Object.values(ledger.entries).filter((entry) => entry.status === 'failed').length,
    unknownCount: Object.values(ledger.entries).filter((entry) => entry.status === 'unknown').length,
    guardedBudgetUsd: buildBudgetSummary().combinedGuardedUsd,
    hardCapUsd: BENCHMARK_HARD_CAP_USD,
    comparisons: report.comparisons,
  }, null, 2));
}

async function repairGeminiTransportRejections(): Promise<void> {
  await buildManifest();
  if (!(await exists(LEDGER_PATH))) throw new Error('No execution ledger exists to repair.');
  const rawLedger = await readJson(LEDGER_PATH);
  if (!isRecord(rawLedger)) throw new Error('Execution ledger is malformed.');
  const ledger = rawLedger as unknown as ExecutionLedger;
  const requests = buildBenchmarkRequests();
  const geminiRequests = requests.filter((request) => request.adapter === 'gemini');
  const eligible: Array<{ request: BenchmarkRequestSpec; entry: LedgerEntry }> = [];

  for (const request of geminiRequests) {
    const entry = ledger.entries[request.id];
    if (
      entry?.status === 'failed' &&
      typeof entry.error === 'string' &&
      entry.error.includes("generation_config.response_format.image") &&
      !entry.outputPath
    ) {
      eligible.push({ request, entry });
    }
  }
  if (eligible.length === 0 && ledger.planFingerprint === benchmarkPlanFingerprint(requests)) {
    console.log(JSON.stringify({ repaired: 0, reason: 'already repaired' }, null, 2));
    return;
  }
  if (eligible.length !== 2) {
    throw new Error(`Expected exactly two non-inference Gemini schema rejections; found ${eligible.length}.`);
  }

  ledger.transportRejections ??= [];
  for (const { request, entry } of eligible) {
    ledger.transportRejections.push({
      requestId: request.id,
      rejectedAt: entry.submitStartedAt ?? new Date().toISOString(),
      endpoint: request.endpoint,
      error: entry.error ?? 'Gemini schema rejection',
      billedInference: false,
    });
    entry.status = 'planned';
    entry.error = undefined;
    entry.submitStartedAt = undefined;
    entry.submittedAt = undefined;
    entry.completedAt = undefined;
    entry.durationMs = undefined;
  }
  ledger.transportRejectedCount = (ledger.transportRejectedCount ?? 0) + eligible.length;
  ledger.submittedCount -= eligible.length;
  if (ledger.submittedCount < 0) throw new Error('Ledger paid submission count would become negative.');
  ledger.planFingerprint = benchmarkPlanFingerprint(requests);
  ledger.updatedAt = new Date().toISOString();
  await atomicWriteJson(LEDGER_PATH, ledger);
  await rebuildReport(ledger);
  console.log(JSON.stringify({
    repaired: eligible.length,
    correction: 'generationConfig.responseFormat.image -> generationConfig.imageConfig',
    paidGenerationAttemptsRestoredTo: ledger.submittedCount,
    transportRejectedCount: ledger.transportRejectedCount,
  }, null, 2));
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'plan';
  const args = process.argv.slice(3);
  if (command === 'plan') {
    const manifest = await buildManifest();
    console.log(JSON.stringify({
      runId: BENCHMARK_RUN_ID,
      runDirectory: relativeToProject(RUN_DIR),
      manifest: relativeToProject(MANIFEST_PATH),
      planFingerprint: manifest.planFingerprint,
      budget: manifest.budget,
      paidInferenceCalls: 0,
    }, null, 2));
    return;
  }
  if (command === 'pricing') {
    await buildManifest();
    const { fal } = await loadSecrets();
    await pricingPreflight(fal);
    console.log(JSON.stringify({
      runId: BENCHMARK_RUN_ID,
      pricing: relativeToProject(PRICING_PATH),
      paidInferenceCalls: 0,
    }, null, 2));
    return;
  }
  if (command === 'execute') {
    await executeBenchmark(args);
    return;
  }
  if (command === 'repair-gemini-transport') {
    await repairGeminiTransportRejections();
    return;
  }
  throw new Error(`Unknown command: ${command}. Use plan, pricing, repair-gemini-transport, or execute.`);
}

await main();
