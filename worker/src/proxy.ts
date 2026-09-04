import type { Env, PublicAuthContext } from './types';
import { enforceRateLimit } from './rateLimit';
import { generateId, hashString } from './auth';
import { generationJobIdFromAuth } from './generationAuth';
import {
  createProviderRequestState,
  finalizeProviderRequest,
  requireProviderResultSession,
  requireProviderSession,
  requireUnmeteredProviderSession,
} from './providerSessions';
import {
  createBoundedRequestStream,
  InvalidJsonBodyError,
  readJsonBody,
  RequestBodyTooLargeError,
} from './requestBody';
import { createBoundedByteStream, ResponseBodyTooLargeError } from './streamLimits';
import {
  PROVIDER_REQUEST_BODY_LIMITS,
  PROVIDER_RESPONSE_BODY_LIMITS,
  type ProviderName,
} from './providerLimits';
import {
  geminiTransportStatus,
  meterkeyBaseUrl,
} from './geminiTransport';

export { ResponseBodyTooLargeError } from './streamLimits';

const TEMP_ASSET_TTL_SECONDS = 24 * 60 * 60;
const TEMP_ASSET_PATH_PREFIX = '/temp-assets/';
const MAX_TEMP_ASSET_BYTES = 12 * 1024 * 1024;
const MAX_BASE64_TEMP_ASSET_CHARS = Math.ceil(MAX_TEMP_ASSET_BYTES * 4 / 3) + 128;
const MAX_TEMP_UPLOAD_JSON_BYTES = MAX_BASE64_TEMP_ASSET_CHARS + 4096;
const MAX_PROXIED_IMAGE_BYTES = 24 * 1024 * 1024;
const MAX_PROXIED_MEDIA_BYTES = 64 * 1024 * 1024;
const MAX_RESULT_REDIRECTS = 3;
const PROVIDER_FETCH_TIMEOUT_MS = 60_000;
const RESULT_FETCH_TIMEOUT_MS = 45_000;
const MAX_PIXCLI_VIDEO_SUBMISSION_BYTES = 32 * 1024;
const PIXCLI_VIDEO_MODEL = 'grok-imagine-i2v-pinned';
interface ImageFormat {
  ext: 'gif' | 'jpg' | 'png' | 'webp';
  contentType: string;
}

type ProxyProvider = ProviderName;

interface ProviderRouteRule {
  method: string;
  pattern: RegExp;
}

interface FetchedPublicResult {
  response: Response;
  finalUrl: URL;
}

const PROVIDER_ROUTE_ALLOWLIST: Record<ProxyProvider, ProviderRouteRule[]> = {
  gemini: [
    { method: 'POST', pattern: /^\/v1beta\/models\/[A-Za-z0-9._-]+:generateContent$/ },
  ],
  ludo: [
    { method: 'POST', pattern: /^\/assets\/sprite\/animate$/ },
    { method: 'POST', pattern: /^\/assets\/sprite\/pose$/ },
    { method: 'POST', pattern: /^\/assets\/image$/ },
    { method: 'GET', pattern: /^\/auth\/validate-api-key$/ },
    { method: 'GET', pattern: /^\/assets\/sprites\/results$/ },
    { method: 'GET', pattern: /^\/assets\/sprite\/animation-presets$/ },
  ],
  freepik: [
    { method: 'POST', pattern: /^\/v1\/ai\/text-to-image\/flux-kontext-pro$/ },
    { method: 'GET', pattern: /^\/v1\/ai\/text-to-image\/flux-kontext-pro\/[^/]+$/ },
    { method: 'POST', pattern: /^\/v1\/ai\/beta\/remove-background$/ },
    { method: 'POST', pattern: /^\/v1\/ai\/image-to-video\/kling-v2-1-std$/ },
    { method: 'GET', pattern: /^\/v1\/ai\/image-to-video\/kling-v2-1\/[^/]+$/ },
    { method: 'POST', pattern: /^\/v1\/ai\/reference-to-video\/veo-3-1$/ },
    { method: 'GET', pattern: /^\/v1\/ai\/reference-to-video\/veo-3-1\/[^/]+$/ },
  ],
  runway: [
    { method: 'POST', pattern: /^\/v1\/image_to_video$/ },
    { method: 'GET', pattern: /^\/v1\/tasks\/[^/]+$/ },
  ],
  fal: [
    { method: 'POST', pattern: /^\/fal-ai\/birefnet$/ },
    { method: 'GET', pattern: /^\/fal-ai\/birefnet\/requests\/[^/]+(?:\/status)?$/ },
    { method: 'POST', pattern: /^\/fal-ai\/ltx-2\.3\/image-to-video\/fast$/ },
    { method: 'GET', pattern: /^\/fal-ai\/ltx-2\.3\/image-to-video\/fast\/requests\/[^/]+(?:\/status)?$/ },
  ],
  pixcli: [
    { method: 'POST', pattern: /^\/api\/v1\/uploads$/ },
    { method: 'POST', pattern: /^\/api\/v1\/video\/advanced$/ },
    { method: 'GET', pattern: /^\/api\/v1\/jobs\/[a-f0-9]{32}$/ },
    { method: 'GET', pattern: /^\/api\/v1\/jobs\/[a-f0-9]{32}\/canva$/ },
    { method: 'GET', pattern: /^\/api\/v1\/assets\/[a-f0-9]{32}$/ },
  ],
};

function missingKey(name: string): Response {
  return Response.json({ error: `${name} is not configured` }, { status: 503 });
}

function enforceProviderRouteAllowlist(provider: ProxyProvider, path: string, method: string): Response | null {
  const relativePath = path.replace(new RegExp(`^/proxy/${provider}`), '') || '/';
  const rules = PROVIDER_ROUTE_ALLOWLIST[provider];
  if (rules.some((rule) => rule.method === method && rule.pattern.test(relativePath))) return null;

  const allowedMethods = rules
    .filter((rule) => rule.pattern.test(relativePath))
    .map((rule) => rule.method);
  if (allowedMethods.length > 0) {
    return Response.json(
      { error: 'Provider proxy method is not allowed' },
      { status: 405, headers: { Allow: [...new Set(allowedMethods)].join(', ') } },
    );
  }

  return Response.json({ error: 'Provider proxy route is not allowed' }, { status: 404 });
}

function requiresProviderSession(provider: ProxyProvider, _method: string): boolean {
  return (
    provider === 'gemini' ||
    provider === 'ludo' ||
    provider === 'freepik' ||
    provider === 'runway' ||
    provider === 'fal' ||
    provider === 'pixcli'
  );
}

export function pixcliBaseUrl(value: string | undefined): URL | null {
  const raw = value?.trim() || 'https://pixcli.hilo.cx';
  try {
    const parsed = new URL(raw);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) return null;
    parsed.pathname = '/';
    return parsed;
  } catch {
    return null;
  }
}

export function pixcliUpstreamHeaders(
  apiKey: string,
  path: string,
  dispatchKey: string | null,
): Record<string, string> | null {
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  if (path !== '/proxy/pixcli/api/v1/video/advanced') return headers;
  if (!dispatchKey || !/^ip:[a-f0-9]{32}$/.test(dispatchKey)) return null;
  headers['Idempotency-Key'] = dispatchKey;
  headers['X-Request-Id'] = dispatchKey;
  return headers;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

async function validatePixcliTransportRequest(request: Request, path: string): Promise<Response | null> {
  if (path === '/proxy/pixcli/api/v1/uploads') {
    if (!/^multipart\/form-data;\s*boundary=/i.test(request.headers.get('Content-Type') ?? '')) {
      return Response.json({ error: 'PixCLI uploads require multipart form data' }, { status: 415 });
    }
    return null;
  }
  if (path !== '/proxy/pixcli/api/v1/video/advanced') return null;

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody<Record<string, unknown>>(
      request.clone(),
      MAX_PIXCLI_VIDEO_SUBMISSION_BYTES,
    );
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return Response.json({ error: 'PixCLI video request is too large' }, { status: 413 });
    }
    if (error instanceof InvalidJsonBodyError) {
      return Response.json({ error: 'PixCLI video request must be valid JSON' }, { status: 400 });
    }
    throw error;
  }

  const params = body.params;
  const validParams = Boolean(
    params &&
    typeof params === 'object' &&
    !Array.isArray(params) &&
    exactKeys(params as Record<string, unknown>, ['duration', 'resolution']) &&
    (params as Record<string, unknown>).duration === 2 &&
    (params as Record<string, unknown>).resolution === '720p',
  );
  const valid = exactKeys(body, [
    'enrich_prompt',
    'image',
    'model',
    'output_format',
    'params',
    'prompt',
    'publish',
    'publish_name',
    'resolution',
  ]) &&
    body.model === PIXCLI_VIDEO_MODEL &&
    typeof body.image === 'string' && /^[a-f0-9]{32}$/.test(body.image) &&
    typeof body.prompt === 'string' && body.prompt.trim().length >= 32 && body.prompt.length <= 8_000 &&
    body.resolution === '720p' &&
    validParams &&
    body.enrich_prompt === false &&
    body.output_format === 'url' &&
    body.publish === false &&
    typeof body.publish_name === 'string' && /^[A-Za-z0-9._-]{1,60}$/.test(body.publish_name);
  return valid
    ? null
    : Response.json({ error: 'PixCLI video request does not match the pinned generation contract' }, { status: 400 });
}

function appendSearch(target: URL, source: URL): URL {
  for (const [key, value] of source.searchParams.entries()) {
    target.searchParams.append(key, value);
  }
  return target;
}

function appendSearchWithoutGoogleKey(target: URL, source: URL): URL {
  for (const [key, value] of source.searchParams.entries()) {
    if (key.toLowerCase() !== 'key') target.searchParams.append(key, value);
  }
  return target;
}

function meterkeyGeminiHeaders(apiKey: string, upstreamAttemptKey?: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    // Do not persist licensed photos, prompts, or generated images in AI
    // Gateway logs. Meterkey forwards this customer-controlled AIG header.
    'cf-aig-collect-log-payload': 'false',
    // One Insert Player provider attempt must remain one upstream attempt.
    'cf-aig-max-attempts': '1',
    // Meterkey keeps only a small completed-attempt marker for idempotency;
    // generated image bytes must not enter its 24-hour replay cache.
    'x-meterkey-no-store': 'true',
  };
  if (upstreamAttemptKey && /^[a-zA-Z0-9:_-]{1,200}$/.test(upstreamAttemptKey)) {
    headers['Idempotency-Key'] = upstreamAttemptKey;
    headers['X-Request-Id'] = upstreamAttemptKey;
  }
  return headers;
}

export interface GeminiProxyTarget {
  transport: 'google-direct' | 'meterkey';
  targetUrl: string;
  headers: Record<string, string>;
}

export function buildGeminiProxyTarget(
  request: Request,
  env: Env,
  apiPath: string,
  sourceUrl: URL,
  upstreamAttemptKey?: string | null,
): GeminiProxyTarget | null {
  const status = geminiTransportStatus(env);
  if (!status.configured || !status.transport) return null;
  if (status.transport === 'meterkey') {
    const baseUrl = meterkeyBaseUrl(env.METERKEY_BASE_URL);
    if (!baseUrl || !env.METERKEY_API_KEY) return null;
    const attemptKey = upstreamAttemptKey ?? `ip:ephemeral:${crypto.randomUUID()}`;
    const target = appendSearchWithoutGoogleKey(
      new URL(`/google-ai-studio${apiPath}`, baseUrl),
      sourceUrl,
    );
    return {
      transport: status.transport,
      targetUrl: target.toString(),
      headers: meterkeyGeminiHeaders(env.METERKEY_API_KEY, attemptKey),
    };
  }
  if (!env.GEMINI_API_KEY) return null;
  const target = appendSearch(new URL(`https://generativelanguage.googleapis.com${apiPath}`), sourceUrl);
  target.searchParams.set('key', env.GEMINI_API_KEY);
  return { transport: status.transport, targetUrl: target.toString(), headers: {} };
}

export async function proxyRequest(
  request: Request,
  targetUrl: string,
  extraHeaders: Record<string, string>,
  maxRequestBytes: number,
  maxResponseBytes = 32 * 1024 * 1024,
  upstreamOutcomePolicy: 'standard' | 'meterkey' = 'standard',
  redirect: 'follow' | 'error' | 'manual' = 'follow',
): Promise<Response> {
  const headers = new Headers(extraHeaders);
  const contentType = request.headers.get('Content-Type');
  if (contentType) headers.set('Content-Type', contentType);

  let boundedRequest;
  try {
    boundedRequest = createBoundedRequestStream(request, maxRequestBytes);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return Response.json({ error: 'Provider request body is too large' }, { status: 413 });
    }
    throw error;
  }

  const signal = AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : boundedRequest.body,
      signal,
      redirect,
    });
  } catch (error) {
    if (boundedRequest.didExceedLimit() || error instanceof RequestBodyTooLargeError) {
      return Response.json({ error: 'Provider request body is too large' }, { status: 413 });
    }
    return Response.json(
      { error: signal.aborted ? 'Provider request timed out' : 'Provider request failed' },
      {
        status: signal.aborted ? 504 : 502,
        headers: { 'X-Insert-Player-Upstream-Outcome': 'unknown' },
      },
    );
  }

  const responseHeaders = new Headers();
  const upstreamContentType = upstream.headers.get('Content-Type');
  if (upstreamContentType) responseHeaders.set('Content-Type', upstreamContentType);
  const retryAfter = upstream.headers.get('Retry-After');
  if (retryAfter) responseHeaders.set('Retry-After', retryAfter);
  const meterkeyOutcome = upstream.headers.get('X-Meterkey-Upstream-Outcome')?.trim().toLowerCase();
  responseHeaders.set(
    'X-Insert-Player-Upstream-Outcome',
    meterkeyOutcome === 'unknown'
      ? 'unknown'
      : meterkeyOutcome === 'not-dispatched'
        ? 'not-dispatched'
        : meterkeyOutcome === 'received'
          ? 'received'
          : upstreamOutcomePolicy === 'meterkey'
            ? 'unknown'
            : 'received',
  );
  const boundedBody = upstream.body
    ? createBoundedByteStream(upstream.body, maxResponseBytes)
    : null;
  return new Response(boundedBody, { status: upstream.status, headers: responseHeaders });
}

function decodeBase64Image(image: string): Uint8Array | null {
  const normalized = image.includes(',') ? image.split(',').pop() ?? '' : image;
  try {
    const binary = atob(normalized.replace(/\s+/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function isBase64TempAssetTooLarge(image: string): boolean {
  const normalized = image.includes(',') ? image.split(',').pop() ?? '' : image;
  return normalized.replace(/\s+/g, '').length > MAX_BASE64_TEMP_ASSET_CHARS;
}

function detectImageFormat(bytes: Uint8Array): ImageFormat | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { ext: 'png', contentType: 'image/png' };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: 'jpg', contentType: 'image/jpeg' };
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { ext: 'webp', contentType: 'image/webp' };
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return { ext: 'gif', contentType: 'image/gif' };
  }
  return null;
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return true;
  }
  if (isPrivateIpv4(host)) return true;
  return host.includes(':');
}

function parsePublicHttpUrl(input: string): URL | Response {
  let target: URL;
  try {
    target = new URL(input);
  } catch {
    return Response.json({ error: 'Invalid image URL' }, { status: 400 });
  }
  if (target.protocol !== 'https:') {
    return Response.json({ error: 'Only HTTPS result URLs are allowed' }, { status: 400 });
  }
  if (target.username || target.password || isBlockedHostname(target.hostname)) {
    return Response.json({ error: 'Image URL host is not allowed' }, { status: 400 });
  }
  return target;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function fetchPublicResult(target: URL, accept: string): Promise<FetchedPublicResult | Response> {
  let current = target;
  const signal = AbortSignal.timeout(RESULT_FETCH_TIMEOUT_MS);
  for (let redirects = 0; redirects <= MAX_RESULT_REDIRECTS; redirects += 1) {
    let response: Response;
    try {
      response = await fetch(current, {
        headers: { Accept: accept },
        redirect: 'manual',
        signal,
      });
    } catch {
      return Response.json(
        { error: signal.aborted ? 'Upstream download timed out' : 'Upstream download failed' },
        { status: signal.aborted ? 504 : 502 },
      );
    }
    if (!isRedirectStatus(response.status)) return { response, finalUrl: current };
    if (redirects === MAX_RESULT_REDIRECTS) {
      return Response.json({ error: 'Upstream returned too many redirects' }, { status: 502 });
    }

    const location = response.headers.get('Location');
    if (!location) {
      return Response.json({ error: 'Upstream redirect is missing a destination' }, { status: 502 });
    }
    let redirectedUrl: string;
    try {
      redirectedUrl = new URL(location, current).toString();
    } catch {
      return Response.json({ error: 'Upstream redirect URL is invalid' }, { status: 502 });
    }
    const validated = parsePublicHttpUrl(redirectedUrl);
    if (validated instanceof Response) return validated;
    current = validated;
  }
  return Response.json({ error: 'Upstream redirect failed' }, { status: 502 });
}

export async function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new ResponseBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function handleTempUpload(request: Request, env: Env, auth: PublicAuthContext): Promise<Response> {
  const sessionError = await requireProviderResultSession(request, env, auth);
  if (sessionError) return sessionError;
  const limited = await enforceRateLimit(env, 'proxy:default', auth);
  if (limited) return limited;

  const body = await readJsonBody<{ image?: string }>(request, MAX_TEMP_UPLOAD_JSON_BYTES);
  if (!body.image) {
    return Response.json({ error: 'Missing image field' }, { status: 400 });
  }
  if (isBase64TempAssetTooLarge(body.image)) {
    return Response.json({ error: 'Temp image is too large' }, { status: 413 });
  }

  const bytes = decodeBase64Image(body.image);
  if (!bytes) {
    return Response.json({ error: 'Invalid base64 image' }, { status: 400 });
  }
  if (bytes.byteLength > MAX_TEMP_ASSET_BYTES) {
    return Response.json({ error: 'Temp image is too large' }, { status: 413 });
  }
  const format = detectImageFormat(bytes);
  if (!format) {
    return Response.json({ error: 'Only PNG, JPEG, WebP, and GIF temp images are supported' }, { status: 415 });
  }

  const jobId = generationJobIdFromAuth(auth);
  const artifactRunId = jobId
    ? (await env.DB.prepare(`
        SELECT artifact_run_id
        FROM generation_jobs
        WHERE id = ? AND user_id = ?
        LIMIT 1
      `).bind(jobId, auth.userId ?? '').first<{ artifact_run_id: string | null }>())?.artifact_run_id
    : null;
  const durableNamespace = artifactRunId || jobId;
  const id = durableNamespace
    ? (await hashString(`${durableNamespace}:${await hashString(bytes.buffer as ArrayBuffer)}`)).slice(0, 32)
    : generateId();
  const expiresAt = new Date(Date.now() + TEMP_ASSET_TTL_SECONDS * 1000).toISOString();
  await env.SPRITES.put(`temp/${id}.${format.ext}`, bytes, {
    httpMetadata: { contentType: format.contentType },
    customMetadata: { expiresAt },
  });

  const url = new URL(request.url);
  return Response.json({ url: `${url.origin}${TEMP_ASSET_PATH_PREFIX}${id}.${format.ext}`, expiresAt });
}

async function handleImageProxy(request: Request, env: Env, auth: PublicAuthContext, url: URL): Promise<Response> {
  const imageUrl = url.searchParams.get('url');
  if (!imageUrl) {
    return Response.json({ error: 'Missing ?url= parameter' }, { status: 400 });
  }
  const target = parsePublicHttpUrl(imageUrl);
  if (target instanceof Response) {
    return target;
  }
  const sessionError = await requireProviderResultSession(request, env, auth);
  if (sessionError) return sessionError;
  const limited = await enforceRateLimit(env, 'proxy:default', auth);
  if (limited) return limited;
  const fetched = await fetchPublicResult(target, 'image/*');
  if (fetched instanceof Response) return fetched;
  const upstream = fetched.response;
  if (!upstream.ok) {
    return Response.json({ error: `Upstream error: ${upstream.status}` }, { status: upstream.status });
  }
  const contentLength = Number(upstream.headers.get('Content-Length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_PROXIED_IMAGE_BYTES) {
    return Response.json({ error: 'Upstream image is too large' }, { status: 413 });
  }
  const headers = new Headers();
  const contentType = upstream.headers.get('Content-Type');
  if (!contentType || !contentType.toLowerCase().startsWith('image/')) {
    return Response.json({ error: 'Upstream did not return an image' }, { status: 415 });
  }
  let bytes: Uint8Array;
  try {
    bytes = await readResponseBytes(upstream, MAX_PROXIED_IMAGE_BYTES);
  } catch (error) {
    if (error instanceof ResponseBodyTooLargeError) {
      return Response.json({ error: 'Upstream image is too large' }, { status: 413 });
    }
    return Response.json({ error: 'Upstream image download failed' }, { status: 502 });
  }
  headers.set('Content-Type', contentType);
  headers.set('Cache-Control', 'public, max-age=86400');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(bytes, { headers });
}

async function handleMediaProxy(request: Request, env: Env, auth: PublicAuthContext, url: URL): Promise<Response> {
  const mediaUrl = url.searchParams.get('url');
  if (!mediaUrl) {
    return Response.json({ error: 'Missing ?url= parameter' }, { status: 400 });
  }
  const target = parsePublicHttpUrl(mediaUrl);
  if (target instanceof Response) {
    return target;
  }
  const sessionError = await requireProviderResultSession(request, env, auth);
  if (sessionError) return sessionError;
  const limited = await enforceRateLimit(env, 'proxy:default', auth);
  if (limited) return limited;
  const fetched = await fetchPublicResult(target, 'image/*,video/*');
  if (fetched instanceof Response) return fetched;
  const upstream = fetched.response;
  if (!upstream.ok) {
    return Response.json({ error: `Upstream error: ${upstream.status}` }, { status: upstream.status });
  }
  const contentLength = Number(upstream.headers.get('Content-Length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_PROXIED_MEDIA_BYTES) {
    return Response.json({ error: 'Upstream media is too large' }, { status: 413 });
  }
  const contentType = upstream.headers.get('Content-Type');
  const normalizedType = contentType?.toLowerCase() ?? '';
  if (!contentType || (!normalizedType.startsWith('image/') && !normalizedType.startsWith('video/'))) {
    return Response.json({ error: 'Upstream did not return supported media' }, { status: 415 });
  }
  let bytes: Uint8Array;
  try {
    bytes = await readResponseBytes(upstream, MAX_PROXIED_MEDIA_BYTES);
  } catch (error) {
    if (error instanceof ResponseBodyTooLargeError) {
      return Response.json({ error: 'Upstream media is too large' }, { status: 413 });
    }
    return Response.json({ error: 'Upstream media download failed' }, { status: 502 });
  }
  const headers = new Headers();
  headers.set('Content-Type', contentType);
  headers.set('Cache-Control', 'public, max-age=86400');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(bytes, { headers });
}

export async function getTempAsset(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  let file: string;
  try {
    file = decodeURIComponent(url.pathname.slice(TEMP_ASSET_PATH_PREFIX.length));
  } catch {
    return Response.json({ error: 'Invalid temp asset path' }, { status: 400 });
  }
  const match = file.match(/^([a-f0-9]{32})\.(gif|jpg|png|webp)$/);
  if (!match) return Response.json({ error: 'Temp asset not found' }, { status: 404 });

  const key = `temp/${match[1]}.${match[2]}`;
  const object = await env.SPRITES.get(key);
  if (!object) return Response.json({ error: 'Temp asset not found' }, { status: 404 });

  const expiresAt = object.customMetadata?.expiresAt;
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
    await env.SPRITES.delete(key);
    return Response.json({ error: 'Temp asset expired' }, { status: 410 });
  }

  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType ?? 'image/png');
  const maxAge = Number.isFinite(expiresAtMs)
    ? Math.max(0, Math.min(TEMP_ASSET_TTL_SECONDS, Math.floor((expiresAtMs - Date.now()) / 1000)))
    : TEMP_ASSET_TTL_SECONDS;
  headers.set('Cache-Control', `public, max-age=${maxAge}`);
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(object.body, { headers });
}

export async function handleProxy(request: Request, env: Env, auth: PublicAuthContext): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/proxy/upload-temp') {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: 'POST' } });
    }
    return handleTempUpload(request, env, auth);
  }

  if (path === '/proxy/image') {
    return handleImageProxy(request, env, auth, url);
  }

  if (path === '/proxy/media') {
    return handleMediaProxy(request, env, auth, url);
  }

  if (path.startsWith('/proxy/ludo')) {
    const allowlistError = enforceProviderRouteAllowlist('ludo', path, request.method);
    if (allowlistError) return allowlistError;
    if (!env.LUDO_API_KEY) return missingKey('LUDO_API_KEY');
    if (path === '/proxy/ludo/assets/sprites/results' && !url.searchParams.get('request_id')?.trim()) {
      return Response.json({ error: 'request_id is required' }, { status: 400 });
    }
    const limited = await enforceRateLimit(env, 'proxy:default', auth);
    if (limited) return limited;
    const providerState = createProviderRequestState();
    if (requiresProviderSession('ludo', request.method)) {
      const sessionError = await requireProviderSession(request, env, auth, { provider: 'ludo', path }, providerState);
      if (sessionError) return sessionError;
    }
    const apiPath = path.replace(/^\/proxy\/ludo/, '/api');
    const target = appendSearch(new URL(`https://api.ludo.ai${apiPath}`), url);
    const response = await proxyRequest(
      request,
      target.toString(),
      { Authorization: `ApiKey ${env.LUDO_API_KEY}` },
      PROVIDER_REQUEST_BODY_LIMITS.ludo,
      PROVIDER_RESPONSE_BODY_LIMITS.ludo,
    );
    return finalizeProviderRequest(env, response, providerState);
  }

  if (path.startsWith('/proxy/freepik')) {
    const allowlistError = enforceProviderRouteAllowlist('freepik', path, request.method);
    if (allowlistError) return allowlistError;
    if (!env.FREEPIK_API_KEY) return missingKey('FREEPIK_API_KEY');
    const limited = await enforceRateLimit(env, 'proxy:default', auth);
    if (limited) return limited;
    const providerState = createProviderRequestState();
    if (requiresProviderSession('freepik', request.method)) {
      const sessionError = await requireProviderSession(request, env, auth, { provider: 'freepik', path }, providerState);
      if (sessionError) return sessionError;
    }
    const apiPath = path.replace(/^\/proxy\/freepik/, '');
    const target = appendSearch(new URL(`https://api.freepik.com${apiPath}`), url);
    const response = await proxyRequest(
      request,
      target.toString(),
      { 'x-freepik-api-key': env.FREEPIK_API_KEY },
      PROVIDER_REQUEST_BODY_LIMITS.freepik,
      PROVIDER_RESPONSE_BODY_LIMITS.freepik,
    );
    return finalizeProviderRequest(env, response, providerState);
  }

  if (path.startsWith('/proxy/gemini')) {
    const allowlistError = enforceProviderRouteAllowlist('gemini', path, request.method);
    if (allowlistError) return allowlistError;
    const transport = geminiTransportStatus(env);
    if (!transport.configured || !transport.transport) {
      return Response.json({ error: transport.error ?? 'Gemini transport is not configured' }, { status: 503 });
    }
    const limited = await enforceRateLimit(env, 'proxy:gemini', auth);
    if (limited) return limited;
    const providerState = createProviderRequestState();
    if (requiresProviderSession('gemini', request.method)) {
      const sessionError = await requireProviderSession(request, env, auth, { provider: 'gemini', path }, providerState);
      if (sessionError) return sessionError;
    }
    const apiPath = path.replace(/^\/proxy\/gemini/, '');
    const upstream = buildGeminiProxyTarget(
      request,
      env,
      apiPath,
      url,
      providerState.upstreamAttemptKey,
    );
    if (!upstream) {
      return Response.json({ error: 'Gemini transport is not configured' }, { status: 503 });
    }
    const response = await proxyRequest(
      request,
      upstream.targetUrl,
      upstream.headers,
      PROVIDER_REQUEST_BODY_LIMITS.gemini,
      PROVIDER_RESPONSE_BODY_LIMITS.gemini,
      upstream.transport === 'meterkey' ? 'meterkey' : 'standard',
    );
    const finalized = await finalizeProviderRequest(env, response, providerState);
    finalized.headers.set('X-Insert-Player-Gemini-Transport', upstream.transport);
    return finalized;
  }

  if (path.startsWith('/proxy/runway')) {
    const allowlistError = enforceProviderRouteAllowlist('runway', path, request.method);
    if (allowlistError) return allowlistError;
    if (!env.RUNWAY_API_KEY) return missingKey('RUNWAY_API_KEY');
    const limited = await enforceRateLimit(env, 'proxy:default', auth);
    if (limited) return limited;
    const providerState = createProviderRequestState();
    if (requiresProviderSession('runway', request.method)) {
      const sessionError = await requireProviderSession(request, env, auth, { provider: 'runway', path }, providerState);
      if (sessionError) return sessionError;
    }
    const apiPath = path.replace(/^\/proxy\/runway/, '');
    const target = appendSearch(new URL(`https://api.dev.runwayml.com${apiPath}`), url);
    const response = await proxyRequest(
      request,
      target.toString(),
      {
        Authorization: `Bearer ${env.RUNWAY_API_KEY}`,
        'X-Runway-Version': '2024-11-06',
      },
      PROVIDER_REQUEST_BODY_LIMITS.runway,
      PROVIDER_RESPONSE_BODY_LIMITS.runway,
    );
    return finalizeProviderRequest(env, response, providerState);
  }

  if (path.startsWith('/proxy/fal')) {
    const allowlistError = enforceProviderRouteAllowlist('fal', path, request.method);
    if (allowlistError) return allowlistError;
    if (!env.FAL_API_KEY) return missingKey('FAL_API_KEY');
    const limited = await enforceRateLimit(env, 'proxy:fal', auth);
    if (limited) return limited;
    const providerState = createProviderRequestState();
    if (requiresProviderSession('fal', request.method)) {
      const sessionError = await requireProviderSession(request, env, auth, { provider: 'fal', path }, providerState);
      if (sessionError) return sessionError;
    }
    const apiPath = path.replace(/^\/proxy\/fal/, '');
    const target = appendSearch(new URL(`https://queue.fal.run${apiPath}`), url);
    const response = await proxyRequest(
      request,
      target.toString(),
      { Authorization: `Key ${env.FAL_API_KEY}` },
      PROVIDER_REQUEST_BODY_LIMITS.fal,
      PROVIDER_RESPONSE_BODY_LIMITS.fal,
    );
    return finalizeProviderRequest(env, response, providerState);
  }

  if (path.startsWith('/proxy/pixcli')) {
    const allowlistError = enforceProviderRouteAllowlist('pixcli', path, request.method);
    if (allowlistError) return allowlistError;
    if (url.search) {
      return Response.json({ error: 'PixCLI proxy query parameters are not allowed' }, { status: 400 });
    }
    if (!env.PIXCLI_API_KEY) return missingKey('PIXCLI_API_KEY');
    const baseUrl = pixcliBaseUrl(env.PIXCLI_BASE_URL);
    if (!baseUrl) return Response.json({ error: 'PIXCLI_BASE_URL is invalid' }, { status: 503 });
    const contractError = await validatePixcliTransportRequest(request, path);
    if (contractError) return contractError;
    const limited = await enforceRateLimit(env, 'proxy:default', auth);
    if (limited) return limited;
    const providerState = createProviderRequestState();
    const route = { provider: 'pixcli' as const, path };
    const sessionError = path === '/proxy/pixcli/api/v1/uploads'
      ? await requireUnmeteredProviderSession(request, env, auth, route, providerState)
      : await requireProviderSession(request, env, auth, route, providerState);
    if (sessionError) return sessionError;
    const upstreamAttemptKey = providerState.upstreamAttemptKey;
    const upstreamHeaders = pixcliUpstreamHeaders(env.PIXCLI_API_KEY, path, upstreamAttemptKey);
    if (!upstreamHeaders) {
      return finalizeProviderRequest(env, Response.json(
        {
          error: 'PixCLI video dispatch identity is unavailable',
          code: 'pixcli_dispatch_identity_missing',
        },
        {
          status: 503,
          headers: { 'X-Insert-Player-Upstream-Outcome': 'not-dispatched' },
        },
      ), providerState);
    }
    const apiPath = path.replace(/^\/proxy\/pixcli/, '');
    const target = appendSearch(new URL(apiPath, baseUrl), url);
    const isAssetDownload = /^\/proxy\/pixcli\/api\/v1\/assets\/[a-f0-9]{32}$/.test(path);
    const response = await proxyRequest(
      request,
      target.toString(),
      upstreamHeaders,
      PROVIDER_REQUEST_BODY_LIMITS.pixcli,
      PROVIDER_RESPONSE_BODY_LIMITS.pixcli,
      'standard',
      'manual',
    );
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return finalizeProviderRequest(env, Response.json(
        { error: 'PixCLI redirects are not allowed' },
        {
          status: 502,
          headers: { 'X-Insert-Player-Upstream-Outcome': 'received' },
        },
      ), providerState);
    }
    if (isAssetDownload) {
      const contentType = response.headers.get('Content-Type')
        ?.split(';', 1)[0]
        ?.trim()
        .toLowerCase();
      if (response.ok && contentType !== 'video/mp4' && contentType !== 'application/json') {
        await response.body?.cancel();
        return Response.json({ error: 'PixCLI asset MIME type is not allowlisted' }, { status: 415 });
      }
    }
    return finalizeProviderRequest(env, response, providerState);
  }

  return null;
}
