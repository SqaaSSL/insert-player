import { GAME_HEIGHT, GAME_WIDTH } from '../game/constants.ts';
import { getFighterPersonality, type FighterPersonalityId } from '../game/match/MatchConfig.ts';
import { getStageTheme, type StageThemeId } from '../game/match/StageConfig.ts';
import { geminiStageBackground } from './GeminiApi.ts';
import { blobToBase64, resizeImageForApi } from './FreepikApi.ts';
import {
  getCachedMeta,
  getCachedStageBackground,
  setCachedStageBackground,
  type CachedStageBackground,
} from './SpriteCache.ts';

const STAGE_BACKGROUND_VERSION = 'stage-v1';
const inflightGenerations = new Map<string, Promise<CachedStageBackground>>();

export interface StageBackgroundRequest {
  matchSeed: number;
  stageId: StageThemeId;
  fighterOneName: string;
  fighterTwoName: string;
  fighterOnePersonalityId: FighterPersonalityId;
  fighterTwoPersonalityId: FighterPersonalityId;
  fighterOnePhotoHash?: string | null;
  fighterTwoPhotoHash?: string | null;
}

export function buildStageBackgroundKey(matchSeed: number, stageId: StageThemeId): string {
  return `${STAGE_BACKGROUND_VERSION}:${stageId}:${(matchSeed >>> 0).toString(16)}`;
}

export async function getCachedStageBackgroundForRequest(
  req: Pick<StageBackgroundRequest, 'matchSeed' | 'stageId'>,
): Promise<CachedStageBackground | null> {
  return getCachedStageBackground(buildStageBackgroundKey(req.matchSeed, req.stageId));
}

export async function ensureStageBackground(req: StageBackgroundRequest): Promise<CachedStageBackground> {
  const stageKey = buildStageBackgroundKey(req.matchSeed, req.stageId);
  const cached = await getCachedStageBackground(stageKey);
  if (cached) return cached;

  const existing = inflightGenerations.get(stageKey);
  if (existing) return existing;

  const promise = generateStageBackground(req, stageKey).finally(() => {
    inflightGenerations.delete(stageKey);
  });
  inflightGenerations.set(stageKey, promise);
  return promise;
}

async function generateStageBackground(req: StageBackgroundRequest, stageKey: string): Promise<CachedStageBackground> {
  const stage = getStageTheme(req.stageId);
  const fighterOneStyle = getFighterPersonality(req.fighterOnePersonalityId).label;
  const fighterTwoStyle = getFighterPersonality(req.fighterTwoPersonalityId).label;
  const referenceImages = await loadReferenceImages(req.fighterOnePhotoHash, req.fighterTwoPhotoHash);

  const result = await geminiStageBackground({
    stageLabel: stage.label,
    stageBlurb: stage.blurb,
    fighterOneName: req.fighterOneName,
    fighterTwoName: req.fighterTwoName,
    fighterOneStyle,
    fighterTwoStyle,
    referenceImages,
  });

  const pngBlob = await normalizeStageBackground(result.imageBase64);
  const cached: CachedStageBackground = {
    stageKey,
    prompt: result.prompt,
    pngBlob,
    createdAt: Date.now(),
  };

  await setCachedStageBackground(cached);
  return cached;
}

async function loadReferenceImages(
  fighterOnePhotoHash?: string | null,
  fighterTwoPhotoHash?: string | null,
): Promise<{ data: string; mime: string }[]> {
  const hashes = [fighterOnePhotoHash, fighterTwoPhotoHash].filter(Boolean) as string[];
  const refs: { data: string; mime: string }[] = [];

  for (const hash of hashes) {
    const meta = await getCachedMeta(hash);
    const blob = meta?.originalPhotoBlob ?? meta?.sideViewBlob ?? null;
    if (!blob) continue;

    const base64 = await blobToBase64(blob);
    const resized = await resizeImageForApi(base64);
    refs.push({ data: resized, mime: 'image/jpeg' });
  }

  return refs;
}

async function normalizeStageBackground(base64: string): Promise<Blob> {
  const img = await loadImg(`data:image/png;base64,${base64}`);
  const canvas = document.createElement('canvas');
  canvas.width = GAME_WIDTH;
  canvas.height = GAME_HEIGHT;
  const ctx = canvas.getContext('2d')!;

  const scale = Math.max(GAME_WIDTH / img.width, GAME_HEIGHT / img.height);
  const drawWidth = img.width * scale;
  const drawHeight = img.height * scale;
  const drawX = (GAME_WIDTH - drawWidth) / 2;
  const drawY = (GAME_HEIGHT - drawHeight) / 2;

  ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight);

  const grade = ctx.createLinearGradient(0, 0, 0, GAME_HEIGHT);
  grade.addColorStop(0, 'rgba(255, 255, 255, 0.02)');
  grade.addColorStop(0.6, 'rgba(255, 255, 255, 0)');
  grade.addColorStop(1, 'rgba(0, 0, 0, 0.05)');
  ctx.fillStyle = grade;
  ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

  return canvasToBlob(canvas);
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
