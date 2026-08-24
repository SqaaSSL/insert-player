import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  stat,
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
  BIREFNET_GUARD_USD,
  BIREFNET_MODEL_ID,
  FLASH_GENERATION_GUARD_USD,
  FLASH_MODEL_ID,
  FLASH_OBSERVED_BILLED_REQUEST_USD,
  FLASH_SEQUENCE_BILLING_CORRECTED_GUARD_USD,
  FLASH_SEQUENCE_CONFIRMATION,
  FLASH_SEQUENCE_HARD_CAP_USD,
  FLASH_SEQUENCE_RUN_ID,
  FLASH_SEQUENCE_SOURCES,
  HIGH_KICK_ANCHORS,
  HIGH_KICK_PLAYBACK_ORDER,
  LIVE_COMPUTE_SECOND_PRICE_USD,
  buildFlashSequenceRequests,
  flashSequenceFingerprint,
  flashSequenceGuardedBudgetUsd,
  type FlashSequenceRequest,
  validateFlashSequencePlan,
} from './flashSequenceBenchmark.ts';

installCanvasRuntime();

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SOURCE_DIR, '../../..');
const RUN_DIR = resolve(PROJECT_ROOT, '.qa/provider-benchmark', FLASH_SEQUENCE_RUN_ID);
const MANIFEST_PATH = resolve(RUN_DIR, 'manifest.json');
const PRICING_PATH = resolve(RUN_DIR, 'pricing-preflight.json');
const BILLING_EVENTS_PATH = resolve(RUN_DIR, 'billing-events.json');
const LEDGER_PATH = resolve(RUN_DIR, 'execution-ledger.json');
const REPORT_PATH = resolve(RUN_DIR, 'report.json');
const IDENTITY_PATH = resolve(RUN_DIR, 'inputs/identity.png');
const PROMPT_PATH = resolve(RUN_DIR, 'prompts/high-kick-refine.txt');
const POLL_TIMEOUT_MS = 12 * 60_000;
const MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024;
const REUSED_FLASH_LEDGER_PATH = resolve(
  PROJECT_ROOT,
  '.qa/provider-benchmark/phase0-20260822-v1/execution-ledger.json',
);

type JsonRecord = Record<string, unknown>;
type LedgerStatus = 'planned' | 'submitting' | 'queued' | 'completed' | 'failed' | 'unknown';

interface LedgerEntry {
  id: string;
  kind: 'generation' | 'cleanup';
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
  computedCostUsd?: number;
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
  reusedGenerationEvent: BillingEvent;
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

function frameDir(frameIndex: number): string {
  return resolve(RUN_DIR, 'outputs', `frame-${String(frameIndex).padStart(2, '0')}`);
}

function rawFramePath(frameIndex: number): string {
  return resolve(frameDir(frameIndex), 'raw.png');
}

function metadataPathFor(request: FlashSequenceRequest): string {
  return resolve(frameDir(request.frameIndex), request.kind === 'generation' ? 'generation-metadata.json' : 'birefnet-metadata.json');
}

async function prepareFrozenInputs(): Promise<void> {
  validateFlashSequencePlan();
  await mkdir(resolve(RUN_DIR, 'inputs/anchors'), { recursive: true });
  await mkdir(resolve(RUN_DIR, 'prompts'), { recursive: true });

  const identitySource = resolve(PROJECT_ROOT, FLASH_SEQUENCE_SOURCES.identity.path);
  const sheetSource = resolve(PROJECT_ROOT, FLASH_SEQUENCE_SOURCES.highKickSheet.path);
  const reusedSource = resolve(PROJECT_ROOT, FLASH_SEQUENCE_SOURCES.reusedImpact.path);
  const reusedMetadataSource = resolve(PROJECT_ROOT, FLASH_SEQUENCE_SOURCES.reusedImpact.metadataPath);
  await assertImage(identitySource, FLASH_SEQUENCE_SOURCES.identity);
  const sheetBytes = await assertImage(sheetSource, FLASH_SEQUENCE_SOURCES.highKickSheet);
  await assertImage(reusedSource, FLASH_SEQUENCE_SOURCES.reusedImpact);

  await copyFile(identitySource, IDENTITY_PATH);
  const sheet = await loadImage(sheetBytes);
  for (const anchor of HIGH_KICK_ANCHORS) {
    const canvas = createCanvas(anchor.width, anchor.height);
    const context = canvas.getContext('2d');
    context.drawImage(
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
    if (hash !== anchor.sha256) {
      throw new Error(`Anchor ${anchor.frameIndex} hash mismatch: ${hash}`);
    }
    await writeFile(anchorPath(anchor.frameIndex), bytes, { mode: 0o600 });
  }

  await mkdir(frameDir(3), { recursive: true });
  await copyFile(reusedSource, rawFramePath(3));
  if (await exists(reusedMetadataSource)) {
    await copyFile(reusedMetadataSource, resolve(frameDir(3), 'generation-metadata-reused.json'));
  }
  await writeFile(PROMPT_PATH, buildHighKickRefinePrompt(), { mode: 0o600 });
}

async function buildManifest(): Promise<JsonRecord> {
  await prepareFrozenInputs();
  const manifest: JsonRecord = {
    schemaVersion: 1,
    runId: FLASH_SEQUENCE_RUN_ID,
    createdAt: new Date().toISOString(),
    fingerprint: flashSequenceFingerprint(),
    purpose: 'Test FLUX.2 Flash temporal consistency on all four unique HIGH_KICK keyframes without changing production architecture.',
    safety: {
      syntheticFixtureOnly: true,
      hardCapUsd: FLASH_SEQUENCE_HARD_CAP_USD,
      originalGuardedBudgetUsd: flashSequenceGuardedBudgetUsd(),
      billingCorrectedGuardedBudgetUsd: FLASH_SEQUENCE_BILLING_CORRECTED_GUARD_USD,
      newGenerationSubmissions: 3,
      reusedExactGeneration: 1,
      cleanupSubmissions: 4,
      automaticProviderRetries: 0,
      freepikFallback: false,
      confirmation: FLASH_SEQUENCE_CONFIRMATION,
    },
    prompt: {
      path: relativeToProject(PROMPT_PATH),
      characters: buildHighKickRefinePrompt().length,
      sha256: sha256Text(buildHighKickRefinePrompt()),
    },
    generation: {
      model: FLASH_MODEL_ID,
      seed: BENCHMARK_SEED_REFINE,
      imageSize: { width: 864, height: 1152 },
      guidanceScale: 2.5,
      promptExpansion: false,
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
    reusedFrame: {
      frameIndex: 3,
      source: FLASH_SEQUENCE_SOURCES.reusedImpact.path,
      sha256: FLASH_SEQUENCE_SOURCES.reusedImpact.sha256,
    },
    requests: buildFlashSequenceRequests(),
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
  const models = [FLASH_MODEL_ID, BIREFNET_MODEL_ID];
  const results: Record<string, unknown> = {};
  for (const model of models) {
    const url = new URL('https://api.fal.ai/v1/models/pricing');
    url.searchParams.set('endpoint_id', model);
    const response = await fetch(url, {
      headers: { Authorization: `Key ${falKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    const json = await response.json() as unknown;
    const prices = isRecord(json) && Array.isArray(json.prices) ? json.prices : [];
    const first = prices[0];
    if (!response.ok || !isRecord(first)) {
      throw new Error(`Unexpected live pricing for ${model}; refusing paid execution.`);
    }
    results[model] = { prices };
  }
  const result: JsonRecord = {
    checkedAt: new Date().toISOString(),
    paidInferenceCalls: 0,
    source: 'https://api.fal.ai/v1/models/pricing',
    caveat: 'This endpoint reported compute-second pricing for FLUX.2 Flash, but the public model page and per-request billing events charge $0.005 per megapixel of input and output. Billing events are reconciled after execution.',
    models: results,
  };
  await atomicWriteJson(PRICING_PATH, result);
  return result;
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

async function reusedFlashRequestId(): Promise<string> {
  const ledger = await readJson(REUSED_FLASH_LEDGER_PATH);
  if (!isRecord(ledger) || !isRecord(ledger.entries)) {
    throw new Error('Phase 0 ledger is unavailable for reused-frame billing reconciliation.');
  }
  const entry = ledger.entries['plan-b-flux2-flash-via-fal'];
  if (!isRecord(entry) || typeof entry.requestId !== 'string') {
    throw new Error('Phase 0 FLUX.2 Flash request id is unavailable.');
  }
  return entry.requestId;
}

async function reconcileBillingEvents(
  falKey: string,
  ledger: SequenceLedger,
): Promise<BillingReconciliation> {
  const currentRequestIds = Object.values(ledger.entries).map((entry) => entry.requestId);
  if (currentRequestIds.some((requestId) => !requestId)) {
    throw new Error('Cannot reconcile billing before every paid request has an id.');
  }
  const reusedRequestId = await reusedFlashRequestId();
  const requestIds = [...currentRequestIds as string[], reusedRequestId];
  const url = new URL('https://api.fal.ai/v1/models/billing-events');
  url.searchParams.set('request_id', requestIds.join(','));
  url.searchParams.set('limit', String(requestIds.length));
  const response = await fetch(url, {
    headers: { Authorization: `Key ${falKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  const json = await response.json() as unknown;
  if (!response.ok || !isRecord(json) || !Array.isArray(json.billing_events)) {
    throw new Error(`fal billing-events reconciliation failed with HTTP ${response.status}.`);
  }
  const events = json.billing_events
    .map(parseBillingEvent)
    .filter((event): event is BillingEvent => event !== null);
  const byRequestId = new Map(events.map((event) => [event.requestId, event]));
  const currentEvents = (currentRequestIds as string[]).map((requestId) => byRequestId.get(requestId));
  const reusedGenerationEvent = byRequestId.get(reusedRequestId);
  if (currentEvents.some((event) => !event) || !reusedGenerationEvent) {
    throw new Error(`fal billing-events returned ${events.length}/${requestIds.length} required request records.`);
  }
  const reconciliation: BillingReconciliation = {
    source: 'https://api.fal.ai/v1/models/billing-events',
    checkedAt: new Date().toISOString(),
    currentEvents: currentEvents as BillingEvent[],
    reusedGenerationEvent,
  };
  await atomicWriteJson(BILLING_EVENTS_PATH, reconciliation);
  return reconciliation;
}

async function loadOrCreateLedger(maxCostUsd: number): Promise<SequenceLedger> {
  const fingerprint = flashSequenceFingerprint();
  if (await exists(LEDGER_PATH)) {
    const existing = await readJson(LEDGER_PATH);
    if (!isRecord(existing) || existing.runId !== FLASH_SEQUENCE_RUN_ID || existing.fingerprint !== fingerprint) {
      throw new Error('Existing sequence ledger does not match this frozen plan.');
    }
    return existing as unknown as SequenceLedger;
  }
  const now = new Date().toISOString();
  const entries = Object.fromEntries(buildFlashSequenceRequests().map((request) => [
    request.id,
    {
      id: request.id,
      kind: request.kind,
      frameIndex: request.frameIndex,
      status: 'planned',
      guardedMaxUsd: request.guardedMaxUsd,
    } satisfies LedgerEntry,
  ]));
  const ledger: SequenceLedger = {
    schemaVersion: 1,
    runId: FLASH_SEQUENCE_RUN_ID,
    fingerprint,
    confirmedMaxCostUsd: maxCostUsd,
    maxPaidSubmissions: buildFlashSequenceRequests().length,
    submittedCount: 0,
    createdAt: now,
    updatedAt: now,
    entries,
  };
  await atomicWriteJson(LEDGER_PATH, ledger);
  return ledger;
}

function committedBudget(ledger: SequenceLedger): number {
  let total = 0;
  for (const entry of Object.values(ledger.entries)) {
    if (entry.status === 'failed') continue;
    total += entry.kind === 'generation'
      ? Math.max(entry.guardedMaxUsd, FLASH_OBSERVED_BILLED_REQUEST_USD)
      : entry.guardedMaxUsd;
  }
  return round(total);
}

function assertBudget(ledger: SequenceLedger): void {
  const committed = committedBudget(ledger);
  if (committed > ledger.confirmedMaxCostUsd || committed > FLASH_SEQUENCE_HARD_CAP_USD) {
    throw new Error(`Remaining guarded budget is $${committed.toFixed(4)}, above the approved $${FLASH_SEQUENCE_HARD_CAP_USD.toFixed(2)} cap.`);
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

async function hydrateGenerationBody(frameIndex: number): Promise<JsonRecord> {
  const identity = (await readFile(IDENTITY_PATH)).toString('base64');
  const pose = (await readFile(anchorPath(frameIndex))).toString('base64');
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
    guidance_scale: 2.5,
    num_images: 1,
    enable_prompt_expansion: false,
  };
}

async function prepareCleanup(frameIndex: number): Promise<{ body: JsonRecord; chromaPath: string }> {
  const directory = frameDir(frameIndex);
  const raw = await readFile(rawFramePath(frameIndex));
  const rawBase64 = raw.toString('base64');
  const neutralized = await neutralizeGreenSpillForSegmentation(rawBase64);
  const chroma = await cleanReposedImagePreserveCanvas(neutralized);
  const neutralizedPath = resolve(directory, 'neutralized.png');
  const chromaPath = resolve(directory, 'chroma-only.png');
  await writeFile(neutralizedPath, Buffer.from(neutralized, 'base64'), { mode: 0o600 });
  await writeFile(chromaPath, Buffer.from(chroma, 'base64'), { mode: 0o600 });

  const neutralizedImage = await loadImage(Buffer.from(neutralized, 'base64'));
  const scale = Math.min(1024 / neutralizedImage.width, 1024 / neutralizedImage.height, 1);
  const width = Math.round(neutralizedImage.width * scale);
  const height = Math.round(neutralizedImage.height * scale);
  const canvas = createCanvas(width, height);
  canvas.getContext('2d').drawImage(neutralizedImage, 0, 0, width, height);
  const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.85);
  const jpegBase64 = jpegDataUrl.slice(jpegDataUrl.indexOf(',') + 1);
  await writeFile(resolve(directory, 'birefnet-input.jpg'), Buffer.from(jpegBase64, 'base64'), { mode: 0o600 });
  return {
    chromaPath,
    body: {
      image_url: `data:image/jpeg;base64,${jpegBase64}`,
      model: 'General Use (Light)',
      operating_resolution: '1024x1024',
      refine_foreground: true,
      output_format: 'png',
      sync_mode: false,
    },
  };
}

function findFalOutput(result: unknown, kind: 'generation' | 'cleanup'): { url: string; mimeType: string; metadata: JsonRecord; inferenceSeconds: number | null } {
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
  const inferenceSeconds = timings && typeof timings.inference === 'number' ? timings.inference : null;
  return {
    url: image.url,
    mimeType: typeof image.content_type === 'string' ? image.content_type : 'image/png',
    inferenceSeconds,
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

async function downloadQueueOutput(result: unknown, kind: 'generation' | 'cleanup'): Promise<QueueOutput> {
  const output = findFalOutput(result, kind);
  const url = new URL(output.url);
  if (url.protocol !== 'https:') throw new Error('fal output URL is not HTTPS');
  const response = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw new Error(`fal output download HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length') || '0');
  if (length > MAX_DOWNLOAD_BYTES) throw new Error('fal output exceeds maximum download size');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_DOWNLOAD_BYTES) throw new Error('fal output exceeds maximum download size');
  return {
    bytes,
    mimeType: response.headers.get('content-type') || output.mimeType,
    metadata: output.metadata,
    inferenceSeconds: output.inferenceSeconds,
  };
}

function failureStatus(status: string): boolean {
  return ['FAILED', 'ERROR', 'CANCELLED', 'CANCELED'].includes(status.toUpperCase());
}

async function pollQueue(
  request: FlashSequenceRequest,
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
      if (failureStatus(status)) throw new Error(`fal ${request.kind} ended with ${status}`);
      if (status === 'COMPLETED') {
        const result = await fetch(responseUrl, {
          headers: { Authorization: `Key ${falKey}` },
          signal: AbortSignal.timeout(60_000),
        });
        if (!result.ok) throw new Error(`result HTTP ${result.status}`);
        entry.durationMs = Date.now() - startedAt;
        return downloadQueueOutput(await result.json() as unknown, request.kind);
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
  request: FlashSequenceRequest,
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
  request: FlashSequenceRequest,
  output: QueueOutput,
): Promise<{ outputPath: string; metadataPath: string }> {
  const outputPath = request.kind === 'generation'
    ? rawFramePath(request.frameIndex)
    : resolve(frameDir(request.frameIndex), 'birefnet.png');
  const metadataPath = metadataPathFor(request);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, output.bytes, { mode: 0o600 });
  await atomicWriteJson(metadataPath, output.metadata);
  return { outputPath, metadataPath };
}

async function unionCleanup(frameIndex: number): Promise<string> {
  const chromaPath = resolve(frameDir(frameIndex), 'chroma-only.png');
  const dnnPath = resolve(frameDir(frameIndex), 'birefnet.png');
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
  const path = resolve(frameDir(frameIndex), 'cleaned-union.png');
  await writeFile(path, canvas.toBuffer('image/png'), { mode: 0o600 });
  return path;
}

async function composeSheet(paths: string[], columns: number, rows: number, transparent = true): Promise<Buffer> {
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

async function splitSheet(path: string, count: number, columns: number, rows: number, outputDirectory: string): Promise<string[]> {
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

async function createAuditSheet(): Promise<string> {
  const rowLabels = ['ANCHOR', 'RAW FLASH', 'CHROMA ONLY', 'PRODUCTION UNION'];
  const rowPaths = [
    HIGH_KICK_ANCHORS.map((anchor) => anchorPath(anchor.frameIndex)),
    HIGH_KICK_ANCHORS.map((anchor) => rawFramePath(anchor.frameIndex)),
    HIGH_KICK_ANCHORS.map((anchor) => resolve(frameDir(anchor.frameIndex), 'chroma-only.png')),
    HIGH_KICK_ANCHORS.map((anchor) => resolve(frameDir(anchor.frameIndex), 'cleaned-union.png')),
  ];
  const previewWidth = 288;
  const previewHeight = 384;
  const labelHeight = 30;
  const canvas = createCanvas(previewWidth * 4, (previewHeight + labelHeight) * rowPaths.length);
  const context = canvas.getContext('2d');
  context.fillStyle = '#202020';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.font = 'bold 17px sans-serif';
  context.textBaseline = 'middle';
  for (let row = 0; row < rowPaths.length; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      const x = column * previewWidth;
      const y = row * (previewHeight + labelHeight);
      const image = await loadImage(await readFile(rowPaths[row][column]));
      context.fillStyle = row >= 2 ? '#555555' : '#00ff00';
      context.fillRect(x, y, previewWidth, previewHeight);
      context.drawImage(image, x, y, previewWidth, previewHeight);
      context.fillStyle = '#111111';
      context.fillRect(x, y + previewHeight, previewWidth, labelHeight);
      context.fillStyle = '#ffffff';
      context.fillText(`${rowLabels[row]} · F${column}`, x + 10, y + previewHeight + labelHeight / 2);
    }
  }
  const path = resolve(RUN_DIR, 'flash-high-kick-audit-sheet.png');
  await writeFile(path, canvas.toBuffer('image/png'), { mode: 0o600 });
  return path;
}

interface MaskMetrics {
  width: number;
  height: number;
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
    width,
    height,
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

async function finalizeSequence(
  ledger: SequenceLedger,
  billing: BillingReconciliation,
): Promise<JsonRecord> {
  const uniqueCleaned = HIGH_KICK_ANCHORS.map((anchor) => resolve(frameDir(anchor.frameIndex), 'cleaned-union.png'));
  for (const path of uniqueCleaned) {
    if (!(await exists(path))) throw new Error(`Missing cleaned frame ${relativeToProject(path)}`);
  }
  const playbackPaths = expandMirroredSequence(uniqueCleaned, 7);
  const rawPlaybackPaths = expandMirroredSequence(HIGH_KICK_ANCHORS.map((anchor) => rawFramePath(anchor.frameIndex)), 7);
  const preNormalizedSheet = await composeSheet(playbackPaths, 4, 2, true);
  const preNormalizedPath = resolve(RUN_DIR, 'flash-high-kick-union-sheet.png');
  await writeFile(preNormalizedPath, preNormalizedSheet, { mode: 0o600 });
  const cleaned = await cleanSpriteSheet(preNormalizedSheet.toString('base64'), 7, 4, 2, 'high_kick');
  const cleanedSheetPath = resolve(RUN_DIR, 'flash-high-kick-cleaned-sheet.png');
  await writeFile(cleanedSheetPath, Buffer.from(cleaned.base64, 'base64'), { mode: 0o600 });
  const rawSheetPath = resolve(RUN_DIR, 'flash-high-kick-raw-sheet.png');
  await writeFile(rawSheetPath, await composeSheet(rawPlaybackPaths, 4, 2, false), { mode: 0o600 });
  const playbackFramePaths = await splitSheet(cleanedSheetPath, 7, cleaned.gridCols, cleaned.gridRows, resolve(RUN_DIR, 'playback'));
  const auditPath = await createAuditSheet();

  const frames: JsonRecord[] = [];
  for (const anchor of HIGH_KICK_ANCHORS) {
    const pose = await maskMetrics(anchorPath(anchor.frameIndex));
    const raw = await maskMetrics(rawFramePath(anchor.frameIndex));
    const union = await maskMetrics(resolve(frameDir(anchor.frameIndex), 'cleaned-union.png'));
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
        raw: relativeToProject(rawFramePath(anchor.frameIndex)),
        chromaOnly: relativeToProject(resolve(frameDir(anchor.frameIndex), 'chroma-only.png')),
        birefnet: relativeToProject(resolve(frameDir(anchor.frameIndex), 'birefnet.png')),
        cleanedUnion: relativeToProject(resolve(frameDir(anchor.frameIndex), 'cleaned-union.png')),
      },
    });
  }

  const completedEntries = Object.values(ledger.entries);
  const billingByRequestId = new Map(
    billing.currentEvents.map((event) => [event.requestId, event]),
  );
  const billedCostFor = (entry: LedgerEntry): number => {
    if (!entry.requestId) throw new Error(`Missing request id for billed entry ${entry.id}`);
    const event = billingByRequestId.get(entry.requestId);
    if (!event) throw new Error(`Missing billing event for ${entry.id}`);
    return event.costTotalUsd;
  };
  const incrementalGenerationBilledCostUsd = round(completedEntries
    .filter((entry) => entry.kind === 'generation')
    .reduce((sum, entry) => sum + billedCostFor(entry), 0), 8);
  const incrementalCleanupBilledCostUsd = round(completedEntries
    .filter((entry) => entry.kind === 'cleanup')
    .reduce((sum, entry) => sum + billedCostFor(entry), 0), 8);
  const incrementalBilledCostUsd = round(
    incrementalGenerationBilledCostUsd + incrementalCleanupBilledCostUsd,
    8,
  );
  const reusedGenerationBilledCostUsd = billing.reusedGenerationEvent.costTotalUsd;
  const logicalSequenceBilledCostUsd = round(
    incrementalBilledCostUsd + reusedGenerationBilledCostUsd,
    8,
  );
  const logicalGenerationBilledCostUsd = round(
    incrementalGenerationBilledCostUsd + reusedGenerationBilledCostUsd,
    8,
  );
  const cleanupCosts = billing.currentEvents
    .filter((event) => event.endpointId === BIREFNET_MODEL_ID)
    .map((event) => event.costTotalUsd);
  const cleanupMeanBilledCostUsd = round(
    cleanupCosts.reduce((sum, cost) => sum + cost, 0) / cleanupCosts.length,
    8,
  );
  const generationEvents = [
    ...billing.currentEvents.filter((event) => event.endpointId === FLASH_MODEL_ID),
    billing.reusedGenerationEvent,
  ];
  const generationMeanBilledCostUsd = round(
    generationEvents.reduce((sum, event) => sum + event.costTotalUsd, 0)
      / generationEvents.length,
    8,
  );
  const projectedGeneration76Usd = round(generationMeanBilledCostUsd * 76, 8);
  const projectedCleanup76MeanUsd = round(cleanupMeanBilledCostUsd * 76, 8);
  const projectedCleanup76MinUsd = round(Math.min(...cleanupCosts) * 76, 8);
  const projectedCleanup76MaxObservedUsd = round(Math.max(...cleanupCosts) * 76, 8);
  const report: JsonRecord = {
    schemaVersion: 1,
    runId: FLASH_SEQUENCE_RUN_ID,
    generatedAt: new Date().toISOString(),
    execution: {
      paidSubmissions: ledger.submittedCount,
      newGenerations: Object.values(ledger.entries).filter((entry) => entry.kind === 'generation' && entry.status === 'completed').length,
      cleanups: Object.values(ledger.entries).filter((entry) => entry.kind === 'cleanup' && entry.status === 'completed').length,
      reusedExactGeneration: 1,
      automaticRetries: 0,
      incrementalGenerationBilledCostUsd,
      incrementalCleanupBilledCostUsd,
      incrementalBilledCostUsd,
      reusedGenerationBilledCostUsd,
      logicalGenerationBilledCostUsd,
      logicalSequenceBilledCostUsd,
      billingSource: billing.source,
      billingEventsPath: relativeToProject(BILLING_EVENTS_PATH),
      originalGuardedBudgetUsd: flashSequenceGuardedBudgetUsd(),
      billingCorrectedGuardedBudgetUsd: FLASH_SEQUENCE_BILLING_CORRECTED_GUARD_USD,
      hardCapUsd: FLASH_SEQUENCE_HARD_CAP_USD,
      incrementalWithinApprovedCap: incrementalBilledCostUsd <= FLASH_SEQUENCE_HARD_CAP_USD,
      pricingReconciliation: 'The pricing endpoint reported $0.0008/compute-second, but the public FLUX.2 Flash page and billing events applied $0.005 per input/output megapixel. Per-request billing events are authoritative for this report.',
    },
    projected76UniqueRefines: {
      generationMeanBilledCostUsd,
      generationUsd: projectedGeneration76Usd,
      cleanupMeanBilledCostUsd,
      cleanupAtObservedMeanUsd: projectedCleanup76MeanUsd,
      cleanupObservedRangeUsd: [projectedCleanup76MinUsd, projectedCleanup76MaxObservedUsd],
      combinedAtObservedMeanUsd: round(projectedGeneration76Usd + projectedCleanup76MeanUsd, 8),
      combinedObservedRangeUsd: [
        round(projectedGeneration76Usd + projectedCleanup76MinUsd, 8),
        round(projectedGeneration76Usd + projectedCleanup76MaxObservedUsd, 8),
      ],
      caveat: 'Projection assumes 76 paid unique refines. Mirrored playback frames do not add calls. This run produced no acceptable complete sequence, so it is not a cost-per-accepted-sequence estimate.',
    },
    normalizedSequence: {
      playbackOrder: HIGH_KICK_PLAYBACK_ORDER,
      grid: { columns: cleaned.gridCols, rows: cleaned.gridRows },
      frameCount: cleaned.frameCount,
      frameWidth: cleaned.frameW,
      frameHeight: cleaned.frameH,
      usedScale: cleaned.usedScale,
    },
    artifacts: {
      auditSheet: relativeToProject(auditPath),
      rawSheet: relativeToProject(rawSheetPath),
      unionSheet: relativeToProject(preNormalizedPath),
      cleanedSheet: relativeToProject(cleanedSheetPath),
      playbackFrames: playbackFramePaths.map(relativeToProject),
    },
    frames,
    ledger: Object.values(ledger.entries).map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      frameIndex: entry.frameIndex,
      status: entry.status,
      durationMs: entry.durationMs ?? null,
      inferenceSeconds: entry.inferenceSeconds ?? null,
      runtimeDerivedCostEstimateUsd: entry.computedCostUsd ?? null,
      billedCostUsd: billedCostFor(entry),
    })),
  };
  await atomicWriteJson(REPORT_PATH, report);
  return report;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[A-Za-z0-9_-]{32,}/g, '<redacted>').slice(0, 600);
}

async function executeRequest(
  request: FlashSequenceRequest,
  ledger: SequenceLedger,
  falKey: string,
): Promise<void> {
  const entry = ledger.entries[request.id];
  if (!entry) throw new Error(`Missing ledger entry ${request.id}`);
  if (entry.status === 'completed') {
    if (request.kind === 'cleanup') await unionCleanup(request.frameIndex);
    return;
  }
  if (entry.status === 'submitting' || entry.status === 'unknown') {
    throw new Error(`${request.id} has unknown submission outcome and will not be resubmitted.`);
  }
  if (entry.status === 'failed') throw new Error(`${request.id} previously failed and will not be retried.`);

  const body = request.kind === 'generation'
    ? await hydrateGenerationBody(request.frameIndex)
    : (await prepareCleanup(request.frameIndex)).body;

  let output: QueueOutput;
  if (entry.status === 'queued') {
    output = await pollQueue(request, entry, ledger, falKey, Date.now());
  } else {
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
  entry.computedCostUsd = output.inferenceSeconds == null
    ? undefined
    : round(output.inferenceSeconds * LIVE_COMPUTE_SECOND_PRICE_USD, 8);
  entry.outputPath = relativeToProject(paths.outputPath);
  entry.metadataPath = relativeToProject(paths.metadataPath);
  ledger.updatedAt = entry.completedAt;
  await atomicWriteJson(LEDGER_PATH, ledger);
  if (request.kind === 'cleanup') await unionCleanup(request.frameIndex);
}

async function executeBenchmark(maxCostUsd: number): Promise<JsonRecord> {
  await buildManifest();
  const falKey = await loadFalKey();
  await pricingPreflight(falKey);
  const ledger = await loadOrCreateLedger(maxCostUsd);
  assertBudget(ledger);

  for (const request of buildFlashSequenceRequests()) {
    try {
      await executeRequest(request, ledger, falKey);
    } catch (error) {
      const entry = ledger.entries[request.id];
      if (entry && entry.status === 'submitting') entry.status = 'unknown';
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

function parseMaxCost(args: string[]): number {
  const raw = args.find((argument) => argument.startsWith('--max-cost-usd='))?.split('=')[1];
  const value = Number(raw);
  if (!Number.isFinite(value) || value < FLASH_SEQUENCE_BILLING_CORRECTED_GUARD_USD || value > FLASH_SEQUENCE_HARD_CAP_USD) {
    throw new Error(`--max-cost-usd must be between $${FLASH_SEQUENCE_BILLING_CORRECTED_GUARD_USD.toFixed(3)} and $${FLASH_SEQUENCE_HARD_CAP_USD.toFixed(2)}`);
  }
  return value;
}

async function main(): Promise<void> {
  const [command = 'plan', ...args] = process.argv.slice(2);
  if (command === 'plan') {
    const manifest = await buildManifest();
    console.log(JSON.stringify({
      runId: FLASH_SEQUENCE_RUN_ID,
      manifest: relativeToProject(MANIFEST_PATH),
      originalGuardedBudgetUsd: flashSequenceGuardedBudgetUsd(),
      billingCorrectedGuardedBudgetUsd: FLASH_SEQUENCE_BILLING_CORRECTED_GUARD_USD,
      hardCapUsd: FLASH_SEQUENCE_HARD_CAP_USD,
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
      runId: FLASH_SEQUENCE_RUN_ID,
      pricing: relativeToProject(PRICING_PATH),
      paidInferenceCalls: 0,
    }, null, 2));
    return;
  }
  if (command === 'execute') {
    if (!args.includes('--execute')) throw new Error('Paid execution requires --execute.');
    if (!args.includes(`--confirm-paid-benchmark=${FLASH_SEQUENCE_CONFIRMATION}`)) {
      throw new Error(`Paid execution requires --confirm-paid-benchmark=${FLASH_SEQUENCE_CONFIRMATION}`);
    }
    const maxCostUsd = parseMaxCost(args);
    const report = await executeBenchmark(maxCostUsd);
    console.log(JSON.stringify({
      runId: FLASH_SEQUENCE_RUN_ID,
      report: relativeToProject(REPORT_PATH),
      execution: report.execution,
      artifacts: report.artifacts,
    }, null, 2));
    return;
  }
  throw new Error('Unknown command. Use plan, pricing, or execute.');
}

await main();
