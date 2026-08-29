import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { installCanvasRuntime } from '../canvasRuntime.ts';
import {
  cleanReposedImagePreserveCanvas,
  cleanSpriteSheet,
  neutralizeGreenSpillForSegmentation,
} from '../../../src/services/SpritePostProcess.ts';
import {
  decontaminateGreenEdges,
  unionForegroundMasks,
} from '../../../src/services/AlphaMask.ts';
import { expandMirroredSequence } from '../../../src/services/FrameSequence.ts';
import {
  BENCHMARK_SEED_REFINE,
  buildHighKickRefinePrompt,
  sha256Text,
} from './rosterProviderBenchmark.ts';
import {
  BIREFNET_MODEL_ID,
  HIGH_KICK_ANCHORS,
  HIGH_KICK_PLAYBACK_ORDER,
} from './flashSequenceBenchmark.ts';
import {
  KLEIN_SEQUENCE_CONFIRMATION,
  KLEIN_SEQUENCE_HARD_CAP_USD,
  KLEIN_SEQUENCE_RUN_ID,
  KLEIN_SEQUENCE_SOURCES,
  KLEIN_VARIANTS,
  buildKleinSequenceRequests,
  kleinSequenceFingerprint,
  kleinSequenceGuardedBudgetUsd,
  validateKleinSequencePlan,
  type KleinSequenceRequest,
  type KleinVariantId,
} from './kleinSequenceBenchmark.ts';

installCanvasRuntime();

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SOURCE_DIR, '../../..');
const RUN_DIR = resolve(PROJECT_ROOT, '.qa/provider-benchmark', KLEIN_SEQUENCE_RUN_ID);
const MANIFEST_PATH = resolve(RUN_DIR, 'manifest.json');
const PRICING_PATH = resolve(RUN_DIR, 'pricing-preflight.json');
const LEDGER_PATH = resolve(RUN_DIR, 'execution-ledger.json');
const BILLING_PATH = resolve(RUN_DIR, 'billing-events.json');
const REPORT_PATH = resolve(RUN_DIR, 'report.json');
const CLEANUP_REPAIR_REPORT_PATH = resolve(RUN_DIR, 'cleanup-repair-report.json');
const LOCK_PATH = resolve(RUN_DIR, 'execution.lock');
const PROMPT_PATH = resolve(RUN_DIR, 'prompts/high-kick-refine.txt');
const IDENTITY_PATH = resolve(RUN_DIR, 'inputs/identity.png');
const PHASE0_LEDGER_PATH = resolve(
  PROJECT_ROOT,
  '.qa/provider-benchmark/phase0-20260822-v1/execution-ledger.json',
);
const MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024;
const POLL_TIMEOUT_MS = 12 * 60_000;

type JsonRecord = Record<string, unknown>;
type LedgerStatus = 'planned' | 'submitting' | 'queued' | 'completed' | 'failed' | 'unknown';

interface LedgerEntry {
  id: string;
  kind: 'generation' | 'cleanup';
  variantId: KleinVariantId;
  frameIndex: number;
  status: LedgerStatus;
  guardedMaxUsd: number;
  submitStartedAt?: string;
  submittedAt?: string;
  completedAt?: string;
  requestId?: string;
  statusUrl?: string;
  responseUrl?: string;
  providerStatus?: string;
  durationMs?: number;
  inferenceSeconds?: number;
  outputPath?: string;
  metadataPath?: string;
  error?: string;
}

interface SequenceLedger {
  schemaVersion: 1;
  runId: string;
  fingerprint: string;
  confirmedMaxCostUsd: number;
  maxPaidSubmissions: number;
  submittedCount: number;
  createdAt: string;
  updatedAt: string;
  entries: Record<string, LedgerEntry>;
}

interface BillingEvent {
  requestId: string;
  endpointId: string;
  timestamp: string;
  outputUnits: number;
  unitPriceUsd: number;
  percentDiscount: number | null;
  costSubtotalUsd: number;
  costDiscountUsd: number;
  costTotalUsd: number;
}

interface BillingReconciliation {
  source: string;
  checkedAt: string;
  currentEvents: BillingEvent[];
  reusedEvents: Record<KleinVariantId, BillingEvent>;
}

interface QueueOutput {
  bytes: Buffer;
  mimeType: string;
  metadata: JsonRecord;
  inferenceSeconds: number | null;
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

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function assertImage(
  path: string,
  expected: { width: number; height: number; sha256: string },
): Promise<Buffer> {
  const bytes = await readFile(path);
  const hash = sha256Buffer(bytes);
  if (hash !== expected.sha256) {
    throw new Error(`Frozen image hash changed for ${relativeToProject(path)}: ${hash}`);
  }
  const image = await loadImage(bytes);
  if (image.width !== expected.width || image.height !== expected.height) {
    throw new Error(`Frozen image dimensions changed for ${relativeToProject(path)}: ${image.width}x${image.height}`);
  }
  return bytes;
}

function anchorPath(frameIndex: number): string {
  return resolve(RUN_DIR, 'inputs/anchors', `frame-${String(frameIndex).padStart(2, '0')}.png`);
}

function variantDir(variantId: KleinVariantId): string {
  return resolve(RUN_DIR, 'outputs', variantId);
}

function frameDir(variantId: KleinVariantId, frameIndex: number): string {
  return resolve(variantDir(variantId), `frame-${String(frameIndex).padStart(2, '0')}`);
}

function rawFramePath(variantId: KleinVariantId, frameIndex: number): string {
  return resolve(frameDir(variantId, frameIndex), 'raw.png');
}

function requestMetadataPath(request: KleinSequenceRequest): string {
  return resolve(
    frameDir(request.variantId, request.frameIndex),
    request.kind === 'generation' ? 'generation-metadata.json' : 'birefnet-metadata.json',
  );
}

async function prepareFrozenInputs(): Promise<void> {
  validateKleinSequencePlan();
  await mkdir(resolve(RUN_DIR, 'inputs/anchors'), { recursive: true });
  await mkdir(resolve(RUN_DIR, 'prompts'), { recursive: true });
  const identitySource = resolve(PROJECT_ROOT, KLEIN_SEQUENCE_SOURCES.identity.path);
  const sheetSource = resolve(PROJECT_ROOT, KLEIN_SEQUENCE_SOURCES.highKickSheet.path);
  await assertImage(identitySource, KLEIN_SEQUENCE_SOURCES.identity);
  const sheetBytes = await assertImage(sheetSource, KLEIN_SEQUENCE_SOURCES.highKickSheet);
  await copyFile(identitySource, IDENTITY_PATH);

  const sheet = await loadImage(sheetBytes);
  for (const anchor of HIGH_KICK_ANCHORS) {
    const canvas = createCanvas(anchor.width, anchor.height);
    canvas.getContext('2d').drawImage(
      sheet,
      anchor.x,
      anchor.y,
      anchor.width,
      anchor.height,
      0,
      0,
      anchor.width,
      anchor.height,
    );
    const bytes = canvas.toBuffer('image/png');
    const hash = sha256Buffer(bytes);
    if (hash !== anchor.sha256) throw new Error(`Anchor ${anchor.frameIndex} hash mismatch: ${hash}`);
    await writeFile(anchorPath(anchor.frameIndex), bytes, { mode: 0o600 });
  }

  for (const variant of KLEIN_VARIANTS) {
    const rawSource = resolve(PROJECT_ROOT, variant.reusedRaw.path);
    await assertImage(rawSource, variant.reusedRaw);
    await mkdir(frameDir(variant.id, 3), { recursive: true });
    await copyFile(rawSource, rawFramePath(variant.id, 3));
    const metadataSource = resolve(PROJECT_ROOT, variant.reusedRaw.metadataPath);
    if (await exists(metadataSource)) {
      await copyFile(metadataSource, resolve(frameDir(variant.id, 3), 'generation-metadata-reused.json'));
    }
  }
  await writeFile(PROMPT_PATH, buildHighKickRefinePrompt(), { mode: 0o600 });
}

async function buildManifest(): Promise<JsonRecord> {
  await prepareFrozenInputs();
  const manifest: JsonRecord = {
    schemaVersion: 1,
    runId: KLEIN_SEQUENCE_RUN_ID,
    createdAt: new Date().toISOString(),
    fingerprint: kleinSequenceFingerprint(),
    purpose: 'Compare FLUX.2 Klein 4B and 9B on all four unique HIGH_KICK refines without changing production architecture.',
    safety: {
      syntheticFixtureOnly: true,
      hardCapUsd: KLEIN_SEQUENCE_HARD_CAP_USD,
      guardedBudgetUsd: kleinSequenceGuardedBudgetUsd(),
      newGenerationSubmissions: 6,
      reusedExactGenerations: 2,
      cleanupSubmissions: 8,
      automaticProviderRetries: 0,
      freepikFallback: false,
      confirmation: KLEIN_SEQUENCE_CONFIRMATION,
    },
    prompt: {
      path: relativeToProject(PROMPT_PATH),
      characters: buildHighKickRefinePrompt().length,
      sha256: sha256Text(buildHighKickRefinePrompt()),
    },
    generation: {
      seed: BENCHMARK_SEED_REFINE,
      imageSize: { width: 864, height: 1152 },
      numInferenceSteps: 4,
      numImages: 1,
      variants: KLEIN_VARIANTS.map((variant) => ({
        id: variant.id,
        model: variant.model,
        expectedRequestCostUsd: variant.expectedRequestCostUsd,
      })),
    },
    cleanup: {
      model: BIREFNET_MODEL_ID,
      primaryPath: 'production neutralize -> chroma -> BiRefNet -> union -> normalize',
      freepikFallbackDisabled: true,
    },
    anchors: HIGH_KICK_ANCHORS.map((anchor) => ({
      ...anchor,
      path: relativeToProject(anchorPath(anchor.frameIndex)),
    })),
    playbackOrder: HIGH_KICK_PLAYBACK_ORDER,
    reusedFrames: KLEIN_VARIANTS.map((variant) => ({
      variantId: variant.id,
      frameIndex: 3,
      source: variant.reusedRaw.path,
      sha256: variant.reusedRaw.sha256,
    })),
    requests: buildKleinSequenceRequests(),
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
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

async function loadFalKey(): Promise<string> {
  const dotenv = parseEnv(await readFile(resolve(PROJECT_ROOT, '.env'), 'utf8'));
  const key = process.env.FAL_API_KEY?.trim() || dotenv.FAL_API_KEY?.trim();
  if (!key || key.toLowerCase().includes('replace_me')) {
    throw new Error('FAL_API_KEY is missing. No paid requests were sent.');
  }
  return key;
}

async function pricingPreflight(falKey: string): Promise<JsonRecord> {
  const expected = new Map<string, { unitPriceUsd: number; unit: string }>([
    ...KLEIN_VARIANTS.map((variant) => [variant.model, {
      unitPriceUsd: variant.unitPriceUsd,
      unit: variant.billingUnit,
    }] as const),
    [BIREFNET_MODEL_ID, { unitPriceUsd: 0.0008, unit: 'compute seconds' }],
  ]);
  const models: Record<string, unknown> = {};
  for (const [model, expectation] of expected) {
    const url = new URL('https://api.fal.ai/v1/models/pricing');
    url.searchParams.set('endpoint_id', model);
    const response = await fetch(url, {
      headers: { Authorization: `Key ${falKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    const json = await response.json() as unknown;
    const prices = isRecord(json) && Array.isArray(json.prices) ? json.prices : [];
    const first = prices[0];
    if (
      !response.ok ||
      !isRecord(first) ||
      first.unit_price !== expectation.unitPriceUsd ||
      first.unit !== expectation.unit
    ) {
      throw new Error(`Unexpected live pricing for ${model}; refusing paid execution.`);
    }
    models[model] = { prices };
  }
  const reusedBilling = await validateReusedBilling(falKey);
  const result: JsonRecord = {
    checkedAt: new Date().toISOString(),
    paidInferenceCalls: 0,
    source: 'https://api.fal.ai/v1/models/pricing',
    expectedTwoReferenceCosts: Object.fromEntries(KLEIN_VARIANTS.map((variant) => [
      variant.id,
      variant.expectedRequestCostUsd,
    ])),
    reusedBilling,
    caveat: 'Klein 4B pricing is inconsistent upstream: the Platform Pricing API reports $0.009/MP, while the public model page and Phase 0 billing event use $0.01/MP. The $0.030/request guard covers a future switch to charging two 1MP references plus the 0.949MP output.',
    models,
  };
  await atomicWriteJson(PRICING_PATH, result);
  return result;
}

async function loadOrCreateLedger(maxCostUsd: number): Promise<SequenceLedger> {
  const fingerprint = kleinSequenceFingerprint();
  if (await exists(LEDGER_PATH)) {
    const existing = await readJson(LEDGER_PATH);
    if (!isRecord(existing) || existing.runId !== KLEIN_SEQUENCE_RUN_ID || existing.fingerprint !== fingerprint) {
      throw new Error('Existing Klein sequence ledger does not match this frozen plan.');
    }
    const ledger = existing as unknown as SequenceLedger;
    const expected = buildKleinSequenceRequests();
    const expectedIds = expected.map((request) => request.id).sort();
    const actualIds = Object.keys(ledger.entries || {}).sort();
    if (
      ledger.schemaVersion !== 1 ||
      ledger.maxPaidSubmissions !== expected.length ||
      !Number.isInteger(ledger.submittedCount) ||
      ledger.submittedCount < 0 ||
      ledger.submittedCount > expected.length ||
      ledger.confirmedMaxCostUsd !== maxCostUsd ||
      JSON.stringify(actualIds) !== JSON.stringify(expectedIds)
    ) {
      throw new Error('Existing Klein sequence ledger schema or counters are invalid.');
    }
    for (const request of expected) {
      const entry = ledger.entries[request.id];
      if (
        !entry ||
        entry.id !== request.id ||
        entry.kind !== request.kind ||
        entry.variantId !== request.variantId ||
        entry.frameIndex !== request.frameIndex ||
        entry.guardedMaxUsd !== request.guardedMaxUsd
      ) throw new Error(`Existing ledger entry mismatch for ${request.id}.`);
    }
    return ledger;
  }
  const now = new Date().toISOString();
  const entries = Object.fromEntries(buildKleinSequenceRequests().map((request) => [
    request.id,
    {
      id: request.id,
      kind: request.kind,
      variantId: request.variantId,
      frameIndex: request.frameIndex,
      status: 'planned',
      guardedMaxUsd: request.guardedMaxUsd,
    } satisfies LedgerEntry,
  ]));
  const ledger: SequenceLedger = {
    schemaVersion: 1,
    runId: KLEIN_SEQUENCE_RUN_ID,
    fingerprint,
    confirmedMaxCostUsd: maxCostUsd,
    maxPaidSubmissions: buildKleinSequenceRequests().length,
    submittedCount: 0,
    createdAt: now,
    updatedAt: now,
    entries,
  };
  await atomicWriteJson(LEDGER_PATH, ledger);
  return ledger;
}

function committedBudget(ledger: SequenceLedger): number {
  return round(Object.values(ledger.entries)
    .filter((entry) => entry.status !== 'failed')
    .reduce((sum, entry) => sum + entry.guardedMaxUsd, 0));
}

function assertBudget(ledger: SequenceLedger): void {
  const committed = committedBudget(ledger);
  if (committed > ledger.confirmedMaxCostUsd || committed > KLEIN_SEQUENCE_HARD_CAP_USD) {
    throw new Error(`Guarded budget is $${committed.toFixed(4)}, above the approved $${KLEIN_SEQUENCE_HARD_CAP_USD.toFixed(2)} cap.`);
  }
}

function requireQueueUrl(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`fal ${label} missing`);
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'queue.fal.run') {
    throw new Error(`fal returned unexpected ${label} host`);
  }
  return url.toString();
}

function sanitizeRemoteUrl(value: string): string {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
}

async function hydrateGenerationBody(request: KleinSequenceRequest): Promise<JsonRecord> {
  const identity = (await readFile(IDENTITY_PATH)).toString('base64');
  const pose = (await readFile(anchorPath(request.frameIndex))).toString('base64');
  return {
    prompt: buildHighKickRefinePrompt(),
    image_urls: [
      `data:image/png;base64,${identity}`,
      `data:image/png;base64,${pose}`,
    ],
    image_size: { width: 864, height: 1152 },
    seed: BENCHMARK_SEED_REFINE,
    sync_mode: false,
    enable_safety_checker: true,
    output_format: 'png',
    num_inference_steps: 4,
    num_images: 1,
  };
}

async function prepareCleanup(
  variantId: KleinVariantId,
  frameIndex: number,
): Promise<JsonRecord> {
  const directory = frameDir(variantId, frameIndex);
  const raw = await readFile(rawFramePath(variantId, frameIndex));
  const neutralized = await neutralizeGreenSpillForSegmentation(raw.toString('base64'));
  const chroma = await cleanReposedImagePreserveCanvas(neutralized);
  await writeFile(resolve(directory, 'neutralized.png'), Buffer.from(neutralized, 'base64'), { mode: 0o600 });
  await writeFile(resolve(directory, 'chroma-only.png'), Buffer.from(chroma, 'base64'), { mode: 0o600 });

  const image = await loadImage(Buffer.from(neutralized, 'base64'));
  const scale = Math.min(1024 / image.width, 1024 / image.height, 1);
  const width = Math.round(image.width * scale);
  const height = Math.round(image.height * scale);
  const canvas = createCanvas(width, height);
  canvas.getContext('2d').drawImage(image, 0, 0, width, height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  const jpegBase64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  await writeFile(resolve(directory, 'birefnet-input.jpg'), Buffer.from(jpegBase64, 'base64'), { mode: 0o600 });
  return { image_url: `data:image/jpeg;base64,${jpegBase64}` };
}

function findFalOutput(
  result: unknown,
  kind: 'generation' | 'cleanup',
): { url: string; mimeType: string; metadata: JsonRecord; inferenceSeconds: number | null } {
  if (!isRecord(result)) throw new Error('fal result is not an object');
  let image: JsonRecord | undefined;
  if (kind === 'generation') {
    const images = Array.isArray(result.images) ? result.images : [];
    image = isRecord(images[0]) ? images[0] : undefined;
  } else {
    image = isRecord(result.image) ? result.image : undefined;
  }
  if (!image || typeof image.url !== 'string') throw new Error(`fal ${kind} returned no output image`);
  const timings = isRecord(result.timings) ? result.timings : null;
  return {
    url: image.url,
    mimeType: typeof image.content_type === 'string' ? image.content_type : 'image/png',
    inferenceSeconds: timings && typeof timings.inference === 'number' ? timings.inference : null,
    metadata: {
      seed: result.seed ?? null,
      timings,
      hasNsfwConcepts: result.has_nsfw_concepts ?? null,
      output: {
        width: image.width ?? null,
        height: image.height ?? null,
        contentType: image.content_type ?? null,
        fileSize: image.file_size ?? null,
        remoteUrl: sanitizeRemoteUrl(image.url),
      },
    },
  };
}

async function downloadQueueOutput(
  result: unknown,
  request: KleinSequenceRequest,
): Promise<QueueOutput> {
  const output = findFalOutput(result, request.kind);
  const url = new URL(output.url);
  if (url.protocol !== 'https:') throw new Error('fal output URL is not HTTPS');
  const response = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw new Error(`fal output download HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length') || '0');
  if (length > MAX_DOWNLOAD_BYTES) throw new Error('fal output exceeds maximum download size');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_DOWNLOAD_BYTES) throw new Error('fal output exceeds maximum download size');
  const image = await loadImage(bytes);
  const expected = request.kind === 'generation'
    ? { width: 864, height: 1152 }
    : { width: 768, height: 1024 };
  if (image.width !== expected.width || image.height !== expected.height) {
    throw new Error(`${request.id} returned ${image.width}x${image.height}; expected ${expected.width}x${expected.height}`);
  }
  return {
    bytes,
    mimeType: response.headers.get('content-type') || output.mimeType,
    metadata: {
      ...output.metadata,
      downloaded: {
        width: image.width,
        height: image.height,
        bytes: bytes.byteLength,
        sha256: sha256Buffer(bytes),
      },
    },
    inferenceSeconds: output.inferenceSeconds,
  };
}

function falFailureStatus(status: string): boolean {
  return ['FAILED', 'ERROR', 'CANCELLED', 'CANCELED'].includes(status.toUpperCase());
}

async function pollQueue(
  request: KleinSequenceRequest,
  entry: LedgerEntry,
  ledger: SequenceLedger,
  falKey: string,
  startedAt: number,
): Promise<QueueOutput> {
  if (!entry.requestId) throw new Error(`Missing request id for ${request.id}`);
  const statusUrl = requireQueueUrl(
    entry.statusUrl || `https://queue.fal.run/${request.model}/requests/${entry.requestId}/status?logs=1`,
    'status URL',
  );
  const responseUrl = requireQueueUrl(
    entry.responseUrl || `https://queue.fal.run/${request.model}/requests/${entry.requestId}`,
    'response URL',
  );
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let consecutiveErrors = 0;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(statusUrl, {
        headers: { Authorization: `Key ${falKey}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`status HTTP ${response.status}`);
      consecutiveErrors = 0;
      const json = await response.json() as unknown;
      const status = isRecord(json) && typeof json.status === 'string' ? json.status.toUpperCase() : 'UNKNOWN';
      entry.providerStatus = status;
      entry.status = 'queued';
      ledger.updatedAt = new Date().toISOString();
      await atomicWriteJson(LEDGER_PATH, ledger);
      if (falFailureStatus(status)) throw new Error(`fal ${request.kind} ended with ${status}`);
      if (status === 'COMPLETED') {
        const result = await fetch(responseUrl, {
          headers: { Authorization: `Key ${falKey}` },
          signal: AbortSignal.timeout(60_000),
        });
        if (!result.ok) throw new Error(`result HTTP ${result.status}`);
        entry.durationMs = Date.now() - startedAt;
        return downloadQueueOutput(await result.json() as unknown, request);
      }
    } catch (error) {
      consecutiveErrors += 1;
      if (consecutiveErrors >= 5) throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
  }
  throw new Error('fal polling timed out; request was not resubmitted');
}

async function submitQueue(
  request: KleinSequenceRequest,
  body: JsonRecord,
  entry: LedgerEntry,
  ledger: SequenceLedger,
  falKey: string,
): Promise<QueueOutput> {
  const startedAt = Date.now();
  const response = await fetch(request.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Key ${falKey}`,
      'Content-Type': 'application/json',
      'X-Fal-No-Retry': '1',
      'X-Fal-Store-IO': '0',
      'X-Fal-Object-Lifecycle-Preference': JSON.stringify({ expiration_duration_seconds: 3_600 }),
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
  if (!response.ok || !isRecord(json) || typeof json.request_id !== 'string') {
    const detail = isRecord(json) ? json.detail ?? json.error ?? json.message : responseText;
    throw new Error(`fal submit HTTP ${response.status}: ${String(detail).slice(0, 300)}`);
  }
  entry.requestId = json.request_id;
  entry.statusUrl = typeof json.status_url === 'string'
    ? requireQueueUrl(json.status_url, 'status URL')
    : `https://queue.fal.run/${request.model}/requests/${json.request_id}/status?logs=1`;
  entry.responseUrl = typeof json.response_url === 'string'
    ? requireQueueUrl(json.response_url, 'response URL')
    : `https://queue.fal.run/${request.model}/requests/${json.request_id}`;
  entry.status = 'queued';
  entry.submittedAt = new Date().toISOString();
  ledger.updatedAt = entry.submittedAt;
  await atomicWriteJson(LEDGER_PATH, ledger);
  return pollQueue(request, entry, ledger, falKey, startedAt);
}

async function persistOutput(
  request: KleinSequenceRequest,
  output: QueueOutput,
): Promise<{ outputPath: string; metadataPath: string }> {
  const outputPath = request.kind === 'generation'
    ? rawFramePath(request.variantId, request.frameIndex)
    : resolve(frameDir(request.variantId, request.frameIndex), 'birefnet.png');
  const metadataPath = requestMetadataPath(request);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, output.bytes, { mode: 0o600 });
  await atomicWriteJson(metadataPath, output.metadata);
  return { outputPath, metadataPath };
}

async function unionCleanup(variantId: KleinVariantId, frameIndex: number): Promise<string> {
  const chromaPath = resolve(frameDir(variantId, frameIndex), 'chroma-only.png');
  const dnnPath = resolve(frameDir(variantId, frameIndex), 'birefnet.png');
  const chromaImage = await loadImage(await readFile(chromaPath));
  const dnnImage = await loadImage(await readFile(dnnPath));
  const canvas = createCanvas(chromaImage.width, chromaImage.height);
  const context = canvas.getContext('2d');
  context.drawImage(chromaImage, 0, 0);
  const dnnCanvas = createCanvas(chromaImage.width, chromaImage.height);
  const dnnContext = dnnCanvas.getContext('2d');
  dnnContext.drawImage(dnnImage, 0, 0, chromaImage.width, chromaImage.height);
  const chromaData = context.getImageData(0, 0, canvas.width, canvas.height);
  const dnnData = dnnContext.getImageData(0, 0, dnnCanvas.width, dnnCanvas.height);
  unionForegroundMasks(chromaData.data, dnnData.data);
  decontaminateGreenEdges(chromaData.data, canvas.width, canvas.height);
  context.putImageData(chromaData, 0, 0);
  const path = resolve(frameDir(variantId, frameIndex), 'cleaned-union.png');
  await writeFile(path, canvas.toBuffer('image/png'), { mode: 0o600 });
  return path;
}

async function repairCleanupFromRaw(
  variantId: KleinVariantId,
  frameIndex: number,
): Promise<{ chromaPath: string; unionPath: string }> {
  const directory = frameDir(variantId, frameIndex);
  const raw = await readFile(rawFramePath(variantId, frameIndex));
  const chroma = await cleanReposedImagePreserveCanvas(raw.toString('base64'));
  const chromaPath = resolve(directory, 'chroma-from-raw.png');
  await writeFile(chromaPath, Buffer.from(chroma, 'base64'), { mode: 0o600 });

  const chromaImage = await loadImage(Buffer.from(chroma, 'base64'));
  const dnnImage = await loadImage(await readFile(resolve(directory, 'birefnet.png')));
  const canvas = createCanvas(chromaImage.width, chromaImage.height);
  const context = canvas.getContext('2d');
  context.drawImage(chromaImage, 0, 0);
  const dnnCanvas = createCanvas(chromaImage.width, chromaImage.height);
  const dnnContext = dnnCanvas.getContext('2d');
  dnnContext.drawImage(dnnImage, 0, 0, chromaImage.width, chromaImage.height);
  const chromaData = context.getImageData(0, 0, canvas.width, canvas.height);
  const dnnData = dnnContext.getImageData(0, 0, dnnCanvas.width, dnnCanvas.height);
  unionForegroundMasks(chromaData.data, dnnData.data);
  decontaminateGreenEdges(chromaData.data, canvas.width, canvas.height);
  context.putImageData(chromaData, 0, 0);
  const unionPath = resolve(directory, 'cleaned-union-from-raw.png');
  await writeFile(unionPath, canvas.toBuffer('image/png'), { mode: 0o600 });
  return { chromaPath, unionPath };
}

function parseBillingEvent(value: unknown): BillingEvent | null {
  if (!isRecord(value)) return null;
  const costTotal = typeof value.cost_total === 'number'
    ? value.cost_total
    : typeof value.cost_estimate_nano_usd === 'number'
      ? value.cost_estimate_nano_usd / 1_000_000_000
      : null;
  if (
    typeof value.request_id !== 'string' ||
    typeof value.endpoint_id !== 'string' ||
    typeof value.timestamp !== 'string' ||
    typeof value.output_units !== 'number' ||
    typeof value.unit_price !== 'number' ||
    costTotal == null
  ) return null;
  const costSubtotal = typeof value.cost_subtotal === 'number'
    ? value.cost_subtotal
    : value.output_units * value.unit_price;
  const costDiscount = typeof value.cost_discount === 'number'
    ? value.cost_discount
    : costSubtotal - costTotal;
  return {
    requestId: value.request_id,
    endpointId: value.endpoint_id,
    timestamp: value.timestamp,
    outputUnits: value.output_units,
    unitPriceUsd: value.unit_price,
    percentDiscount: typeof value.percent_discount === 'number' ? value.percent_discount : null,
    costSubtotalUsd: round(costSubtotal, 9),
    costDiscountUsd: round(costDiscount, 9),
    costTotalUsd: round(costTotal, 9),
  };
}

async function fetchBillingEvents(
  falKey: string,
  requestIds: string[],
): Promise<BillingEvent[]> {
  const url = new URL('https://api.fal.ai/v1/models/billing-events');
  url.searchParams.set('request_id', requestIds.join(','));
  url.searchParams.set('limit', String(requestIds.length));
  const response = await fetch(url, {
    headers: { Authorization: `Key ${falKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  const json = await response.json() as unknown;
  if (!response.ok || !isRecord(json) || !Array.isArray(json.billing_events)) {
    throw new Error(`fal billing-events query failed with HTTP ${response.status}.`);
  }
  return json.billing_events
    .map(parseBillingEvent)
    .filter((event): event is BillingEvent => event !== null);
}

async function reusedRequestIds(): Promise<Record<KleinVariantId, string>> {
  const ledger = await readJson(PHASE0_LEDGER_PATH);
  if (!isRecord(ledger) || !isRecord(ledger.entries)) {
    throw new Error('Phase 0 ledger is unavailable for reused-frame provenance.');
  }
  const ids = {} as Record<KleinVariantId, string>;
  for (const variant of KLEIN_VARIANTS) {
    const entry = ledger.entries[variant.reusedRaw.ledgerEntryId];
    if (
      !isRecord(entry) ||
      entry.status !== 'completed' ||
      typeof entry.requestId !== 'string' ||
      entry.outputPath !== variant.reusedRaw.path
    ) {
      throw new Error(`Phase 0 provenance mismatch for ${variant.id}.`);
    }
    ids[variant.id] = entry.requestId;
  }
  return ids;
}

async function validateReusedBilling(falKey: string): Promise<Record<KleinVariantId, BillingEvent>> {
  const ids = await reusedRequestIds();
  const events = await fetchBillingEvents(falKey, Object.values(ids));
  const byId = new Map(events.map((event) => [event.requestId, event]));
  const result = {} as Record<KleinVariantId, BillingEvent>;
  for (const variant of KLEIN_VARIANTS) {
    const event = byId.get(ids[variant.id]);
    if (!event || event.endpointId !== variant.model) {
      throw new Error(`Missing or mismatched reused billing event for ${variant.id}.`);
    }
    if (Math.abs(event.costTotalUsd - variant.expectedRequestCostUsd) > 0.00000001) {
      throw new Error(`Reused ${variant.id} billing cost changed from the frozen Phase 0 event.`);
    }
    result[variant.id] = event;
  }
  return result;
}

async function reconcileBillingEvents(
  falKey: string,
  ledger: SequenceLedger,
): Promise<BillingReconciliation> {
  const currentIds = Object.values(ledger.entries).map((entry) => entry.requestId);
  if (currentIds.some((requestId) => !requestId)) {
    throw new Error('Cannot reconcile billing before every paid request has an id.');
  }
  const reusedIds = await reusedRequestIds();
  const allIds = [...currentIds as string[], ...Object.values(reusedIds)];
  let events: BillingEvent[] = [];
  let byId = new Map<string, BillingEvent>();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    events = await fetchBillingEvents(falKey, allIds);
    byId = new Map(events.map((event) => [event.requestId, event]));
    if (allIds.every((requestId) => byId.has(requestId))) break;
    if (attempt < 11) await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000));
  }
  const currentEvents = (currentIds as string[]).map((requestId) => byId.get(requestId));
  if (currentEvents.some((event) => !event) || allIds.some((requestId) => !byId.has(requestId))) {
    throw new Error(`fal billing-events returned ${events.length}/${allIds.length} required records after read-only polling.`);
  }
  const reusedEvents = {} as Record<KleinVariantId, BillingEvent>;
  for (const variant of KLEIN_VARIANTS) {
    const event = byId.get(reusedIds[variant.id]);
    if (!event) throw new Error(`Missing reused billing event for ${variant.id}.`);
    reusedEvents[variant.id] = event;
  }
  const reconciliation: BillingReconciliation = {
    source: 'https://api.fal.ai/v1/models/billing-events',
    checkedAt: new Date().toISOString(),
    currentEvents: currentEvents as BillingEvent[],
    reusedEvents,
  };
  await atomicWriteJson(BILLING_PATH, reconciliation);
  return reconciliation;
}

async function composeSheet(
  paths: string[],
  columns: number,
  rows: number,
  transparent = true,
): Promise<Buffer> {
  const images = await Promise.all(paths.map(async (path) => loadImage(await readFile(path))));
  const cellWidth = Math.max(...images.map((image) => image.width));
  const cellHeight = Math.max(...images.map((image) => image.height));
  const canvas = createCanvas(cellWidth * columns, cellHeight * rows);
  const context = canvas.getContext('2d');
  if (!transparent) {
    context.fillStyle = '#00ff00';
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    const x = (index % columns) * cellWidth + Math.round((cellWidth - image.width) / 2);
    const y = Math.floor(index / columns) * cellHeight + Math.round((cellHeight - image.height) / 2);
    context.drawImage(image, x, y);
  }
  return canvas.toBuffer('image/png');
}

async function splitSheet(
  path: string,
  count: number,
  columns: number,
  rows: number,
  outputDirectory: string,
): Promise<string[]> {
  const image = await loadImage(await readFile(path));
  const width = Math.round(image.width / columns);
  const height = Math.round(image.height / rows);
  await mkdir(outputDirectory, { recursive: true });
  const paths: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const canvas = createCanvas(width, height);
    canvas.getContext('2d').drawImage(
      image,
      (index % columns) * width,
      Math.floor(index / columns) * height,
      width,
      height,
      0,
      0,
      width,
      height,
    );
    const framePath = resolve(outputDirectory, `frame-${String(index).padStart(2, '0')}.png`);
    await writeFile(framePath, canvas.toBuffer('image/png'), { mode: 0o600 });
    paths.push(framePath);
  }
  return paths;
}

async function createComparisonAuditSheet(): Promise<string> {
  const rows = [
    {
      label: 'ANCHOR',
      paths: HIGH_KICK_ANCHORS.map((anchor) => anchorPath(anchor.frameIndex)),
      greenBackground: true,
    },
    ...KLEIN_VARIANTS.flatMap((variant) => [
      {
        label: `${variant.label} RAW`,
        paths: HIGH_KICK_ANCHORS.map((anchor) => rawFramePath(variant.id, anchor.frameIndex)),
        greenBackground: true,
      },
      {
        label: `${variant.label} CLEANED`,
        paths: HIGH_KICK_ANCHORS.map((anchor) => resolve(frameDir(variant.id, anchor.frameIndex), 'cleaned-union.png')),
        greenBackground: false,
      },
    ]),
  ];
  const previewWidth = 288;
  const previewHeight = 384;
  const labelHeight = 30;
  const canvas = createCanvas(previewWidth * 4, (previewHeight + labelHeight) * rows.length);
  const context = canvas.getContext('2d');
  context.fillStyle = '#202020';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.font = 'bold 16px sans-serif';
  context.textBaseline = 'middle';
  for (let row = 0; row < rows.length; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      const x = column * previewWidth;
      const y = row * (previewHeight + labelHeight);
      const image = await loadImage(await readFile(rows[row].paths[column]));
      context.fillStyle = rows[row].greenBackground ? '#00ff00' : '#555555';
      context.fillRect(x, y, previewWidth, previewHeight);
      context.drawImage(image, x, y, previewWidth, previewHeight);
      context.fillStyle = '#111111';
      context.fillRect(x, y + previewHeight, previewWidth, labelHeight);
      context.fillStyle = '#ffffff';
      context.fillText(`${rows[row].label} · F${column}`, x + 8, y + previewHeight + labelHeight / 2);
    }
  }
  const path = resolve(RUN_DIR, 'klein-high-kick-comparison-audit.png');
  await writeFile(path, canvas.toBuffer('image/png'), { mode: 0o600 });
  return path;
}

async function createCleanupRepairAuditSheet(): Promise<string> {
  const rows = [
    {
      label: 'ANCHOR',
      paths: HIGH_KICK_ANCHORS.map((anchor) => anchorPath(anchor.frameIndex)),
      greenBackground: true,
    },
    ...KLEIN_VARIANTS.flatMap((variant) => [
      {
        label: `${variant.label} RAW`,
        paths: HIGH_KICK_ANCHORS.map((anchor) => rawFramePath(variant.id, anchor.frameIndex)),
        greenBackground: true,
      },
      {
        label: `${variant.label} RAW-CHROMA + BIREFNET`,
        paths: HIGH_KICK_ANCHORS.map((anchor) => resolve(
          frameDir(variant.id, anchor.frameIndex),
          'cleaned-union-from-raw.png',
        )),
        greenBackground: false,
      },
    ]),
  ];
  const previewWidth = 288;
  const previewHeight = 384;
  const labelHeight = 30;
  const canvas = createCanvas(previewWidth * 4, (previewHeight + labelHeight) * rows.length);
  const context = canvas.getContext('2d');
  context.fillStyle = '#202020';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.font = 'bold 16px sans-serif';
  context.textBaseline = 'middle';
  for (let row = 0; row < rows.length; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      const x = column * previewWidth;
      const y = row * (previewHeight + labelHeight);
      const image = await loadImage(await readFile(rows[row].paths[column]));
      context.fillStyle = rows[row].greenBackground ? '#00ff00' : '#555555';
      context.fillRect(x, y, previewWidth, previewHeight);
      context.drawImage(image, x, y, previewWidth, previewHeight);
      context.fillStyle = '#111111';
      context.fillRect(x, y + previewHeight, previewWidth, labelHeight);
      context.fillStyle = '#ffffff';
      context.fillText(`${rows[row].label} · F${column}`, x + 8, y + previewHeight + labelHeight / 2);
    }
  }
  const path = resolve(RUN_DIR, 'klein-high-kick-cleanup-repair-audit.png');
  await writeFile(path, canvas.toBuffer('image/png'), { mode: 0o600 });
  return path;
}

interface MaskMetrics {
  foregroundFraction: number;
  greenFraction: number;
  transparentFraction: number;
  bbox: { x: number; y: number; width: number; height: number } | null;
  mask: Uint8Array;
}

async function maskMetrics(path: string, width = 768, height = 1024): Promise<MaskMetrics> {
  const image = await loadImage(await readFile(path));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0, width, height);
  const data = context.getImageData(0, 0, width, height).data;
  const mask = new Uint8Array(width * height);
  let foreground = 0;
  let green = 0;
  let transparent = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    const red = data[offset];
    const greenValue = data[offset + 1];
    const blue = data[offset + 2];
    const alpha = data[offset + 3];
    const isTransparent = alpha < 32;
    const isGreen = !isTransparent && greenValue >= 145 && greenValue > red * 1.32 && greenValue > blue * 1.32;
    if (isTransparent) transparent += 1;
    if (isGreen) green += 1;
    if (isTransparent || isGreen) continue;
    mask[index] = 1;
    foreground += 1;
    const x = index % width;
    const y = Math.floor(index / width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const pixels = width * height;
  return {
    foregroundFraction: round(foreground / pixels),
    greenFraction: round(green / pixels),
    transparentFraction: round(transparent / pixels),
    bbox: foreground > 0 ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null,
    mask,
  };
}

function silhouetteIou(a: Uint8Array, b: Uint8Array): number {
  let intersection = 0;
  let union = 0;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] && b[index]) intersection += 1;
    if (a[index] || b[index]) union += 1;
  }
  return union > 0 ? round(intersection / union) : 0;
}

async function buildCleanupRepairArtifacts(): Promise<JsonRecord> {
  const variants: JsonRecord[] = [];
  for (const variant of KLEIN_VARIANTS) {
    const uniquePaths: string[] = [];
    const frames: JsonRecord[] = [];
    for (const anchor of HIGH_KICK_ANCHORS) {
      const repaired = await repairCleanupFromRaw(variant.id, anchor.frameIndex);
      const metrics = await maskMetrics(repaired.unionPath);
      uniquePaths.push(repaired.unionPath);
      frames.push({
        frameIndex: anchor.frameIndex,
        chromaFromRaw: relativeToProject(repaired.chromaPath),
        cleanedUnionFromRaw: relativeToProject(repaired.unionPath),
        foregroundFraction: metrics.foregroundFraction,
        greenFraction: metrics.greenFraction,
        transparentFraction: metrics.transparentFraction,
        bbox: metrics.bbox,
      });
    }
    const playback = expandMirroredSequence(uniquePaths, 7);
    const unionSheetPath = resolve(variantDir(variant.id), 'high-kick-union-from-raw-sheet.png');
    const unionSheet = await composeSheet(playback, 4, 2, true);
    await writeFile(unionSheetPath, unionSheet, { mode: 0o600 });
    const cleaned = await cleanSpriteSheet(unionSheet.toString('base64'), 7, 4, 2, 'high_kick');
    const cleanedSheetPath = resolve(variantDir(variant.id), 'high-kick-cleaned-from-raw-sheet.png');
    await writeFile(cleanedSheetPath, Buffer.from(cleaned.base64, 'base64'), { mode: 0o600 });
    const playbackPaths = await splitSheet(
      cleanedSheetPath,
      7,
      cleaned.gridCols,
      cleaned.gridRows,
      resolve(variantDir(variant.id), 'playback-from-raw'),
    );
    variants.push({
      id: variant.id,
      frames,
      artifacts: {
        unionSheet: relativeToProject(unionSheetPath),
        cleanedSheet: relativeToProject(cleanedSheetPath),
        playbackFrames: playbackPaths.map(relativeToProject),
      },
    });
  }
  const auditPath = await createCleanupRepairAuditSheet();
  const report: JsonRecord = {
    schemaVersion: 1,
    runId: KLEIN_SEQUENCE_RUN_ID,
    generatedAt: new Date().toISOString(),
    paidInferenceCalls: 0,
    method: 'chroma from original raw + existing BiRefNet alpha + foreground-mask union',
    productionRoutingChanged: false,
    audit: relativeToProject(auditPath),
    variants,
  };
  await atomicWriteJson(CLEANUP_REPAIR_REPORT_PATH, report);
  return report;
}

async function finalizeSequence(
  ledger: SequenceLedger,
  billing: BillingReconciliation,
): Promise<JsonRecord> {
  const billingByRequestId = new Map(billing.currentEvents.map((event) => [event.requestId, event]));
  const entryCost = (entry: LedgerEntry): number => {
    if (!entry.requestId) throw new Error(`Missing request id for ${entry.id}`);
    const event = billingByRequestId.get(entry.requestId);
    if (!event) throw new Error(`Missing billing event for ${entry.id}`);
    return event.costTotalUsd;
  };

  const artifacts: Record<string, unknown> = {};
  const variants: JsonRecord[] = [];
  for (const variant of KLEIN_VARIANTS) {
    const uniqueRaw = HIGH_KICK_ANCHORS.map((anchor) => rawFramePath(variant.id, anchor.frameIndex));
    const uniqueCleaned = HIGH_KICK_ANCHORS.map((anchor) => resolve(frameDir(variant.id, anchor.frameIndex), 'cleaned-union.png'));
    for (const path of [...uniqueRaw, ...uniqueCleaned]) {
      if (!(await exists(path))) throw new Error(`Missing artifact ${relativeToProject(path)}`);
    }
    const playbackCleaned = expandMirroredSequence(uniqueCleaned, 7);
    const playbackRaw = expandMirroredSequence(uniqueRaw, 7);
    const unionSheetPath = resolve(variantDir(variant.id), 'high-kick-union-sheet.png');
    const unionSheet = await composeSheet(playbackCleaned, 4, 2, true);
    await writeFile(unionSheetPath, unionSheet, { mode: 0o600 });
    const cleaned = await cleanSpriteSheet(unionSheet.toString('base64'), 7, 4, 2, 'high_kick');
    const cleanedSheetPath = resolve(variantDir(variant.id), 'high-kick-cleaned-sheet.png');
    await writeFile(cleanedSheetPath, Buffer.from(cleaned.base64, 'base64'), { mode: 0o600 });
    const rawSheetPath = resolve(variantDir(variant.id), 'high-kick-raw-sheet.png');
    await writeFile(rawSheetPath, await composeSheet(playbackRaw, 4, 2, false), { mode: 0o600 });
    const playbackPaths = await splitSheet(
      cleanedSheetPath,
      7,
      cleaned.gridCols,
      cleaned.gridRows,
      resolve(variantDir(variant.id), 'playback'),
    );

    const frames: JsonRecord[] = [];
    for (const anchor of HIGH_KICK_ANCHORS) {
      const pose = await maskMetrics(anchorPath(anchor.frameIndex));
      const raw = await maskMetrics(rawFramePath(variant.id, anchor.frameIndex));
      const union = await maskMetrics(resolve(frameDir(variant.id, anchor.frameIndex), 'cleaned-union.png'));
      frames.push({
        frameIndex: anchor.frameIndex,
        reusedGeneration: anchor.frameIndex === 3,
        poseIouRaw: silhouetteIou(raw.mask, pose.mask),
        poseBboxHeightRatio: raw.bbox && pose.bbox ? round(raw.bbox.height / pose.bbox.height) : null,
        raw: {
          foregroundFraction: raw.foregroundFraction,
          greenFraction: raw.greenFraction,
          transparentFraction: raw.transparentFraction,
          bbox: raw.bbox,
        },
        cleanedUnion: {
          foregroundFraction: union.foregroundFraction,
          greenFraction: union.greenFraction,
          transparentFraction: union.transparentFraction,
          bbox: union.bbox,
        },
        paths: {
          anchor: relativeToProject(anchorPath(anchor.frameIndex)),
          raw: relativeToProject(rawFramePath(variant.id, anchor.frameIndex)),
          chromaOnly: relativeToProject(resolve(frameDir(variant.id, anchor.frameIndex), 'chroma-only.png')),
          birefnet: relativeToProject(resolve(frameDir(variant.id, anchor.frameIndex), 'birefnet.png')),
          cleanedUnion: relativeToProject(resolve(frameDir(variant.id, anchor.frameIndex), 'cleaned-union.png')),
        },
      });
    }

    const variantEntries = Object.values(ledger.entries).filter((entry) => entry.variantId === variant.id);
    const generationEntries = variantEntries.filter((entry) => entry.kind === 'generation');
    const cleanupEntries = variantEntries.filter((entry) => entry.kind === 'cleanup');
    const newGenerationBilledCostUsd = round(generationEntries.reduce((sum, entry) => sum + entryCost(entry), 0), 9);
    const cleanupBilledCostUsd = round(cleanupEntries.reduce((sum, entry) => sum + entryCost(entry), 0), 9);
    const reusedGenerationBilledCostUsd = billing.reusedEvents[variant.id].costTotalUsd;
    const logicalSequenceBilledCostUsd = round(
      newGenerationBilledCostUsd + cleanupBilledCostUsd + reusedGenerationBilledCostUsd,
      9,
    );
    const generationPerFrameUsd = round(
      (newGenerationBilledCostUsd + reusedGenerationBilledCostUsd) / 4,
      9,
    );
    const cleanupPerFrameUsd = round(cleanupBilledCostUsd / 4, 9);
    variants.push({
      id: variant.id,
      label: variant.label,
      model: variant.model,
      billing: {
        newGenerationBilledCostUsd,
        reusedGenerationBilledCostUsd,
        cleanupBilledCostUsd,
        logicalSequenceBilledCostUsd,
      },
      projected76UniqueRefines: {
        generationUsd: round(generationPerFrameUsd * 76, 9),
        cleanupAtObservedMeanUsd: round(cleanupPerFrameUsd * 76, 9),
        combinedAtObservedMeanUsd: round((generationPerFrameUsd + cleanupPerFrameUsd) * 76, 9),
        caveat: 'Projection is request cost, not cost per accepted sequence.',
      },
      normalizedSequence: {
        playbackOrder: HIGH_KICK_PLAYBACK_ORDER,
        grid: { columns: cleaned.gridCols, rows: cleaned.gridRows },
        frameCount: cleaned.frameCount,
        frameWidth: cleaned.frameW,
        frameHeight: cleaned.frameH,
        usedScale: cleaned.usedScale,
      },
      frames,
      artifacts: {
        rawSheet: relativeToProject(rawSheetPath),
        unionSheet: relativeToProject(unionSheetPath),
        cleanedSheet: relativeToProject(cleanedSheetPath),
        playbackFrames: playbackPaths.map(relativeToProject),
      },
    });
    artifacts[variant.id] = (variants.at(-1) as JsonRecord).artifacts;
  }

  const comparisonAuditPath = await createComparisonAuditSheet();
  const incrementalBilledCostUsd = round(
    billing.currentEvents.reduce((sum, event) => sum + event.costTotalUsd, 0),
    9,
  );
  const guardExceededEntries = Object.values(ledger.entries).flatMap((entry) => {
    const billed = entryCost(entry);
    return billed > entry.guardedMaxUsd
      ? [{ id: entry.id, guardedMaxUsd: entry.guardedMaxUsd, billedCostUsd: billed }]
      : [];
  });
  const report: JsonRecord = {
    schemaVersion: 1,
    runId: KLEIN_SEQUENCE_RUN_ID,
    generatedAt: new Date().toISOString(),
    execution: {
      paidSubmissions: ledger.submittedCount,
      newGenerations: Object.values(ledger.entries).filter((entry) => entry.kind === 'generation' && entry.status === 'completed').length,
      cleanups: Object.values(ledger.entries).filter((entry) => entry.kind === 'cleanup' && entry.status === 'completed').length,
      reusedExactGenerations: 2,
      automaticRetries: 0,
      incrementalBilledCostUsd,
      guardedBudgetUsd: kleinSequenceGuardedBudgetUsd(),
      hardCapUsd: KLEIN_SEQUENCE_HARD_CAP_USD,
      withinApprovedCap: incrementalBilledCostUsd <= KLEIN_SEQUENCE_HARD_CAP_USD,
      guardExceededEntries,
      billingSource: billing.source,
      billingEventsPath: relativeToProject(BILLING_PATH),
    },
    comparisonAudit: relativeToProject(comparisonAuditPath),
    artifacts,
    variants,
    ledger: Object.values(ledger.entries).map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      variantId: entry.variantId,
      frameIndex: entry.frameIndex,
      status: entry.status,
      durationMs: entry.durationMs ?? null,
      inferenceSeconds: entry.inferenceSeconds ?? null,
      billedCostUsd: entryCost(entry),
    })),
  };
  await atomicWriteJson(REPORT_PATH, report);
  if (incrementalBilledCostUsd > KLEIN_SEQUENCE_HARD_CAP_USD) {
    throw new Error(`Recorded billing $${incrementalBilledCostUsd} exceeded the approved cap.`);
  }
  return report;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[A-Za-z0-9_-]{32,}/g, '<redacted>').slice(0, 600);
}

async function executeRequest(
  request: KleinSequenceRequest,
  ledger: SequenceLedger,
  falKey: string,
): Promise<void> {
  const entry = ledger.entries[request.id];
  if (!entry) throw new Error(`Missing ledger entry ${request.id}`);
  if (entry.status === 'completed') {
    if (request.kind === 'cleanup') await unionCleanup(request.variantId, request.frameIndex);
    return;
  }
  if (entry.status === 'submitting' || entry.status === 'unknown') {
    throw new Error(`${request.id} has unknown submission outcome and will not be resubmitted.`);
  }
  if (entry.status === 'failed') throw new Error(`${request.id} previously failed and will not be retried.`);

  let output: QueueOutput;
  if (entry.status === 'queued') {
    output = await pollQueue(request, entry, ledger, falKey, Date.now());
  } else {
    const body = request.kind === 'generation'
      ? await hydrateGenerationBody(request)
      : await prepareCleanup(request.variantId, request.frameIndex);
    assertBudget(ledger);
    if (ledger.submittedCount >= ledger.maxPaidSubmissions) throw new Error('Paid submission count exhausted.');
    entry.status = 'submitting';
    entry.submitStartedAt = new Date().toISOString();
    ledger.submittedCount += 1;
    ledger.updatedAt = entry.submitStartedAt;
    await atomicWriteJson(LEDGER_PATH, ledger);
    console.log(`[submit ${ledger.submittedCount}/${ledger.maxPaidSubmissions}] ${request.id}`);
    output = await submitQueue(request, body, entry, ledger, falKey);
  }

  const paths = await persistOutput(request, output);
  entry.status = 'completed';
  entry.completedAt = new Date().toISOString();
  entry.inferenceSeconds = output.inferenceSeconds ?? undefined;
  entry.outputPath = relativeToProject(paths.outputPath);
  entry.metadataPath = relativeToProject(paths.metadataPath);
  ledger.updatedAt = entry.completedAt;
  await atomicWriteJson(LEDGER_PATH, ledger);
  if (request.kind === 'cleanup') await unionCleanup(request.variantId, request.frameIndex);
}

async function executeBenchmark(maxCostUsd: number): Promise<JsonRecord> {
  await buildManifest();
  const falKey = await loadFalKey();
  await pricingPreflight(falKey);
  const ledger = await loadOrCreateLedger(maxCostUsd);
  assertBudget(ledger);
  for (const request of buildKleinSequenceRequests()) {
    try {
      await executeRequest(request, ledger, falKey);
    } catch (error) {
      const entry = ledger.entries[request.id];
      if (entry?.status === 'submitting') entry.status = 'unknown';
      else if (entry && entry.status !== 'queued') entry.status = 'failed';
      if (entry) entry.error = safeError(error);
      ledger.updatedAt = new Date().toISOString();
      await atomicWriteJson(LEDGER_PATH, ledger);
      throw error;
    }
  }
  const billing = await reconcileBillingEvents(falKey, ledger);
  return finalizeSequence(ledger, billing);
}

async function withExecutionLock<T>(work: () => Promise<T>): Promise<T> {
  await mkdir(RUN_DIR, { recursive: true });
  let handle;
  try {
    handle = await open(LOCK_PATH, 'wx', 0o600);
  } catch {
    throw new Error(`Execution lock already exists at ${relativeToProject(LOCK_PATH)}; refusing concurrent paid execution.`);
  }
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
    return await work();
  } finally {
    await handle.close();
    await unlink(LOCK_PATH).catch(() => undefined);
  }
}

function parseMaxCost(args: string[]): number {
  const raw = args.find((argument) => argument.startsWith('--max-cost-usd='))?.split('=')[1];
  const value = Number(raw);
  if (!Number.isFinite(value) || value < kleinSequenceGuardedBudgetUsd() || value > KLEIN_SEQUENCE_HARD_CAP_USD) {
    throw new Error(`--max-cost-usd must be between $${kleinSequenceGuardedBudgetUsd().toFixed(3)} and $${KLEIN_SEQUENCE_HARD_CAP_USD.toFixed(2)}`);
  }
  return value;
}

async function main(): Promise<void> {
  const [command = 'plan', ...args] = process.argv.slice(2);
  if (command === 'plan') {
    const manifest = await buildManifest();
    console.log(JSON.stringify({
      runId: KLEIN_SEQUENCE_RUN_ID,
      manifest: relativeToProject(MANIFEST_PATH),
      guardedBudgetUsd: kleinSequenceGuardedBudgetUsd(),
      hardCapUsd: KLEIN_SEQUENCE_HARD_CAP_USD,
      paidInferenceCalls: 0,
      fingerprint: manifest.fingerprint,
    }, null, 2));
    return;
  }
  if (command === 'pricing') {
    await buildManifest();
    const falKey = await loadFalKey();
    await pricingPreflight(falKey);
    console.log(JSON.stringify({
      runId: KLEIN_SEQUENCE_RUN_ID,
      pricing: relativeToProject(PRICING_PATH),
      guardedBudgetUsd: kleinSequenceGuardedBudgetUsd(),
      paidInferenceCalls: 0,
    }, null, 2));
    return;
  }
  if (command === 'repair-cleanup') {
    const report = await buildCleanupRepairArtifacts();
    console.log(JSON.stringify({
      runId: KLEIN_SEQUENCE_RUN_ID,
      paidInferenceCalls: 0,
      report: relativeToProject(CLEANUP_REPAIR_REPORT_PATH),
      audit: report.audit,
    }, null, 2));
    return;
  }
  if (command === 'execute') {
    if (!args.includes('--execute')) throw new Error('Paid execution requires --execute.');
    if (!args.includes(`--confirm-paid-benchmark=${KLEIN_SEQUENCE_CONFIRMATION}`)) {
      throw new Error(`Paid execution requires --confirm-paid-benchmark=${KLEIN_SEQUENCE_CONFIRMATION}`);
    }
    const maxCostUsd = parseMaxCost(args);
    const report = await withExecutionLock(() => executeBenchmark(maxCostUsd));
    console.log(JSON.stringify({
      runId: KLEIN_SEQUENCE_RUN_ID,
      report: relativeToProject(REPORT_PATH),
      execution: report.execution,
      comparisonAudit: report.comparisonAudit,
    }, null, 2));
    return;
  }
  throw new Error('Unknown command. Use plan, pricing, repair-cleanup, or execute.');
}

await main();
