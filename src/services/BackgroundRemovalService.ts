import { freepikRemoveBackground, resizeImageForApi, urlToBase64 } from './FreepikApi';
import { ApiSessionChangedError, apiFetch, type ApiRequestContext } from './ApiClient';
import { debugInfo, debugWarn } from './DebugLog';

const FAL_BASE = '/proxy/fal';
const FAL_BG_MODEL_ID = 'fal-ai/birefnet';

export type BgRemovalProvider = 'fal' | 'freepik' | 'none';

interface FalCreateResponse {
  request_id?: string;
}

interface FalStatusResponse {
  status?: string;
}

function normalizeConfiguredProvider(value: string | undefined | null): BgRemovalProvider {
  const normalized = (value ?? '').trim().toLowerCase();
  switch (normalized) {
    case 'freepik':
      return 'freepik';
    case 'none':
      return 'none';
    case 'fal':
    default:
      return 'fal';
  }
}

function getConfiguredProvider(): BgRemovalProvider {
  const metaEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  return normalizeConfiguredProvider(metaEnv?.VITE_BG_REMOVAL_PROVIDER);
}

async function uploadTempImage(base64: string, context?: ApiRequestContext): Promise<string> {
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

function isSuccessStatus(status: string): boolean {
  const normalized = status.trim().toUpperCase();
  return ['COMPLETED', 'SUCCESS', 'SUCCEEDED', 'DONE', 'FINISHED', 'READY'].includes(normalized);
}

function isFailureStatus(status: string): boolean {
  const normalized = status.trim().toUpperCase();
  return ['FAILED', 'ERROR', 'CANCELLED', 'CANCELED', 'REJECTED', 'EXPIRED'].includes(normalized);
}

function findHttpUrl(value: unknown, depth = 0): string | null {
  if (depth > 6 || value == null) return null;
  if (typeof value === 'string') {
    return /^https?:\/\//i.test(value) ? value : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findHttpUrl(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['url', 'image', 'output', 'result', 'mask', 'foreground']) {
      if (key in record) {
        const found = findHttpUrl(record[key], depth + 1);
        if (found) return found;
      }
    }
    for (const nested of Object.values(record)) {
      const found = findHttpUrl(nested, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

async function createFalBgRemovalTask(imageUrl: string, context?: ApiRequestContext): Promise<string> {
  const res = await apiFetch(`${FAL_BASE}/${FAL_BG_MODEL_ID}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_url: imageUrl }),
  }, context);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`fal bg-remove create failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const json = await res.json() as FalCreateResponse;
  if (!json.request_id) throw new Error('fal bg-remove create returned no request_id');
  return json.request_id;
}

async function pollFalBgRemovalTask(taskId: string, context?: ApiRequestContext): Promise<string> {
  const start = Date.now();
  const maxWaitMs = 180_000;
  const pollInterval = 2500;
  let lastStatus = 'UNKNOWN';

  while (Date.now() - start < maxWaitMs) {
    const statusRes = await apiFetch(`${FAL_BASE}/${FAL_BG_MODEL_ID}/requests/${taskId}/status`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    }, context);

    if (!statusRes.ok) {
      const body = await statusRes.text();
      throw new Error(`fal bg-remove status failed (${statusRes.status}): ${body.slice(0, 200)}`);
    }

    const statusJson = await statusRes.json() as FalStatusResponse;
    const status = statusJson.status ?? 'UNKNOWN';
    lastStatus = status;

    if (isFailureStatus(status)) {
      throw new Error(`fal bg-remove task failed with status ${status}`);
    }

    if (isSuccessStatus(status)) {
      const resultRes = await apiFetch(`${FAL_BASE}/${FAL_BG_MODEL_ID}/requests/${taskId}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }, context);
      if (!resultRes.ok) {
        const body = await resultRes.text();
        throw new Error(`fal bg-remove result fetch failed (${resultRes.status}): ${body.slice(0, 200)}`);
      }

      const resultJson = await resultRes.json();
      const url = findHttpUrl(resultJson);
      if (!url) throw new Error('fal bg-remove completed but returned no image URL');
      return url;
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(`fal bg-remove timed out after ${Math.round(maxWaitMs / 1000)}s (last status: ${lastStatus})`);
}

async function falRemoveBackground(imageBase64: string, context?: ApiRequestContext): Promise<string> {
  const resized = await resizeImageForApi(imageBase64);
  const publicUrl = await uploadTempImage(resized, context);

  debugInfo('[BackgroundRemoval] Removing background via fal/BiRefNet...');
  const taskId = await createFalBgRemovalTask(publicUrl, context);
  const resultUrl = await pollFalBgRemovalTask(taskId, context);
  return urlToBase64(resultUrl, context);
}

export async function removeBackgroundWithConfiguredProvider(
  imageBase64: string,
  context?: ApiRequestContext,
): Promise<string | null> {
  const provider = getConfiguredProvider();

  if (provider === 'none') {
    debugInfo('[BackgroundRemoval] Provider disabled');
    return null;
  }

  if (provider === 'freepik') {
    debugInfo('[BackgroundRemoval] Using Freepik provider');
    return freepikRemoveBackground(imageBase64, context);
  }

  debugInfo('[BackgroundRemoval] Using fal provider');
  try {
    return await falRemoveBackground(imageBase64, context);
  } catch (error) {
    if (error instanceof ApiSessionChangedError) throw error;
    const falMessage = error instanceof Error ? error.message : String(error);
    debugWarn(`[BackgroundRemoval] fal failed (${falMessage}); retrying with Freepik DNN`);
    try {
      return await freepikRemoveBackground(imageBase64, context);
    } catch (fallbackError) {
      if (fallbackError instanceof ApiSessionChangedError) throw fallbackError;
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(`fal failed (${falMessage}); Freepik fallback failed (${fallbackMessage})`);
    }
  }
}

export function getConfiguredBgRemovalProvider(): BgRemovalProvider {
  return getConfiguredProvider();
}
