import { createHash } from 'node:crypto';
import {
  appendFile,
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
import { installCanvasRuntime } from '../../canvasRuntime.ts';
import {
  cleanReposedImagePreserveCanvas,
  cleanSpriteSheet,
  neutralizeGreenSpillForSegmentation,
} from '../../../../src/services/SpritePostProcess.ts';
import { decontaminateGreenEdges, unionForegroundMasks } from '../../../../src/services/AlphaMask.ts';
import {
  ANIMATIONS,
  FROZEN_INPUTS,
  PROVIDER_MATRIX_PAID_APPROVALS,
  PROVIDER_MATRIX_RUN_ID,
  RENDERERS,
  STRATEGIES,
  buildProviderPrompt,
  buildStrategyPlan,
  directSheetLayout,
  planFingerprint,
  validateStrategyPlan,
} from './catalog.ts';
import type {
  AnimationId,
  BenchmarkNode,
  GenerationNode,
  ReferenceBinding,
  RendererId,
  RendererSpec,
  StrategyId,
  StrategyPlan,
} from './contract.ts';

installCanvasRuntime();

type JsonRecord = Record<string, unknown>;
type EntryStatus = 'planned' | 'submitting' | 'queued' | 'completed' | 'failed' | 'unknown' | 'blocked';

interface LedgerEntry {
  id: string;
  kind: BenchmarkNode['kind'];
  frameIndex?: number;
  status: EntryStatus;
  guardedMaxUsd: number;
  attempts: 0 | 1;
  submittedAt?: string;
  completedAt?: string;
  requestId?: string;
  statusUrl?: string;
  responseUrl?: string;
  outputPath?: string;
  outputSha256?: string;
  outputWidth?: number;
  outputHeight?: number;
  payloadSha256?: string;
  error?: string;
}

interface ExecutionLedger {
  schemaVersion: 2;
  runId: string;
  planFingerprint: string;
  executionFingerprint: string;
  rendererId: RendererId;
  strategyId: StrategyId;
  animationId: AnimationId;
  confirmedMaxCostUsd: number;
  maxPaidSubmissions: number;
  submittedCount: number;
  createdAt: string;
  updatedAt: string;
  entries: Record<string, LedgerEntry>;
}

interface QueueOutput {
  bytes: Buffer;
  metadata: JsonRecord;
}

interface BillingEvent {
  requestId: string;
  endpointId: string;
  costTotalUsd: number;
  outputUnits: number;
  unitPriceUsd: number;
  timestamp: string;
}

export interface ExecuteOptions {
  rendererId: RendererId;
  strategyId: StrategyId;
  animationId: AnimationId;
  throughFrame?: number;
  confirmation: string;
  maxCostUsd: number;
}

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(SOURCE_DIR, '../../../..');
export const MATRIX_RUN_DIR = resolve(PROJECT_ROOT, '.qa/provider-benchmark', PROVIDER_MATRIX_RUN_ID);
const INPUT_DIR = resolve(MATRIX_RUN_DIR, 'inputs');
const GLOBAL_LOCK_PATH = resolve(PROJECT_ROOT, '.qa/provider-benchmark/.paid-execution.lock');
const MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024;
const POLL_TIMEOUT_MS = 12 * 60_000;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function round(value: number, digits = 9): number {
  return Number(value.toFixed(digits));
}

function relativeToProject(path: string): string {
  return relative(PROJECT_ROOT, path).split('\\').join('/');
}

function sha256(value: Uint8Array | string): string {
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
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function appendEvent(path: string, event: JsonRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function assertFrozenImage(asset: { path: string; width: number; height: number; sha256: string }): Promise<Buffer> {
  const absolute = resolve(PROJECT_ROOT, asset.path);
  const bytes = await readFile(absolute);
  if (sha256(bytes) !== asset.sha256) throw new Error(`Frozen input hash changed: ${asset.path}`);
  const image = await loadImage(bytes);
  if (image.width !== asset.width || image.height !== asset.height) {
    throw new Error(`Frozen input dimensions changed: ${asset.path}`);
  }
  return bytes;
}

function renderer(rendererId: RendererId): RendererSpec {
  const value = RENDERERS.find((candidate) => candidate.id === rendererId);
  if (!value) throw new Error(`Unknown renderer ${rendererId}`);
  return value;
}

function planDir(plan: StrategyPlan): string {
  return resolve(MATRIX_RUN_DIR, 'runs', plan.rendererId, plan.strategyId, plan.animationId);
}

function ledgerPath(plan: StrategyPlan): string {
  return resolve(planDir(plan), 'execution-ledger.json');
}

function eventsPath(plan: StrategyPlan): string {
  return resolve(planDir(plan), 'execution-events.ndjson');
}

function pricingPath(plan: StrategyPlan): string {
  return resolve(planDir(plan), 'pricing-preflight.json');
}

function billingPath(plan: StrategyPlan): string {
  return resolve(planDir(plan), 'billing-events.json');
}

function reportPath(plan: StrategyPlan): string {
  return resolve(planDir(plan), 'report.json');
}

function promptPath(plan: StrategyPlan, frameIndex?: number): string {
  return resolve(planDir(plan), 'prompts', frameIndex === undefined ? 'sheet.txt' : `frame-${String(frameIndex).padStart(2, '0')}.txt`);
}

function frameDir(plan: StrategyPlan, frameIndex: number): string {
  return resolve(planDir(plan), 'frames', `frame-${String(frameIndex).padStart(2, '0')}`);
}

function rawFramePath(plan: StrategyPlan, frameIndex: number): string {
  return resolve(frameDir(plan, frameIndex), 'raw.png');
}

function cleanFramePath(plan: StrategyPlan, frameIndex: number): string {
  return resolve(frameDir(plan, frameIndex), 'cleaned.png');
}

function directSheetPath(plan: StrategyPlan): string {
  return resolve(planDir(plan), 'sheets/direct-raw.png');
}

function nodeOutputPath(plan: StrategyPlan, node: BenchmarkNode): string {
  if (node.kind === 'generate-sheet') return directSheetPath(plan);
  if (node.kind === 'generate-frame') return rawFramePath(plan, node.frameIndex as number);
  return resolve(frameDir(plan, node.frameIndex as number), 'birefnet.png');
}

async function runtimeSourceHashes(): Promise<Record<string, string>> {
  const paths = [
    'processor/src/benchmark/providerMatrix/contract.ts',
    'processor/src/benchmark/providerMatrix/runtime.ts',
    'src/services/SpritePostProcess.ts',
    'src/services/AlphaMask.ts',
  ];
  return Object.fromEntries(await Promise.all(paths.map(async (path) => [path, sha256(await readFile(resolve(PROJECT_ROOT, path)))])));
}

async function executionFingerprint(plan: StrategyPlan): Promise<string> {
  return sha256(JSON.stringify({ planFingerprint: planFingerprint(plan), runtimeSourceHashes: await runtimeSourceHashes() }));
}

export async function prepareMatrix(): Promise<JsonRecord> {
  await mkdir(INPUT_DIR, { recursive: true });
  const original = await assertFrozenImage(FROZEN_INPUTS.original);
  const canonicalRaw = await assertFrozenImage(FROZEN_INPUTS.canonicalRaw);
  const canonicalClean = await assertFrozenImage(FROZEN_INPUTS.canonicalClean);
  const scaffold = await assertFrozenImage(FROZEN_INPUTS.scaffold);
  await copyFile(resolve(PROJECT_ROOT, FROZEN_INPUTS.original.path), resolve(INPUT_DIR, 'original-lineage-only.png'));
  await writeFile(resolve(INPUT_DIR, 'canonical-raw.png'), canonicalRaw, { mode: 0o600 });
  await writeFile(resolve(INPUT_DIR, 'canonical-clean.png'), canonicalClean, { mode: 0o600 });
  await writeFile(resolve(INPUT_DIR, 'common-scaffold.png'), scaffold, { mode: 0o600 });
  await mkdir(resolve(INPUT_DIR, 'pose-cells'), { recursive: true });
  for (let frameIndex = 0; frameIndex < FROZEN_INPUTS.poseCells.length; frameIndex += 1) {
    const bytes = await assertFrozenImage(FROZEN_INPUTS.poseCells[frameIndex]);
    await writeFile(resolve(INPUT_DIR, 'pose-cells', `frame-${String(frameIndex).padStart(2, '0')}.png`), bytes, { mode: 0o600 });
  }

  const highKickPlans = RENDERERS.flatMap((rendererSpec) => Object.keys(STRATEGIES).map((strategyId) => {
    const plan = buildStrategyPlan(rendererSpec.id, strategyId as StrategyId, 'high_kick');
    validateStrategyPlan(plan);
    return {
      rendererId: plan.rendererId,
      strategyId: plan.strategyId,
      guardedBudgetUsd: plan.guardedBudgetUsd,
      maxPaidSubmissions: plan.maxPaidSubmissions,
      fingerprint: planFingerprint(plan),
    };
  }));
  const fullHighKickCartesianGuardUsd = round(highKickPlans.reduce((sum, plan) => sum + plan.guardedBudgetUsd, 0), 6);
  const fullHighKickCartesianSubmissions = highKickPlans.reduce((sum, plan) => sum + plan.maxPaidSubmissions, 0);
  const manifest: JsonRecord = {
    schemaVersion: 1,
    runId: PROVIDER_MATRIX_RUN_ID,
    preparedAt: new Date().toISOString(),
    scope: 'Isolated benchmark only. No production route, tier, retry, fallback, cache key, or Gemini prompt is changed.',
    axes: {
      renderers: RENDERERS,
      strategies: STRATEGIES,
      animations: ANIMATIONS,
    },
    inputs: {
      original: { ...FROZEN_INPUTS.original, copiedBytes: original.byteLength, role: 'lineage only; never sent to a temporal renderer' },
      canonicalRaw: FROZEN_INPUTS.canonicalRaw,
      canonicalClean: FROZEN_INPUTS.canonicalClean,
      commonScaffold: FROZEN_INPUTS.scaffold,
      poseCells: FROZEN_INPUTS.poseCells,
    },
    policies: {
      automaticGenerationRetries: 0,
      providerFallbacks: 0,
      rawPreviousFrameFeedsNextNode: true,
      failedVisualEvaluationReplaced: false,
      failedRequestReleasesBudget: false,
      globalPaidExecutionLock: relativeToProject(GLOBAL_LOCK_PATH),
    },
    highKickMatrix: {
      guardedBudgetUsd: fullHighKickCartesianGuardUsd,
      maxPaidSubmissions: fullHighKickCartesianSubmissions,
      executionPolicy: 'Never execute as a cartesian batch. Advance winners through staged visual gates.',
      plans: highKickPlans,
    },
  };
  await atomicWriteJson(resolve(MATRIX_RUN_DIR, 'manifest.json'), manifest);

  const promptCatalog: Record<string, unknown> = {};
  for (const rendererSpec of RENDERERS) {
    promptCatalog[rendererSpec.id] = Object.fromEntries(Object.keys(STRATEGIES).map((strategyId) => {
      const strategy = strategyId as StrategyId;
      return [strategy, strategy === 'direct-sheet'
        ? { prompt: buildProviderPrompt(rendererSpec.id, strategy, 'high_kick'), sha256: sha256(buildProviderPrompt(rendererSpec.id, strategy, 'high_kick')) }
        : [1, 2, 3].map((frameIndex) => {
          const prompt = buildProviderPrompt(rendererSpec.id, strategy, 'high_kick', frameIndex);
          return { frameIndex, prompt, sha256: sha256(prompt) };
        })];
    }));
  }
  await atomicWriteJson(resolve(MATRIX_RUN_DIR, 'high-kick-prompt-catalog.json'), promptCatalog);
  return manifest;
}

async function preparePlanArtifacts(plan: StrategyPlan): Promise<void> {
  await prepareMatrix();
  validateStrategyPlan(plan);
  await mkdir(planDir(plan), { recursive: true });
  await mkdir(frameDir(plan, 0), { recursive: true });
  await copyFile(resolve(INPUT_DIR, 'canonical-raw.png'), rawFramePath(plan, 0));
  await copyFile(resolve(INPUT_DIR, 'canonical-clean.png'), cleanFramePath(plan, 0));
  for (const node of plan.nodes) {
    if (node.kind === 'cleanup') continue;
    const path = promptPath(plan, node.frameIndex);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, node.prompt, { mode: 0o600 });
  }
  await atomicWriteJson(resolve(planDir(plan), 'plan.json'), {
    schemaVersion: 1,
    runId: PROVIDER_MATRIX_RUN_ID,
    plan,
    planFingerprint: planFingerprint(plan),
    executionFingerprint: await executionFingerprint(plan),
    outputPolicy: {
      frame0: 'frozen canonical raw/clean fixture, zero paid requests',
      rawFeedsSequence: true,
      cleanupFeedsSequence: false,
      visualFailureSubstitution: false,
    },
  });
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

async function loadKeys(): Promise<{ fal?: string; gemini?: string }> {
  const dotenvPath = resolve(PROJECT_ROOT, '.env');
  const dotenv = await exists(dotenvPath) ? parseEnv(await readFile(dotenvPath, 'utf8')) : {};
  return {
    fal: process.env.FAL_API_KEY?.trim() || dotenv.FAL_API_KEY?.trim(),
    gemini: process.env.GEMINI_API_KEY?.trim() || dotenv.GEMINI_API_KEY?.trim(),
  };
}

async function pricingPreflight(plan: StrategyPlan, falKey: string): Promise<JsonRecord> {
  const rendererSpec = renderer(plan.rendererId);
  const expected = new Map<string, { maxUnitPrice: number; units: readonly string[] }>();
  if (rendererSpec.adapter === 'fal-queue') {
    expected.set(rendererSpec.model, rendererSpec.id === 'klein-9b'
      ? { maxUnitPrice: 0.011, units: ['megapixels'] }
      : rendererSpec.id === 'klein-4b'
        ? { maxUnitPrice: 0.01, units: ['megapixels'] }
        : rendererSpec.id === 'flux2-pro'
          ? { maxUnitPrice: 0.03, units: ['processed megapixels'] }
          : rendererSpec.id === 'seedream-4'
            ? { maxUnitPrice: 0.03, units: ['images'] }
            : { maxUnitPrice: 0.005, units: ['megapixels', 'compute seconds'] });
  }
  if (plan.nodes.some((node) => node.kind === 'cleanup')) {
    expected.set('fal-ai/birefnet', { maxUnitPrice: 0.0008, units: ['compute seconds'] });
  }
  const models: Record<string, unknown> = {};
  for (const [model, guard] of expected) {
    const url = new URL('https://api.fal.ai/v1/models/pricing');
    url.searchParams.set('endpoint_id', model);
    const response = await fetch(url, {
      headers: { Authorization: `Key ${falKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    const json = await response.json() as unknown;
    models[model] = { httpStatus: response.status, response: json };
    if (!response.ok || !isRecord(json) || !Array.isArray(json.prices) || json.prices.length === 0) {
      throw new Error(`Pricing preflight failed for ${model}; no inference was submitted.`);
    }
    for (const price of json.prices) {
      if (!isRecord(price) || typeof price.unit_price !== 'number' || price.unit_price > guard.maxUnitPrice || typeof price.unit !== 'string' || !guard.units.includes(price.unit)) {
        throw new Error(`Pricing changed for ${model}; no inference was submitted.`);
      }
    }
  }
  const result: JsonRecord = { checkedAt: new Date().toISOString(), paidInferenceCalls: 0, models };
  await atomicWriteJson(pricingPath(plan), result);
  return result;
}

async function loadOrCreateLedger(plan: StrategyPlan, maxCostUsd: number): Promise<ExecutionLedger> {
  const path = ledgerPath(plan);
  const expectedExecutionFingerprint = await executionFingerprint(plan);
  if (await exists(path)) {
    const value = await readJson(path);
    if (!isRecord(value)) throw new Error('Existing ledger is invalid.');
    const ledger = value as unknown as ExecutionLedger;
    if (
      ledger.schemaVersion !== 2 || ledger.runId !== PROVIDER_MATRIX_RUN_ID ||
      ledger.planFingerprint !== planFingerprint(plan) || ledger.executionFingerprint !== expectedExecutionFingerprint ||
      ledger.confirmedMaxCostUsd > maxCostUsd || ledger.maxPaidSubmissions !== plan.maxPaidSubmissions
    ) throw new Error('Existing ledger does not match the frozen execution contract.');
    if (ledger.confirmedMaxCostUsd < maxCostUsd) {
      const previousMaxCostUsd = ledger.confirmedMaxCostUsd;
      ledger.confirmedMaxCostUsd = maxCostUsd;
      await persistLedger(plan, ledger, {
        type: 'approved-cap-raised',
        previousMaxCostUsd,
        confirmedMaxCostUsd: maxCostUsd,
      });
    }
    return ledger;
  }
  const now = new Date().toISOString();
  const entries = Object.fromEntries(plan.nodes.map((node) => [node.id, {
    id: node.id,
    kind: node.kind,
    frameIndex: node.frameIndex,
    status: 'planned',
    guardedMaxUsd: node.guardedMaxUsd,
    attempts: 0,
  } satisfies LedgerEntry]));
  const ledger: ExecutionLedger = {
    schemaVersion: 2,
    runId: PROVIDER_MATRIX_RUN_ID,
    planFingerprint: planFingerprint(plan),
    executionFingerprint: expectedExecutionFingerprint,
    rendererId: plan.rendererId,
    strategyId: plan.strategyId,
    animationId: plan.animationId,
    confirmedMaxCostUsd: maxCostUsd,
    maxPaidSubmissions: plan.maxPaidSubmissions,
    submittedCount: 0,
    createdAt: now,
    updatedAt: now,
    entries,
  };
  await atomicWriteJson(path, ledger);
  await appendEvent(eventsPath(plan), { type: 'ledger-created', maxCostUsd, maxPaidSubmissions: plan.maxPaidSubmissions });
  return ledger;
}

async function persistLedger(plan: StrategyPlan, ledger: ExecutionLedger, event: JsonRecord): Promise<void> {
  ledger.updatedAt = new Date().toISOString();
  await atomicWriteJson(ledgerPath(plan), ledger);
  await appendEvent(eventsPath(plan), event);
}

function reservedOrSpentUsd(ledger: ExecutionLedger): number {
  return round(Object.values(ledger.entries)
    .filter((entry) => entry.status !== 'planned' && entry.status !== 'blocked')
    .reduce((sum, entry) => sum + entry.guardedMaxUsd, 0), 6);
}

async function reserveNode(plan: StrategyPlan, ledger: ExecutionLedger, node: BenchmarkNode, payloadSha256: string): Promise<LedgerEntry> {
  const entry = ledger.entries[node.id];
  if (!entry) throw new Error(`Missing ledger entry ${node.id}`);
  if (entry.status !== 'planned' || entry.attempts !== 0) throw new Error(`${node.id} cannot be submitted from ${entry.status}.`);
  const nextGuard = round(reservedOrSpentUsd(ledger) + entry.guardedMaxUsd, 6);
  if (nextGuard > ledger.confirmedMaxCostUsd || nextGuard > plan.guardedBudgetUsd) {
    throw new Error(`Submitting ${node.id} would exceed the frozen cap.`);
  }
  if (ledger.submittedCount >= ledger.maxPaidSubmissions) throw new Error('Submission count cap reached.');
  entry.status = 'submitting';
  entry.attempts = 1;
  entry.submittedAt = new Date().toISOString();
  entry.payloadSha256 = payloadSha256;
  ledger.submittedCount += 1;
  await persistLedger(plan, ledger, { type: 'submission-reserved', nodeId: node.id, guardedMaxUsd: node.guardedMaxUsd, payloadSha256 });
  return entry;
}

async function markFailed(plan: StrategyPlan, ledger: ExecutionLedger, entry: LedgerEntry, error: unknown): Promise<void> {
  entry.status = entry.requestId ? 'failed' : 'unknown';
  entry.error = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
  await persistLedger(plan, ledger, { type: entry.status, nodeId: entry.id, requestId: entry.requestId ?? null, error: entry.error });
}

function requireQueueUrl(value: string, label: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'queue.fal.run') throw new Error(`Unexpected fal ${label} host.`);
  return url.toString();
}

function falPayload(rendererSpec: RendererSpec, node: GenerationNode, images: Buffer[]): JsonRecord {
  const common: JsonRecord = {
    prompt: node.prompt,
    image_urls: images.map((buffer) => `data:image/png;base64,${buffer.toString('base64')}`),
    image_size: { width: node.width, height: node.height },
    seed: node.seed,
    sync_mode: false,
    enable_safety_checker: true,
  };
  if (rendererSpec.id === 'klein-4b' || rendererSpec.id === 'klein-9b') {
    return { ...common, num_inference_steps: 4, num_images: 1, output_format: 'png' };
  }
  if (rendererSpec.id === 'flux2-pro') return { ...common, safety_tolerance: '2', output_format: 'png' };
  if (rendererSpec.id === 'flux2-flash') {
    return { ...common, guidance_scale: 2.5, num_images: 1, enable_prompt_expansion: false, output_format: 'png' };
  }
  return { ...common, num_images: 1, max_images: 1, enhance_prompt_mode: 'standard' };
}

function geminiPayload(node: GenerationNode, images: Buffer[]): JsonRecord {
  return {
    contents: [{
      role: 'user',
      parts: [
        ...images.map((buffer) => ({ inlineData: { mimeType: 'image/png', data: buffer.toString('base64') } })),
        { text: node.prompt },
      ],
    }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      seed: node.seed,
      imageConfig: { aspectRatio: geminiAspectRatio(node.width, node.height), imageSize: node.kind === 'generate-sheet' ? '2K' : '1K' },
    },
  };
}

export function geminiAspectRatio(width: number, height: number): '3:2' | '3:4' {
  return width > height ? '3:2' : '3:4';
}

function payloadFingerprint(body: JsonRecord): string {
  const sanitized = JSON.parse(JSON.stringify(body)) as JsonRecord;
  const contents = Array.isArray(sanitized.contents) ? sanitized.contents : null;
  if (contents) {
    for (const content of contents) {
      if (!isRecord(content) || !Array.isArray(content.parts)) continue;
      for (const part of content.parts) {
        if (isRecord(part) && isRecord(part.inlineData) && typeof part.inlineData.data === 'string') {
          part.inlineData.data = `sha256:${sha256(Buffer.from(part.inlineData.data, 'base64'))}`;
        }
      }
    }
  }
  if (Array.isArray(sanitized.image_urls)) {
    sanitized.image_urls = sanitized.image_urls.map((value) => {
      if (typeof value !== 'string' || !value.startsWith('data:')) return value;
      return `sha256:${sha256(Buffer.from(value.slice(value.indexOf(',') + 1), 'base64'))}`;
    });
  }
  if (typeof sanitized.image_url === 'string' && sanitized.image_url.startsWith('data:')) {
    sanitized.image_url = `sha256:${sha256(Buffer.from(sanitized.image_url.slice(sanitized.image_url.indexOf(',') + 1), 'base64'))}`;
  }
  return sha256(JSON.stringify(sanitized));
}

async function materializeReferences(plan: StrategyPlan, bindings: readonly ReferenceBinding[]): Promise<Buffer[]> {
  return Promise.all(bindings.map(async (binding) => {
    if (binding.source === 'frozen-canonical') return readFile(resolve(INPUT_DIR, 'canonical-raw.png'));
    if (binding.source === 'frozen-pose-cell') {
      return readFile(resolve(INPUT_DIR, 'pose-cells', `frame-${String(binding.frameIndex).padStart(2, '0')}.png`));
    }
    const path = rawFramePath(plan, binding.frameIndex as number);
    if (!(await exists(path))) throw new Error(`Previous frame ${binding.frameIndex} is unavailable.`);
    return readFile(path);
  }));
}

function findFalImage(value: unknown, cleanup: boolean): { url: string; metadata: JsonRecord } {
  if (!isRecord(value)) throw new Error('fal returned a non-object response.');
  const image = cleanup
    ? (isRecord(value.image) ? value.image : null)
    : (Array.isArray(value.images) && isRecord(value.images[0]) ? value.images[0] : null);
  if (!image || typeof image.url !== 'string') throw new Error('fal completed without an image.');
  return {
    url: image.url,
    metadata: {
      seed: value.seed ?? null,
      timings: value.timings ?? null,
      hasNsfwConcepts: value.has_nsfw_concepts ?? null,
      output: { width: image.width ?? null, height: image.height ?? null, contentType: image.content_type ?? null, fileSize: image.file_size ?? null },
    },
  };
}

async function downloadUrl(urlValue: string): Promise<Buffer> {
  const url = new URL(urlValue);
  if (url.protocol !== 'https:') throw new Error('Provider output URL is not HTTPS.');
  const response = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw new Error(`Output download HTTP ${response.status}.`);
  const length = Number(response.headers.get('content-length') || '0');
  if (length > MAX_DOWNLOAD_BYTES) throw new Error('Provider output exceeds the download limit.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength <= 0 || bytes.byteLength > MAX_DOWNLOAD_BYTES) throw new Error('Provider output size is invalid.');
  return bytes;
}

async function pollFal(entry: LedgerEntry, falKey: string, cleanup: boolean): Promise<QueueOutput> {
  if (!entry.requestId || !entry.statusUrl || !entry.responseUrl) throw new Error(`Missing queue state for ${entry.id}.`);
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
      const status = isRecord(statusJson) && typeof statusJson.status === 'string' ? statusJson.status.toUpperCase() : 'UNKNOWN';
      if (['FAILED', 'ERROR', 'CANCELLED', 'CANCELED'].includes(status)) throw new Error(`fal request ended with ${status}.`);
      if (status === 'COMPLETED') {
        const resultResponse = await fetch(entry.responseUrl, {
          headers: { Authorization: `Key ${falKey}` },
          signal: AbortSignal.timeout(60_000),
        });
        const responseText = await resultResponse.text();
        let result: unknown;
        try { result = JSON.parse(responseText) as unknown; } catch { throw new Error(`fal result HTTP ${resultResponse.status}: non-JSON response.`); }
        if (!resultResponse.ok) throw new Error(`fal result HTTP ${resultResponse.status}: ${responseText.slice(0, 500)}`);
        const found = findFalImage(result, cleanup);
        return { bytes: await downloadUrl(found.url), metadata: found.metadata };
      }
      consecutiveErrors = 0;
    } catch (error) {
      consecutiveErrors += 1;
      if (consecutiveErrors >= 5) throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
  }
  throw new Error('fal polling timed out. The request was not resubmitted.');
}

async function submitFal(
  plan: StrategyPlan,
  ledger: ExecutionLedger,
  node: BenchmarkNode,
  body: JsonRecord,
  falKey: string,
  cleanup: boolean,
): Promise<QueueOutput> {
  const entry = ledger.entries[node.id];
  if (entry.status === 'queued') return pollFal(entry, falKey, cleanup);
  await reserveNode(plan, ledger, node, payloadFingerprint(body));
  try {
    const model = cleanup ? 'fal-ai/birefnet' : renderer(plan.rendererId).model;
    const endpoint = cleanup ? 'https://queue.fal.run/fal-ai/birefnet' : renderer(plan.rendererId).endpoint;
    const response = await fetch(endpoint, {
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
    try { json = JSON.parse(responseText) as unknown; } catch { throw new Error(`fal submit HTTP ${response.status}: non-JSON response.`); }
    if (!response.ok || !isRecord(json) || typeof json.request_id !== 'string') {
      const detail = isRecord(json) ? json.detail ?? json.error ?? json.message : responseText;
      throw new Error(`fal submit HTTP ${response.status}: ${JSON.stringify(detail).slice(0, 600)}`);
    }
    entry.requestId = json.request_id;
    entry.statusUrl = typeof json.status_url === 'string'
      ? requireQueueUrl(json.status_url, 'status URL')
      : `https://queue.fal.run/${model}/requests/${json.request_id}/status?logs=1`;
    entry.responseUrl = typeof json.response_url === 'string'
      ? requireQueueUrl(json.response_url, 'response URL')
      : `https://queue.fal.run/${model}/requests/${json.request_id}`;
    entry.status = 'queued';
    await persistLedger(plan, ledger, { type: 'queued', nodeId: node.id, requestId: entry.requestId });
    return pollFal(entry, falKey, cleanup);
  } catch (error) {
    await markFailed(plan, ledger, entry, error);
    throw error;
  }
}

function findGeminiImage(value: unknown): QueueOutput {
  if (!isRecord(value)) throw new Error('Gemini returned a non-object response.');
  const promptFeedback = isRecord(value.promptFeedback) ? value.promptFeedback : null;
  const candidates = Array.isArray(value.candidates) ? value.candidates : [];
  const candidate = isRecord(candidates[0]) ? candidates[0] : null;
  const parts = candidate && isRecord(candidate.content) && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
  let imageData: string | undefined;
  let text = '';
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (typeof part.text === 'string') text += part.text;
    if (isRecord(part.inlineData) && typeof part.inlineData.data === 'string') imageData = part.inlineData.data;
  }
  if (!imageData) {
    const reason = candidate?.finishReason ?? promptFeedback?.blockReason ?? 'unknown';
    throw new Error(`Gemini returned no image (reason: ${String(reason)}${text ? `; ${text.slice(0, 180)}` : ''}).`);
  }
  return {
    bytes: Buffer.from(imageData, 'base64'),
    metadata: { finishReason: candidate?.finishReason ?? null, promptBlockReason: promptFeedback?.blockReason ?? null, modelVersion: value.modelVersion ?? null, usageMetadata: value.usageMetadata ?? null },
  };
}

async function submitGemini(
  plan: StrategyPlan,
  ledger: ExecutionLedger,
  node: GenerationNode,
  body: JsonRecord,
  geminiKey: string,
): Promise<QueueOutput> {
  const entry = await reserveNode(plan, ledger, node, payloadFingerprint(body));
  try {
    const response = await fetch(renderer(plan.rendererId).endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
    const responseText = await response.text();
    let json: unknown;
    try { json = JSON.parse(responseText) as unknown; } catch { throw new Error(`Gemini HTTP ${response.status}: non-JSON response.`); }
    if (!response.ok) {
      const message = isRecord(json) && isRecord(json.error) ? json.error.message : responseText;
      throw new Error(`Gemini HTTP ${response.status}: ${String(message).slice(0, 500)}`);
    }
    return findGeminiImage(json);
  } catch (error) {
    await markFailed(plan, ledger, entry, error);
    throw error;
  }
}

async function normalizeProviderOutput(bytes: Buffer, node: GenerationNode): Promise<{ bytes: Buffer; sourceWidth: number; sourceHeight: number }> {
  const image = await loadImage(bytes);
  const targetWidth = node.width;
  const targetHeight = node.height;
  const canvas = createCanvas(targetWidth, targetHeight);
  const context = canvas.getContext('2d');
  context.fillStyle = '#00ff00';
  context.fillRect(0, 0, targetWidth, targetHeight);
  const scale = Math.min(targetWidth / image.width, targetHeight / image.height);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  context.drawImage(image, Math.round((targetWidth - width) / 2), Math.round((targetHeight - height) / 2), width, height);
  return { bytes: canvas.toBuffer('image/png'), sourceWidth: image.width, sourceHeight: image.height };
}

async function completeNode(
  plan: StrategyPlan,
  ledger: ExecutionLedger,
  node: BenchmarkNode,
  output: QueueOutput,
): Promise<void> {
  const path = nodeOutputPath(plan, node);
  await mkdir(dirname(path), { recursive: true });
  let bytes = output.bytes;
  let sourceDimensions: { sourceWidth?: number; sourceHeight?: number } = {};
  if (node.kind !== 'cleanup') {
    const normalized = await normalizeProviderOutput(bytes, node);
    bytes = normalized.bytes;
    sourceDimensions = normalized;
  }
  await writeFile(path, bytes, { mode: 0o600 });
  const image = await loadImage(bytes);
  const entry = ledger.entries[node.id];
  entry.status = 'completed';
  entry.completedAt = new Date().toISOString();
  entry.outputPath = relativeToProject(path);
  entry.outputSha256 = sha256(bytes);
  entry.outputWidth = image.width;
  entry.outputHeight = image.height;
  await atomicWriteJson(resolve(dirname(path), node.kind === 'cleanup' ? 'birefnet-metadata.json' : 'provider-metadata.json'), {
    ...output.metadata,
    ...sourceDimensions,
    normalized: { width: image.width, height: image.height, bytes: bytes.byteLength, sha256: entry.outputSha256 },
  });
  await persistLedger(plan, ledger, { type: 'completed', nodeId: node.id, requestId: entry.requestId ?? null, outputPath: entry.outputPath, outputSha256: entry.outputSha256 });
}

async function prepareCleanup(plan: StrategyPlan, frameIndex: number): Promise<JsonRecord> {
  const directory = frameDir(plan, frameIndex);
  const raw = await readFile(rawFramePath(plan, frameIndex));
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
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  const jpegBase64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  await writeFile(resolve(directory, 'birefnet-input.jpg'), Buffer.from(jpegBase64, 'base64'), { mode: 0o600 });
  return { image_url: `data:image/jpeg;base64,${jpegBase64}` };
}

async function unionCleanup(plan: StrategyPlan, frameIndex: number): Promise<void> {
  const directory = frameDir(plan, frameIndex);
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
  await writeFile(cleanFramePath(plan, frameIndex), canvas.toBuffer('image/png'), { mode: 0o600 });
}

async function splitDirectSheet(plan: StrategyPlan): Promise<void> {
  const topology = ANIMATIONS[plan.animationId];
  const layout = directSheetLayout(topology);
  const image = await loadImage(await readFile(directSheetPath(plan)));
  const cellWidth = Math.floor(image.width / layout.columns);
  const cellHeight = Math.floor(image.height / layout.rows);
  for (let frameIndex = 0; frameIndex < topology.uniqueFrameCount; frameIndex += 1) {
    const canvas = createCanvas(cellWidth, cellHeight);
    canvas.getContext('2d').drawImage(image, (frameIndex % layout.columns) * cellWidth, Math.floor(frameIndex / layout.columns) * cellHeight, cellWidth, cellHeight, 0, 0, cellWidth, cellHeight);
    const raw = canvas.toBuffer('image/png');
    await mkdir(frameDir(plan, frameIndex), { recursive: true });
    await writeFile(rawFramePath(plan, frameIndex), raw, { mode: 0o600 });
    const clean = await cleanReposedImagePreserveCanvas(raw.toString('base64'));
    await writeFile(cleanFramePath(plan, frameIndex), Buffer.from(clean, 'base64'), { mode: 0o600 });
  }
}

async function composeSheet(paths: string[], columns: number, rows: number, transparent: boolean): Promise<Buffer> {
  const images = await Promise.all(paths.map(async (path) => loadImage(await readFile(path))));
  const cellWidth = Math.max(...images.map((image) => image.width));
  const cellHeight = Math.max(...images.map((image) => image.height));
  const canvas = createCanvas(cellWidth * columns, cellHeight * rows);
  const context = canvas.getContext('2d');
  if (!transparent) { context.fillStyle = '#00ff00'; context.fillRect(0, 0, canvas.width, canvas.height); }
  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    const x = (index % columns) * cellWidth + Math.round((cellWidth - image.width) / 2);
    const y = Math.floor(index / columns) * cellHeight + Math.round((cellHeight - image.height) / 2);
    context.drawImage(image, x, y);
  }
  return canvas.toBuffer('image/png');
}

async function finalizePlan(plan: StrategyPlan): Promise<void> {
  if (plan.strategyId === 'direct-sheet' && await exists(directSheetPath(plan))) await splitDirectSheet(plan);
  const topology = ANIMATIONS[plan.animationId];
  const requiredRaw = Array.from({ length: topology.uniqueFrameCount }, (_, index) => rawFramePath(plan, index));
  const requiredClean = Array.from({ length: topology.uniqueFrameCount }, (_, index) => cleanFramePath(plan, index));
  if (!(await Promise.all([...requiredRaw, ...requiredClean].map(exists))).every(Boolean)) return;
  const rawPlayback = topology.playbackOrder.map((frameIndex) => rawFramePath(plan, frameIndex));
  const cleanPlayback = topology.playbackOrder.map((frameIndex) => cleanFramePath(plan, frameIndex));
  const sheetsDir = resolve(planDir(plan), 'sheets');
  await mkdir(sheetsDir, { recursive: true });
  await writeFile(resolve(sheetsDir, 'raw-playback.png'), await composeSheet(rawPlayback, topology.grid.columns, topology.grid.rows, false), { mode: 0o600 });
  const unionSheet = await composeSheet(cleanPlayback, topology.grid.columns, topology.grid.rows, true);
  await writeFile(resolve(sheetsDir, 'cleaned-playback.png'), unionSheet, { mode: 0o600 });
  const normalized = await cleanSpriteSheet(unionSheet.toString('base64'), topology.frameCount, topology.grid.columns, topology.grid.rows, topology.id);
  await writeFile(resolve(sheetsDir, 'production-normalized.png'), Buffer.from(normalized.base64, 'base64'), { mode: 0o600 });
}

async function executeGeneration(
  plan: StrategyPlan,
  ledger: ExecutionLedger,
  node: GenerationNode,
  keys: { fal?: string; gemini?: string },
): Promise<void> {
  const images = await materializeReferences(plan, node.references);
  const rendererSpec = renderer(plan.rendererId);
  const output = rendererSpec.adapter === 'fal-queue'
    ? await submitFal(plan, ledger, node, falPayload(rendererSpec, node, images), keys.fal as string, false)
    : await submitGemini(plan, ledger, node, geminiPayload(node, images), keys.gemini as string);
  await completeNode(plan, ledger, node, output);
}

async function executeCleanup(
  plan: StrategyPlan,
  ledger: ExecutionLedger,
  node: Extract<BenchmarkNode, { kind: 'cleanup' }>,
  falKey: string,
): Promise<void> {
  const body = await prepareCleanup(plan, node.frameIndex);
  const output = await submitFal(plan, ledger, node, body, falKey, true);
  await completeNode(plan, ledger, node, output);
  await unionCleanup(plan, node.frameIndex);
}

async function verifyCompletedOutput(plan: StrategyPlan, entry: LedgerEntry): Promise<boolean> {
  if (entry.status !== 'completed' || !entry.outputPath || !entry.outputSha256) return false;
  const path = resolve(PROJECT_ROOT, entry.outputPath);
  if (!(await exists(path))) return false;
  const bytes = await readFile(path);
  return sha256(bytes) === entry.outputSha256;
}

function shouldRunNode(node: BenchmarkNode, throughFrame: number | undefined): boolean {
  if (throughFrame === undefined || node.kind === 'generate-sheet') return true;
  return (node.frameIndex ?? Number.POSITIVE_INFINITY) <= throughFrame;
}

async function reconcileBilling(plan: StrategyPlan, ledger: ExecutionLedger, falKey: string): Promise<BillingEvent[]> {
  const requestIds = Object.values(ledger.entries).filter((entry) => entry.requestId).map((entry) => entry.requestId as string);
  if (requestIds.length === 0) return [];
  let events: BillingEvent[] = [];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const url = new URL('https://api.fal.ai/v1/models/billing-events');
    url.searchParams.set('request_id', requestIds.join(','));
    url.searchParams.set('limit', String(Math.min(100, requestIds.length)));
    const response = await fetch(url, { headers: { Authorization: `Key ${falKey}` }, signal: AbortSignal.timeout(30_000) });
    const json = await response.json() as unknown;
    if (!response.ok || !isRecord(json) || !Array.isArray(json.billing_events)) throw new Error(`fal billing-events HTTP ${response.status}.`);
    events = json.billing_events.flatMap((value): BillingEvent[] => {
      if (!isRecord(value) || typeof value.request_id !== 'string' || typeof value.endpoint_id !== 'string') return [];
      const cost = typeof value.cost_total === 'number'
        ? value.cost_total
        : typeof value.cost_estimate_nano_usd === 'number' ? value.cost_estimate_nano_usd / 1_000_000_000 : null;
      if (cost === null || typeof value.output_units !== 'number' || typeof value.unit_price !== 'number') return [];
      return [{ requestId: value.request_id, endpointId: value.endpoint_id, costTotalUsd: round(cost), outputUnits: value.output_units, unitPriceUsd: value.unit_price, timestamp: typeof value.timestamp === 'string' ? value.timestamp : '' }];
    });
    if (requestIds.every((requestId) => events.some((event) => event.requestId === requestId))) break;
    if (attempt < 11) await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000));
  }
  const missingRequestIds = requestIds.filter((requestId) => !events.some((event) => event.requestId === requestId));
  await atomicWriteJson(billingPath(plan), {
    checkedAt: new Date().toISOString(),
    requestIds,
    complete: missingRequestIds.length === 0,
    missingRequestIds,
    events,
    falRecordedUsd: round(events.reduce((sum, event) => sum + event.costTotalUsd, 0)),
  });
  if (missingRequestIds.length > 0) {
    throw new Error(`fal billing reconciliation is incomplete for ${missingRequestIds.length} submitted request(s).`);
  }
  return events;
}

async function buildReport(plan: StrategyPlan, ledger: ExecutionLedger, billing: BillingEvent[]): Promise<JsonRecord> {
  await finalizePlan(plan);
  const topology = ANIMATIONS[plan.animationId];
  const frames = await Promise.all(Array.from({ length: topology.uniqueFrameCount }, async (_, frameIndex) => ({
    frameIndex,
    phase: topology.phases[frameIndex],
    raw: await exists(rawFramePath(plan, frameIndex)) ? relativeToProject(rawFramePath(plan, frameIndex)) : null,
    cleaned: await exists(cleanFramePath(plan, frameIndex)) ? relativeToProject(cleanFramePath(plan, frameIndex)) : null,
  })));
  const report: JsonRecord = {
    schemaVersion: 1,
    runId: PROVIDER_MATRIX_RUN_ID,
    generatedAt: new Date().toISOString(),
    plan: { rendererId: plan.rendererId, strategyId: plan.strategyId, animationId: plan.animationId, fingerprint: planFingerprint(plan) },
    submissions: { used: ledger.submittedCount, maximum: ledger.maxPaidSubmissions, automaticRetries: 0, providerFallbacks: 0 },
    costs: {
      guardedReservedOrSpentUsd: reservedOrSpentUsd(ledger),
      guardedPlanUsd: plan.guardedBudgetUsd,
      hardCapUsd: ledger.confirmedMaxCostUsd,
      providerEnforcedHardCap: false,
      guardCaveat: 'The ledger prevents planned submissions above this value, but fal does not expose a contractual per-request spend cap. BiRefNet compute time can vary.',
      falRecordedUsd: round(billing.reduce((sum, event) => sum + event.costTotalUsd, 0)),
      geminiRecordedUsd: null,
    },
    statusCounts: Object.fromEntries(['planned', 'submitting', 'queued', 'completed', 'failed', 'unknown', 'blocked'].map((status) => [status, Object.values(ledger.entries).filter((entry) => entry.status === status).length])),
    frames,
    sheets: {
      rawPlayback: await exists(resolve(planDir(plan), 'sheets/raw-playback.png')) ? relativeToProject(resolve(planDir(plan), 'sheets/raw-playback.png')) : null,
      cleanedPlayback: await exists(resolve(planDir(plan), 'sheets/cleaned-playback.png')) ? relativeToProject(resolve(planDir(plan), 'sheets/cleaned-playback.png')) : null,
      productionNormalized: await exists(resolve(planDir(plan), 'sheets/production-normalized.png')) ? relativeToProject(resolve(planDir(plan), 'sheets/production-normalized.png')) : null,
    },
    evaluation: {
      status: 'not-graded',
      requiredGates: ['exactly one complete person', 'two arms/two legs', 'viewer-right facing', 'identity/outfit continuity', 'monotonic pose progression', 'fixed camera/scale/floor line'],
      note: 'No generated frame is silently replaced. A provider block is reported as blocked, never as 0/N valid frames.',
    },
  };
  await atomicWriteJson(reportPath(plan), report);
  return report;
}

export async function executePlan(options: ExecuteOptions): Promise<JsonRecord> {
  if (options.animationId !== 'high_kick') {
    throw new Error('Paid execution is currently locked to HIGH_KICK. Other topologies are compiled for planning but need their own frozen base/scaffold fixtures first.');
  }
  const requestedApprovalId = `${PROVIDER_MATRIX_RUN_ID}:${options.rendererId}:${options.strategyId}:${options.animationId}`;
  const approval = PROVIDER_MATRIX_PAID_APPROVALS.find((candidate) => candidate.id === requestedApprovalId);
  if (!approval || approval.status !== 'approved') {
    throw new Error('This paid matrix gate is not explicitly approved in PROVIDER_MATRIX_PAID_APPROVALS. No request was sent.');
  }
  if (options.throughFrame === undefined || options.throughFrame > approval.maxThroughFrame) {
    throw new Error(`--through-frame is required and may not exceed the approved frame ${approval.maxThroughFrame}. No request was sent.`);
  }
  const plan = buildStrategyPlan(options.rendererId, options.strategyId, options.animationId);
  validateStrategyPlan(plan);
  if (options.confirmation !== requestedApprovalId) {
    throw new Error('Missing the exact paid benchmark confirmation token.');
  }
  if (options.maxCostUsd !== approval.maxCostUsd || options.maxCostUsd > plan.guardedBudgetUsd) {
    throw new Error(`--max-cost must equal the approved staged guard ${approval.maxCostUsd} and remain within the full plan guard ${plan.guardedBudgetUsd}.`);
  }
  await preparePlanArtifacts(plan);
  const keys = await loadKeys();
  const rendererSpec = renderer(plan.rendererId);
  if (rendererSpec.adapter === 'fal-queue' && !keys.fal) throw new Error('FAL_API_KEY is missing; no paid requests were sent.');
  if (rendererSpec.adapter === 'gemini-inline' && !keys.gemini) throw new Error('GEMINI_API_KEY is missing; no paid requests were sent.');
  if (plan.nodes.some((node) => node.kind === 'cleanup') && !keys.fal) throw new Error('FAL_API_KEY is required for cleanup; no paid requests were sent.');
  if (keys.fal) await pricingPreflight(plan, keys.fal);

  await mkdir(dirname(GLOBAL_LOCK_PATH), { recursive: true });
  const lock = await open(GLOBAL_LOCK_PATH, 'wx', 0o600).catch(() => null);
  if (!lock) throw new Error('Another paid provider benchmark holds the global execution lock.');
  let ledger: ExecutionLedger | undefined;
  try {
    const activeLedger = await loadOrCreateLedger(plan, options.maxCostUsd);
    ledger = activeLedger;
    for (const node of plan.nodes) {
      if (!shouldRunNode(node, options.throughFrame)) continue;
      const entry = activeLedger.entries[node.id];
      if (entry.status === 'completed') {
        if (!(await verifyCompletedOutput(plan, entry))) throw new Error(`Completed artifact verification failed for ${node.id}.`);
        if (node.kind === 'cleanup' && !(await exists(cleanFramePath(plan, node.frameIndex)))) await unionCleanup(plan, node.frameIndex);
        continue;
      }
      if (entry.status === 'submitting' || entry.status === 'unknown') {
        throw new Error(`${node.id} is ${entry.status}; refusing any automatic resubmission.`);
      }
      if (entry.status === 'failed' || entry.status === 'blocked') continue;
      const dependenciesReady = await Promise.all(node.dependsOn.map(async (dependency) => {
        if (dependency.endsWith(':frame-0')) return exists(rawFramePath(plan, 0));
        const dependencyEntry = activeLedger.entries[dependency];
        return !!dependencyEntry && dependencyEntry.status === 'completed' && verifyCompletedOutput(plan, dependencyEntry);
      }));
      if (!dependenciesReady.every(Boolean)) {
        entry.status = 'blocked';
        entry.error = 'A dependency did not produce a verified output.';
        await persistLedger(plan, activeLedger, { type: 'blocked', nodeId: node.id, reason: entry.error });
        continue;
      }
      if (node.kind === 'cleanup') await executeCleanup(plan, activeLedger, node, keys.fal as string);
      else await executeGeneration(plan, activeLedger, node, keys);
    }
    const billing = keys.fal ? await reconcileBilling(plan, activeLedger, keys.fal) : [];
    return buildReport(plan, activeLedger, billing);
  } catch (error) {
    if (ledger && keys.fal) {
      await reconcileBilling(plan, ledger, keys.fal).catch(async (billingError) => {
        await atomicWriteJson(resolve(planDir(plan), 'billing-reconciliation-error.json'), {
          checkedAt: new Date().toISOString(),
          originalError: error instanceof Error ? error.message : String(error),
          billingError: billingError instanceof Error ? billingError.message : String(billingError),
        });
      });
    }
    throw error;
  } finally {
    await lock.close();
    await unlink(GLOBAL_LOCK_PATH).catch(() => undefined);
  }
}

export async function planSummary(rendererId?: RendererId, strategyId?: StrategyId, animationId: AnimationId = 'high_kick'): Promise<JsonRecord> {
  await prepareMatrix();
  if (rendererId && strategyId) {
    const plan = buildStrategyPlan(rendererId, strategyId, animationId);
    validateStrategyPlan(plan);
    await preparePlanArtifacts(plan);
    return {
      runId: PROVIDER_MATRIX_RUN_ID,
      rendererId,
      strategyId,
      animationId,
      guardedBudgetUsd: plan.guardedBudgetUsd,
      stagedExecutionNote: 'A paid approval may authorize only a prefix of this full plan. Its cap is shown separately below.',
      maxPaidSubmissions: plan.maxPaidSubmissions,
      confirmation: `${PROVIDER_MATRIX_RUN_ID}:${rendererId}:${strategyId}:${animationId}`,
      paidApproval: PROVIDER_MATRIX_PAID_APPROVALS.find((candidate) =>
        candidate.id === `${PROVIDER_MATRIX_RUN_ID}:${rendererId}:${strategyId}:${animationId}`,
      ) ?? null,
      plan: relativeToProject(resolve(planDir(plan), 'plan.json')),
      paidInferenceCalls: 0,
    };
  }
  return {
    runId: PROVIDER_MATRIX_RUN_ID,
    manifest: relativeToProject(resolve(MATRIX_RUN_DIR, 'manifest.json')),
    highKickPromptCatalog: relativeToProject(resolve(MATRIX_RUN_DIR, 'high-kick-prompt-catalog.json')),
    renderers: RENDERERS.map((value) => value.id),
    strategies: Object.keys(STRATEGIES),
    animations: Object.keys(ANIMATIONS),
    paidInferenceCalls: 0,
  };
}
