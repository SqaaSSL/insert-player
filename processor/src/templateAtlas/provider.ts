import { createHash } from 'node:crypto';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { apiFetch, createDetachedApiRequestContext } from '../../../src/services/ApiClient';
import {
  isTemplateAtlasRendererVersion,
  normalizeTemplateAtlasAnimationNames,
  TEMPLATE_ATLAS_MODEL,
  TEMPLATE_ATLAS_VERSION,
  type CollectTemplateAtlasRequest,
  type GenerateTemplateAtlasRequest,
  type GenerateTemplateAtlasResult,
  type SubmitTemplateAtlasRequest,
  type TemplateAtlasProvenance,
  type TemplateAtlasReceipt,
} from '../../../src/services/TemplateAtlasContract';
import { getTemplateAtlasImage, resolveTemplateAtlasPlan, type TemplateAtlasPlan } from './templates';

const MAX_IMAGE_BYTES = 24 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
// Matches the Worker GET allowlist exactly; an unpollable handle is not a verified receipt.
const REQUEST_ID = /^[A-Za-z0-9-]{16,80}$/;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export class TemplateAtlasRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'TemplateAtlasRequestError';
  }
}

function invalid(message: string): never {
  throw new TemplateAtlasRequestError(message, 400, 'invalid_template_atlas_request');
}

export function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** No caller-supplied model, template URL, prompt, original photo or fallback. */
export function validateGenerateTemplateAtlasRequest(value: unknown): GenerateTemplateAtlasRequest {
  if (!record(value)) invalid('Expected a Template Atlas request');
  const allowed = new Set([
    'operation', 'rendererVersion', 'animationNames', 'planId', 'apiBaseUrl',
    'generationToken', 'providerSessionId', 'requestScope',
    ...(value.operation === 'submit' ? ['uprightBase64'] : ['receipt']),
  ]);
  if (Object.keys(value).some(key => !allowed.has(key))) invalid('Unexpected Template Atlas request field');
  if (value.operation !== 'submit' && value.operation !== 'collect') invalid('Expected submit or collect');
  if (!isTemplateAtlasRendererVersion(value.rendererVersion)) invalid('Unsupported Template Atlas renderer');
  let animationNames;
  try { animationNames = normalizeTemplateAtlasAnimationNames(value.animationNames); }
  catch { invalid('Invalid Template Atlas animation selection'); }
  if (typeof value.planId !== 'string' || !/^[a-z0-9:_-]{1,100}$/.test(value.planId)) invalid('Invalid trusted plan ID');
  if (typeof value.apiBaseUrl !== 'string') invalid('Missing processor API context');
  let apiUrl: URL;
  try { apiUrl = new URL(value.apiBaseUrl); } catch { invalid('Invalid processor API context'); }
  if (!['http:', 'https:'].includes(apiUrl.protocol) || apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash) {
    invalid('Invalid processor API context');
  }
  if (typeof value.generationToken !== 'string' || !value.generationToken.trim()
    || typeof value.providerSessionId !== 'string' || !value.providerSessionId.trim()
    || typeof value.requestScope !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(value.requestScope)) {
    invalid('Missing generation authorization context');
  }
  if (value.operation === 'submit') {
    if (typeof value.uprightBase64 !== 'string' || !value.uprightBase64) invalid('Missing prepared upright');
  } else if (!record(value.receipt)) invalid('Missing durable provider receipt');
  return { ...value, animationNames } as unknown as GenerateTemplateAtlasRequest;
}

export function decodePngBase64(value: string): Buffer {
  const encoded = value.startsWith('data:image/png;base64,') ? value.slice(22) : value;
  if (encoded.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) invalid('Invalid or oversized PNG');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 24 || bytes.length > MAX_IMAGE_BYTES || !bytes.subarray(0, 8).equals(PNG)) invalid('Expected native PNG bytes');
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 32 * 1024 * 1024) invalid('PNG dimensions exceed image limits');
  return bytes;
}

/** Composite once at the existing canvas size; never crop, fit or normalize body scale. */
export async function prepareWhiteUpright(value: string): Promise<{ bytes: Buffer; inputSha256: string }> {
  const input = decodePngBase64(value);
  let image;
  try { image = await loadImage(input); } catch { invalid('Unable to decode prepared upright PNG'); }
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, image.width, image.height);
  context.drawImage(image, 0, 0);
  return { bytes: await canvas.encode('png'), inputSha256: sha256(input) };
}

/** The reviewed white-atlas experiment prompt, with identity described by the upright only. */
export function templateAtlasPrompt(plan: TemplateAtlasPlan): string {
  const { columns, rows } = plan.grid;
  const count = plan.cells.length;
  return `Edit @Image1, the supplied Template Zero pose atlas, IN PLACE. Replace each humanoid with the SAME person from @Image2. Return ONE photorealistic 4096x4096 game sprite atlas, exactly ${columns} columns by ${rows} rows, with ${count} occupied cells in reading order and ${columns * rows - count} trailing empty white cells. This atlas contains DIFFERENT movements and intermediate poses, not repeated copies of one pose. Every occupied input cell must have exactly one corresponding fully drawn person in the same output cell. Keep empty input cells empty. No gutters, separators, borders, labels, captions or grid lines.

IDENTITY ONLY: @Image2 controls the person's face, hair, body appearance, real fabric, outfit and shoes. It never controls posture. Apply this same recognizable identity and outfit to EVERY occupied cell. No bald gray mannequin, no blend between mannequin and the person, no extra person. Do not send every pose back to standing or guard.

POSE AND REGISTRATION ONLY: @Image1 is the immutable layout and pose master. Edit each cell independently, one for one, without inventing choreography. Preserve its joint angles, silhouette, orientation, body scale, full-canvas margins, occlusion, hand and foot contacts. Copy bent-knee transitions as bent-knee transitions, not as fully extended kicks. Keep crouching and lying poses at their original anatomical scale, never enlarged to fill the cell or replaced with upright poses. Preserve the direction of falling bodies, unusual leaning and one-leg poses, alternating hand positions and the intentionally exaggerated close-to-camera kiss. No crop, camera change, zoom, per-cell reframing, missing limbs, rearranged cells, invented in-betweens, pose substitutions or repetition of just the last phase.

OPAQUE SUBJECT / NEUTRAL LIGHT: Fully render each complete opaque person with natural skin and fabric colors, sharp face and fabric details at the available cell resolution. The background is solid pure #FFFFFF, only in empty space outside the body. No green lighting, green tint, green haze, green patches or unpainted holes in the person. Do not blend the background into the subject. No motion blur, shadows on the floor, props, text or watermarks.

Return ONE sharp 4K square image with exactly the same ${columns}x${rows} grid. Preserve all ${count} supplied poses, cell by cell, even when their motions or silhouettes look similar. Never collapse this atlas to a collage of a few enlarged figures.`;
}

export function templateAtlasPayload(plan: TemplateAtlasPlan, templatePng: Uint8Array, uprightPng: Uint8Array) {
  return {
    sync_mode: false,
    num_images: 1,
    resolution: '4K',
    aspect_ratio: '1:1',
    output_format: 'png',
    limit_generations: true,
    enable_web_search: false,
    prompt: templateAtlasPrompt(plan),
    image_urls: [templatePng, uprightPng].map(bytes => `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`),
  };
}

function requestContext(body: GenerateTemplateAtlasRequest) {
  return createDetachedApiRequestContext({
    apiBaseUrl: body.apiBaseUrl,
    authorizationToken: body.generationToken,
    authorizationScheme: 'Generation',
    providerSessionId: body.providerSessionId,
    providerRequestScope: body.requestScope,
  });
}

async function jsonObject(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (text.length > MAX_JSON_BYTES) throw new Error('Oversized provider response');
  const value: unknown = JSON.parse(text);
  if (!record(value)) throw new Error('Invalid provider response');
  return value;
}

export interface TemplateAtlasProviderDependencies {
  resolvePlan: typeof resolveTemplateAtlasPlan;
  templateImage: typeof getTemplateAtlasImage;
  fetch: typeof apiFetch;
}
const defaults: TemplateAtlasProviderDependencies = {
  resolvePlan: resolveTemplateAtlasPlan,
  templateImage: getTemplateAtlasImage,
  fetch: apiFetch,
};

async function submit(
  body: SubmitTemplateAtlasRequest,
  plan: TemplateAtlasPlan,
  dependencies: TemplateAtlasProviderDependencies,
): Promise<GenerateTemplateAtlasResult> {
  const [template, upright] = await Promise.all([
    dependencies.templateImage(plan), prepareWhiteUpright(body.uprightBase64),
  ]);
  if (sha256(template) !== plan.templateImageSha256) throw new Error('Trusted Template Atlas image digest mismatch');
  const payload = templateAtlasPayload(plan, template, upright.bytes);
  const serialized = JSON.stringify(payload);
  const provenance: TemplateAtlasProvenance = {
    rendererVersion: body.rendererVersion,
    templateVersion: TEMPLATE_ATLAS_VERSION,
    planId: plan.planId,
    templateManifestSha256: plan.templateManifestSha256,
    templateImageSha256: sha256(template),
    inputUprightSha256: upright.inputSha256,
    preparedUprightSha256: sha256(upright.bytes),
    promptSha256: sha256(payload.prompt),
    requestBodySha256: sha256(serialized),
    model: TEMPLATE_ATLAS_MODEL,
    referenceRoles: ['template', 'prepared-upright'],
    originalPhotoIncluded: false,
  };
  let response: Response;
  try {
    // Deliberately exactly one paid attempt. The Worker pins Meterkey and owns the logical request key.
    response = await dependencies.fetch(`/proxy/fal/${TEMPLATE_ATLAS_MODEL}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-fal-no-retry': '1',
        'cf-aig-max-attempts': '1',
        'cf-aig-skip-cache': 'true',
      },
      body: serialized,
      signal: AbortSignal.timeout(90_000),
    }, requestContext(body));
  } catch {
    throw new TemplateAtlasRequestError('Atlas submission outcome is unknown. Do not submit it again.', 502, 'provider_request_outcome_unknown');
  }
  let data: Record<string, unknown>;
  try { data = await jsonObject(response); }
  catch {
    throw new TemplateAtlasRequestError('Atlas submission has no verified receipt. Do not submit it again.', 502, 'provider_request_outcome_unknown');
  }
  if (!response.ok) {
    // A deliberate gateway block is distinct from an ambiguous upstream failure. Neither gets a new POST here.
    const code = data.code === 'provider_request_not_dispatched'
      || data.code === 'daily_cap_exceeded' || data.code === 'monthly_cap_exceeded'
      ? data.code : 'provider_request_outcome_unknown';
    throw new TemplateAtlasRequestError('Atlas submission was not accepted with a verified receipt. No automatic retry.', response.status, code);
  }
  if (typeof data.request_id !== 'string' || !REQUEST_ID.test(data.request_id)) {
    throw new TemplateAtlasRequestError('Atlas submission has no verified request ID. Do not submit it again.', 502, 'provider_request_outcome_unknown');
  }
  if (data.insert_player_request_body_sha256 !== provenance.requestBodySha256) {
    throw new TemplateAtlasRequestError('Atlas receipt does not verify these exact input bytes. Do not submit it again.', 409, 'provider_request_outcome_unknown', data.request_id);
  }
  return { status: 'submitted', receipt: { requestId: data.request_id, requestScope: body.requestScope, provenance } };
}

function validateReceipt(body: CollectTemplateAtlasRequest, plan: TemplateAtlasPlan): TemplateAtlasReceipt {
  const receipt = body.receipt;
  if (!record(receipt) || typeof receipt.requestId !== 'string' || !REQUEST_ID.test(receipt.requestId)
    || receipt.requestScope !== body.requestScope || !record(receipt.provenance)) invalid('Invalid durable provider receipt');
  const provenance = receipt.provenance;
  if (provenance.rendererVersion !== body.rendererVersion || provenance.planId !== plan.planId
    || provenance.templateVersion !== TEMPLATE_ATLAS_VERSION || provenance.model !== TEMPLATE_ATLAS_MODEL
    || provenance.templateManifestSha256 !== plan.templateManifestSha256
    || provenance.templateImageSha256 !== plan.templateImageSha256
    || provenance.promptSha256 !== sha256(templateAtlasPrompt(plan))
    || provenance.originalPhotoIncluded !== false
    || JSON.stringify(provenance.referenceRoles) !== JSON.stringify(['template', 'prepared-upright'])
    || ![provenance.requestBodySha256, provenance.preparedUprightSha256, provenance.inputUprightSha256]
      .every(value => typeof value === 'string' && HASH.test(value))) invalid('Provider receipt does not match the trusted plan');
  return receipt;
}

function falImageUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Missing provider image');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || !(url.hostname === 'fal.media' || url.hostname.endsWith('.fal.media'))) throw new Error('Untrusted provider image host');
  return url.href;
}

async function collect(
  body: CollectTemplateAtlasRequest,
  plan: TemplateAtlasPlan,
  dependencies: TemplateAtlasProviderDependencies,
): Promise<GenerateTemplateAtlasResult> {
  const receipt = validateReceipt(body, plan);
  const context = requestContext(body);
  // FAL's queue handle belongs to the BASE model, not the /edit submission path.
  const base = `/proxy/fal/fal-ai/nano-banana-2/requests/${receipt.requestId}`;
  try {
    const statusResponse = await dependencies.fetch(`${base}/status`, { method: 'GET', signal: AbortSignal.timeout(30_000) }, context);
    if (!statusResponse.ok) throw new Error('Provider status unavailable');
    const status = await jsonObject(statusResponse);
    if (status.status === 'IN_QUEUE' || status.status === 'IN_PROGRESS') {
      return { status: 'pending', providerStatus: status.status, receipt };
    }
    if (status.status !== 'COMPLETED') {
      throw new TemplateAtlasRequestError('Atlas provider job did not complete successfully; no new generation was requested.', 422, 'provider_result_failed', receipt.requestId);
    }
    const resultResponse = await dependencies.fetch(base, { method: 'GET', signal: AbortSignal.timeout(30_000) }, context);
    if (!resultResponse.ok) throw new Error('Provider result unavailable');
    const result = await jsonObject(resultResponse);
    if (!Array.isArray(result.images) || result.images.length !== 1 || !record(result.images[0])) {
      throw new TemplateAtlasRequestError('Atlas result must contain exactly one native image.', 422, 'provider_result_invalid', receipt.requestId);
    }
    let url: string;
    try { url = falImageUrl(result.images[0].url); }
    catch { throw new TemplateAtlasRequestError('Atlas result contains an untrusted image URL.', 422, 'provider_result_invalid', receipt.requestId); }
    const imageResponse = await dependencies.fetch(`/proxy/image?url=${encodeURIComponent(url)}`, { method: 'GET', signal: AbortSignal.timeout(45_000) }, context);
    if (!imageResponse.ok) throw new Error('Provider image unavailable');
    const bytes = Buffer.from(await imageResponse.arrayBuffer());
    if (bytes.length < 24 || bytes.length > MAX_IMAGE_BYTES || !bytes.subarray(0, 8).equals(PNG)) {
      throw new TemplateAtlasRequestError('Atlas result is not the requested native PNG.', 422, 'provider_result_invalid', receipt.requestId);
    }
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 32 * 1024 * 1024) {
      throw new TemplateAtlasRequestError('Atlas image dimensions exceed safe limits.', 422, 'provider_result_invalid', receipt.requestId);
    }
    // Unexpected-but-safe dimensions are still checkpointed; compile alone rejects an invalid grid.
    // Native provider bytes are returned intact; cleanup is a separate, inference-free endpoint.
    return { status: 'completed', receipt, rawBase64: bytes.toString('base64'), sha256: sha256(bytes), width, height, mimeType: 'image/png' };
  } catch (error) {
    if (error instanceof TemplateAtlasRequestError) throw error;
    throw new TemplateAtlasRequestError('Atlas collection is temporarily unavailable. Recover this receipt using GET only.', 503, 'provider_collection_failed', receipt.requestId);
  }
}

export async function generateTemplateAtlas(
  input: unknown,
  dependencies: TemplateAtlasProviderDependencies = defaults,
): Promise<GenerateTemplateAtlasResult> {
  const body = validateGenerateTemplateAtlasRequest(input);
  let plan: TemplateAtlasPlan;
  try { plan = await dependencies.resolvePlan(body.rendererVersion, body.planId, body.animationNames); }
  catch { invalid('Template Atlas plan is not present in the trusted renderer manifest'); }
  return body.operation === 'submit' ? submit(body, plan, dependencies) : collect(body, plan, dependencies);
}
