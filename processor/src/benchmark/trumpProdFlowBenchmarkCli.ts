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
  TRUMP_COMMON_GUARDS,
  TRUMP_PROD_FLOW_CONFIRMATION,
  TRUMP_PROD_FLOW_HARD_CAP_USD,
  TRUMP_PROD_FLOW_MAX_SUBMISSIONS,
  TRUMP_PROD_FLOW_RUN_ID,
  TRUMP_PROD_FLOW_SEEDS,
  TRUMP_RENDERERS,
  benchmarkFingerprint,
  buildTrumpHighKickScaffoldPrompt,
  buildTrumpRefinePrompt,
  buildTrumpSourcePrompt,
  guardedBudgetUsd,
  sha256Text,
  validateTrumpProdFlowPlan,
  type TrumpRenderer,
  type TrumpRendererId,
} from './trumpProdFlowBenchmark.ts';

installCanvasRuntime();

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SOURCE_DIR, '../../..');
const RUN_DIR = resolve(PROJECT_ROOT, '.qa/provider-benchmark', TRUMP_PROD_FLOW_RUN_ID);
const ORIGINAL_SOURCE_PATH = resolve(PROJECT_ROOT, '.arcade-sources/donald-trump.png');
const ORIGINAL_PATH = resolve(RUN_DIR, 'inputs/original-licensed-photo.png');
const MANIFEST_PATH = resolve(RUN_DIR, 'manifest.json');
const LEDGER_PATH = resolve(RUN_DIR, 'execution-ledger.json');
const PRICING_PATH = resolve(RUN_DIR, 'pricing-preflight.json');
const BILLING_PATH = resolve(RUN_DIR, 'billing-events.json');
const REPORT_PATH = resolve(RUN_DIR, 'report.json');
const LOCK_PATH = resolve(RUN_DIR, 'execution.lock');
const ORIGINAL_SHA256 = 'b8cdec38c5a7e8042acd2a095336a2a5b3255bf8771aedf7634860129af4c476';
const MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024;
const POLL_TIMEOUT_MS = 12 * 60_000;

type JsonRecord = Record<string, unknown>;
type EntryStatus = 'planned' | 'submitting' | 'queued' | 'completed' | 'failed' | 'skipped' | 'unknown';
type EntryKind = 'source' | 'scaffold' | 'refine' | 'cleanup';

interface LedgerEntry {
  id: string;
  rendererId: TrumpRendererId;
  kind: EntryKind;
  adapter: 'gemini' | 'fal';
  model: string;
  guardedMaxUsd: number;
  references: string[];
  frameIndex?: number;
  status: EntryStatus;
  submitStartedAt?: string;
  submittedAt?: string;
  completedAt?: string;
  requestId?: string;
  statusUrl?: string;
  responseUrl?: string;
  providerStatus?: string;
  durationMs?: number;
  outputPath?: string;
  metadataPath?: string;
  error?: string;
}

interface ExecutionLedger {
  schemaVersion: 1;
  runId: string;
  fingerprint: string;
  confirmedMaxCostUsd: number;
  guardedPlanUsd: number;
  committedGuardUsd: number;
  maxPaidSubmissions: number;
  submittedCount: number;
  automaticRetries: 0;
  createdAt: string;
  updatedAt: string;
  entries: Record<string, LedgerEntry>;
}

interface QueueOutput {
  bytes: Buffer;
  mimeType: string;
  metadata: JsonRecord;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256Buffer(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function round(value: number, digits = 9): number {
  return Number(value.toFixed(digits));
}

function relativeToProject(path: string): string {
  return relative(PROJECT_ROOT, path).split('\\').join('/');
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

function rendererDir(rendererId: TrumpRendererId): string {
  return resolve(RUN_DIR, 'outputs', rendererId);
}

function sourceRawPath(rendererId: TrumpRendererId): string {
  return resolve(rendererDir(rendererId), 'source/raw.png');
}

function sourceCleanPath(rendererId: TrumpRendererId): string {
  return resolve(rendererDir(rendererId), 'source/clean.png');
}

function scaffoldPath(rendererId: TrumpRendererId): string {
  return resolve(rendererDir(rendererId), 'scaffold/raw.png');
}

function scaffoldCellPath(rendererId: TrumpRendererId, frameIndex: number): string {
  return resolve(rendererDir(rendererId), 'scaffold/cells', `frame-${String(frameIndex).padStart(2, '0')}.png`);
}

function frameDir(rendererId: TrumpRendererId, frameIndex: number): string {
  return resolve(rendererDir(rendererId), 'frames', `frame-${String(frameIndex).padStart(2, '0')}`);
}

function rawFramePath(rendererId: TrumpRendererId, frameIndex: number): string {
  return resolve(frameDir(rendererId, frameIndex), 'raw.png');
}

function cleanedFramePath(rendererId: TrumpRendererId, frameIndex: number): string {
  return resolve(frameDir(rendererId, frameIndex), 'cleaned-union.png');
}

function entryId(rendererId: TrumpRendererId, kind: EntryKind, frameIndex?: number): string {
  return `${rendererId}:${kind}${frameIndex === undefined ? '' : `:${String(frameIndex).padStart(2, '0')}`}`;
}

function buildEntries(): Record<string, LedgerEntry> {
  const entries: LedgerEntry[] = [];
  for (const renderer of TRUMP_RENDERERS) {
    entries.push({
      id: entryId(renderer.id, 'source'),
      rendererId: renderer.id,
      kind: 'source',
      adapter: renderer.adapter,
      model: renderer.model,
      guardedMaxUsd: renderer.guardedSourceUsd,
      references: ['inputs/original-licensed-photo.png'],
      status: 'planned',
    });
    entries.push({
      id: entryId(renderer.id, 'scaffold'),
      rendererId: renderer.id,
      kind: 'scaffold',
      adapter: renderer.adapter,
      model: renderer.model,
      guardedMaxUsd: renderer.guardedScaffoldUsd,
      references: [`outputs/${renderer.id}/source/clean.png`],
      status: 'planned',
    });
    for (let frameIndex = 0; frameIndex < 4; frameIndex += 1) {
      entries.push({
        id: entryId(renderer.id, 'refine', frameIndex),
        rendererId: renderer.id,
        kind: 'refine',
        adapter: renderer.adapter,
        model: renderer.model,
        frameIndex,
        guardedMaxUsd: renderer.guardedFrameUsd,
        references: renderer.adapter === 'gemini'
          ? ['inputs/original-licensed-photo.png', `outputs/${renderer.id}/scaffold/cells/frame-${String(frameIndex).padStart(2, '0')}.png`]
          : [`outputs/${renderer.id}/scaffold/cells/frame-${String(frameIndex).padStart(2, '0')}.png`, 'inputs/original-licensed-photo.png'],
        status: 'planned',
      });
      entries.push({
        id: entryId(renderer.id, 'cleanup', frameIndex),
        rendererId: renderer.id,
        kind: 'cleanup',
        adapter: 'fal',
        model: 'fal-ai/birefnet',
        frameIndex,
        guardedMaxUsd: TRUMP_COMMON_GUARDS.cleanupPerFrameUsd,
        references: [`outputs/${renderer.id}/frames/frame-${String(frameIndex).padStart(2, '0')}/birefnet-input.jpg`],
        status: 'planned',
      });
    }
  }
  return Object.fromEntries(entries.map((entry) => [entry.id, entry]));
}

async function loadOrCreateLedger(confirmedMaxCostUsd: number): Promise<ExecutionLedger> {
  if (await exists(LEDGER_PATH)) {
    const value = await readJson(LEDGER_PATH);
    if (!isRecord(value) || value.runId !== TRUMP_PROD_FLOW_RUN_ID || value.fingerprint !== benchmarkFingerprint()) {
      throw new Error('Existing ledger does not match this frozen benchmark. Refusing to submit.');
    }
    return value as unknown as ExecutionLedger;
  }
  const now = new Date().toISOString();
  const ledger: ExecutionLedger = {
    schemaVersion: 1,
    runId: TRUMP_PROD_FLOW_RUN_ID,
    fingerprint: benchmarkFingerprint(),
    confirmedMaxCostUsd,
    guardedPlanUsd: guardedBudgetUsd(),
    committedGuardUsd: 0,
    maxPaidSubmissions: TRUMP_PROD_FLOW_MAX_SUBMISSIONS,
    submittedCount: 0,
    automaticRetries: 0,
    createdAt: now,
    updatedAt: now,
    entries: buildEntries(),
  };
  await atomicWriteJson(LEDGER_PATH, ledger);
  return ledger;
}

async function reserveSubmission(ledger: ExecutionLedger, entry: LedgerEntry): Promise<void> {
  if (entry.status !== 'planned') throw new Error(`Cannot reserve ${entry.id} from status ${entry.status}.`);
  if (ledger.submittedCount + 1 > ledger.maxPaidSubmissions) throw new Error('Paid submission count cap reached.');
  const nextGuard = round(ledger.committedGuardUsd + entry.guardedMaxUsd, 6);
  if (nextGuard > ledger.confirmedMaxCostUsd + 1e-9 || nextGuard > TRUMP_PROD_FLOW_HARD_CAP_USD + 1e-9) {
    throw new Error(`Cost guard would exceed cap: ${nextGuard} > ${ledger.confirmedMaxCostUsd}.`);
  }
  const now = new Date().toISOString();
  entry.status = 'submitting';
  entry.submitStartedAt = now;
  ledger.submittedCount += 1;
  ledger.committedGuardUsd = nextGuard;
  ledger.updatedAt = now;
  await atomicWriteJson(LEDGER_PATH, ledger);
}

async function markFailed(ledger: ExecutionLedger, entry: LedgerEntry, error: unknown): Promise<void> {
  entry.status = 'failed';
  entry.error = (error instanceof Error ? error.message : String(error)).slice(0, 800);
  entry.completedAt = new Date().toISOString();
  ledger.updatedAt = entry.completedAt;
  await atomicWriteJson(LEDGER_PATH, ledger);
}

async function markSkipped(ledger: ExecutionLedger, entry: LedgerEntry, reason: string): Promise<void> {
  if (entry.status === 'completed') return;
  entry.status = 'skipped';
  entry.error = reason;
  entry.completedAt = new Date().toISOString();
  ledger.updatedAt = entry.completedAt;
  await atomicWriteJson(LEDGER_PATH, ledger);
}

async function writePng(bytes: Buffer, outputPath: string): Promise<void> {
  if (bytes.byteLength <= 0 || bytes.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(`Unexpected image size: ${bytes.byteLength} bytes.`);
  }
  const image = await loadImage(bytes);
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext('2d').drawImage(image, 0, 0);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, canvas.toBuffer('image/png'), { mode: 0o600 });
}

function geminiBody(imageBuffers: Buffer[], prompt: string, seed: number): JsonRecord {
  return {
    contents: [{
      role: 'user',
      parts: [
        ...imageBuffers.map((buffer) => ({ inlineData: { mimeType: 'image/png', data: buffer.toString('base64') } })),
        { text: prompt },
      ],
    }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      seed,
      imageConfig: { aspectRatio: '3:4', imageSize: '1K' },
    },
  };
}

function findGeminiImage(value: unknown): QueueOutput {
  if (!isRecord(value)) throw new Error('Gemini returned a non-object response.');
  const promptFeedback = isRecord(value.promptFeedback) ? value.promptFeedback : null;
  const candidates = Array.isArray(value.candidates) ? value.candidates : [];
  const candidate = isRecord(candidates[0]) ? candidates[0] : null;
  const parts = candidate && isRecord(candidate.content) && Array.isArray(candidate.content.parts)
    ? candidate.content.parts
    : [];
  let imageData: string | undefined;
  let mimeType = 'image/png';
  let text = '';
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (typeof part.text === 'string') text += part.text;
    if (isRecord(part.inlineData) && typeof part.inlineData.data === 'string') {
      imageData = part.inlineData.data;
      if (typeof part.inlineData.mimeType === 'string') mimeType = part.inlineData.mimeType;
    }
  }
  if (!imageData) {
    const reason = candidate?.finishReason ?? promptFeedback?.blockReason ?? 'unknown';
    throw new Error(`Gemini returned no image (reason: ${String(reason)}${text ? `; ${text.slice(0, 160)}` : ''}).`);
  }
  return {
    bytes: Buffer.from(imageData, 'base64'),
    mimeType,
    metadata: {
      finishReason: candidate?.finishReason ?? null,
      promptBlockReason: promptFeedback?.blockReason ?? null,
      modelVersion: value.modelVersion ?? null,
      usageMetadata: value.usageMetadata ?? null,
      text: text.slice(0, 500),
    },
  };
}

async function executeGemini(
  renderer: TrumpRenderer,
  entry: LedgerEntry,
  ledger: ExecutionLedger,
  images: Buffer[],
  prompt: string,
  seed: number,
  outputPath: string,
  geminiKey: string,
): Promise<void> {
  await reserveSubmission(ledger, entry);
  const startedAt = Date.now();
  try {
    const response = await fetch(renderer.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
      body: JSON.stringify(geminiBody(images, prompt, seed)),
      signal: AbortSignal.timeout(180_000),
    });
    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      throw new Error(`Gemini HTTP ${response.status}: non-JSON response.`);
    }
    if (!response.ok) {
      const message = isRecord(json) && isRecord(json.error) ? json.error.message : text;
      throw new Error(`Gemini HTTP ${response.status}: ${String(message).slice(0, 400)}`);
    }
    const output = findGeminiImage(json);
    await writePng(output.bytes, outputPath);
    const metadataPath = resolve(dirname(outputPath), 'provider-metadata.json');
    await atomicWriteJson(metadataPath, output.metadata);
    entry.status = 'completed';
    entry.completedAt = new Date().toISOString();
    entry.durationMs = Date.now() - startedAt;
    entry.outputPath = relativeToProject(outputPath);
    entry.metadataPath = relativeToProject(metadataPath);
    ledger.updatedAt = entry.completedAt;
    await atomicWriteJson(LEDGER_PATH, ledger);
  } catch (error) {
    await markFailed(ledger, entry, error);
    throw error;
  }
}

function requireQueueUrl(value: string, label: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'queue.fal.run') {
    throw new Error(`Unexpected fal ${label} host.`);
  }
  return url.toString();
}

function falPayload(renderer: TrumpRenderer, imageBuffers: Buffer[], prompt: string, seed: number): JsonRecord {
  const common: JsonRecord = {
    prompt,
    image_urls: imageBuffers.map((buffer) => `data:image/png;base64,${buffer.toString('base64')}`),
    image_size: { width: 864, height: 1152 },
    seed,
    sync_mode: false,
    enable_safety_checker: true,
  };
  if (renderer.id === 'klein-4b' || renderer.id === 'klein-9b') {
    return { ...common, num_inference_steps: 4, num_images: 1, output_format: 'png' };
  }
  if (renderer.id === 'flux2-pro') {
    return { ...common, safety_tolerance: '2', output_format: 'png' };
  }
  if (renderer.id === 'flux2-flash') {
    return { ...common, guidance_scale: 2.5, num_images: 1, enable_prompt_expansion: false, output_format: 'png' };
  }
  return { ...common, num_images: 1, max_images: 1, enhance_prompt_mode: 'standard' };
}

function findFalOutput(value: unknown, cleanup: boolean): { url: string; metadata: JsonRecord } {
  if (!isRecord(value)) throw new Error('fal returned a non-object result.');
  const image = cleanup
    ? (isRecord(value.image) ? value.image : null)
    : (Array.isArray(value.images) && isRecord(value.images[0]) ? value.images[0] : null);
  if (!image || typeof image.url !== 'string') throw new Error('fal completed but returned no image URL.');
  return {
    url: image.url,
    metadata: {
      seed: value.seed ?? null,
      timings: value.timings ?? null,
      hasNsfwConcepts: value.has_nsfw_concepts ?? null,
      output: {
        width: image.width ?? null,
        height: image.height ?? null,
        contentType: image.content_type ?? null,
        fileSize: image.file_size ?? null,
        remoteHost: new URL(image.url).hostname,
      },
    },
  };
}

async function pollFal(entry: LedgerEntry, ledger: ExecutionLedger, falKey: string, cleanup: boolean): Promise<QueueOutput> {
  if (!entry.requestId || !entry.statusUrl || !entry.responseUrl) throw new Error(`Missing queue data for ${entry.id}.`);
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let consecutiveErrors = 0;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(entry.statusUrl, {
        headers: { Authorization: `Key ${falKey}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`status HTTP ${response.status}`);
      const statusJson = await response.json() as unknown;
      const status = isRecord(statusJson) && typeof statusJson.status === 'string'
        ? statusJson.status.toUpperCase()
        : 'UNKNOWN';
      entry.providerStatus = status;
      entry.status = 'queued';
      ledger.updatedAt = new Date().toISOString();
      await atomicWriteJson(LEDGER_PATH, ledger);
      if (['FAILED', 'ERROR', 'CANCELLED', 'CANCELED'].includes(status)) {
        throw new Error(`fal request ended with ${status}.`);
      }
      if (status === 'COMPLETED') {
        const result = await fetch(entry.responseUrl, {
          headers: { Authorization: `Key ${falKey}` },
          signal: AbortSignal.timeout(60_000),
        });
        if (!result.ok) {
          const responseText = await result.text();
          let detail: unknown = responseText;
          try {
            const parsed = JSON.parse(responseText) as unknown;
            detail = isRecord(parsed) ? parsed.detail ?? parsed.error ?? parsed.message ?? parsed : parsed;
          } catch {
            // Preserve the bounded raw response when fal does not return JSON.
          }
          throw new Error(`result HTTP ${result.status}: ${JSON.stringify(detail).slice(0, 600)}`);
        }
        const found = findFalOutput(await result.json() as unknown, cleanup);
        const url = new URL(found.url);
        if (url.protocol !== 'https:') throw new Error('fal returned a non-HTTPS output URL.');
        const download = await fetch(url, { signal: AbortSignal.timeout(90_000) });
        if (!download.ok) throw new Error(`download HTTP ${download.status}`);
        const bytes = Buffer.from(await download.arrayBuffer());
        if (bytes.byteLength <= 0 || bytes.byteLength > MAX_DOWNLOAD_BYTES) throw new Error('fal output size is invalid.');
        return { bytes, mimeType: download.headers.get('content-type') || 'image/png', metadata: found.metadata };
      }
      consecutiveErrors = 0;
    } catch (error) {
      consecutiveErrors += 1;
      if (consecutiveErrors >= 5) throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
  }
  throw new Error('fal polling timed out; request remains resumable and was not resubmitted.');
}

async function executeFal(
  renderer: TrumpRenderer,
  entry: LedgerEntry,
  ledger: ExecutionLedger,
  body: JsonRecord,
  outputPath: string,
  falKey: string,
  cleanup = false,
): Promise<void> {
  const startedAt = Date.now();
  try {
    if (!entry.requestId) {
      await reserveSubmission(ledger, entry);
      const response = await fetch(renderer.endpoint, {
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
        throw new Error(`fal submit HTTP ${response.status}: non-JSON response.`);
      }
      if (!response.ok || !isRecord(json) || typeof json.request_id !== 'string') {
        const detail = isRecord(json) ? json.detail ?? json.error ?? json.message : responseText;
        throw new Error(`fal submit HTTP ${response.status}: ${String(detail).slice(0, 400)}`);
      }
      entry.requestId = json.request_id;
      entry.statusUrl = typeof json.status_url === 'string'
        ? requireQueueUrl(json.status_url, 'status URL')
        : `https://queue.fal.run/${renderer.model}/requests/${json.request_id}/status?logs=1`;
      entry.responseUrl = typeof json.response_url === 'string'
        ? requireQueueUrl(json.response_url, 'response URL')
        : `https://queue.fal.run/${renderer.model}/requests/${json.request_id}`;
      entry.status = 'queued';
      entry.submittedAt = new Date().toISOString();
      ledger.updatedAt = entry.submittedAt;
      await atomicWriteJson(LEDGER_PATH, ledger);
    }
    const output = await pollFal(entry, ledger, falKey, cleanup);
    await writePng(output.bytes, outputPath);
    const metadataPath = resolve(dirname(outputPath), cleanup ? 'birefnet-metadata.json' : 'provider-metadata.json');
    await atomicWriteJson(metadataPath, output.metadata);
    entry.status = 'completed';
    entry.completedAt = new Date().toISOString();
    entry.durationMs = Date.now() - startedAt;
    entry.outputPath = relativeToProject(outputPath);
    entry.metadataPath = relativeToProject(metadataPath);
    ledger.updatedAt = entry.completedAt;
    await atomicWriteJson(LEDGER_PATH, ledger);
  } catch (error) {
    await markFailed(ledger, entry, error);
    throw error;
  }
}

async function splitScaffold(rendererId: TrumpRendererId): Promise<void> {
  const image = await loadImage(await readFile(scaffoldPath(rendererId)));
  const cellWidth = Math.floor(image.width / 2);
  const cellHeight = Math.floor(image.height / 2);
  for (let frameIndex = 0; frameIndex < 4; frameIndex += 1) {
    const canvas = createCanvas(cellWidth, cellHeight);
    canvas.getContext('2d').drawImage(
      image,
      (frameIndex % 2) * cellWidth,
      Math.floor(frameIndex / 2) * cellHeight,
      cellWidth,
      cellHeight,
      0,
      0,
      cellWidth,
      cellHeight,
    );
    const path = scaffoldCellPath(rendererId, frameIndex);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, canvas.toBuffer('image/png'), { mode: 0o600 });
  }
}

async function prepareCleanup(rendererId: TrumpRendererId, frameIndex: number): Promise<JsonRecord> {
  const directory = frameDir(rendererId, frameIndex);
  const raw = await readFile(rawFramePath(rendererId, frameIndex));
  const neutralized = await neutralizeGreenSpillForSegmentation(raw.toString('base64'));
  const chroma = await cleanReposedImagePreserveCanvas(neutralized);
  await writeFile(resolve(directory, 'neutralized.png'), Buffer.from(neutralized, 'base64'), { mode: 0o600 });
  await writeFile(resolve(directory, 'chroma-only.png'), Buffer.from(chroma, 'base64'), { mode: 0o600 });
  const image = await loadImage(Buffer.from(neutralized, 'base64'));
  const scale = Math.min(1024 / image.width, 1024 / image.height, 1);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = createCanvas(width, height);
  canvas.getContext('2d').drawImage(image, 0, 0, width, height);
  const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.85);
  const jpegBase64 = jpegDataUrl.slice(jpegDataUrl.indexOf(',') + 1);
  await writeFile(resolve(directory, 'birefnet-input.jpg'), Buffer.from(jpegBase64, 'base64'), { mode: 0o600 });
  return { image_url: `data:image/jpeg;base64,${jpegBase64}` };
}

async function unionCleanup(rendererId: TrumpRendererId, frameIndex: number): Promise<void> {
  const directory = frameDir(rendererId, frameIndex);
  const chromaImage = await loadImage(await readFile(resolve(directory, 'chroma-only.png')));
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
  await writeFile(cleanedFramePath(rendererId, frameIndex), canvas.toBuffer('image/png'), { mode: 0o600 });
}

async function composeSheet(paths: string[], columns: number, rows: number, transparent: boolean): Promise<Buffer> {
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

async function finalizeRenderer(rendererId: TrumpRendererId): Promise<void> {
  const uniqueRaw = [0, 1, 2, 3].map((frame) => rawFramePath(rendererId, frame));
  const uniqueClean = [0, 1, 2, 3].map((frame) => cleanedFramePath(rendererId, frame));
  if (!(await Promise.all([...uniqueRaw, ...uniqueClean].map(exists))).every(Boolean)) return;
  const rawPlayback = expandMirroredSequence(uniqueRaw, 7);
  const cleanPlayback = expandMirroredSequence(uniqueClean, 7);
  const sheetsDir = resolve(rendererDir(rendererId), 'sheets');
  await mkdir(sheetsDir, { recursive: true });
  await writeFile(resolve(sheetsDir, 'raw-playback.png'), await composeSheet(rawPlayback, 4, 2, false), { mode: 0o600 });
  const unionSheet = await composeSheet(cleanPlayback, 4, 2, true);
  await writeFile(resolve(sheetsDir, 'union-playback.png'), unionSheet, { mode: 0o600 });
  const normalized = await cleanSpriteSheet(unionSheet.toString('base64'), 7, 4, 2, 'high_kick');
  await writeFile(resolve(sheetsDir, 'production-normalized.png'), Buffer.from(normalized.base64, 'base64'), { mode: 0o600 });
}

async function comparisonSheet(kind: 'raw' | 'cleaned'): Promise<string> {
  const previewWidth = 270;
  const previewHeight = 360;
  const labelHeight = 34;
  const columns = 4;
  const rows = TRUMP_RENDERERS.length;
  const canvas = createCanvas(previewWidth * columns, (previewHeight + labelHeight) * rows);
  const context = canvas.getContext('2d');
  context.fillStyle = '#202020';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.font = 'bold 15px sans-serif';
  context.textBaseline = 'middle';
  for (let row = 0; row < rows; row += 1) {
    const renderer = TRUMP_RENDERERS[row];
    for (let frameIndex = 0; frameIndex < 4; frameIndex += 1) {
      const path = kind === 'raw' ? rawFramePath(renderer.id, frameIndex) : cleanedFramePath(renderer.id, frameIndex);
      const x = frameIndex * previewWidth;
      const y = row * (previewHeight + labelHeight);
      context.fillStyle = kind === 'raw' ? '#00ff00' : '#555555';
      context.fillRect(x, y, previewWidth, previewHeight);
      if (await exists(path)) {
        const image = await loadImage(await readFile(path));
        context.drawImage(image, x, y, previewWidth, previewHeight);
      }
      context.fillStyle = '#111111';
      context.fillRect(x, y + previewHeight, previewWidth, labelHeight);
      context.fillStyle = '#ffffff';
      context.fillText(`${renderer.id} · F${frameIndex}`, x + 8, y + previewHeight + labelHeight / 2);
    }
  }
  const path = resolve(RUN_DIR, `comparison-${kind}.png`);
  await writeFile(path, canvas.toBuffer('image/png'), { mode: 0o600 });
  return path;
}

async function pricingPreflight(falKey: string): Promise<JsonRecord> {
  const expected: Record<string, { maxPrice: number; units: string[] }> = {
    'fal-ai/flux-2/klein/4b/edit': { maxPrice: 0.01, units: ['megapixels'] },
    'fal-ai/flux-2/klein/9b/edit': { maxPrice: 0.011, units: ['megapixels'] },
    'fal-ai/flux-2-pro/edit': { maxPrice: 0.03, units: ['processed megapixels'] },
    'fal-ai/flux-2/flash/edit': { maxPrice: 0.0008, units: ['compute seconds'] },
    'fal-ai/bytedance/seedream/v4/edit': { maxPrice: 0.03, units: ['images'] },
    'fal-ai/birefnet': { maxPrice: 0.0008, units: ['compute seconds'] },
  };
  const models: Record<string, unknown> = {};
  for (const [model, guard] of Object.entries(expected)) {
    const url = new URL('https://api.fal.ai/v1/models/pricing');
    url.searchParams.set('endpoint_id', model);
    let response: Response | undefined;
    let json: unknown;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      response = await fetch(url, {
        headers: { Authorization: `Key ${falKey}` },
        signal: AbortSignal.timeout(30_000),
      });
      const body = await response.text();
      try {
        json = JSON.parse(body) as unknown;
      } catch {
        json = body.slice(0, 1_000);
      }
      if (response.ok || response.status !== 429 || attempt === 5) break;
      const retryAfter = Number(response.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(30_000, retryAfter * 1_000)
        : Math.min(20_000, 2_000 * (attempt + 1));
      await new Promise((resolveDelay) => setTimeout(resolveDelay, waitMs));
    }
    models[model] = { httpStatus: response?.status ?? null, response: json };
    await atomicWriteJson(PRICING_PATH, {
      checkedAt: new Date().toISOString(),
      paidInferenceCalls: 0,
      source: 'https://api.fal.ai/v1/models/pricing',
      models,
    });
    if (!response) throw new Error(`Pricing preflight did not run for ${model}. No inference was submitted.`);
    if (!response.ok || !isRecord(json) || !Array.isArray(json.prices) || !isRecord(json.prices[0])) {
      throw new Error(`Pricing preflight failed for ${model} with HTTP ${response.status}. No inference was submitted.`);
    }
    const price = json.prices[0];
    if (
      typeof price.unit_price !== 'number' ||
      price.unit_price > guard.maxPrice ||
      typeof price.unit !== 'string' ||
      !guard.units.includes(price.unit) ||
      price.currency !== 'USD'
    ) {
      throw new Error(`Pricing changed for ${model}. No inference was submitted.`);
    }
  }
  const result: JsonRecord = {
    checkedAt: new Date().toISOString(),
    paidInferenceCalls: 0,
    source: 'https://api.fal.ai/v1/models/pricing',
    models,
  };
  await atomicWriteJson(PRICING_PATH, result);
  return result;
}

async function prepareRun(): Promise<void> {
  validateTrumpProdFlowPlan();
  await mkdir(resolve(RUN_DIR, 'inputs'), { recursive: true });
  const original = await readFile(ORIGINAL_SOURCE_PATH);
  if (sha256Buffer(original) !== ORIGINAL_SHA256) throw new Error('Licensed Trump source hash does not match the roster manifest.');
  await copyFile(ORIGINAL_SOURCE_PATH, ORIGINAL_PATH);
  const promptsDir = resolve(RUN_DIR, 'prompts');
  await mkdir(promptsDir, { recursive: true });
  await writeFile(resolve(promptsDir, 'source.txt'), buildTrumpSourcePrompt(), { mode: 0o600 });
  await writeFile(resolve(promptsDir, 'scaffold.txt'), buildTrumpHighKickScaffoldPrompt(), { mode: 0o600 });
  for (const renderer of TRUMP_RENDERERS) {
    const directory = resolve(promptsDir, renderer.id);
    await mkdir(directory, { recursive: true });
    for (let frameIndex = 0; frameIndex < 4; frameIndex += 1) {
      await writeFile(
        resolve(directory, `frame-${String(frameIndex).padStart(2, '0')}.txt`),
        buildTrumpRefinePrompt(renderer.id, frameIndex),
        { mode: 0o600 },
      );
    }
  }
  const manifest: JsonRecord = {
    schemaVersion: 1,
    runId: TRUMP_PROD_FLOW_RUN_ID,
    generatedAt: new Date().toISOString(),
    fingerprint: benchmarkFingerprint(),
    scope: {
      architecture: 'per-renderer original -> canonical -> character-specific 2x2 scaffold -> four unique refines -> production cleanup -> local mirror',
      productionRuntimeChanged: false,
      rendererPromotionAuthorized: false,
      originalIncludedInSource: true,
      originalIncludedInEveryRefine: true,
      genericActorAnchorsUsed: false,
      textOnlyFallbackAllowed: false,
    },
    safety: {
      hardCapUsd: TRUMP_PROD_FLOW_HARD_CAP_USD,
      guardedPlanUsd: guardedBudgetUsd(),
      maxPaidSubmissions: TRUMP_PROD_FLOW_MAX_SUBMISSIONS,
      automaticRetries: 0,
      providerFallbacks: 0,
      confirmation: TRUMP_PROD_FLOW_CONFIRMATION,
    },
    input: {
      path: relativeToProject(ORIGINAL_PATH),
      sourcePath: relativeToProject(ORIGINAL_SOURCE_PATH),
      sha256: ORIGINAL_SHA256,
      provenance: 'Daniel Torok / The White House (2025), public-domain US federal government work',
    },
    prompts: {
      source: { path: 'prompts/source.txt', sha256: sha256Text(buildTrumpSourcePrompt()) },
      scaffold: { path: 'prompts/scaffold.txt', sha256: sha256Text(buildTrumpHighKickScaffoldPrompt()) },
      refines: Object.fromEntries(TRUMP_RENDERERS.map((renderer) => [renderer.id, [0, 1, 2, 3].map((frameIndex) => ({
        path: `prompts/${renderer.id}/frame-${String(frameIndex).padStart(2, '0')}.txt`,
        sha256: sha256Text(buildTrumpRefinePrompt(renderer.id, frameIndex)),
      }))])),
    },
    renderers: TRUMP_RENDERERS,
    notes: [
      'Each renderer builds its own canonical source and its own Trump-specific scaffold so a Gemini safety block cannot invalidate the other candidates.',
      'Refines use exactly two references: the pose cell as the only body geometry plus the unaltered original portrait for identity and surface texture.',
      'Gemini receives original then pose due its prompt roles; fal renderers receive pose then original so the editable canvas is first.',
      'No production provider selector, fallback, retry, workflow, seeder, or proxy route is modified.',
    ],
  };
  await atomicWriteJson(MANIFEST_PATH, manifest);
}

async function runRenderer(
  renderer: TrumpRenderer,
  ledger: ExecutionLedger,
  original: Buffer,
  geminiKey: string,
  falKey: string,
): Promise<void> {
  const sourceEntry = ledger.entries[entryId(renderer.id, 'source')];
  if (sourceEntry.status !== 'completed') {
    try {
      if (renderer.adapter === 'gemini') {
        await executeGemini(renderer, sourceEntry, ledger, [original], buildTrumpSourcePrompt(), TRUMP_PROD_FLOW_SEEDS.source, sourceRawPath(renderer.id), geminiKey);
      } else {
        await executeFal(renderer, sourceEntry, ledger, falPayload(renderer, [original], buildTrumpSourcePrompt(), TRUMP_PROD_FLOW_SEEDS.source), sourceRawPath(renderer.id), falKey);
      }
    } catch (error) {
      process.stderr.write(`[${renderer.id}] source failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  if (sourceEntry.status !== 'completed' || !(await exists(sourceRawPath(renderer.id)))) {
    for (const entry of Object.values(ledger.entries).filter((candidate) => candidate.rendererId === renderer.id && candidate.kind !== 'source')) {
      await markSkipped(ledger, entry, 'Source stage did not produce an image; no text-only or cross-provider fallback is allowed.');
    }
    return;
  }

  if (!(await exists(sourceCleanPath(renderer.id)))) {
    const raw = await readFile(sourceRawPath(renderer.id));
    const clean = await cleanReposedImagePreserveCanvas(raw.toString('base64'));
    await writeFile(sourceCleanPath(renderer.id), Buffer.from(clean, 'base64'), { mode: 0o600 });
  }
  const canonical = await readFile(sourceCleanPath(renderer.id));

  const scaffoldEntry = ledger.entries[entryId(renderer.id, 'scaffold')];
  if (scaffoldEntry.status !== 'completed') {
    try {
      if (renderer.adapter === 'gemini') {
        await executeGemini(renderer, scaffoldEntry, ledger, [canonical], buildTrumpHighKickScaffoldPrompt(), TRUMP_PROD_FLOW_SEEDS.scaffold, scaffoldPath(renderer.id), geminiKey);
      } else {
        await executeFal(renderer, scaffoldEntry, ledger, falPayload(renderer, [canonical], buildTrumpHighKickScaffoldPrompt(), TRUMP_PROD_FLOW_SEEDS.scaffold), scaffoldPath(renderer.id), falKey);
      }
    } catch (error) {
      process.stderr.write(`[${renderer.id}] scaffold failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  if (scaffoldEntry.status !== 'completed' || !(await exists(scaffoldPath(renderer.id)))) {
    for (const entry of Object.values(ledger.entries).filter((candidate) => candidate.rendererId === renderer.id && (candidate.kind === 'refine' || candidate.kind === 'cleanup'))) {
      await markSkipped(ledger, entry, 'Scaffold stage did not produce an image.');
    }
    return;
  }
  await splitScaffold(renderer.id);

  for (let frameIndex = 0; frameIndex < 4; frameIndex += 1) {
    const refineEntry = ledger.entries[entryId(renderer.id, 'refine', frameIndex)];
    if (refineEntry.status === 'completed') continue;
    const pose = await readFile(scaffoldCellPath(renderer.id, frameIndex));
    try {
      if (renderer.adapter === 'gemini') {
        await executeGemini(
          renderer,
          refineEntry,
          ledger,
          [original, pose],
          buildTrumpRefinePrompt(renderer.id, frameIndex),
          TRUMP_PROD_FLOW_SEEDS.frames[frameIndex],
          rawFramePath(renderer.id, frameIndex),
          geminiKey,
        );
      } else {
        await executeFal(
          renderer,
          refineEntry,
          ledger,
          falPayload(renderer, [pose, original], buildTrumpRefinePrompt(renderer.id, frameIndex), TRUMP_PROD_FLOW_SEEDS.frames[frameIndex]),
          rawFramePath(renderer.id, frameIndex),
          falKey,
        );
      }
    } catch (error) {
      process.stderr.write(`[${renderer.id}] frame ${frameIndex} failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  const birefnetRenderer: TrumpRenderer = {
    id: renderer.id,
    label: 'BiRefNet cleanup',
    adapter: 'fal',
    model: 'fal-ai/birefnet',
    endpoint: 'https://queue.fal.run/fal-ai/birefnet',
    guardedSourceUsd: 0,
    guardedScaffoldUsd: 0,
    guardedFrameUsd: TRUMP_COMMON_GUARDS.cleanupPerFrameUsd,
    pricingSource: 'https://fal.ai/models/fal-ai/birefnet',
  };
  for (let frameIndex = 0; frameIndex < 4; frameIndex += 1) {
    const cleanupEntry = ledger.entries[entryId(renderer.id, 'cleanup', frameIndex)];
    const refineEntry = ledger.entries[entryId(renderer.id, 'refine', frameIndex)];
    if (refineEntry.status !== 'completed' || !(await exists(rawFramePath(renderer.id, frameIndex)))) {
      await markSkipped(ledger, cleanupEntry, 'Refine stage did not produce a raw frame.');
      continue;
    }
    if (cleanupEntry.status !== 'completed') {
      try {
        const body = await prepareCleanup(renderer.id, frameIndex);
        await executeFal(
          birefnetRenderer,
          cleanupEntry,
          ledger,
          body,
          resolve(frameDir(renderer.id, frameIndex), 'birefnet.png'),
          falKey,
          true,
        );
      } catch (error) {
        process.stderr.write(`[${renderer.id}] cleanup ${frameIndex} failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    if (cleanupEntry.status === 'completed') await unionCleanup(renderer.id, frameIndex);
  }
  await finalizeRenderer(renderer.id);
}

interface BillingEvent {
  requestId: string;
  endpointId: string;
  costTotalUsd: number;
  outputUnits: number;
  unitPriceUsd: number;
  timestamp: string;
}

function parseBillingEvent(value: unknown): BillingEvent | null {
  if (!isRecord(value) || typeof value.request_id !== 'string' || typeof value.endpoint_id !== 'string') return null;
  const cost = typeof value.cost_total === 'number'
    ? value.cost_total
    : typeof value.cost_estimate_nano_usd === 'number'
      ? value.cost_estimate_nano_usd / 1_000_000_000
      : null;
  if (cost === null || typeof value.output_units !== 'number' || typeof value.unit_price !== 'number') return null;
  return {
    requestId: value.request_id,
    endpointId: value.endpoint_id,
    costTotalUsd: round(cost),
    outputUnits: value.output_units,
    unitPriceUsd: value.unit_price,
    timestamp: typeof value.timestamp === 'string' ? value.timestamp : '',
  };
}

async function reconcileBilling(ledger: ExecutionLedger, falKey: string): Promise<BillingEvent[]> {
  const requestIds = Object.values(ledger.entries)
    // Reconcile every submitted fal request, including moderated/failed requests.
    // fal records zero-cost billing events for those, which is part of the audit trail.
    .filter((entry) => entry.adapter === 'fal' && entry.requestId)
    .map((entry) => entry.requestId as string);
  if (requestIds.length === 0) return [];
  let events: BillingEvent[] = [];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const url = new URL('https://api.fal.ai/v1/models/billing-events');
    url.searchParams.set('request_id', requestIds.join(','));
    url.searchParams.set('limit', String(Math.min(100, requestIds.length)));
    const response = await fetch(url, {
      headers: { Authorization: `Key ${falKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    const json = await response.json() as unknown;
    if (!response.ok || !isRecord(json) || !Array.isArray(json.billing_events)) {
      throw new Error(`fal billing-events failed with HTTP ${response.status}.`);
    }
    events = json.billing_events.map(parseBillingEvent).filter((event): event is BillingEvent => event !== null);
    const byId = new Set(events.map((event) => event.requestId));
    if (requestIds.every((requestId) => byId.has(requestId))) break;
    if (attempt < 11) await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000));
  }
  await atomicWriteJson(BILLING_PATH, {
    source: 'https://api.fal.ai/v1/models/billing-events',
    checkedAt: new Date().toISOString(),
    requestedIds: requestIds.length,
    returnedIds: events.length,
    events,
    falCostTotalUsd: round(events.reduce((sum, event) => sum + event.costTotalUsd, 0)),
  });
  return events;
}

async function buildReport(ledger: ExecutionLedger, billing: BillingEvent[]): Promise<void> {
  const rawComparison = await comparisonSheet('raw');
  const cleanedComparison = await comparisonSheet('cleaned');
  const variants = TRUMP_RENDERERS.map((renderer) => {
    const entries = Object.values(ledger.entries).filter((entry) => entry.rendererId === renderer.id);
    const status = entries.some((entry) => entry.kind === 'source' && entry.status === 'failed')
      ? 'blocked-or-failed-at-source'
      : entries.some((entry) => entry.status === 'failed')
        ? 'partial'
        : entries.every((entry) => entry.status === 'completed')
          ? 'completed'
          : 'incomplete';
    return {
      id: renderer.id,
      label: renderer.label,
      model: renderer.model,
      status,
      source: awaitablePath(sourceRawPath(renderer.id)),
      scaffold: awaitablePath(scaffoldPath(renderer.id)),
      frames: [0, 1, 2, 3].map((frameIndex) => ({
        raw: awaitablePath(rawFramePath(renderer.id, frameIndex)),
        cleaned: awaitablePath(cleanedFramePath(renderer.id, frameIndex)),
      })),
      rawSheet: awaitablePath(resolve(rendererDir(renderer.id), 'sheets/raw-playback.png')),
      cleanedSheet: awaitablePath(resolve(rendererDir(renderer.id), 'sheets/production-normalized.png')),
    };
  });
  const resolvedVariants = await Promise.all(variants.map(async (variant) => ({
    ...variant,
    source: await variant.source,
    scaffold: await variant.scaffold,
    frames: await Promise.all(variant.frames.map(async (frame) => ({ raw: await frame.raw, cleaned: await frame.cleaned }))),
    rawSheet: await variant.rawSheet,
    cleanedSheet: await variant.cleanedSheet,
  })));
  const falCost = round(billing.reduce((sum, event) => sum + event.costTotalUsd, 0));
  const geminiCompleted = Object.values(ledger.entries).filter((entry) => entry.adapter === 'gemini' && entry.status === 'completed');
  const geminiFailedOrBlocked = Object.values(ledger.entries).filter(
    (entry) => entry.adapter === 'gemini' && entry.status === 'failed',
  );
  await atomicWriteJson(REPORT_PATH, {
    schemaVersion: 2,
    runId: TRUMP_PROD_FLOW_RUN_ID,
    generatedAt: new Date().toISOString(),
    scope: 'isolated benchmark only; no production routing or provider promotion',
    submissions: { used: ledger.submittedCount, maximum: ledger.maxPaidSubmissions, automaticRetries: 0 },
    costs: {
      falRecordedUsd: falCost,
      falSubmittedRequestsReconciled: billing.length,
      geminiBilling: {
        status: 'not-reconciled',
        completedImageCalls: geminiCompleted.length,
        failedOrBlockedCalls: geminiFailedOrBlocked.length,
        recordedUsd: null,
        note: 'The blocked Gemini request returned no image. Its possible input/thinking-token charge was not available to this harness, so no combined total is asserted.',
      },
      combinedRecordedUsd: null,
      guardedCommittedUsd: ledger.committedGuardUsd,
      hardCapUsd: ledger.confirmedMaxCostUsd,
    },
    comparisons: {
      raw: relativeToProject(rawComparison),
      cleaned: relativeToProject(cleanedComparison),
    },
    variants: resolvedVariants,
  });
}

async function awaitablePath(path: string): Promise<string | null> {
  return await exists(path) ? relativeToProject(path) : null;
}

function parseArgs(): { execute: boolean; confirmation?: string; maxCost?: number } {
  const args = process.argv.slice(2);
  const confirmation = args.find((arg) => arg.startsWith('--confirm='))?.slice('--confirm='.length);
  const maxCostRaw = args.find((arg) => arg.startsWith('--max-cost='))?.slice('--max-cost='.length);
  return {
    execute: args.includes('--execute'),
    confirmation,
    maxCost: maxCostRaw === undefined ? undefined : Number(maxCostRaw),
  };
}

async function main(): Promise<void> {
  await prepareRun();
  const args = parseArgs();
  if (!args.execute) {
    process.stdout.write(`${JSON.stringify({
      runId: TRUMP_PROD_FLOW_RUN_ID,
      manifest: relativeToProject(MANIFEST_PATH),
      guardedBudgetUsd: guardedBudgetUsd(),
      hardCapUsd: TRUMP_PROD_FLOW_HARD_CAP_USD,
      maxPaidSubmissions: TRUMP_PROD_FLOW_MAX_SUBMISSIONS,
      paidInferenceCalls: 0,
    }, null, 2)}\n`);
    return;
  }
  if (args.confirmation !== TRUMP_PROD_FLOW_CONFIRMATION) throw new Error('Missing exact run confirmation.');
  if (args.maxCost !== TRUMP_PROD_FLOW_HARD_CAP_USD) throw new Error(`--max-cost must equal ${TRUMP_PROD_FLOW_HARD_CAP_USD}.`);
  const geminiKey = process.env.GEMINI_API_KEY?.trim();
  const falKey = process.env.FAL_API_KEY?.trim();
  if (!geminiKey || !falKey) throw new Error('GEMINI_API_KEY and FAL_API_KEY are required.');
  await pricingPreflight(falKey);
  const lock = await open(LOCK_PATH, 'wx', 0o600).catch(() => null);
  if (!lock) throw new Error('Benchmark execution lock already exists.');
  try {
    const ledger = await loadOrCreateLedger(args.maxCost);
    const original = await readFile(ORIGINAL_PATH);
    for (const renderer of TRUMP_RENDERERS) {
      process.stdout.write(`Running ${renderer.id}...\n`);
      await runRenderer(renderer, ledger, original, geminiKey, falKey);
    }
    const billing = await reconcileBilling(ledger, falKey);
    await buildReport(ledger, billing);
    process.stdout.write(`${JSON.stringify({
      runId: TRUMP_PROD_FLOW_RUN_ID,
      submitted: ledger.submittedCount,
      maxSubmitted: ledger.maxPaidSubmissions,
      guardedCommittedUsd: ledger.committedGuardUsd,
      hardCapUsd: ledger.confirmedMaxCostUsd,
      report: relativeToProject(REPORT_PATH),
    }, null, 2)}\n`);
  } finally {
    await lock.close();
    await unlink(LOCK_PATH).catch(() => undefined);
  }
}

await main();
