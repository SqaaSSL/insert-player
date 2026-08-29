import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { transformWithEsbuild } from 'vite';

const execFileAsync = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const productionApiOrigin = 'https://api.insertplayer.ai';
const approvedModel = 'gemini-3.1-flash-image';
const maxSeedBytes = 2_000_000;
const maxActiveBytes = 1_250_000;
const requestTimeoutMs = 180_000;
const legalKeys = [
  'ageConfirmed',
  'termsAccepted',
  'photoRightsConfirmed',
  'aiProcessingConfirmed',
  'immediatePerformanceConfirmed',
  'withdrawalLossAcknowledged',
];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeRelativePath(value, label) {
  invariant(typeof value === 'string' && value.length > 0, `${label} is required.`);
  invariant(!isAbsolute(value), `${label} must be repository-relative.`);
  const resolved = resolve(root, value);
  const rel = relative(root, resolved);
  invariant(rel && !rel.startsWith('..') && !isAbsolute(rel), `${label} escapes the repository.`);
  return resolved;
}

export function validateStagePublicationRequest(value) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'Stage request must be an object.');
  invariant(value.schemaVersion === 1, 'Unsupported stage request schema.');
  invariant(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.id ?? ''), 'Stage id is invalid.');
  invariant(typeof value.label === 'string' && value.label.length > 0 && value.label.length <= 28, 'Stage label is invalid.');
  invariant(typeof value.blurb === 'string' && value.blurb.length > 0 && value.blurb.length <= 180, 'Stage blurb is invalid.');
  invariant(/^\d{4}-\d{2}-\d{2}\.\d+$/.test(value.legalVersion ?? ''), 'Legal version is invalid.');
  invariant(value.sourceMode === 'transform-scene', 'Only transform-scene publication is allowed.');
  invariant(value.model === approvedModel, `Stage model must be ${approvedModel}.`);
  invariant(value.seed?.mime === 'image/png', 'Stage seed must be a PNG.');
  invariant(/^[a-f0-9]{64}$/.test(value.seed?.sha256 ?? ''), 'Stage seed SHA-256 is invalid.');
  invariant(/^[a-z0-9]+(?:-[a-z0-9]+)*-pipeline-v\d+$/.test(value.output?.baseName ?? ''), 'Output base name is invalid.');
  invariant(value.output?.format === 'png', 'Stage output must be PNG.');
  invariant(value.output?.width === 1024 && value.output?.height === 576, 'Stage output must be 1024x576.');
  invariant(value.output?.normalization?.bottomShadeAlpha === 0.04, 'Stage bottom shade must remain 0.04.');
  invariant(value.output?.normalization?.verticalBias === 0.92, 'Stage vertical bias must remain 0.92.');
  if (value.output.cleanup !== undefined) {
    invariant(value.output.cleanup?.method === 'interpolate-empty-panels-v1', 'Stage cleanup method is invalid.');
    invariant(Array.isArray(value.output.cleanup?.regions) && value.output.cleanup.regions.length > 0, 'Stage cleanup regions are required.');
    for (const region of value.output.cleanup.regions) {
      const coordinates = [region?.x, region?.y, region?.width, region?.height];
      invariant(coordinates.every(Number.isInteger), 'Stage cleanup regions must use integer coordinates.');
      invariant(region.x >= 0 && region.y >= 0 && region.width >= 2 && region.height >= 2, 'Stage cleanup region dimensions are invalid.');
      invariant(region.x + region.width <= value.output.width, 'Stage cleanup region exceeds output width.');
      invariant(region.y + region.height <= value.output.height, 'Stage cleanup region exceeds output height.');
    }
  }
  return value;
}

export function parseGeminiStageImage(body) {
  const candidate = body?.candidates?.[0];
  invariant(candidate && typeof candidate === 'object', 'Gemini returned no candidate.');
  const parts = candidate.content?.parts;
  invariant(Array.isArray(parts), `Gemini returned no content (${candidate.finishReason ?? 'unknown'}).`);
  const images = parts.flatMap((part) => (
    typeof part?.inlineData?.data === 'string' && typeof part.inlineData.mimeType === 'string'
      ? [part.inlineData]
      : []
  ));
  invariant(images.length === 1, `Gemini returned ${images.length} images; exactly one is required.`);
  invariant(/^image\/(?:png|jpeg|webp)$/i.test(images[0].mimeType), `Unsupported Gemini image MIME ${images[0].mimeType}.`);
  const bytes = Buffer.from(images[0].data, 'base64');
  invariant(bytes.length > 0, 'Gemini returned an empty image.');
  return {
    bytes,
    mime: images[0].mimeType.toLowerCase(),
    finishReason: typeof candidate.finishReason === 'string' ? candidate.finishReason : null,
  };
}

function rawExtension(mime) {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  return 'png';
}

export function validateFfmpegVersionOutput(stdout) {
  invariant(typeof stdout === 'string' && /^ffmpeg version\s+/m.test(stdout), 'ffmpeg runtime is unavailable.');
  return stdout.split(/\r?\n/, 1)[0];
}

export function buildPanelCleanupFilter(regions) {
  if (!regions?.length) return null;
  const splitLabels = ['base'];
  for (let index = 0; index < regions.length; index += 1) {
    splitLabels.push(`top${index}`, `bottom${index}`);
  }
  const filters = [
    `[0:v]split=${splitLabels.length}${splitLabels.map((label) => `[${label}]`).join('')}`,
  ];
  for (const [index, region] of regions.entries()) {
    const bottomY = region.y + region.height - 1;
    filters.push(
      `[top${index}]crop=${region.width}:1:${region.x}:${region.y}[topCrop${index}]`,
      `[bottom${index}]crop=${region.width}:1:${region.x}:${bottomY}[bottomCrop${index}]`,
      `[topCrop${index}][bottomCrop${index}]vstack=inputs=2,scale=${region.width}:${region.height}:flags=bilinear,gblur=sigma=1.5[patch${index}]`,
    );
  }
  let base = 'base';
  for (const [index, region] of regions.entries()) {
    const next = index === regions.length - 1 ? 'out' : `clean${index}`;
    filters.push(`[${base}][patch${index}]overlay=${region.x}:${region.y}[${next}]`);
    base = next;
  }
  return filters.join(';');
}

async function readJsonResponse(response, label) {
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label} returned non-JSON (${response.status}).`);
  }
  if (!response.ok) {
    const detail = body?.error?.message ?? body?.error ?? body?.message;
    throw new Error(`${label} failed (${response.status})${typeof detail === 'string' ? `: ${detail}` : ''}.`);
  }
  return body;
}

async function clerkJson(secretKey, path, init = {}) {
  const response = await fetch(`https://api.clerk.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  return readJsonResponse(response, `Clerk ${init.method ?? 'GET'} ${path}`);
}

async function mintAdminToken(secretKey, userId) {
  invariant(/^sk_live_/.test(secretKey), 'Production stage generation requires a live Clerk backend key.');
  invariant(/^user_[A-Za-z0-9]+$/.test(userId), 'Arcade admin Clerk user id is invalid.');
  const query = new URLSearchParams({ user_id: userId, status: 'active', limit: '20' });
  const listed = await clerkJson(secretKey, `/sessions?${query}`);
  const sessions = Array.isArray(listed.data) ? listed.data : Array.isArray(listed) ? listed : [];
  const session = sessions.find((entry) => entry?.user_id === userId && entry?.status === 'active');
  invariant(session?.id, 'The configured Arcade admin has no active Clerk session.');
  const created = await clerkJson(secretKey, `/sessions/${encodeURIComponent(session.id)}/tokens`, {
    method: 'POST',
    body: JSON.stringify({ expires_in_seconds: 600 }),
  });
  invariant(typeof created.jwt === 'string' && created.jwt.length > 0, 'Clerk did not return an admin token.');
  return created.jwt;
}

async function loadPromptBuilder() {
  const sourcePath = join(root, 'src/services/StageBackgroundPrompt.ts');
  const source = await readFile(sourcePath, 'utf8');
  const transformed = await transformWithEsbuild(source, sourcePath, {
    loader: 'ts',
    format: 'esm',
    target: 'es2022',
  });
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(transformed.code).toString('base64')}`;
  const module = await import(moduleUrl);
  invariant(typeof module.buildGeminiStageBackgroundPrompt === 'function', 'Stage prompt builder did not load.');
  return module.buildGeminiStageBackgroundPrompt;
}

export async function normalizeStageImage(rawBytes, mime, request, outputPath) {
  const browser = await chromium.launch({ headless: true });
  let rgbaPng;
  try {
    const page = await browser.newPage();
    rgbaPng = await page.evaluate(async ({ base64, mimeType, width, height, normalization }) => {
      const image = new Image();
      image.src = `data:${mimeType};base64,${base64}`;
      await new Promise((resolveImage, rejectImage) => {
        image.onload = resolveImage;
        image.onerror = () => rejectImage(new Error('Generated stage could not be decoded.'));
      });

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas 2D context is unavailable.');

      const scale = Math.max(width / image.width, height / image.height);
      const drawWidth = image.width * scale;
      const drawHeight = image.height * scale;
      const drawX = (width - drawWidth) / 2;
      const overflowY = Math.max(0, drawHeight - height);
      const drawY = overflowY > 0
        ? -overflowY * Math.min(1, Math.max(0, normalization.verticalBias))
        : (height - drawHeight) / 2;
      context.drawImage(image, drawX, drawY, drawWidth, drawHeight);

      const grade = context.createLinearGradient(0, 0, 0, height);
      grade.addColorStop(0, 'rgba(255, 255, 255, 0.02)');
      grade.addColorStop(0.6, 'rgba(255, 255, 255, 0)');
      grade.addColorStop(1, `rgba(0, 0, 0, ${normalization.bottomShadeAlpha})`);
      context.fillStyle = grade;
      context.fillRect(0, 0, width, height);

      return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);
    }, {
      base64: rawBytes.toString('base64'),
      mimeType: mime,
      width: request.output.width,
      height: request.output.height,
      normalization: request.output.normalization,
    });
  } finally {
    await browser.close();
  }

  const tempDirectory = await mkdtemp(join(tmpdir(), 'insert-player-stage-'));
  const rgbaPath = join(tempDirectory, 'rgba.png');
  try {
    await writeFile(rgbaPath, Buffer.from(rgbaPng, 'base64'));
    const cleanupFilter = buildPanelCleanupFilter(request.output.cleanup?.regions);
    const ffmpegArguments = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', rgbaPath,
    ];
    if (cleanupFilter) {
      ffmpegArguments.push('-filter_complex', cleanupFilter, '-map', '[out]');
    }
    ffmpegArguments.push(
      '-frames:v', '1',
      '-pix_fmt', 'rgb24',
      '-compression_level', '9',
      outputPath,
    );
    await execFileAsync('ffmpeg', ffmpegArguments);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function localRuntimePreflight(seed, request) {
  const ffmpeg = await execFileAsync('ffmpeg', ['-version']);
  const ffmpegVersion = validateFfmpegVersionOutput(ffmpeg.stdout);
  const tempDirectory = await mkdtemp(join(tmpdir(), 'insert-player-stage-preflight-'));
  const outputPath = join(tempDirectory, 'normalized-seed.png');
  try {
    // Exercise the exact decode, Canvas transform, Chromium launch, and PNG
    // encoding path before any provider session or paid request exists.
    await normalizeStageImage(seed, request.seed.mime, request, outputPath);
    const output = await readFile(outputPath);
    invariant(output.length > 8, 'Stage normalization preflight produced an empty image.');
    invariant(output.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Stage normalization preflight did not produce PNG.');
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
  return { ffmpegVersion };
}

function generationLegalAttestation(legalVersion) {
  return Object.fromEntries([
    ['legalVersion', legalVersion],
    ...legalKeys.map((key) => [key, true]),
  ]);
}

async function productionPreflight(request) {
  const healthResponse = await fetch(`${productionApiOrigin}/health`, {
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  const health = await readJsonResponse(healthResponse, 'Production health');
  invariant(health.status === 'ok' && health.environment === 'production', 'Production Worker is not healthy.');
  invariant(health.geminiTransport === 'meterkey', 'Production Gemini transport is not Meterkey.');
  invariant(health.providerSessionLimits === 'configured', 'Provider session limits are not configured.');
  invariant(health.legalVersion === request.legalVersion, 'Stage request legal version is stale.');
  return health;
}

export function backendAuthHeaders(token, backendBridgeSecret) {
  invariant(backendBridgeSecret.length >= 32, 'Clerk backend auth bridge secret is invalid.');
  return {
    Authorization: `Bearer ${token}`,
    'X-Insert-Player-Admin-Seed': 'clerk-backend',
    'X-Insert-Player-Clerk-Backend-Auth': backendBridgeSecret,
  };
}

async function createStageProviderSession(token, backendBridgeSecret, request) {
  const response = await fetch(`${productionApiOrigin}/api/provider-sessions`, {
    method: 'POST',
    headers: {
      ...backendAuthHeaders(token, backendBridgeSecret),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      purpose: 'stage_background',
      legal: generationLegalAttestation(request.legalVersion),
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  const session = await readJsonResponse(response, 'Stage provider session');
  invariant(typeof session.providerSessionId === 'string' && session.providerSessionId.length > 0, 'Provider session id is missing.');
  invariant(session.providerCallLimit === 1, 'Stage provider session must allow exactly one call.');
  invariant(session.providerCostLimitCents === 10, 'Stage provider session must cap estimated cost at 10 cents.');
  return session;
}

async function generateOnce(token, backendBridgeSecret, providerSessionId, prompt, seed, request) {
  const response = await fetch(
    `${productionApiOrigin}/proxy/gemini/v1beta/models/${approvedModel}:generateContent`,
    {
      method: 'POST',
      headers: {
        ...backendAuthHeaders(token, backendBridgeSecret),
        'Content-Type': 'application/json',
        'X-ASF-Provider-Session': providerSessionId,
        'X-Insert-Player-Provider-Call-Kind': 'image_generation',
      },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inlineData: { mimeType: request.seed.mime, data: seed.toString('base64') } },
            { text: prompt },
          ],
        }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(requestTimeoutMs),
    },
  );
  return readJsonResponse(response, 'Gemini stage generation');
}

export async function generateSignatureStage({ requestPath, outputDirectory }) {
  const resolvedRequestPath = safeRelativePath(requestPath, 'Request path');
  const request = validateStagePublicationRequest(JSON.parse(await readFile(resolvedRequestPath, 'utf8')));
  const seedPath = safeRelativePath(request.seed.path, 'Seed path');
  const seed = await readFile(seedPath);
  invariant(seed.length <= maxSeedBytes, `Stage seed exceeds ${maxSeedBytes} bytes.`);
  invariant(sha256(seed) === request.seed.sha256, 'Stage seed hash does not match the sealed request.');

  const resolvedOutputDirectory = isAbsolute(outputDirectory)
    ? outputDirectory
    : resolve(root, outputDirectory);
  await mkdir(resolvedOutputDirectory, { recursive: true });

  const runtime = await localRuntimePreflight(seed, request);

  const health = await productionPreflight(request);
  const clerkSecretKey = process.env.ASF_ARCADE_CLERK_SECRET_KEY?.trim() ?? '';
  const clerkUserId = process.env.ASF_ARCADE_ADMIN_CLERK_USER_ID?.trim() ?? '';
  const backendBridgeSecret = process.env.CLERK_BACKEND_AUTH_BRIDGE_SECRET?.trim() ?? '';
  invariant(clerkSecretKey && clerkUserId && backendBridgeSecret, 'Production Clerk automation credentials are required.');
  const token = await mintAdminToken(clerkSecretKey, clerkUserId);
  const buildPrompt = await loadPromptBuilder();
  const prompt = buildPrompt({
    stageLabel: request.label,
    stageBlurb: request.blurb,
    sourceImage: { data: seed.toString('base64'), mime: request.seed.mime },
    sourceMode: request.sourceMode,
  });
  const providerSession = await createStageProviderSession(token, backendBridgeSecret, request);

  // Deliberately one call: no retry, fallback, resubmit, or alternate model.
  const response = await generateOnce(
    token,
    backendBridgeSecret,
    providerSession.providerSessionId,
    prompt,
    seed,
    request,
  );
  const generated = parseGeminiStageImage(response);

  const rawPath = join(
    resolvedOutputDirectory,
    `${request.output.baseName}-provider-raw.${rawExtension(generated.mime)}`,
  );
  const activePath = join(resolvedOutputDirectory, `${request.output.baseName}.png`);
  await writeFile(rawPath, generated.bytes);
  await normalizeStageImage(generated.bytes, generated.mime, request, activePath);
  const active = await readFile(activePath);
  invariant(active.length <= maxActiveBytes, `Normalized stage exceeds ${maxActiveBytes} bytes.`);

  const provenance = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    request: relative(root, resolvedRequestPath),
    stageId: request.id,
    operation: 'stage_background',
    sourceMode: request.sourceMode,
    model: request.model,
    transport: health.geminiTransport,
    workerVersionId: health.workerVersionId ?? null,
    workerTag: health.workerVersion?.tag ?? null,
    runtime,
    limits: {
      providerCalls: providerSession.providerCallLimit,
      estimatedCostCents: providerSession.providerCostLimitCents,
    },
    seed: {
      path: request.seed.path,
      sha256: request.seed.sha256,
      bytes: seed.length,
    },
    promptSha256: sha256(Buffer.from(prompt)),
    providerOutput: {
      file: relative(resolvedOutputDirectory, rawPath),
      mime: generated.mime,
      sha256: sha256(generated.bytes),
      bytes: generated.bytes.length,
      finishReason: generated.finishReason,
    },
    activeOutput: {
      file: relative(resolvedOutputDirectory, activePath),
      mime: 'image/png',
      sha256: sha256(active),
      bytes: active.length,
      width: request.output.width,
      height: request.output.height,
      normalization: request.output.normalization,
      cleanup: request.output.cleanup ?? null,
    },
  };
  const provenancePath = join(resolvedOutputDirectory, `${request.output.baseName}.provenance.json`);
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  return { activePath, provenance, provenancePath, rawPath };
}

function parseArguments(argv) {
  const values = new Map(argv.map((argument) => {
    const [key, ...rest] = argument.split('=');
    return [key, rest.join('=')];
  }));
  return {
    requestPath: values.get('--request') ?? '',
    outputDirectory: values.get('--output-dir') ?? '',
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  invariant(options.requestPath, 'Pass --request=<repository-relative JSON path>.');
  invariant(options.outputDirectory, 'Pass --output-dir=<directory>.');
  const result = await generateSignatureStage(options);
  console.log(JSON.stringify({
    stageId: result.provenance.stageId,
    model: result.provenance.model,
    transport: result.provenance.transport,
    providerCalls: result.provenance.limits.providerCalls,
    estimatedCostCents: result.provenance.limits.estimatedCostCents,
    activeSha256: result.provenance.activeOutput.sha256,
    activeBytes: result.provenance.activeOutput.bytes,
    artifactDirectory: dirname(result.activePath),
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
