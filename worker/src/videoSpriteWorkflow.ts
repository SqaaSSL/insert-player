import { NonRetryableError } from 'cloudflare:workflows';
import type { WorkflowStep } from 'cloudflare:workers';
import { generateId, hashString } from './auth';
import { settleGenerationPurchase } from './billing';
import { mintGenerationJobToken } from './generationAuth';
import type { Env, GenerationJob } from './types';
import { pixcliBaseUrl } from './proxy';
import { stripTrailingSlashes } from './url';
import {
  DEFAULT_VIDEO_SPRITE_AUTOMATIC_SELECTION_POLICY,
  VIDEO_SPRITE_ACTIONS,
  type VideoSpriteAction,
  type VideoSpriteCompileResponse,
} from '../../src/services/VideoSpriteCompileContract';
import {
  STUDIO_CURATED_VIDEO_POLICY,
  videoGenerationPolicyContract,
  type VideoGenerationPolicy,
} from '../../src/services/VideoGenerationPolicy';
import {
  buildPixcliVideoPayload,
  buildVideoSpritePrompt,
  canonicalJson,
  deterministicCanonicalMultipart,
  parsePixcliSubmission,
  parsePixcliUpload,
  pixcliJobStatus,
  projectCompilerReport,
  validatePixcliProviderRequestAudit,
  validatePixcliProviderResponseAudit,
  validatePixcliVideoAudit,
  videoAction,
  type PixcliVideoPayload,
  type VideoSpriteCandidateReportProjection,
  type ValidatedPixcliAsset,
} from './videoSpriteGeneration';
import { persistInitialVideoSpriteCandidate } from './videoSpriteReview';
import { createBoundedByteStream, ResponseBodyTooLargeError } from './streamLimits';

const VIDEO_STEP_CONFIG = {
  retries: { limit: 5, delay: '20 seconds' as const, backoff: 'exponential' as const },
  timeout: '3 hours' as const,
};
const VIDEO_POLL_ATTEMPTS = 120;
const VIDEO_POLL_INTERVAL = '15 seconds' as const;
const MAX_JSON_ASSET_BYTES = 1024 * 1024;
const MAX_VIDEO_BYTES = 16 * 1024 * 1024;
const MAX_COMPILER_RESPONSE_BYTES = 96 * 1024 * 1024;
const MAX_PROXY_JSON_BYTES = 2 * 1024 * 1024;
const TERMINAL_VIDEO_RESPONSE_PREFIX = 'Pinned PixCLI video response is terminal and cannot be replayed safely:';
const TERMINAL_VIDEO_AUDIT_PREFIX = 'Pinned completed PixCLI video audit is terminal and cannot be replayed safely:';

class TerminalVideoProviderResponseError extends NonRetryableError {
  constructor(detail: string) {
    super(`${TERMINAL_VIDEO_RESPONSE_PREFIX} ${detail}`);
  }
}

class TerminalVideoAuditInvariantError extends NonRetryableError {
  constructor(detail: string) {
    super(`${TERMINAL_VIDEO_AUDIT_PREFIX} ${detail}`);
  }
}

function terminalVideoAuditInvariant(error: unknown, fallback: string): TerminalVideoAuditInvariantError {
  if (error instanceof TerminalVideoAuditInvariantError) return error;
  const detail = error instanceof Error ? error.message : fallback;
  return new TerminalVideoAuditInvariantError(
    detail.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240) || fallback,
  );
}

export interface VideoWorkflowCanonical {
  blobKey: string;
  bytes: ArrayBuffer;
  sha256: string;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let encoded = '';
  for (let offset = 0; offset < bytes.length; offset += 24_576) {
    const chunk = bytes.subarray(offset, Math.min(offset + 24_576, bytes.length));
    let binary = '';
    for (const byte of chunk) binary += String.fromCharCode(byte);
    encoded += btoa(binary);
  }
  return encoded;
}

function parseJsonBytes(bytes: ArrayBuffer, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    throw new TerminalVideoAuditInvariantError(`${label} is not canonical UTF-8 JSON`);
  }
}

function assertMp4(bytes: ArrayBuffer): void {
  const header = new Uint8Array(bytes, 0, Math.min(12, bytes.byteLength));
  if (
    bytes.byteLength < 12 || bytes.byteLength > MAX_VIDEO_BYTES ||
    String.fromCharCode(...header.slice(4, 8)) !== 'ftyp'
  ) throw new TerminalVideoAuditInvariantError('PixCLI video asset is not a bounded MP4');
}

async function generationHeaders(
  env: Env,
  job: GenerationJob,
  requestKey: string,
): Promise<Headers> {
  const token = await mintGenerationJobToken(env, {
    jobId: job.id,
    userId: job.user_id,
    providerSessionId: job.provider_session_id,
    creationFlow: 'video',
  });
  return new Headers({
    Authorization: `Generation ${token}`,
    'X-ASF-Provider-Session': job.provider_session_id,
    'X-Insert-Player-Provider-Request-Key': requestKey,
  });
}

async function proxyFetch(
  env: Env,
  job: GenerationJob,
  requestKey: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const base = stripTrailingSlashes(env.GENERATION_API_BASE_URL?.trim() ?? '');
  if (!/^https:\/\/[^/]+/i.test(base)) throw new NonRetryableError('Generation API base URL is unavailable');
  const headers = await generationHeaders(env, job, requestKey);
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  return fetch(`${base}${path}`, { ...init, headers, redirect: 'manual' });
}

async function responseJson(response: Response, label: string): Promise<unknown> {
  if (!response.body) throw new NonRetryableError(`${label} returned an empty response`);
  const bytes = await new Response(
    createBoundedByteStream(response.body, MAX_PROXY_JSON_BYTES),
  ).arrayBuffer();
  const text = new TextDecoder().decode(bytes);
  if (!response.ok) {
    let code: string | null = null;
    try {
      const parsed = JSON.parse(text) as { code?: unknown };
      code = typeof parsed.code === 'string' ? parsed.code : null;
    } catch {
      // The bounded response excerpt below remains the diagnostic for non-JSON failures.
    }
    if (response.status === 409 && code === 'provider_request_outcome_unknown') {
      throw new TerminalVideoProviderResponseError('provider_request_outcome_unknown');
    }
    if (
      label === 'PixCLI video submission' && response.status !== 425 &&
      code !== 'provider_request_in_progress' && code !== 'provider_request_not_dispatched'
    ) {
      throw new TerminalVideoProviderResponseError(
        `submission returned HTTP ${response.status}` +
        (code ? ` (${code})` : ''),
      );
    }
    throw new Error(`${label} failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new NonRetryableError(`${label} returned invalid JSON`);
  }
}

export function isTerminalVideoProviderFailure(message: string): boolean {
  const normalized = message.trimStart().replace(
    /^(?:(?:Error|NonRetryableError|TerminalVideoProviderResponseError|TerminalVideoAuditInvariantError):\s*)+/,
    '',
  );
  return normalized.startsWith('Pinned PixCLI video job terminated as ') ||
    normalized.startsWith(TERMINAL_VIDEO_RESPONSE_PREFIX) ||
    normalized.startsWith(TERMINAL_VIDEO_AUDIT_PREFIX);
}

export async function parsePixcliVideoSubmissionResponse(response: Response) {
  try {
    return parsePixcliSubmission(await responseJson(response, 'PixCLI video submission'));
  } catch (error) {
    if (error instanceof TerminalVideoProviderResponseError || !response.ok) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new TerminalVideoProviderResponseError(
      `submission returned an unusable HTTP ${response.status} payload (${detail.slice(0, 160)})`,
    );
  }
}

export async function downloadPixcliAuditAsset(
  env: Env,
  job: GenerationJob,
  requestKey: string,
  asset: ValidatedPixcliAsset,
): Promise<ArrayBuffer> {
  const response = await proxyFetch(
    env,
    job,
    requestKey,
    `/proxy/pixcli/api/v1/assets/${asset.hash}`,
  );
  if (!response.ok) throw new Error(`PixCLI audit asset ${asset.hash} failed with HTTP ${response.status}`);
  const contentType = response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== asset.mimeType) {
    await response.body?.cancel();
    throw new TerminalVideoAuditInvariantError('PixCLI audit asset MIME type changed after Canva validation');
  }
  const maxBytes = asset.mimeType === 'video/mp4' ? MAX_VIDEO_BYTES : MAX_JSON_ASSET_BYTES;
  const contentLengthHeader = response.headers.get('Content-Length');
  if (contentLengthHeader !== null && contentLengthHeader.trim() !== '') {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isFinite(contentLength) || contentLength < 2 || contentLength > maxBytes) {
      await response.body?.cancel();
      throw new TerminalVideoAuditInvariantError('PixCLI audit asset exceeds its local download limit');
    }
  }
  if (!response.body) throw new TerminalVideoAuditInvariantError('PixCLI audit asset has an empty body');
  let bytes: ArrayBuffer;
  try {
    bytes = await new Response(createBoundedByteStream(response.body, maxBytes)).arrayBuffer();
  } catch (error) {
    if (error instanceof ResponseBodyTooLargeError) {
      throw new TerminalVideoAuditInvariantError('PixCLI audit asset exceeds its local download limit');
    }
    throw error;
  }
  if (bytes.byteLength !== asset.sizeBytes || bytes.byteLength < 2 || bytes.byteLength > maxBytes) {
    throw new TerminalVideoAuditInvariantError('PixCLI audit asset size changed after Canva validation');
  }
  const contentSha256 = await hashString(bytes);
  if (asset.contentSha256 && contentSha256 !== asset.contentSha256) {
    throw new TerminalVideoAuditInvariantError('PixCLI audit JSON hash changed after Canva validation');
  }
  return bytes;
}

export async function nextVideoSpriteAction(
  env: Env,
  job: GenerationJob,
): Promise<VideoSpriteAction> {
  if (!job.artifact_run_id) throw new NonRetryableError('Video generation artifact run is unavailable');
  if (job.operation !== 'fighter_generation') {
    throw new NonRetryableError('The review-gated video flow supports full fighter generation only');
  }
  const { results } = await env.DB.prepare(`
    SELECT job_id, action, status
    FROM video_sprite_candidates
    WHERE run_id = ?
    ORDER BY sequence_order ASC
  `).bind(job.artifact_run_id).all<{
    job_id: string;
    action: VideoSpriteAction;
    status: 'awaiting_review' | 'approved' | 'rejected';
  }>();
  const candidates = results ?? [];
  const pending = candidates.find((candidate) => candidate.status === 'awaiting_review');
  if (pending) {
    if (pending.job_id !== job.id) {
      throw new NonRetryableError('Another video action is still awaiting review');
    }
    return pending.action;
  }
  if (candidates.some((candidate) => candidate.status === 'rejected')) {
    throw new NonRetryableError('A rejected video action requires an explicit retry purchase');
  }
  const approved = new Set(candidates.filter((candidate) => candidate.status === 'approved').map((entry) => entry.action));
  const next = VIDEO_SPRITE_ACTIONS.find((action) => !approved.has(action));
  if (!next) throw new NonRetryableError('All video actions are already approved');
  const nextIndex = VIDEO_SPRITE_ACTIONS.indexOf(next);
  if (VIDEO_SPRITE_ACTIONS.slice(0, nextIndex).some((action) => !approved.has(action))) {
    throw new NonRetryableError('Approved video actions are not a contiguous prefix');
  }
  return next;
}

async function compileAndPersistCandidate(
  env: Env,
  job: GenerationJob,
  action: VideoSpriteAction,
  canonical: VideoWorkflowCanonical,
  prompt: string,
  promptSha256: string,
  requestKey: string,
  pixcliJobId: string,
  payload: PixcliVideoPayload,
  videoGenerationPolicy: VideoGenerationPolicy,
): Promise<{ candidateId: string; revision: number }> {
  const pixcli = pixcliBaseUrl(env.PIXCLI_BASE_URL);
  if (!pixcli) throw new NonRetryableError('PixCLI base URL is unavailable');
  const canvaResponse = await proxyFetch(
    env,
    job,
    requestKey,
    `/proxy/pixcli/api/v1/jobs/${pixcliJobId}/canva`,
  );
  let canva: unknown;
  try {
    canva = await responseJson(canvaResponse, 'PixCLI Canva audit');
  } catch (error) {
    if (canvaResponse.ok && (error instanceof NonRetryableError || error instanceof ResponseBodyTooLargeError)) {
      throw terminalVideoAuditInvariant(error, 'PixCLI Canva audit response is unusable');
    }
    throw error;
  }
  let audit;
  try {
    audit = await validatePixcliVideoAudit(canva, {
      jobId: pixcliJobId,
      payload,
      pixcliOrigin: pixcli.origin,
    });
  } catch (error) {
    throw terminalVideoAuditInvariant(error, 'PixCLI Canva audit contract is invalid');
  }
  const [providerRequestBytes, providerResponseBytes, videoBytes] = await Promise.all([
    downloadPixcliAuditAsset(env, job, requestKey, audit.assets.providerRequest),
    downloadPixcliAuditAsset(env, job, requestKey, audit.assets.providerResponse),
    downloadPixcliAuditAsset(env, job, requestKey, audit.assets.video),
  ]);
  const providerRequest = parseJsonBytes(providerRequestBytes, 'PixCLI provider request audit');
  const providerResponse = parseJsonBytes(providerResponseBytes, 'PixCLI provider response audit');
  try {
    validatePixcliProviderRequestAudit(providerRequest, { payload, pixcliOrigin: pixcli.origin });
    validatePixcliProviderResponseAudit(providerResponse, { sizeBytes: videoBytes.byteLength });
  } catch (error) {
    throw terminalVideoAuditInvariant(error, 'PixCLI provider audit contract is invalid');
  }
  assertMp4(videoBytes);
  const videoSha256 = await hashString(videoBytes);
  const providerAuditDocument = {
    schema: 'video-provider-audit.v1',
    jobId: pixcliJobId,
    providerRequestId: audit.providerRequestId,
    model: payload.model,
    payload,
    canva,
    artifacts: {
      providerRequest: { ...audit.assets.providerRequest, computedSha256: await hashString(providerRequestBytes) },
      providerResponse: { ...audit.assets.providerResponse, computedSha256: await hashString(providerResponseBytes) },
      video: { ...audit.assets.video, computedSha256: videoSha256 },
    },
    providerRequest,
    providerResponse,
  };
  const providerAuditBytesView = new TextEncoder().encode(canonicalJson(providerAuditDocument));
  const providerAuditBytes = providerAuditBytesView.buffer.slice(
    providerAuditBytesView.byteOffset,
    providerAuditBytesView.byteOffset + providerAuditBytesView.byteLength,
  ) as ArrayBuffer;
  if (providerAuditBytes.byteLength > MAX_JSON_ASSET_BYTES) {
    throw new TerminalVideoAuditInvariantError('Provider audit bundle is too large');
  }
  const providerAuditSha256 = await hashString(providerAuditBytes);
  if (!env.IMAGE_PROCESSOR) throw new NonRetryableError('Image processor binding is unavailable');
  const lineage = {
    jobId: job.id,
    runId: job.artifact_run_id!,
    fighterId: job.fighter_id,
    provider: 'fal',
    modelId: payload.model,
    providerRequestId: audit.providerRequestId,
    promptSha256,
    videoSha256,
    canonicalSha256: canonical.sha256,
  };
  const automaticSelectionPolicy = videoGenerationPolicyContract(
    videoGenerationPolicy,
  ).automaticSelectionPolicy;
  const compilerResponse = await env.IMAGE_PROCESSOR.getByName(job.id).fetch(new Request(
    'http://image-processor/v1/compile-video-sprite',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 1,
        action,
        expectedFacing: 'right',
        videoBase64: toBase64(videoBytes),
        canonicalFrameBase64: toBase64(canonical.bytes),
        ...(automaticSelectionPolicy === DEFAULT_VIDEO_SPRITE_AUTOMATIC_SELECTION_POLICY
          ? {}
          : { automaticSelectionPolicy }),
        lineage,
      }),
    },
  ));
  if (!compilerResponse.ok) {
    const detail = `Video compiler rejected the provider asset (${compilerResponse.status}): ` +
      `${(await compilerResponse.text()).slice(0, 500)}`;
    if (compilerResponse.status >= 400 && compilerResponse.status < 500) {
      throw new TerminalVideoAuditInvariantError(detail);
    }
    throw new Error(detail);
  }
  if (!compilerResponse.body) {
    throw new TerminalVideoAuditInvariantError('Video compiler returned an empty response');
  }
  let compilerBytes: ArrayBuffer;
  try {
    compilerBytes = await new Response(
      createBoundedByteStream(compilerResponse.body, MAX_COMPILER_RESPONSE_BYTES),
    ).arrayBuffer();
  } catch (error) {
    if (error instanceof ResponseBodyTooLargeError) {
      throw new TerminalVideoAuditInvariantError('Video compiler response exceeds its byte limit');
    }
    throw error;
  }
  let compileResponse: VideoSpriteCompileResponse;
  try {
    compileResponse = JSON.parse(new TextDecoder().decode(compilerBytes)) as VideoSpriteCompileResponse;
  } catch {
    throw new TerminalVideoAuditInvariantError('Video compiler returned invalid JSON');
  }
  let projection: VideoSpriteCandidateReportProjection;
  try {
    projection = await projectCompilerReport(compileResponse, action, {
      facing: 'right',
      lineage,
      videoSizeBytes: videoBytes.byteLength,
      canonicalSizeBytes: canonical.bytes.byteLength,
      automaticSelectionPolicy,
      operatorAdjustmentApplied: false,
    });
  } catch (error) {
    throw terminalVideoAuditInvariant(error, 'Video compiler report contract is invalid');
  }
  return persistInitialVideoSpriteCandidate(env, {
    job,
    action,
    sequenceOrder: VIDEO_SPRITE_ACTIONS.indexOf(action),
    pixcliJobId,
    providerRequestId: audit.providerRequestId,
    promptSha256,
    canonical,
    providerAudit: { sha256: providerAuditSha256, bytes: providerAuditBytes },
    video: { sha256: videoSha256, bytes: videoBytes },
    compileResponse,
    projection,
  });
}

export async function runVideoSpriteAction(
  env: Env,
  step: WorkflowStep,
  job: GenerationJob,
  action: VideoSpriteAction,
  canonical: VideoWorkflowCanonical,
  generationPrompt?: string,
  videoGenerationPolicy: VideoGenerationPolicy = STUDIO_CURATED_VIDEO_POLICY,
): Promise<{ candidateId: string; revision: number }> {
  if (job.creation_flow !== 'video' || job.tier !== 'champion' || !job.artifact_run_id) {
    throw new NonRetryableError('Video Workflow requires a signed-in Champion artifact run');
  }
  const definition = videoAction(action);
  if (definition.action !== action) throw new NonRetryableError('Video action contract is unavailable');
  const prompt = buildVideoSpritePrompt(action, generationPrompt, videoGenerationPolicy);
  const promptSha256 = await hashString(prompt);
  const requestKey = `run:${job.artifact_run_id}:sprite:${action}`;
  const multipart = deterministicCanonicalMultipart(
    new Uint8Array(canonical.bytes),
    canonical.sha256,
    action,
  );
  const upload = await step.do(`video ${action}: upload canonical`, VIDEO_STEP_CONFIG, async () => {
    const response = await proxyFetch(env, job, requestKey, '/proxy/pixcli/api/v1/uploads', {
      method: 'POST',
      headers: { 'Content-Type': multipart.contentType },
      body: multipart.bytes,
    });
    return parsePixcliUpload(await responseJson(response, 'PixCLI canonical upload'));
  });
  const payload = buildPixcliVideoPayload(action, upload.assetHash, prompt);
  const submission = await step.do(`video ${action}: submit provider job`, VIDEO_STEP_CONFIG, async () => {
    const response = await proxyFetch(env, job, requestKey, '/proxy/pixcli/api/v1/video/advanced', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return parsePixcliVideoSubmissionResponse(response);
  });
  let completed = false;
  for (let attempt = 0; attempt < VIDEO_POLL_ATTEMPTS; attempt += 1) {
    const status = await step.do(`video ${action}: poll ${attempt + 1}`, VIDEO_STEP_CONFIG, async () => (
      pixcliJobStatus(await responseJson(await proxyFetch(
        env,
        job,
        requestKey,
        `/proxy/pixcli/api/v1/jobs/${submission.jobId}`,
      ), 'PixCLI video poll'))
    ));
    if (status === 'completed') {
      completed = true;
      break;
    }
    if (status === 'failed' || status === 'completed_with_fallback') {
      throw new NonRetryableError(`Pinned PixCLI video job terminated as ${status}`);
    }
    await step.sleep(`video ${action}: wait ${attempt + 1}`, VIDEO_POLL_INTERVAL);
  }
  if (!completed) throw new NonRetryableError('Pinned PixCLI video job timed out without resubmission');
  const candidate = await step.do(`video ${action}: archive and compile candidate`, VIDEO_STEP_CONFIG, () => (
    compileAndPersistCandidate(
      env,
      job,
      action,
      canonical,
      prompt,
      promptSha256,
      requestKey,
      submission.jobId,
      payload,
      videoGenerationPolicy,
    )
  ));
  await step.do(`video ${action}: settle awaiting review`, VIDEO_STEP_CONFIG, () => (
    settleVideoSpriteCandidateAwaitingReview(env, job, candidate.candidateId, action)
  ));
  return candidate;
}

export async function settleVideoSpriteCandidateAwaitingReview(
  env: Env,
  job: GenerationJob,
  candidateId: string,
  action: VideoSpriteAction,
): Promise<{ status: 'awaiting_review' }> {
  const settlement = await settleGenerationPurchase(
    env,
    job.user_id,
    job.charge_id,
    true,
    job.fighter_id,
    [
        env.DB.prepare(`
          UPDATE generation_jobs
          SET status = 'succeeded', stage = 'awaiting_review', review_status = 'awaiting_review',
              failure_stage = NULL, error_code = NULL, error_message = NULL,
              finished_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ? AND status IN ('queued', 'running')
            AND EXISTS (
              SELECT 1 FROM video_sprite_candidates candidate
              WHERE candidate.id = ? AND candidate.job_id = generation_jobs.id
                AND candidate.status = 'awaiting_review'
            )
        `).bind(job.id, candidateId),
        env.DB.prepare(`
          UPDATE generation_artifact_runs
          SET status = 'partial', failure_stage = NULL, completed_at = NULL,
              updated_at = datetime('now')
          WHERE id = ? AND user_id = ? AND fighter_id = ?
            AND EXISTS (
              SELECT 1 FROM video_sprite_candidates candidate
              WHERE candidate.id = ? AND candidate.run_id = generation_artifact_runs.id
                AND candidate.status = 'awaiting_review'
            )
        `).bind(job.artifact_run_id, job.user_id, job.fighter_id, candidateId),
        env.DB.prepare(`
          UPDATE provider_cost_events
          SET stage_outcome = CASE WHEN stage_outcome = 'pending' THEN 'succeeded' ELSE stage_outcome END,
              job_outcome = 'succeeded_partial'
          WHERE job_id = ? AND job_outcome = 'in_progress'
        `).bind(job.id),
        env.DB.prepare(`
          INSERT OR IGNORE INTO generation_job_events (id, job_id, stage, status, detail)
          SELECT ?, ?, 'awaiting_review', 'succeeded', ?
          WHERE EXISTS (
            SELECT 1 FROM video_sprite_candidates WHERE id = ? AND status = 'awaiting_review'
          )
        `).bind(job.id, job.id, `${action} candidate is awaiting human review`, candidateId),
    ],
  );
  if (!settlement || settlement.status !== 'committed') {
    throw new Error('Video generation purchase could not be committed');
  }
  const terminal = await env.DB.prepare(`
    SELECT status, stage, review_status FROM generation_jobs WHERE id = ?
  `).bind(job.id).first<{ status: string; stage: string; review_status: string }>();
  if (
    terminal?.status !== 'succeeded' || terminal.stage !== 'awaiting_review' ||
    terminal.review_status !== 'awaiting_review'
  ) throw new Error('Video candidate terminal review state could not be committed');
  return { status: 'awaiting_review' };
}
