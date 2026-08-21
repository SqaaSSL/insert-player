import { GAME_HEIGHT, GAME_WIDTH } from '../game/constants.ts';
import { getFighterPersonality, type FighterPersonalityId } from '../game/match/MatchConfig.ts';
import { getStageTheme, type StageThemeId } from '../game/match/StageConfig.ts';
import { geminiStageBackground } from './GeminiApi.ts';
import { blobToBase64, resizeImageForApi } from './FreepikApi.ts';
import { captureApiRequestContext, runWithProviderSession } from './ApiClient.ts';
import { authorizeProviderSession } from './Billing.ts';
import {
  hashPhoto,
  getActiveSpriteCacheScope,
  getCachedMeta,
  getCachedStageBackground,
  setCachedStageBackground,
  type CachedStageBackground,
} from './SpriteCache.ts';

const STAGE_BACKGROUND_VERSION = 'stage-v1';
const inflightGenerations = new Map<string, Promise<CachedStageBackground>>();
export type StageBackgroundCacheScope = 'matchup' | 'stage';
const PHOTO_STAGE_PREFIX = `${STAGE_BACKGROUND_VERSION}:photo-ai-v2`;
const DIRECT_STAGE_PREFIX = `${STAGE_BACKGROUND_VERSION}:photo-direct-v1`;

interface NormalizeStageOptions {
  bottomShadeAlpha: number;
  verticalBias?: number;
}

export interface StageBackgroundRequest {
  matchSeed: number;
  stageId: StageThemeId;
  cacheScope?: StageBackgroundCacheScope;
  fighterOneName: string;
  fighterTwoName: string;
  fighterOnePersonalityId: FighterPersonalityId;
  fighterTwoPersonalityId: FighterPersonalityId;
  fighterOnePhotoHash?: string | null;
  fighterTwoPhotoHash?: string | null;
}

export function buildPhotoStageKey(photoHash: string): string {
  return `${PHOTO_STAGE_PREFIX}:${photoHash}`;
}

export function buildDirectPhotoStageKey(photoHash: string): string {
  return `${DIRECT_STAGE_PREFIX}:${photoHash}`;
}

export async function createPhotoStage(file: Blob, label?: string): Promise<CachedStageBackground> {
  const apiContext = captureApiRequestContext();
  const ownerScope = getActiveSpriteCacheScope();
  const photoHash = await hashPhoto(file);
  const stageKey = buildPhotoStageKey(photoHash);
  const cached = await getCachedStageBackground(stageKey, ownerScope);
  if (cached) return cached;

  const base64 = await blobToBase64(file);
  const resized = await resizeImageForApi(base64);
  const safeLabel = sanitizeStageLabel(label);
  const providerSession = await authorizeProviderSession('stage_background', apiContext);
  if (providerSession.error) throw new Error(providerSession.error);
  const result = await runWithProviderSession(providerSession.providerSessionId, (providerContext) =>
    geminiStageBackground({
      stageLabel: safeLabel,
      stageBlurb: 'Transform the supplied location photo into a stylized side-on 2D fighting game arena.',
      sourceImage: { data: resized, mime: 'image/jpeg' },
      sourceMode: 'transform-scene',
    }, providerContext),
  apiContext);
  const pngBlob = await normalizeStageImage(result.imageBase64, {
    bottomShadeAlpha: 0.04,
    verticalBias: 0.92,
  });
  const created: CachedStageBackground = {
    ownerScope,
    stageKey,
    prompt: result.prompt,
    pngBlob,
    createdAt: Date.now(),
    kind: 'photo',
    label: safeLabel,
  };

  await setCachedStageBackground(created);
  return created;
}

export async function createDirectPhotoStage(file: Blob, label?: string): Promise<CachedStageBackground> {
  const ownerScope = getActiveSpriteCacheScope();
  const photoHash = await hashPhoto(file);
  const stageKey = buildDirectPhotoStageKey(photoHash);
  const cached = await getCachedStageBackground(stageKey, ownerScope);
  if (cached) return cached;

  const safeLabel = sanitizeStageLabel(label);
  const pngBlob = await normalizeStageBlob(file, {
    bottomShadeAlpha: 0.02,
    verticalBias: 0.82,
  });
  const created: CachedStageBackground = {
    ownerScope,
    stageKey,
    prompt: 'Direct photo stage using the uploaded image without Gemini transformation.',
    pngBlob,
    createdAt: Date.now(),
    kind: 'photo-direct',
    label: safeLabel,
  };

  await setCachedStageBackground(created);
  return created;
}

export function buildStageBackgroundKey(
  matchSeed: number,
  stageId: StageThemeId,
  cacheScope: StageBackgroundCacheScope = 'matchup',
): string {
  if (cacheScope === 'stage') {
    return `${STAGE_BACKGROUND_VERSION}:${stageId}:stage-lock`;
  }
  return `${STAGE_BACKGROUND_VERSION}:${stageId}:${(matchSeed >>> 0).toString(16)}`;
}

export async function getCachedStageBackgroundForRequest(
  req: Pick<StageBackgroundRequest, 'matchSeed' | 'stageId' | 'cacheScope'>,
): Promise<CachedStageBackground | null> {
  return getCachedStageBackground(buildStageBackgroundKey(req.matchSeed, req.stageId, req.cacheScope));
}

export async function ensureStageBackground(req: StageBackgroundRequest): Promise<CachedStageBackground> {
  const apiContext = captureApiRequestContext();
  const ownerScope = getActiveSpriteCacheScope();
  const stageKey = buildStageBackgroundKey(req.matchSeed, req.stageId, req.cacheScope);
  const cached = await getCachedStageBackground(stageKey, ownerScope);
  if (cached) return cached;

  const operationKey = `${ownerScope}:${stageKey}`;
  const existing = inflightGenerations.get(operationKey);
  if (existing) return existing;

  const promise = generateStageBackground(req, stageKey, ownerScope, apiContext).finally(() => {
    inflightGenerations.delete(operationKey);
  });
  inflightGenerations.set(operationKey, promise);
  return promise;
}

async function generateStageBackground(
  req: StageBackgroundRequest,
  stageKey: string,
  ownerScope: string,
  apiContext: ReturnType<typeof captureApiRequestContext>,
): Promise<CachedStageBackground> {
  const stage = getStageTheme(req.stageId);
  const fighterOneStyle = getFighterPersonality(req.fighterOnePersonalityId).label;
  const fighterTwoStyle = getFighterPersonality(req.fighterTwoPersonalityId).label;
  const referenceImages = await loadReferenceImages(req.fighterOnePhotoHash, req.fighterTwoPhotoHash, ownerScope);

  const providerSession = await authorizeProviderSession('stage_background', apiContext);
  if (providerSession.error) throw new Error(providerSession.error);
  const result = await runWithProviderSession(providerSession.providerSessionId, (providerContext) =>
    geminiStageBackground({
      stageLabel: stage.label,
      stageBlurb: stage.blurb,
      fighterOneName: req.fighterOneName,
      fighterTwoName: req.fighterTwoName,
      fighterOneStyle,
      fighterTwoStyle,
      referenceImages,
    }, providerContext),
  apiContext);

  const pngBlob = await normalizeStageImage(result.imageBase64, {
    bottomShadeAlpha: 0.05,
  });
  const cached: CachedStageBackground = {
    ownerScope,
    stageKey,
    prompt: result.prompt,
    pngBlob,
    createdAt: Date.now(),
    kind: 'generated',
    label: stage.label,
  };

  await setCachedStageBackground(cached);
  return cached;
}

async function loadReferenceImages(
  fighterOnePhotoHash?: string | null,
  fighterTwoPhotoHash?: string | null,
  ownerScope = getActiveSpriteCacheScope(),
): Promise<{ data: string; mime: string }[]> {
  const hashes = [fighterOnePhotoHash, fighterTwoPhotoHash].filter(Boolean) as string[];
  const refs: { data: string; mime: string }[] = [];

  for (const hash of hashes) {
    const meta = await getCachedMeta(hash, ownerScope);
    const blob = meta?.originalPhotoBlob ?? meta?.sideViewBlob ?? null;
    if (!blob) continue;

    const base64 = await blobToBase64(blob);
    const resized = await resizeImageForApi(base64);
    refs.push({ data: resized, mime: 'image/jpeg' });
  }

  return refs;
}

async function normalizeStageImage(base64: string, options: NormalizeStageOptions): Promise<Blob> {
  const img = await loadImg(`data:image/png;base64,${base64}`);
  return normalizeLoadedStageImage(img, options);
}

async function normalizeStageBlob(blob: Blob, options: NormalizeStageOptions): Promise<Blob> {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImg(url);
    return normalizeLoadedStageImage(img, options);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function normalizeLoadedStageImage(img: HTMLImageElement, options: NormalizeStageOptions): Promise<Blob> {
  const { bottomShadeAlpha, verticalBias = 0.5 } = options;
  const canvas = document.createElement('canvas');
  canvas.width = GAME_WIDTH;
  canvas.height = GAME_HEIGHT;
  const ctx = canvas.getContext('2d')!;

  const scale = Math.max(GAME_WIDTH / img.width, GAME_HEIGHT / img.height);
  const drawWidth = img.width * scale;
  const drawHeight = img.height * scale;
  const drawX = (GAME_WIDTH - drawWidth) / 2;
  const overflowY = Math.max(0, drawHeight - GAME_HEIGHT);
  const drawY = overflowY > 0
    ? -overflowY * clamp(verticalBias, 0, 1)
    : (GAME_HEIGHT - drawHeight) / 2;

  ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight);

  const grade = ctx.createLinearGradient(0, 0, 0, GAME_HEIGHT);
  grade.addColorStop(0, 'rgba(255, 255, 255, 0.02)');
  grade.addColorStop(0.6, 'rgba(255, 255, 255, 0)');
  grade.addColorStop(1, `rgba(0, 0, 0, ${bottomShadeAlpha})`);
  ctx.fillStyle = grade;
  ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

  return canvasToBlob(canvas);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sanitizeStageLabel(label?: string): string {
  const trimmed = label?.trim();
  if (!trimmed) return 'PHOTO STAGE';
  const normalized = trimmed.replace(/\.[a-z0-9]+$/i, '').trim();
  return normalized.slice(0, 28) || 'PHOTO STAGE';
}

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Failed to encode stage background'));
        return;
      }
      resolve(blob);
    }, 'image/png');
  });
}
