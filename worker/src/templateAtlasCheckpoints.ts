import { hashString } from './auth';
import { NonRetryableError } from 'cloudflare:workflows';
import { requireArtifactRunId } from './generationArtifacts';
import { storedGenerationRenderer } from './templateGenerationPolicy';
import type { Env, GenerationJob } from './types';
import { getTemplateAtlasPlanIds, TEMPLATE_ATLAS_MODEL, TEMPLATE_ATLAS_VERSION,
  type TemplateAtlasReceipt, type TemplateAtlasRendererVersion } from '../../src/services/TemplateAtlasContract';

const MAX_JSON_BYTES = 32 * 1024;
const MAX_RAW_BYTES = 32 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
function invalid(message: string): never { throw new NonRetryableError(message); }

export interface TemplateAtlasRawCheckpoint {
  rawKey: string;
  sha256: string;
  width: number;
  height: number;
  /** Optional only for older checkpoints; restored bytes are always re-hashed. */
  sizeBytes?: number;
  receipt: TemplateAtlasReceipt;
}

function prefix(job: GenerationJob, renderer: TemplateAtlasRendererVersion, planId: string): string {
  try {
    const animationNames = JSON.parse(job.animation_plan_json!).animations;
    if (storedGenerationRenderer(job) !== renderer || !getTemplateAtlasPlanIds(renderer, animationNames).includes(planId)) {
      invalid('Unauthorized atlas checkpoint plan');
    }
  } catch { invalid('Unauthorized atlas checkpoint plan'); }
  return `users/${job.user_id}/fighters/${job.fighter_id}/generation-runs/${requireArtifactRunId(job)}/atlases/${planId.replaceAll(':', '_')}`;
}

function validateReceipt(job: GenerationJob, renderer: TemplateAtlasRendererVersion,
  planId: string, receipt: TemplateAtlasReceipt): void {
  const provenance = receipt?.provenance;
  if (!receipt || typeof receipt.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(receipt.requestId)
    || receipt.requestScope !== `job:${requireArtifactRunId(job)}:atlas:${planId}`
    || provenance?.planId !== planId || provenance.rendererVersion !== renderer
    || provenance.templateVersion !== TEMPLATE_ATLAS_VERSION || provenance.model !== TEMPLATE_ATLAS_MODEL
    || provenance.originalPhotoIncluded !== false
    || JSON.stringify(provenance.referenceRoles) !== JSON.stringify(['template', 'prepared-upright'])
    || ![provenance.templateManifestSha256, provenance.templateImageSha256, provenance.preparedUprightSha256,
      provenance.inputUprightSha256, provenance.promptSha256, provenance.requestBodySha256]
      .every(value => typeof value === 'string' && HASH.test(value))) invalid('Atlas receipt identity mismatch');
}

async function validateRaw(bytes: ArrayBuffer, expectedHash: string, width: number, height: number): Promise<void> {
  if (!HASH.test(expectedHash) || bytes.byteLength < 24 || bytes.byteLength > MAX_RAW_BYTES
    || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192
    || await hashString(bytes) !== expectedHash) invalid('Invalid verified atlas RAW checksum or size');
  const header = new DataView(bytes);
  if (header.getUint32(0) !== 0x89504e47 || header.getUint32(4) !== 0x0d0a1a0a
    || header.getUint32(16) !== width || header.getUint32(20) !== height) invalid('Atlas PNG header mismatch');
}

async function readJson<T>(env: Env, key: string): Promise<T | null> {
  const object = await env.SPRITES.get(key);
  if (!object) return null;
  if (object.size > MAX_JSON_BYTES) invalid('Invalid atlas checkpoint size');
  const text = await object.text();
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) invalid('Invalid atlas checkpoint size');
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid('Invalid atlas checkpoint JSON');
    return parsed as T;
  }
  catch { invalid('Invalid atlas checkpoint JSON; refusing paid regeneration'); }
}

/** First writer wins; recovery never replaces an earlier inference receipt or RAW. */
export async function persistImmutableAtlasJson(env: Env, key: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) invalid('Invalid atlas checkpoint size');
  const result = await env.SPRITES.put(key, text, {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/json', cacheControl: 'private, no-store' },
  });
  if (!result) {
    const existing = await env.SPRITES.get(key);
    if (!existing || existing.size > MAX_JSON_BYTES || await existing.text() !== text) invalid('Immutable atlas checkpoint conflict');
  }
}

export async function loadTemplateAtlasReceipt(env: Env, job: GenerationJob, renderer: TemplateAtlasRendererVersion, planId: string) {
  const receipt = await readJson<TemplateAtlasReceipt>(env, `${prefix(job, renderer, planId)}/receipt.json`);
  if (receipt) validateReceipt(job, renderer, planId, receipt);
  return receipt;
}

export async function saveTemplateAtlasReceipt(env: Env, job: GenerationJob, renderer: TemplateAtlasRendererVersion,
  planId: string, receipt: TemplateAtlasReceipt): Promise<void> {
  validateReceipt(job, renderer, planId, receipt);
  await persistImmutableAtlasJson(env, `${prefix(job, renderer, planId)}/receipt.json`, receipt);
}

export async function loadTemplateAtlasRaw(env: Env, job: GenerationJob, renderer: TemplateAtlasRendererVersion, planId: string) {
  const namespace = prefix(job, renderer, planId);
  const checkpoint = await readJson<TemplateAtlasRawCheckpoint>(env, `${namespace}/raw.json`);
  if (!checkpoint) return null;
  if (!HASH.test(checkpoint.sha256) || checkpoint.rawKey !== `${namespace}/${checkpoint.sha256}.png`) {
    invalid('Invalid durable atlas RAW identity');
  }
  validateReceipt(job, renderer, planId, checkpoint.receipt);
  const object = await env.SPRITES.get(checkpoint.rawKey);
  if (!object) invalid('Preserved atlas RAW is missing; refusing paid regeneration');
  if (object.size < 24 || object.size > MAX_RAW_BYTES
    || (checkpoint.sizeBytes !== undefined && checkpoint.sizeBytes !== object.size)) invalid('Invalid preserved atlas RAW size');
  await validateRaw(await object.arrayBuffer(), checkpoint.sha256, checkpoint.width, checkpoint.height);
  return checkpoint;
}

export async function saveTemplateAtlasRaw(env: Env, job: GenerationJob, renderer: TemplateAtlasRendererVersion,
  planId: string, receipt: TemplateAtlasReceipt, bytes: ArrayBuffer,
  expectedHash: string, width: number, height: number): Promise<TemplateAtlasRawCheckpoint> {
  validateReceipt(job, renderer, planId, receipt);
  await validateRaw(bytes, expectedHash, width, height);
  const hash = expectedHash;
  const namespace = prefix(job, renderer, planId);
  const rawKey = `${namespace}/${hash}.png`;
  const result = await env.SPRITES.put(rawKey, bytes, { onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'image/png', cacheControl: 'private, no-store' },
    customMetadata: { contentHash: hash, rendererVersion: renderer, planId, jobId: job.id } });
  if (!result) {
    const existing = await env.SPRITES.get(rawKey);
    if (!existing || existing.size !== bytes.byteLength) invalid('Immutable atlas RAW conflict');
    await validateRaw(await existing.arrayBuffer(), hash, width, height);
  }
  const checkpoint = { rawKey, sha256: hash, width, height, sizeBytes: bytes.byteLength, receipt };
  await persistImmutableAtlasJson(env, `${namespace}/raw.json`, checkpoint);
  return checkpoint;
}
