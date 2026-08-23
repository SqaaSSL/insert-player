import { createServer } from 'node:http';
import { installCanvasRuntime } from './canvasRuntime';
import { sourceGenerationStrategy } from './sourceGenerationPolicy';

installCanvasRuntime();

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const port = Number.parseInt(process.env.PORT ?? '8080', 10);

interface CleanSheetRequest {
  imageBase64: string;
  expectedFrameCount: number;
  expectedGridCols: number;
  expectedGridRows: number;
  animationName: string;
  maxScale?: number;
  normalizationReference?: {
    targetDrawHeight?: number;
    targetDrawWidth?: number;
    baselineRatio?: number;
  };
}

interface ProviderContextRequest {
  apiBaseUrl: string;
  generationToken: string;
  providerSessionId: string;
  requestScope: string;
}

interface GenerateSourceRequest extends ProviderContextRequest {
  operation: 'repose' | 'upright' | 'crouch';
  imageBase64: string;
  normalizationSourceBase64?: string;
  generationPrompt?: string;
}

interface GenerateSpriteRequest extends ProviderContextRequest {
  tier: 'rookie' | 'contender' | 'champion';
  animation: {
    name: string;
    motion: string;
    frames: number;
    base: 'standing' | 'crouched';
  };
  primaryBase64: string;
  secondaryBase64?: string;
  generationPrompt?: string;
  normalizationReference?: {
    targetDrawHeight?: number;
    targetDrawWidth?: number;
    baselineRatio?: number;
  };
}

function isProviderContextRequest(body: Partial<ProviderContextRequest>): body is ProviderContextRequest {
  return Boolean(
    /^https?:\/\//i.test(body.apiBaseUrl ?? '') &&
    body.generationToken?.trim() &&
    body.providerSessionId?.trim() &&
    /^[a-zA-Z0-9:_-]{1,160}$/.test(body.requestScope ?? ''),
  );
}

async function detachedProviderContext(body: ProviderContextRequest) {
  const { createDetachedApiRequestContext } = await import('../../src/services/ApiClient.ts');
  return createDetachedApiRequestContext({
    apiBaseUrl: body.apiBaseUrl,
    authorizationToken: body.generationToken,
    authorizationScheme: 'Generation',
    providerSessionId: body.providerSessionId,
    providerRequestScope: body.requestScope,
  });
}

async function crouchNormalizationReference(base64: string | undefined) {
  if (!base64) return undefined;
  const [{ measureOpaqueBoundsFromBase64, CELL_H, CELL_W }, { getAnimationProfile }] = await Promise.all([
    import('../../src/services/SpritePostProcess.ts'),
    import('../../src/services/AnimationProfiles.ts'),
  ]);
  const bounds = await measureOpaqueBoundsFromBase64(base64);
  if (!bounds) return undefined;
  const profile = getAnimationProfile('idle');
  const scale = Math.min(
    (CELL_H * profile.targetHeightRatio) / bounds.h,
    (CELL_W * profile.targetWidthRatio) / bounds.w,
  );
  return {
    targetDrawHeight: Math.round(bounds.h * scale * 0.94),
    targetDrawWidth: Math.round(bounds.w * scale * 1.16),
    baselineRatio: 0.98,
  };
}

async function generateSource(body: GenerateSourceRequest) {
  const context = await detachedProviderContext(body);
  const {
    geminiCrouchReposeDetailed,
    geminiOfficialPoseDetailed,
    geminiReposeDetailed,
    geminiUprightReposeDetailed,
  } = await import('../../src/services/GeminiApi.ts');
  const generationPrompt = body.generationPrompt?.trim();
  const strategy = sourceGenerationStrategy(body.operation, generationPrompt);
  if (strategy !== 'reference-photo') {
    if (strategy === 'official-text-side') {
      if (!generationPrompt) throw new Error('Official source prompt is unavailable');
      return geminiOfficialPoseDetailed(generationPrompt, 'side', context);
    }
    if (strategy === 'official-reference-upright') {
      return geminiUprightReposeDetailed(body.imageBase64, context);
    }
    const normalizationReference = await crouchNormalizationReference(body.normalizationSourceBase64);
    const result = await geminiCrouchReposeDetailed(
      body.imageBase64,
      normalizationReference,
      body.imageBase64,
      context,
    );
    return {
      ...result,
      normalizationReference,
    };
  }
  if (body.operation === 'repose') {
    return geminiReposeDetailed(body.imageBase64, context, body.generationPrompt);
  }
  if (body.operation === 'upright') {
    return geminiUprightReposeDetailed(body.imageBase64, context);
  }
  const normalizationReference = await crouchNormalizationReference(body.normalizationSourceBase64);
  const result = await geminiCrouchReposeDetailed(
    body.imageBase64,
    normalizationReference,
    body.imageBase64,
    context,
  );
  return { ...result, normalizationReference };
}

async function generateSprite(body: GenerateSpriteRequest) {
  const context = await detachedProviderContext(body);
  const { CELL_H, CELL_W } = await import('../../src/services/SpritePostProcess.ts');
  const { geminiSheetRefined, geminiSpriteSheet } = await import('../../src/services/GeminiApi.ts');
  const model = body.tier === 'champion' ? 'gemini-3-pro-image' : 'gemini-3.1-flash-image';
  const refined = body.tier !== 'rookie';
  const result = refined
    ? await geminiSheetRefined(
      body.primaryBase64,
      body.animation.name,
      body.animation.motion,
      body.animation.frames,
      body.secondaryBase64,
      undefined,
      body.normalizationReference,
      { enableBgRemoval: true },
      context,
      model,
      body.generationPrompt,
    )
    : await geminiSpriteSheet(
      body.primaryBase64,
      body.animation.name,
      body.animation.motion,
      body.animation.frames,
      body.secondaryBase64,
      undefined,
      body.normalizationReference,
      context,
      model,
      body.generationPrompt,
    );
  return {
    ...result,
    frameW: CELL_W,
    frameH: CELL_H,
  };
}

async function readJsonBody(request: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error('REQUEST_TOO_LARGE');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(response: import('node:http').ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') {
      sendJson(response, 200, { status: 'ok', runtime: 'canvas-skia' });
      return;
    }

    if (request.method === 'POST' && request.url === '/v1/clean-sheet') {
      const body = await readJsonBody(request) as CleanSheetRequest;
      if (
        !body.imageBase64 || !body.animationName ||
        !Number.isInteger(body.expectedFrameCount) ||
        !Number.isInteger(body.expectedGridCols) ||
        !Number.isInteger(body.expectedGridRows)
      ) {
        sendJson(response, 400, { error: 'Invalid clean-sheet request' });
        return;
      }
      const { cleanSpriteSheet } = await import('../../src/services/SpritePostProcess.ts');
      const result = await cleanSpriteSheet(
        body.imageBase64,
        body.expectedFrameCount,
        body.expectedGridCols,
        body.expectedGridRows,
        body.animationName,
        body.maxScale,
        body.normalizationReference,
      );
      sendJson(response, 200, result);
      return;
    }

    if (request.method === 'POST' && request.url === '/v1/generate-source') {
      const body = await readJsonBody(request) as GenerateSourceRequest;
      if (
        !isProviderContextRequest(body) ||
        !['repose', 'upright', 'crouch'].includes(body.operation) ||
        !body.imageBase64 ||
        (body.generationPrompt !== undefined && (
          typeof body.generationPrompt !== 'string' ||
          body.generationPrompt.trim().length < 180 ||
          body.generationPrompt.length > 3000
        ))
      ) {
        sendJson(response, 400, { error: 'Invalid generate-source request' });
        return;
      }
      sendJson(response, 200, await generateSource(body));
      return;
    }

    if (request.method === 'POST' && request.url === '/v1/measure-crouch-reference') {
      const body = await readJsonBody(request) as { imageBase64?: string };
      if (!body.imageBase64) {
        sendJson(response, 400, { error: 'Invalid crouch-reference request' });
        return;
      }
      sendJson(response, 200, {
        normalizationReference: await crouchNormalizationReference(body.imageBase64),
      });
      return;
    }

    if (request.method === 'POST' && request.url === '/v1/generate-sprite') {
      const body = await readJsonBody(request) as GenerateSpriteRequest;
      if (
        !isProviderContextRequest(body) ||
        !['rookie', 'contender', 'champion'].includes(body.tier) ||
        !body.primaryBase64 ||
        !body.animation?.name ||
        !body.animation.motion ||
        !Number.isInteger(body.animation.frames)
      ) {
        sendJson(response, 400, { error: 'Invalid generate-sprite request' });
        return;
      }
      sendJson(response, 200, await generateSprite(body));
      return;
    }

    sendJson(response, 404, { error: 'Not found' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown image processor error';
    const contentBlocked = error instanceof Error && error.name === 'GeminiContentBlockedError';
    const qualityRejected = error instanceof Error && error.name === 'GeminiOfficialSpriteQualityError';
    sendJson(
      response,
      message === 'REQUEST_TOO_LARGE' ? 413 : contentBlocked || qualityRejected ? 422 : 500,
      contentBlocked
        ? { error: message, code: 'provider_content_blocked' }
        : qualityRejected
          ? { error: message, code: 'official_quality_rejected' }
          : { error: message },
    );
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Insert Player image processor listening on ${port}`);
});
