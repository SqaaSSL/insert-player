import {
  getCachedIntro,
  getCachedMeta,
  setCachedIntro,
  type CachedIntro,
} from './SpriteCache.ts';
import {
  apiFetch,
  captureApiRequestContext,
  runWithProviderSession,
  type ApiRequestContext,
} from './ApiClient';
import { authorizeProviderSession } from './Billing.ts';
import { debugInfo } from './DebugLog';

export type IntroVideoModel =
  | 'freepik-auto'
  | 'kling-v2-1-std'
  | 'veo-3-1'
  | 'runway-gen4-turbo'
  | 'fal-ltx-v2-3-fast'
  | 'fal-kling-v2-6-pro';

export type IntroVideoStatus =
  | { stage: 'preparing' }
  | { stage: 'uploading_inputs'; count: number }
  | { stage: 'creating_task'; model: IntroVideoModel }
  | { stage: 'polling'; model: IntroVideoModel; status: string }
  | { stage: 'fetching_result'; model: IntroVideoModel }
  | { stage: 'done'; model: IntroVideoModel }
  | { stage: 'cached'; model: IntroVideoModel }
  | { stage: 'error'; message: string };

type StatusCallback = (status: IntroVideoStatus) => void;

interface FreepikTaskResponse {
  data?: {
    task_id?: string;
    status?: string;
    generated?: unknown[];
  };
}

interface RunwayCreateResponse {
  id?: string;
}

interface RunwayTaskResponse {
  id?: string;
  status?: string;
  output?: unknown[];
  failure?: string | { message?: string; code?: string };
}

interface FalCreateResponse {
  request_id?: string;
  status_url?: string;
  response_url?: string;
}

interface FalStatusResponse {
  status?: string;
  response_url?: string;
}

interface FalResultResponse {
  video?: { url?: string };
  data?: {
    video?: { url?: string };
  };
}

const FREEPIK_BASE = '/proxy/freepik';
const RUNWAY_BASE = '/proxy/runway';
const FAL_BASE = '/proxy/fal';
const FREEPIK_KLING_DURATION = 5;
const FREEPIK_VEO_DURATION = 8;
const RUNWAY_DURATION = 5;
const FAL_LTX_DURATION = 6;
const FAL_LTX_MODEL_ID = 'fal-ai/ltx-2.3/image-to-video/fast';
const DEFAULT_NEGATIVE_PROMPT =
  'hard cuts, multiple shots, scene changes, extra characters, other people, background people, crowd, duplicate person, cropped body, sitting, lying down, deformed anatomy, duplicate limbs, unreadable face, face swap, identity drift, hairstyle changes, outfit changes, pan-only motion, zoom-only motion, ambient noise, random chatter, comedic sound, whimsical music, weak audio, text overlays, watermark, logo';

export function proxifyFalUrl(url: string): string {
  if (url === FAL_BASE || url.startsWith(`${FAL_BASE}/`)) return url;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  if (parsed.protocol === 'https:' && parsed.hostname === 'queue.fal.run' && parsed.port === '') {
    return `${FAL_BASE}${parsed.pathname}${parsed.search}`;
  }

  return url;
}

function normalizeConfiguredProvider(value: string | undefined | null): IntroVideoModel | null {
  const normalized = (value ?? '').trim().toLowerCase();
  switch (normalized) {
    case 'runway':
    case 'runway-gen4':
    case 'runway-gen4-turbo':
      return 'runway-gen4-turbo';
    case 'fal':
    case 'fal-ltx':
    case 'fal-ltx-v2-3-fast':
      return 'fal-ltx-v2-3-fast';
    case 'fal-kling':
    case 'fal-kling-v2-6-pro':
      return 'fal-ltx-v2-3-fast';
    case 'freepik':
    case 'freepik-auto':
      return 'freepik-auto';
    case 'kling':
    case 'kling-v2-1-std':
      return 'kling-v2-1-std';
    case 'veo':
    case 'veo-3-1':
      return 'veo-3-1';
    default:
      return null;
  }
}

function emit(onStatus: StatusCallback | undefined, status: IntroVideoStatus): void {
  onStatus?.(status);
}

async function uploadTempImage(base64: string, context: ApiRequestContext): Promise<string> {
  const res = await apiFetch('/proxy/upload-temp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: base64 }),
  }, context);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Temp upload failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const json = await res.json();
  if (!json?.url) throw new Error('Temp upload returned no public URL');
  return json.url as string;
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      resolve(dataUrl.split(',')[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load intro reference image'));
    };
    img.src = url;
  });
}

async function prepareIntroReferenceForUpload(
  blob: Blob,
  label: string,
  options?: {
    minSize?: number;
    framingScale?: number;
  },
): Promise<{ base64: string; width: number; height: number }> {
  const img = await blobToImage(blob);
  const minSize = Math.max(1, options?.minSize ?? 320);
  const framingScale = Math.min(1, Math.max(0.5, options?.framingScale ?? 1));
  const width = img.width;
  const height = img.height;
  const minScale = Math.max(minSize / width, minSize / height, 1);

  if (minScale === 1 && framingScale === 1) {
    debugInfo(`[IntroVideo] ${label}: ${width}x${height} (unchanged)`);
    return { base64: await blobToBase64(blob), width, height };
  }

  const canvasWidth = Math.round(width * minScale);
  const canvasHeight = Math.round(height * minScale);
  const drawWidth = Math.round(width * minScale * framingScale);
  const drawHeight = Math.round(height * minScale * framingScale);
  const offsetX = Math.round((canvasWidth - drawWidth) / 2);
  const offsetY = Math.round((canvasHeight - drawHeight) / 2);
  const canvas = document.createElement('canvas');
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, offsetX, offsetY, drawWidth, drawHeight);
  const base64 = canvas.toDataURL('image/png').split(',')[1];
  debugInfo(
    `[IntroVideo] ${label}: ${img.width}x${img.height} -> ${canvasWidth}x${canvasHeight}` +
      ` (framingScale ${framingScale.toFixed(2)}, draw ${drawWidth}x${drawHeight})`,
  );
  return { base64, width: canvasWidth, height: canvasHeight };
}

async function prepareOriginalPhotoForUpload(
  blob: Blob,
  label: string,
  minSize = 320,
): Promise<{ base64: string; width: number; height: number }> {
  const img = await blobToImage(blob);
  const width = img.width;
  const height = img.height;
  const minScale = Math.max(minSize / width, minSize / height, 1);
  const scaledWidth = Math.round(width * minScale);
  const scaledHeight = Math.round(height * minScale);
  const targetAspect = 16 / 9;
  const scaledAspect = scaledWidth / Math.max(1, scaledHeight);
  let canvasWidth = scaledWidth;
  let canvasHeight = scaledHeight;

  if (Math.abs(scaledAspect - targetAspect) > 0.01) {
    if (scaledAspect < targetAspect) {
      canvasWidth = Math.round(scaledHeight * targetAspect);
    } else {
      canvasHeight = Math.round(scaledWidth / targetAspect);
    }
  }

  if (canvasWidth === width && canvasHeight === height) {
    debugInfo(`[IntroVideo] ${label}: ${width}x${height} (original composition preserved)`);
    return { base64: await blobToBase64(blob), width, height };
  }

  const canvas = document.createElement('canvas');
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // Build a 16:9 staging frame without cropping the source photo.
  ctx.fillStyle = '#0b1020';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  ctx.save();
  ctx.filter = 'blur(36px) brightness(0.65)';
  const bgScale = Math.max(canvasWidth / width, canvasHeight / height);
  const bgWidth = Math.round(width * bgScale);
  const bgHeight = Math.round(height * bgScale);
  const bgX = Math.round((canvasWidth - bgWidth) / 2);
  const bgY = Math.round((canvasHeight - bgHeight) / 2);
  ctx.drawImage(img, bgX, bgY, bgWidth, bgHeight);
  ctx.restore();

  const drawX = Math.round((canvasWidth - scaledWidth) / 2);
  const drawY = Math.round((canvasHeight - scaledHeight) / 2);
  ctx.drawImage(img, drawX, drawY, scaledWidth, scaledHeight);

  const base64 = canvas.toDataURL('image/png').split(',')[1];
  debugInfo(
    `[IntroVideo] ${label}: ${width}x${height} -> ${canvasWidth}x${canvasHeight}` +
      ' (original composition preserved on 16:9 canvas)',
  );
  return { base64, width: canvasWidth, height: canvasHeight };
}

async function fetchUrlAsBlob(url: string, context: ApiRequestContext): Promise<Blob> {
  const res = await apiFetch(`/proxy/media?url=${encodeURIComponent(url)}`, {}, context);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to fetch generated video (${res.status}): ${body.slice(0, 200)}`);
  }
  return res.blob();
}

function getBaseImageBlob(meta: Awaited<ReturnType<typeof getCachedMeta>>): Blob | null {
  if (!meta) return null;
  return (
    meta.sideViewBlob ??
    meta.uprightViewBlob ??
    meta.originalPhotoBlob ??
    null
  );
}

function getOriginalBlob(meta: Awaited<ReturnType<typeof getCachedMeta>>): Blob | null {
  if (!meta) return null;
  return meta.originalPhotoBlob ?? null;
}

function buildIntroPrompt(
  extraPrompt: string | null | undefined,
): string {
  const userPrompt = (extraPrompt || '').trim();
  const basePrompt = [
    `This character prepares for an epic battle in a high-energy arcade fighting-game intro.`,
    `Keep only the main fighter and remove any extra people from the source photo.`,
    `Transform the original environment into a dramatic stylized fighting-game intro stage with bold arena presentation energy, cinematic contrast, smoky atmosphere, and strong colored backlight.`,
    `Use confident pre-fight body performance, not just camera movement, and end in a strong ready-to-fight presentation pose.`,
    `If audio is generated, make it a short punchy battle-intro music and impact sound design bed, not ambient or random audio.`,
  ].join(' ');

  if (!userPrompt) return basePrompt;
  return `${basePrompt}\n${userPrompt}`;
}

function chooseModel(meta: Awaited<ReturnType<typeof getCachedMeta>>): IntroVideoModel {
  const envProvider = normalizeConfiguredProvider(import.meta.env.VITE_INTRO_VIDEO_PROVIDER);
  if (envProvider) return envProvider;
  if (meta?.introVideoModel === 'runway-gen4-turbo') return 'runway-gen4-turbo';
  if (meta?.introVideoModel === 'fal-ltx-v2-3-fast' || meta?.introVideoModel === 'fal-kling-v2-6-pro') {
    return 'fal-ltx-v2-3-fast';
  }
  if (meta?.introVideoModel === 'kling-v2-1-std') return 'kling-v2-1-std';
  if (meta?.introVideoModel === 'veo-3-1') return 'veo-3-1';
  if (meta?.introVideoModel === 'freepik-auto') return 'freepik-auto';
  return 'fal-ltx-v2-3-fast';
}

function chooseFreepikSubmodel(meta: Awaited<ReturnType<typeof getCachedMeta>>): 'kling-v2-1-std' | 'veo-3-1' {
  const extraRefs = meta?.introVideoReferenceBlobs ?? [];
  if (extraRefs.length > 0) return 'veo-3-1';
  return 'kling-v2-1-std';
}

function extractGeneratedUrl(json: FreepikTaskResponse): string | null {
  const generated = json.data?.generated;
  if (!generated?.length) return null;
  const first = generated[0];
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object') {
    const anyFirst = first as Record<string, unknown>;
    const nestedUrl = anyFirst.url;
    if (typeof nestedUrl === 'string') return nestedUrl;
    const video = anyFirst.video;
    if (video && typeof video === 'object' && typeof (video as Record<string, unknown>).url === 'string') {
      return (video as Record<string, unknown>).url as string;
    }
  }
  return null;
}

function extractRunwayOutputUrl(json: RunwayTaskResponse): string | null {
  const output = json.output;
  if (!output?.length) return null;
  const first = output[0];
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object') {
    const anyFirst = first as Record<string, unknown>;
    if (typeof anyFirst.url === 'string') return anyFirst.url;
  }
  return null;
}

function extractFalOutputUrl(json: FalResultResponse): string | null {
  return json.video?.url ?? json.data?.video?.url ?? null;
}

function isSuccessStatus(status: string): boolean {
  const normalized = status.trim().toUpperCase();
  return ['COMPLETED', 'SUCCESS', 'SUCCEEDED', 'DONE', 'FINISHED', 'READY'].includes(normalized);
}

function isFailureStatus(status: string): boolean {
  const normalized = status.trim().toUpperCase();
  return ['FAILED', 'ERROR', 'CANCELLED', 'CANCELED', 'REJECTED', 'EXPIRED'].includes(normalized);
}

async function createKlingIntroTask(
  imageUrl: string,
  prompt: string,
  context: ApiRequestContext,
): Promise<string> {
  const res = await apiFetch(`${FREEPIK_BASE}/v1/ai/image-to-video/kling-v2-1-std`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image: imageUrl,
      prompt,
      negative_prompt: DEFAULT_NEGATIVE_PROMPT,
      duration: FREEPIK_KLING_DURATION,
      aspect_ratio: '16:9',
    }),
  }, context);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Kling intro create failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const json = await res.json() as FreepikTaskResponse;
  const taskId = json.data?.task_id;
  if (!taskId) throw new Error('Kling intro create returned no task_id');
  return taskId;
}

async function createVeoIntroTask(
  imageUrls: string[],
  prompt: string,
  context: ApiRequestContext,
): Promise<string> {
  const res = await apiFetch(`${FREEPIK_BASE}/v1/ai/reference-to-video/veo-3-1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image_urls: imageUrls,
      prompt,
      negative_prompt: DEFAULT_NEGATIVE_PROMPT,
      duration: FREEPIK_VEO_DURATION,
      resolution: '720p',
      aspect_ratio: '16:9',
      generate_audio: false,
    }),
  }, context);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Veo intro create failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const json = await res.json() as FreepikTaskResponse;
  const taskId = json.data?.task_id;
  if (!taskId) throw new Error('Veo intro create returned no task_id');
  return taskId;
}

async function createRunwayIntroTask(
  promptImageUrl: string,
  prompt: string,
  context: ApiRequestContext,
): Promise<string> {
  const res = await apiFetch(`${RUNWAY_BASE}/v1/image_to_video`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gen4_turbo',
      promptText: prompt,
      promptImage: promptImageUrl,
      ratio: '1280:720',
      duration: RUNWAY_DURATION,
    }),
  }, context);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Runway intro create failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const json = await res.json() as RunwayCreateResponse;
  if (!json.id) throw new Error('Runway intro create returned no task id');
  return json.id;
}

async function createFalLtxIntroTask(
  imageUrl: string,
  prompt: string,
  context: ApiRequestContext,
): Promise<{ requestId: string; statusUrl?: string; responseUrl?: string }> {
  const res = await apiFetch(`${FAL_BASE}/${FAL_LTX_MODEL_ID}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image_url: imageUrl,
      prompt,
      duration: FAL_LTX_DURATION,
      resolution: '1080p',
      aspect_ratio: '16:9',
      fps: 25,
      generate_audio: true,
      negative_prompt: DEFAULT_NEGATIVE_PROMPT,
    }),
  }, context);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`fal intro create failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const json = await res.json() as FalCreateResponse;
  if (!json.request_id) throw new Error('fal intro create returned no request_id');
  return {
    requestId: json.request_id,
    statusUrl: json.status_url,
    responseUrl: json.response_url,
  };
}

async function pollFreepikTask(
  model: 'kling-v2-1-std' | 'veo-3-1',
  taskId: string,
  onStatus: StatusCallback | undefined,
  context: ApiRequestContext,
): Promise<string> {
  const start = Date.now();
  const maxWaitMs = model === 'veo-3-1' ? 600_000 : 240_000;
  const pollInterval = 4000;
  const statusPath =
    model === 'veo-3-1'
      ? `${FREEPIK_BASE}/v1/ai/reference-to-video/veo-3-1/${taskId}`
      : `${FREEPIK_BASE}/v1/ai/image-to-video/kling-v2-1/${taskId}`;
  let lastStatus = 'UNKNOWN';

  while (Date.now() - start < maxWaitMs) {
    const res = await apiFetch(
      statusPath,
      { method: 'GET', headers: { 'Content-Type': 'application/json' } },
      context,
    );

    if (!res.ok) {
      const body = await res.text();
      emit(onStatus, { stage: 'polling', model, status: `HTTP ${res.status}: ${body.slice(0, 80)}` });
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
      continue;
    }

    const json = await res.json() as FreepikTaskResponse;
    const status = json.data?.status ?? 'UNKNOWN';
    lastStatus = status;
    emit(onStatus, { stage: 'polling', model, status });

    const url = extractGeneratedUrl(json);
    if (url) return url;
    if (isSuccessStatus(status)) throw new Error(`${model} reported ${status} but returned no video URL`);
    if (isFailureStatus(status)) throw new Error(`${model} video task failed with status ${status}`);
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(`${model} video task timed out after ${Math.round(maxWaitMs / 1000)}s (last status: ${lastStatus})`);
}

async function pollRunwayTask(
  taskId: string,
  onStatus: StatusCallback | undefined,
  context: ApiRequestContext,
): Promise<string> {
  const start = Date.now();
  const maxWaitMs = 600_000;
  const pollInterval = 5000;
  let lastStatus = 'UNKNOWN';

  while (Date.now() - start < maxWaitMs) {
    const res = await apiFetch(`${RUNWAY_BASE}/v1/tasks/${taskId}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    }, context);

    if (!res.ok) {
      const body = await res.text();
      emit(onStatus, { stage: 'polling', model: 'runway-gen4-turbo', status: `HTTP ${res.status}: ${body.slice(0, 80)}` });
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
      continue;
    }

    const json = await res.json() as RunwayTaskResponse;
    const status = json.status ?? 'UNKNOWN';
    lastStatus = status;
    emit(onStatus, { stage: 'polling', model: 'runway-gen4-turbo', status });

    const url = extractRunwayOutputUrl(json);
    if (url) return url;

    if (isSuccessStatus(status)) {
      throw new Error(`runway-gen4-turbo reported ${status} but returned no video URL`);
    }
    if (isFailureStatus(status)) {
      const failureMessage =
        typeof json.failure === 'string'
          ? json.failure
          : json.failure?.message ?? json.failure?.code ?? status;
      throw new Error(`runway-gen4-turbo task failed: ${failureMessage}`);
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(`runway-gen4-turbo timed out after ${Math.round(maxWaitMs / 1000)}s (last status: ${lastStatus})`);
}

async function pollFalTask(
  modelId: string,
  modelLabel: IntroVideoModel,
  task: { requestId: string; statusUrl?: string; responseUrl?: string },
  onStatus: StatusCallback | undefined,
  context: ApiRequestContext,
): Promise<string> {
  const start = Date.now();
  const maxWaitMs = 600_000;
  const pollInterval = 5000;
  let lastStatus = 'UNKNOWN';
  const defaultStatusUrl = `${FAL_BASE}/${modelId}/requests/${task.requestId}/status`;
  const defaultResponseUrl = `${FAL_BASE}/${modelId}/requests/${task.requestId}`;
  let responseUrl = task.responseUrl ? proxifyFalUrl(task.responseUrl) : defaultResponseUrl;

  while (Date.now() - start < maxWaitMs) {
    const statusRes = await apiFetch(task.statusUrl ? proxifyFalUrl(task.statusUrl) : defaultStatusUrl, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    }, context);

    if (!statusRes.ok) {
      if (statusRes.status === 405) {
        const resultRes = await apiFetch(responseUrl, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        }, context);
        if (resultRes.ok) {
          const resultJson = await resultRes.json() as Record<string, unknown>;
          const completedStatus = typeof resultJson.status === 'string' ? resultJson.status : 'COMPLETED';
          emit(onStatus, { stage: 'polling', model: modelLabel, status: completedStatus });
          if (isFailureStatus(completedStatus)) {
            throw new Error(`${modelLabel} task failed with status ${completedStatus}`);
          }
          if (isSuccessStatus(completedStatus)) {
            const url = extractFalOutputUrl(resultJson as FalResultResponse);
            if (url) return url;
          }
        }
      }

      const body = await statusRes.text();
      emit(onStatus, { stage: 'polling', model: modelLabel, status: `HTTP ${statusRes.status}: ${body.slice(0, 80)}` });
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
      continue;
    }

    const statusJson = await statusRes.json() as FalStatusResponse;
    const status = statusJson.status ?? 'UNKNOWN';
    lastStatus = status;
    if (statusJson.response_url) responseUrl = proxifyFalUrl(statusJson.response_url);
    emit(onStatus, { stage: 'polling', model: modelLabel, status });

    if (isFailureStatus(status)) {
      throw new Error(`${modelLabel} task failed with status ${status}`);
    }

    if (status.toUpperCase() === 'COMPLETED') {
      const resultRes = await apiFetch(responseUrl, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }, context);
      if (!resultRes.ok) {
        const body = await resultRes.text();
        throw new Error(`${modelLabel} result fetch failed (${resultRes.status}): ${body.slice(0, 200)}`);
      }
      const resultJson = await resultRes.json() as FalResultResponse;
      const url = extractFalOutputUrl(resultJson);
      if (!url) throw new Error(`${modelLabel} completed but returned no video URL`);
      return url;
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(`${modelLabel} timed out after ${Math.round(maxWaitMs / 1000)}s (last status: ${lastStatus})`);
}

export async function generateCharacterIntroVideo(
  photoHash: string,
  onStatus?: StatusCallback,
): Promise<CachedIntro> {
  const apiContext = captureApiRequestContext();
  emit(onStatus, { stage: 'preparing' });
  const meta = await getCachedMeta(photoHash);
  if (!meta) throw new Error('Character not found in cache');

  const configuredModel = chooseModel(meta);
  const effectiveModel =
    configuredModel === 'freepik-auto'
      ? chooseFreepikSubmodel(meta)
      : configuredModel;
  const existing = await getCachedIntro(photoHash, meta.ownerScope);

  const originalBlob = getOriginalBlob(meta);
  const extraRefs = (meta.introVideoReferenceBlobs ?? []).filter(Boolean).slice(0, 2);
  const freepikRefs = (originalBlob ? [originalBlob, ...extraRefs] : extraRefs).slice(0, 3);

  if (
    existing &&
    existing.variants.length > 0 &&
    existing.variants.every((variant) => (variant.prompt ?? '') === (meta.introVideoPrompt ?? ''))
  ) {
    emit(onStatus, { stage: 'cached', model: effectiveModel });
    return existing;
  }

  const baseImageBlob = getBaseImageBlob(meta);
  if (!baseImageBlob) {
    throw new Error('This character needs at least one reference image before generating intro video');
  }

  const providerSession = await authorizeProviderSession('intro_video', apiContext);
  if (providerSession.error) throw new Error(providerSession.error);

  return runWithProviderSession(
    providerSession.providerSessionId,
    (providerContext) => generateCharacterIntroVideoWithSession(
      meta,
      effectiveModel,
      baseImageBlob,
      originalBlob,
      freepikRefs,
      onStatus,
      providerContext,
    ),
    apiContext,
  );
}

async function generateCharacterIntroVideoWithSession(
  meta: NonNullable<Awaited<ReturnType<typeof getCachedMeta>>>,
  effectiveModel: IntroVideoModel,
  baseImageBlob: Blob,
  originalBlob: Blob | null,
  freepikRefs: Blob[],
  onStatus: StatusCallback | undefined,
  context: ApiRequestContext,
): Promise<CachedIntro> {
  const photoHash = meta.photoHash;
  const prompt = buildIntroPrompt(meta.introVideoPrompt);

  let intro: CachedIntro;

  if (effectiveModel === 'kling-v2-1-std') {
    emit(onStatus, { stage: 'uploading_inputs', count: 1 });
    const prepared = await prepareIntroReferenceForUpload(baseImageBlob, 'base_image');
    const imageUrl = await uploadTempImage(prepared.base64, context);
    emit(onStatus, { stage: 'creating_task', model: effectiveModel });
    const taskId = await createKlingIntroTask(imageUrl, prompt, context);
    const generatedUrl = await pollFreepikTask(effectiveModel, taskId, onStatus, context);
    emit(onStatus, { stage: 'fetching_result', model: effectiveModel });
    const videoBlob = await fetchUrlAsBlob(generatedUrl, context);
    intro = {
      photoHash,
      activeVariantId: 'single',
      variants: [{
        id: 'single',
        label: 'VIDEO',
        videoBlob,
        mimeType: videoBlob.type || 'video/mp4',
        createdAt: Date.now(),
        model: effectiveModel,
        prompt: meta.introVideoPrompt ?? null,
        referenceCount: 1,
      }],
    };
    emit(onStatus, { stage: 'done', model: effectiveModel });
  } else if (effectiveModel === 'veo-3-1') {
    const refs = freepikRefs.length > 0 ? freepikRefs : [baseImageBlob];
    emit(onStatus, { stage: 'uploading_inputs', count: refs.length });
    const imageUrls: string[] = [];
    for (let i = 0; i < refs.length; i++) {
      const prepared = await prepareIntroReferenceForUpload(
        refs[i],
        `freepik_ref_${i + 1}`,
        i > 0 ? { framingScale: 0.9 } : undefined,
      );
      imageUrls.push(await uploadTempImage(prepared.base64, context));
    }
    emit(onStatus, { stage: 'creating_task', model: effectiveModel });
    const taskId = await createVeoIntroTask(imageUrls, prompt, context);
    const generatedUrl = await pollFreepikTask(effectiveModel, taskId, onStatus, context);
    emit(onStatus, { stage: 'fetching_result', model: effectiveModel });
    const videoBlob = await fetchUrlAsBlob(generatedUrl, context);
    intro = {
      photoHash,
      activeVariantId: 'single',
      variants: [{
        id: 'single',
        label: 'VIDEO',
        videoBlob,
        mimeType: videoBlob.type || 'video/mp4',
        createdAt: Date.now(),
        model: effectiveModel,
        prompt: meta.introVideoPrompt ?? null,
        referenceCount: refs.length,
      }],
    };
    emit(onStatus, { stage: 'done', model: effectiveModel });
  } else if (effectiveModel === 'runway-gen4-turbo') {
    const runwayBlob = originalBlob ?? baseImageBlob;
    emit(onStatus, { stage: 'uploading_inputs', count: 1 });
    const prepared = await prepareIntroReferenceForUpload(runwayBlob, 'runway_prompt_image', {
      framingScale: 0.88,
    });
    const promptImageUrl = await uploadTempImage(prepared.base64, context);
    emit(onStatus, { stage: 'creating_task', model: effectiveModel });
    const taskId = await createRunwayIntroTask(promptImageUrl, prompt, context);
    const generatedUrl = await pollRunwayTask(taskId, onStatus, context);
    emit(onStatus, { stage: 'fetching_result', model: effectiveModel });
    const videoBlob = await fetchUrlAsBlob(generatedUrl, context);
    intro = {
      photoHash,
      activeVariantId: 'single',
      variants: [{
        id: 'single',
        label: 'VIDEO',
        videoBlob,
        mimeType: videoBlob.type || 'video/mp4',
        createdAt: Date.now(),
        model: effectiveModel,
        prompt: meta.introVideoPrompt ?? null,
        referenceCount: 1,
      }],
    };
    emit(onStatus, { stage: 'done', model: effectiveModel });
  } else {
    const startBlob = originalBlob ?? baseImageBlob;
    emit(onStatus, { stage: 'uploading_inputs', count: 1 });
    const startPrepared =
      originalBlob && startBlob === originalBlob
        ? await prepareOriginalPhotoForUpload(startBlob, 'fal_start_original')
        : await prepareIntroReferenceForUpload(startBlob, 'fal_start_fallback');
    const startUrl = await uploadTempImage(startPrepared.base64, context);
    emit(onStatus, { stage: 'creating_task', model: 'fal-ltx-v2-3-fast' });
    const task = await createFalLtxIntroTask(startUrl, prompt, context);
    const generatedUrl = await pollFalTask(FAL_LTX_MODEL_ID, 'fal-ltx-v2-3-fast', task, onStatus, context);
    emit(onStatus, { stage: 'fetching_result', model: 'fal-ltx-v2-3-fast' });
    const videoBlob = await fetchUrlAsBlob(generatedUrl, context);
    intro = {
      photoHash,
      activeVariantId: 'single',
      variants: [{
        id: 'single',
        label: 'VIDEO',
        videoBlob,
        mimeType: videoBlob.type || 'video/mp4',
        createdAt: Date.now(),
        model: 'fal-ltx-v2-3-fast',
        prompt: meta.introVideoPrompt ?? null,
        referenceCount: 1,
      }],
    };
    emit(onStatus, { stage: 'done', model: 'fal-ltx-v2-3-fast' });
  }
  intro.ownerScope = meta.ownerScope;
  await setCachedIntro(intro);
  return intro;
}
