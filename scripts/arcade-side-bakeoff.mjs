import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest } from './seed-arcade-roster.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_MANIFEST_PATH = join(root, 'arcade/roster-2026.json');
const DEFAULT_SOURCE_DIR = join(root, '.arcade-sources');
const DEFAULT_OUTPUT_DIR = join(root, '.artifacts/arcade-side-bakeoff');
const DEFAULT_STATE_PATH = join(root, '.arcade-bakeoff-state.json');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const REQUEST_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 5_000;
const JOB_TIMEOUT_MS = 30 * 60 * 1000;

export const BAKEOFF_EXPERIMENT_ID = 'arcade-side-4x2-2026-08-25-v1';
export const BAKEOFF_CONFIRMATION = 'ARCADE_SIDE_BAKEOFF_4X2';
export const BAKEOFF_COHORT = Object.freeze([
  'donald-trump',
  'cristiano-ronaldo',
  'bad-bunny',
  'mrbeast',
]);
export const BAKEOFF_MODELS = Object.freeze([
  Object.freeze({
    id: 'grok-imagine-image-2-edit',
    code: 'grok2',
    endpoint: 'xai/grok-imagine-image/v2.0/edit',
    params: Object.freeze({
      num_images: 1,
      aspect_ratio: '1:1',
      resolution: '1k',
      output_format: 'png',
      quality: 'medium',
    }),
  }),
  Object.freeze({
    id: 'seedream-v5-pro-edit',
    code: 'seedream5p',
    endpoint: 'bytedance/seedream/v5/pro/edit',
    params: Object.freeze({
      image_size: 'square_hd',
      num_images: 1,
      output_format: 'png',
      enable_safety_checker: true,
    }),
  }),
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function parseArg(rawArgs, name, fallback = '') {
  return rawArgs.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
}

function ensureBoundedPng(slug, bytes) {
  if (bytes.byteLength < PNG_SIGNATURE.byteLength || bytes.byteLength > 12 * 1024 * 1024) {
    throw new Error(`Licensed source has an invalid size for ${slug}.`);
  }
  if (!bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) {
    throw new Error(`Licensed source is not PNG for ${slug}.`);
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.writing-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function readState(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function stateSlotInvariant(slot, expected) {
  for (const key of ['slug', 'modelId', 'sourceSha256', 'promptSha256', 'requestSha256']) {
    if (slot[key] !== expected[key]) {
      throw new Error(`Bakeoff state mismatch for ${expected.slotKey}: ${key}.`);
    }
  }
}

function nowIso() {
  return new Date().toISOString();
}

function resolveProviderPrompt(promptBuilder, fighter, model) {
  const prompt = promptBuilder({ fighter, model });
  if (typeof prompt !== 'string' || prompt.trim().length < 180) {
    throw new Error(`Provider prompt is incomplete for ${fighter.slug}:${model.id}.`);
  }
  return prompt.trim();
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function responseBodyHash(text) {
  return text ? sha256(text) : null;
}

const PIXCLI_UPLOAD_STORAGE_FAILED_BODY_SHA256 = responseBodyHash(
  JSON.stringify({ error: 'Upload storage failed' }),
);

async function parseJsonResponse(response, label) {
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label} returned non-JSON HTTP ${response.status} (${responseBodyHash(text)}).`);
  }
  return { body, text };
}

async function readJsonWithPollingRetry(url, headers, options = {}) {
  const attempts = options.attempts ?? 6;
  const delayMs = options.delayMs ?? 2_000;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await (options.fetchImpl ?? fetch)(url, {
        headers,
        signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
      });
      const { body } = await parseJsonResponse(response, `GET ${url}`);
      if (response.ok) return body;
      lastError = new Error(`GET ${url} failed with HTTP ${response.status}.`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (attempt < attempts) await (options.sleepImpl ?? sleep)(delayMs);
  }
  throw lastError ?? new Error(`GET ${url} failed.`);
}

function artifactExtension(mimeType, kind) {
  if (mimeType === 'application/json') return 'json';
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  return kind === 'image' ? 'bin' : 'dat';
}

function assetKind(asset) {
  const auditKind = asset?.metadata?.artifact_kind;
  if (auditKind === 'provider_request' || auditKind === 'provider_response') return auditKind;
  if (String(asset?.mime_type ?? '').startsWith('image/')) return 'image';
  return null;
}

async function downloadArtifact(asset, outputPath, headers, fetchImpl = fetch) {
  const response = await fetchImpl(asset.url, {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Artifact download failed with HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const contentSha256 = sha256(bytes);
  const expected = asset?.metadata?.content_sha256;
  if (expected && expected !== contentSha256) {
    throw new Error(`PixCLI audit artifact hash mismatch for ${basename(outputPath)}.`);
  }
  if (asset.mime_type === 'application/json') JSON.parse(bytes.toString('utf8'));
  writeFileSync(outputPath, bytes, { mode: 0o600 });
  chmodSync(outputPath, 0o600);
  return { contentSha256, sizeBytes: bytes.byteLength };
}

export function buildBakeoffPlan(manifest) {
  validateManifest(manifest);
  const bySlug = new Map(manifest.fighters.map((fighter) => [fighter.slug, fighter]));
  const fighters = BAKEOFF_COHORT.map((slug) => {
    const fighter = bySlug.get(slug);
    if (!fighter) throw new Error(`Bakeoff fighter is missing from the manifest: ${slug}.`);
    if (!/^[a-f0-9]{64}$/.test(fighter.reference?.sourceSha256 ?? '')) {
      throw new Error(`Bakeoff source hash is invalid for ${slug}.`);
    }
    return fighter;
  });
  const slots = [];
  for (const fighter of fighters) {
    for (const model of BAKEOFF_MODELS) {
      slots.push({
        slotKey: `${fighter.slug}:${model.id}`,
        fighter,
        model,
      });
    }
  }
  if (slots.length !== 8) throw new Error('The SIDE bakeoff must contain exactly eight slots.');
  return slots;
}

export function buildPixcliPayload({ fighter, model, sourceAssetHash, prompt = fighter.referencePrompt }) {
  const marker = `ip-side-v1-${fighter.slug}-${model.code}`;
  if (marker.length > 60) throw new Error(`PixCLI marker exceeds 60 characters: ${marker}.`);
  if (!/^[a-f0-9]{32}$/.test(sourceAssetHash ?? '')) {
    throw new Error(`PixCLI source asset hash is invalid for ${fighter.slug}.`);
  }
  if (typeof prompt !== 'string' || prompt.trim().length < 180) {
    throw new Error(`Provider prompt is incomplete for ${fighter.slug}:${model.id}.`);
  }
  return {
    prompt: prompt.trim(),
    model: model.id,
    image: sourceAssetHash,
    params: { ...model.params },
    enrich_prompt: false,
    search: false,
    output_format: 'url',
    publish: false,
    publish_name: marker,
  };
}

export async function uploadBakeoffSource(options) {
  const {
    apiBase,
    apiKey,
    fighter,
    sourceBytes,
    sourceSha256,
    save,
    fetchImpl = fetch,
  } = options;
  const uploading = {
    slug: fighter.slug,
    sourceSha256,
    status: 'uploading',
    uploadStartedAt: nowIso(),
  };
  save(uploading);

  const form = new FormData();
  form.append('file', new Blob([sourceBytes], { type: 'image/png' }), `${fighter.slug}.png`);
  let response;
  try {
    response = await fetchImpl(`${apiBase}/api/v1/uploads`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': 'insert-player-arcade-side-bakeoff/1.0',
      },
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const failed = {
      ...uploading,
      status: 'upload_outcome_unknown',
      uploadError: error instanceof Error ? error.message : String(error),
      updatedAt: nowIso(),
    };
    save(failed);
    throw new Error(`Licensed source upload outcome is unknown for ${fighter.slug}.`);
  }

  let parsed;
  try {
    parsed = await parseJsonResponse(response, 'PixCLI source upload');
  } catch (error) {
    const failed = {
      ...uploading,
      status: 'upload_outcome_unknown',
      uploadHttpStatus: response.status,
      uploadError: error instanceof Error ? error.message : String(error),
      updatedAt: nowIso(),
    };
    save(failed);
    throw new Error(`Licensed source upload outcome is unknown for ${fighter.slug}.`);
  }
  const { body, text } = parsed;
  if (
    response.status !== 201
    || !/^[a-f0-9]{32}$/.test(body.hash ?? '')
    || typeof body.url !== 'string'
  ) {
    const failed = {
      ...uploading,
      status: response.status >= 400 && response.status < 500 ? 'upload_rejected' : 'upload_outcome_unknown',
      uploadHttpStatus: response.status,
      uploadResponseSha256: responseBodyHash(text),
      uploadError: typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
      updatedAt: nowIso(),
    };
    save(failed);
    throw new Error(`Licensed source upload failed for ${fighter.slug}.`);
  }
  const uploaded = {
    ...uploading,
    status: 'uploaded',
    pixcliAssetHash: body.hash,
    pixcliAssetUrl: body.url,
    mimeType: body.mime_type ?? 'image/png',
    sizeBytes: body.size ?? sourceBytes.byteLength,
    uploadedAt: nowIso(),
    updatedAt: nowIso(),
  };
  save(uploaded);
  return uploaded;
}

export function verifyBakeoffSource(fighter, sourcePath) {
  if (!existsSync(sourcePath)) throw new Error(`Licensed source is missing for ${fighter.slug}.`);
  const bytes = readFileSync(sourcePath);
  ensureBoundedPng(fighter.slug, bytes);
  const sourceSha256 = sha256(bytes);
  if (sourceSha256 !== fighter.reference.sourceSha256) {
    throw new Error(`Licensed source hash mismatch for ${fighter.slug}.`);
  }
  return { bytes, sourceSha256 };
}

export function resumeActionForSlot(slot) {
  if (!slot) return 'submit';
  if (slot.status === 'submitted' || slot.status === 'processing') return 'poll';
  if (
    slot.status === 'completed'
    || slot.status === 'failed'
    || slot.status === 'submission_rejected'
  ) return 'skip';
  if (slot.status === 'submitting' || slot.status === 'submission_outcome_unknown') return 'block';
  throw new Error(`Unknown bakeoff slot state: ${String(slot.status)}.`);
}

export function resumeActionForSourceUpload(source) {
  if (!source) return 'upload';
  if (source.status === 'uploaded' && /^[a-f0-9]{32}$/.test(source.pixcliAssetHash ?? '')) {
    return 'reuse';
  }
  if (
    source.status === 'upload_outcome_unknown'
    && source.uploadHttpStatus === 502
    && source.uploadError === 'Upload storage failed'
    && source.uploadResponseSha256 === PIXCLI_UPLOAD_STORAGE_FAILED_BODY_SHA256
  ) {
    return 'retry_storage';
  }
  return 'block';
}

export async function submitBakeoffSlot(options) {
  const {
    apiBase,
    apiKey,
    payload,
    slot,
    save,
    fetchImpl = fetch,
  } = options;
  const action = resumeActionForSlot(slot);
  if (action !== 'submit') return { action, slot };

  const submitting = {
    ...options.invariants,
    status: 'submitting',
    submissionStartedAt: nowIso(),
  };
  save(submitting);

  let response;
  try {
    response = await fetchImpl(`${apiBase}/api/v1/edit/advanced`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'insert-player-arcade-side-bakeoff/1.0',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const unknown = {
      ...submitting,
      status: 'submission_outcome_unknown',
      submissionError: error instanceof Error ? error.message : String(error),
      updatedAt: nowIso(),
    };
    save(unknown);
    throw new Error(`Submission outcome is unknown for ${options.invariants.slotKey}; automatic retry is forbidden.`);
  }

  let parsed;
  try {
    parsed = await parseJsonResponse(response, 'PixCLI submit');
  } catch (error) {
    const isDefinitiveRejection = response.status >= 400 && response.status < 500;
    const unknown = {
      ...submitting,
      status: isDefinitiveRejection ? 'submission_rejected' : 'submission_outcome_unknown',
      submissionHttpStatus: response.status,
      submissionError: error instanceof Error ? error.message : String(error),
      updatedAt: nowIso(),
    };
    save(unknown);
    if (isDefinitiveRejection) return { action: 'rejected', slot: unknown };
    throw new Error(`Submission outcome is unknown for ${options.invariants.slotKey}; automatic retry is forbidden.`);
  }
  const { body, text } = parsed;
  if (response.status !== 202 || typeof body.job_id !== 'string' || !body.job_id) {
    const isDefinitiveRejection = response.status >= 400 && response.status < 500;
    const rejected = {
      ...submitting,
      status: isDefinitiveRejection ? 'submission_rejected' : 'submission_outcome_unknown',
      submissionHttpStatus: response.status,
      submissionResponseSha256: responseBodyHash(text),
      submissionError: typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
      updatedAt: nowIso(),
    };
    save(rejected);
    if (!isDefinitiveRejection) {
      throw new Error(`Submission outcome is unknown for ${options.invariants.slotKey}; automatic retry is forbidden.`);
    }
    return { action: 'rejected', slot: rejected };
  }

  const submitted = {
    ...submitting,
    status: 'submitted',
    pixcliJobId: body.job_id,
    deduplicated: body.deduplicated === true,
    submissionHttpStatus: response.status,
    submittedAt: nowIso(),
    updatedAt: nowIso(),
  };
  save(submitted);
  return { action: 'submitted', slot: submitted };
}

export async function pollJob(options, slot) {
  const deadline = Date.now() + (options.jobTimeoutMs ?? JOB_TIMEOUT_MS);
  let current = slot;
  while (Date.now() < deadline) {
    const job = await readJsonWithPollingRetry(
      `${options.apiBase}/api/v1/jobs/${encodeURIComponent(slot.pixcliJobId)}`,
      options.headers,
      {
        fetchImpl: options.fetchImpl,
        sleepImpl: options.sleepImpl,
        delayMs: options.pollIntervalMs ?? POLL_INTERVAL_MS,
      },
    );
    if (job.status === 'completed' || job.status === 'completed_with_fallback' || job.status === 'failed') {
      return job;
    }
    current = {
      ...current,
      status: 'processing',
      providerStatus: job.status,
      updatedAt: nowIso(),
    };
    options.saveSlot(current);
    await (options.sleepImpl ?? sleep)(options.pollIntervalMs ?? POLL_INTERVAL_MS);
  }
  throw new Error(`PixCLI job timed out without a resubmission: ${slot.pixcliJobId}.`);
}

export async function archiveJob(options, slot, job) {
  const canva = await readJsonWithPollingRetry(
    `${options.apiBase}/api/v1/jobs/${encodeURIComponent(slot.pixcliJobId)}/canva`,
    options.headers,
    { fetchImpl: options.fetchImpl, sleepImpl: options.sleepImpl },
  );
  const assets = Array.isArray(canva.assets) ? canva.assets : [];
  const selected = new Map();
  for (const asset of assets) {
    const kind = assetKind(asset);
    if (kind && !selected.has(kind)) selected.set(kind, asset);
  }

  const runDir = join(options.outputDir, options.experimentId ?? BAKEOFF_EXPERIMENT_ID);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const archived = {};
  for (const kind of ['provider_request', 'provider_response', 'image']) {
    const asset = selected.get(kind);
    if (!asset) continue;
    const extension = artifactExtension(asset.mime_type, kind);
    const outputPath = join(runDir, `${slot.slug}--${slot.modelId}--${kind}.${extension}`);
    const stored = await downloadArtifact(asset, outputPath, options.headers, options.fetchImpl);
    archived[kind] = {
      pixcliAssetHash: asset.hash,
      mimeType: asset.mime_type,
      contentSha256: stored.contentSha256,
      sizeBytes: stored.sizeBytes,
      path: relative(root, outputPath),
      providerRequestId: asset?.metadata?.provider_request_id ?? null,
    };
  }

  const providerRuns = Array.isArray(canva.provider_runs) ? canva.provider_runs : [];
  if (job.status === 'failed' && !archived.provider_response) {
    const outputPath = join(runDir, `${slot.slug}--${slot.modelId}--job_failure.json`);
    writeJsonAtomic(outputPath, {
      schemaVersion: 1,
      artifactKind: 'pixcli_job_failure',
      providerResponseRetained: false,
      job,
      providerRuns,
    });
    const bytes = readFileSync(outputPath);
    archived.job_failure = {
      pixcliAssetHash: null,
      mimeType: 'application/json',
      contentSha256: sha256(bytes),
      sizeBytes: bytes.byteLength,
      path: relative(root, outputPath),
      providerRequestId: providerRuns[0]?.requestId ?? null,
    };
  }

  if (!archived.provider_request) {
    throw new Error(`PixCLI provider request audit is incomplete for ${slot.slotKey}.`);
  }
  if (!archived.provider_response && !archived.job_failure) {
    throw new Error(`PixCLI provider outcome audit is incomplete for ${slot.slotKey}.`);
  }
  if ((job.status === 'completed' || job.status === 'completed_with_fallback') && !archived.image) {
    throw new Error(`PixCLI completed without an archived image for ${slot.slotKey}.`);
  }
  return {
    artifacts: archived,
    providerRuns,
    pixcliCostEstimate: canva?.job?.cost ?? job.cost ?? null,
    pixcliInputSha256: sha256(canonicalJson(canva.input ?? null)),
  };
}

export function buildInitialState(matrixSha256, options = {}) {
  const experimentId = options.experimentId ?? BAKEOFF_EXPERIMENT_ID;
  const expectedPaidCalls = options.expectedPaidCalls ?? 8;
  const policyConstraints = options.policyConstraints ?? {};
  for (const reserved of ['expectedPaidCalls', 'retries', 'fallback', 'promptEnrichment', 'activation']) {
    if (Object.hasOwn(policyConstraints, reserved)) {
      throw new Error(`Experiment policy constraint cannot override ${reserved}.`);
    }
  }
  return {
    schemaVersion: 2,
    experimentId,
    matrixSha256,
    status: 'running',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    policy: {
      expectedPaidCalls,
      retries: 0,
      fallback: 'none',
      promptEnrichment: false,
      activation: false,
      ...policyConstraints,
    },
    sources: {},
    slots: {},
  };
}

function writeSummary(outputDir, state) {
  const runDir = join(outputDir, state.experimentId);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  writeJsonAtomic(join(runDir, 'summary.json'), state);
  const lines = [
    '# Arcade SIDE provider bakeoff',
    '',
    `Experiment: \`${state.experimentId}\``,
    '',
    '| Fighter | Model | Status | Image SHA-256 | PixCLI estimate |',
    '| --- | --- | --- | --- | ---: |',
  ];
  for (const slot of Object.values(state.slots)) {
    lines.push(
      `| ${slot.slug} | ${slot.modelId} | ${slot.status} | ${slot.artifacts?.image?.contentSha256 ?? '-'} | ${slot.pixcliCostEstimate ?? '-'} |`,
    );
  }
  lines.push('', 'No fighter, source-version, sprite-version, or playable pointer was mutated.', '');
  writeFileSync(join(runDir, 'summary.md'), `${lines.join('\n')}\n`, { mode: 0o600 });
}

export async function runBakeoff(options = {}) {
  const manifestPath = options.manifestPath ?? DEFAULT_MANIFEST_PATH;
  const sourceDir = options.sourceDir ?? DEFAULT_SOURCE_DIR;
  const outputDir = options.outputDir ?? DEFAULT_OUTPUT_DIR;
  const statePath = options.statePath ?? DEFAULT_STATE_PATH;
  const apiBase = (options.apiBase ?? 'https://pixcli.hilo.cx').replace(/\/$/, '');
  const apiKey = options.apiKey ?? '';
  if (!apiKey) throw new Error('PIXCLI_API_KEY is required.');

  const manifest = options.manifest ?? JSON.parse(readFileSync(manifestPath, 'utf8'));
  validateManifest(manifest);
  const experimentId = options.experimentId ?? BAKEOFF_EXPERIMENT_ID;
  const plan = options.planBuilder ? options.planBuilder(manifest) : buildBakeoffPlan(manifest);
  const expectedPaidCalls = options.expectedPaidCalls ?? 8;
  if (!Number.isSafeInteger(expectedPaidCalls) || expectedPaidCalls < 1 || plan.length !== expectedPaidCalls) {
    throw new Error(`Experiment ${experimentId} does not match its sealed paid-call count.`);
  }
  if (new Set(plan.map((slot) => slot.slotKey)).size !== plan.length) {
    throw new Error(`Experiment ${experimentId} contains duplicate slots.`);
  }
  const promptBuilder = options.promptBuilder ?? (({ fighter }) => fighter.referencePrompt);
  const payloadBuilder = options.payloadBuilder ?? buildPixcliPayload;
  const matrix = plan.map(({ fighter, model }) => {
    const prompt = resolveProviderPrompt(promptBuilder, fighter, model);
    return {
      slug: fighter.slug,
      sourceSha256: fighter.reference.sourceSha256,
      promptSha256: sha256(prompt),
      modelId: model.id,
      endpoint: model.endpoint,
      referenceInputs: model.referenceInputs ?? [],
      params: model.params,
    };
  });
  const matrixSha256 = sha256(canonicalJson(matrix));
  const stateOptions = {
    experimentId,
    expectedPaidCalls,
    policyConstraints: options.policyConstraints,
  };
  const expectedPolicy = buildInitialState(matrixSha256, stateOptions).policy;
  let state = readState(statePath) ?? buildInitialState(matrixSha256, stateOptions);
  if (
    state.schemaVersion !== 2
    || state.experimentId !== experimentId
    || state.matrixSha256 !== matrixSha256
    || canonicalJson(state.policy) !== canonicalJson(expectedPolicy)
  ) {
    throw new Error('Existing bakeoff state belongs to a different immutable matrix.');
  }

  const saveState = () => {
    state.updatedAt = nowIso();
    writeJsonAtomic(statePath, state);
  };
  const saveSlot = (slot) => {
    state.slots[slot.slotKey] = slot;
    saveState();
  };
  const saveSource = (source) => {
    state.sources[source.slug] = source;
    saveState();
  };
  saveState();

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'User-Agent': 'insert-player-arcade-side-bakeoff/1.0',
  };

  for (const { slotKey, fighter, model } of plan) {
    const sourcePath = join(sourceDir, `${fighter.slug}.png`);
    const { bytes, sourceSha256 } = verifyBakeoffSource(fighter, sourcePath);
    let uploadedSource = state.sources[fighter.slug] ?? null;
    if (uploadedSource) {
      if (uploadedSource.sourceSha256 !== sourceSha256) {
        throw new Error(`Uploaded source state mismatch for ${fighter.slug}.`);
      }
    }
    const sourceResumeAction = resumeActionForSourceUpload(uploadedSource);
    if (sourceResumeAction === 'block') {
      throw new Error(`Licensed source upload requires manual reconciliation for ${fighter.slug}.`);
    }
    if (sourceResumeAction === 'upload' || sourceResumeAction === 'retry_storage') {
      uploadedSource = await uploadBakeoffSource({
        apiBase,
        apiKey,
        fighter,
        sourceBytes: bytes,
        sourceSha256,
        save: saveSource,
        fetchImpl: options.fetchImpl,
      });
    }
    const prompt = resolveProviderPrompt(promptBuilder, fighter, model);
    const payload = payloadBuilder({
      fighter,
      model,
      sourceAssetHash: uploadedSource.pixcliAssetHash,
      prompt,
    });
    const invariants = {
      slotKey,
      slug: fighter.slug,
      fighterName: fighter.name,
      modelId: model.id,
      providerEndpoint: model.endpoint,
      sourceSha256,
      promptSha256: sha256(prompt),
      requestSha256: sha256(canonicalJson(payload)),
    };
    const previous = state.slots[slotKey] ?? null;
    if (previous) stateSlotInvariant(previous, invariants);
    const resumeAction = resumeActionForSlot(previous);
    if (resumeAction === 'block') {
      throw new Error(`Slot ${slotKey} has an ambiguous prior submission; manual reconciliation is required.`);
    }
    if (resumeAction === 'skip') continue;

    const submitted = await submitBakeoffSlot({
      apiBase,
      apiKey,
      payload,
      slot: previous,
      invariants,
      save: saveSlot,
      fetchImpl: options.fetchImpl,
    });
    if (submitted.action === 'rejected') continue;
    const activeSlot = submitted.slot;
    const job = await pollJob({
      apiBase,
      headers,
      saveSlot,
      fetchImpl: options.fetchImpl,
      sleepImpl: options.sleepImpl,
      pollIntervalMs: options.pollIntervalMs,
      jobTimeoutMs: options.jobTimeoutMs,
    }, activeSlot);
    const archived = await archiveJob({
      apiBase,
      headers,
      outputDir,
      experimentId,
      fetchImpl: options.fetchImpl,
      sleepImpl: options.sleepImpl,
    }, activeSlot, job);
    saveSlot({
      ...activeSlot,
      ...archived,
      status: job.status === 'failed' ? 'failed' : 'completed',
      providerStatus: job.status,
      providerError: job.error ?? null,
      completedAt: nowIso(),
      updatedAt: nowIso(),
    });
  }

  const terminal = Object.values(state.slots).filter((slot) => (
    slot.status === 'completed'
    || slot.status === 'failed'
    || slot.status === 'submission_rejected'
  ));
  state.status = terminal.length === plan.length ? 'complete' : 'incomplete';
  state.completedAt = state.status === 'complete' ? nowIso() : null;
  saveState();
  writeSummary(outputDir, state);
  return state;
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const confirmation = parseArg(rawArgs, '--confirm');
  if (!rawArgs.includes('--execute') || confirmation !== BAKEOFF_CONFIRMATION) {
    throw new Error(`Paid execution requires --execute --confirm=${BAKEOFF_CONFIRMATION}.`);
  }
  const state = await runBakeoff({
    apiKey: process.env.PIXCLI_API_KEY,
    apiBase: process.env.PIXCLI_BASE_URL,
    manifestPath: parseArg(rawArgs, '--manifest', DEFAULT_MANIFEST_PATH),
    sourceDir: parseArg(rawArgs, '--source-dir', DEFAULT_SOURCE_DIR),
    outputDir: parseArg(rawArgs, '--output-dir', DEFAULT_OUTPUT_DIR),
    statePath: parseArg(rawArgs, '--state', DEFAULT_STATE_PATH),
  });
  const completed = Object.values(state.slots).filter((slot) => slot.status === 'completed').length;
  const failed = Object.values(state.slots).filter((slot) => slot.status !== 'completed').length;
  console.log(`Arcade SIDE bakeoff terminal: ${completed} completed, ${failed} non-completed.`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
