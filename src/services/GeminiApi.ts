import { CELL_H, CELL_W, cleanReposedImagePreserveCanvas, cleanSpriteSheet, mirrorCleanFrames, computeGridCols, computeRequestedSpriteGrid, neutralizeGreenSpillForSegmentation, zoomTransparentImageToBottom, normalizeTransparentReposedImage, measureOpaqueBoundsFromBase64, type CleanSheetResult, type NormalizationReference } from './SpritePostProcess';
import { getAnimationProfile } from './AnimationProfiles';
import { debugInfo, debugWarn as debugConsoleWarn, publishDebugLog, publishDebugMultiline } from './DebugLog';
import { getConfiguredBgRemovalProvider, removeBackgroundWithConfiguredProvider } from './BackgroundRemovalService';
import { ApiSessionChangedError, apiFetch, type ApiRequestContext } from './ApiClient';
import { expandMirroredSequence } from './FrameSequence';
import { decontaminateGreenEdges, unionForegroundMasks } from './AlphaMask';
import {
  GeminiRequestError,
  RequestStartPacer,
  geminiErrorFromResponse,
  geminiNetworkError,
  isApprovedGeminiImageModel,
  retryGeminiRequest,
} from './GeminiRequestPolicy';
import {
  GEMINI_FLASH_IMAGE_MODEL,
  OFFICIAL_ARCADE_IMAGE_PROVIDER_CONTRACT,
} from './ImageProviderContract';

const GEMINI_BASE = '/proxy/gemini/v1beta/models';
const DEFAULT_GEMINI_IMAGE_MODEL = GEMINI_FLASH_IMAGE_MODEL;
const DEFAULT_GEMINI_SOURCE_MODEL = 'gemini-3-pro-image';
const OFFICIAL_GEMINI_REVIEW_MODEL = OFFICIAL_ARCADE_IMAGE_PROVIDER_CONTRACT.championAnimation.reviewModel;
const PRO_REQUEST_START_INTERVAL_MS = 11_000;
const geminiRequestPacer = new RequestStartPacer();

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

interface GeminiResponse {
  candidates?: Array<{
    content: { parts: GeminiPart[] };
    finishReason?: string;
  }>;
  promptFeedback?: {
    blockReason?: string;
    blockReasonMessage?: string;
  };
  error?: { code: number; message: string };
}

type GeminiResponseModality = 'TEXT' | 'IMAGE';

export class GeminiContentBlockedError extends Error {
  readonly blockReason: string;

  constructor(blockReason: string) {
    const normalizedReason = blockReason.trim() || 'UNKNOWN';
    super(`Gemini declined image generation (${normalizedReason})`);
    this.name = 'GeminiContentBlockedError';
    this.blockReason = normalizedReason;
  }
}

export function isGeminiContentBlockedError(error: unknown): boolean {
  return error instanceof GeminiContentBlockedError || (
    error instanceof Error && (
      error.name === 'GeminiContentBlockedError'
      || error.message.includes('IMAGE_SAFETY')
      || error.message.includes('IMAGE_OTHER')
    )
  );
}

export function geminiFinishReasonBlockReason(finishReason: string | null | undefined): string | null {
  const reason = finishReason?.trim();
  if (!reason) return null;
  return /SAFETY|BLOCK|PROHIBITED|IMAGE_OTHER/i.test(reason) ? reason : null;
}

export function geminiContentBlockReason(response: {
  promptFeedback?: { blockReason?: string };
}): string | null {
  const reason = response.promptFeedback?.blockReason?.trim();
  return reason || null;
}

function normalizedBase64Payload(value: string): string {
  const payload = value.includes(',') ? value.slice(value.indexOf(',') + 1) : value;
  return payload.replace(/\s+/g, '');
}

export function isPngBase64(value: string): boolean {
  try {
    const prefix = atob(normalizedBase64Payload(value).slice(0, 16));
    return prefix.length >= 8 &&
      prefix.charCodeAt(0) === 0x89 &&
      prefix.charCodeAt(1) === 0x50 &&
      prefix.charCodeAt(2) === 0x4e &&
      prefix.charCodeAt(3) === 0x47 &&
      prefix.charCodeAt(4) === 0x0d &&
      prefix.charCodeAt(5) === 0x0a &&
      prefix.charCodeAt(6) === 0x1a &&
      prefix.charCodeAt(7) === 0x0a;
  } catch {
    return false;
  }
}

export async function normalizeGeneratedImageToPng(
  value: string,
  declaredMimeType?: string | null,
): Promise<string> {
  const payload = normalizedBase64Payload(value);
  if (isPngBase64(payload)) return payload;

  const mimeType = declaredMimeType && /^image\/(?:jpe?g|png|webp)$/i.test(declaredMimeType)
    ? declaredMimeType
    : 'application/octet-stream';
  const image = await loadAlphaImage(`data:${mimeType};base64,${payload}`);
  if (!image.width || !image.height) throw new Error('Gemini returned an empty image');

  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create an image normalization canvas');
  context.drawImage(image, 0, 0);
  return canvas.toDataURL('image/png').split(',')[1];
}

type GeminiModelOperation = 'repose' | 'upright' | 'crouch' | 'sprite' | 'stage';

function normalizeModelEnvSegment(value: string): string {
  return value.trim().replace(/[^a-z0-9]+/gi, '_').toUpperCase();
}

function resolveGeminiImageModel(options?: {
  operation?: GeminiModelOperation;
  animationName?: string;
  modelOverride?: string;
}): string {
  if (options?.modelOverride && (options.operation === 'sprite' || options.animationName)) {
    return options.modelOverride;
  }

  const env = (import.meta as ImportMeta & {
    env?: Record<string, string | boolean | undefined>;
  }).env ?? {};
  const keys: string[] = [];

  if (options?.animationName) {
    keys.push(`VITE_GEMINI_IMAGE_MODEL_ANIM_${normalizeModelEnvSegment(options.animationName)}`);
  }
  if (options?.operation) {
    keys.push(`VITE_GEMINI_IMAGE_MODEL_${normalizeModelEnvSegment(options.operation)}`);
  }
  keys.push('VITE_GEMINI_IMAGE_MODEL');

  for (const key of keys) {
    const value = env[key];
    if (typeof value === 'string' && value.trim()) {
      if (
        options?.operation && ['repose', 'upright', 'crouch'].includes(options.operation) &&
        !value.toLowerCase().includes('pro')
      ) {
        return DEFAULT_GEMINI_SOURCE_MODEL;
      }
      return value.trim();
    }
  }

  if (options?.operation && ['repose', 'upright', 'crouch'].includes(options.operation)) {
    return DEFAULT_GEMINI_SOURCE_MODEL;
  }
  return DEFAULT_GEMINI_IMAGE_MODEL;
}

async function callGemini(
  prompt: string,
  imageBase64?: string,
  mimeType = 'image/png',
  extraImages?: { data: string; mime: string }[],
  modelOverride?: string,
  context?: ApiRequestContext,
  responseModalities: GeminiResponseModality[] = ['TEXT', 'IMAGE'],
): Promise<{ text: string; imageBase64: string | null; imageMime: string | null; finishReason: string | null }> {
  const model = modelOverride || DEFAULT_GEMINI_IMAGE_MODEL;
  if (!isApprovedGeminiImageModel(model)) {
    throw new GeminiRequestError({
      message: `Gemini image model is not approved for production: ${model}`,
      model,
      status: 0,
      code: 'provider_model_unapproved',
    });
  }
  const reqParts: GeminiPart[] = [];
  if (imageBase64) {
    reqParts.push({ inlineData: { mimeType, data: imageBase64 } });
  }
  if (extraImages) {
    for (const img of extraImages) {
      reqParts.push({ inlineData: { mimeType: img.mime, data: img.data } });
    }
  }
  reqParts.push({ text: prompt });

  const res = await retryGeminiRequest(async () => {
    if (model.toLowerCase().includes('pro')) {
      await geminiRequestPacer.wait(model, PRO_REQUEST_START_INTERVAL_MS);
    }
    let response: Response;
    try {
      response = await apiFetch(`${GEMINI_BASE}/${model}:generateContent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(context?.detached ? {
            'X-Insert-Player-Provider-Call-Kind': responseModalities.length === 1 && responseModalities[0] === 'TEXT'
              ? 'quality_review'
              : 'image_generation',
          } : {}),
        },
        body: JSON.stringify({
          contents: [{ parts: reqParts }],
          generationConfig: { responseModalities },
        }),
      }, context);
    } catch (error) {
      throw geminiNetworkError(model, error);
    }
    if (!response.ok) {
      const body = await response.text();
      throw geminiErrorFromResponse(model, response, body);
    }
    return response;
  }, {
    onRetry: ({ attempt, delayMs, error }) => {
      const seconds = Math.max(1, Math.ceil(delayMs / 1_000));
      debugWarn(
        `[GeminiApi] ${model} ${error.status || 'network'}; retry ${attempt}/5 in ${seconds}s`,
      );
    },
  });

  const json: GeminiResponse = await res.json();
  const candidate = json.candidates?.[0];
  if (!candidate) {
    console.error('[GeminiApi] No candidates. Full response:', JSON.stringify(json).slice(0, 500));
    const blockReason = geminiContentBlockReason(json);
    if (blockReason) throw new GeminiContentBlockedError(blockReason);
    throw new Error('Gemini returned no candidates');
  }

  const resParts = candidate.content?.parts;
  if (!resParts || !Array.isArray(resParts)) {
    const reason = candidate.finishReason || 'unknown';
    console.error(`[GeminiApi] No parts in response. finishReason: ${reason}`, JSON.stringify(candidate).slice(0, 500));
    const blockReason = geminiFinishReasonBlockReason(reason);
    if (blockReason) throw new GeminiContentBlockedError(blockReason);
    throw new Error(`Gemini returned no content (finishReason: ${reason})`);
  }

  let text = '';
  let imageData: { data: string; mimeType: string } | null = null;

  for (const part of resParts) {
    if (part.text) text += part.text;
    if (part.inlineData) imageData = part.inlineData;
  }

  const normalizedImageBase64 = imageData
    ? await normalizeGeneratedImageToPng(imageData.data, imageData.mimeType)
    : null;

  return {
    text,
    imageBase64: normalizedImageBase64,
    imageMime: normalizedImageBase64 ? 'image/png' : null,
    finishReason: candidate.finishReason ?? null,
  };
}

function loadAlphaImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// ─── Repose ──────────────────────────────────────────────────────────

const REPOSE_BASE = `Using this photo as reference, create a full-body fighting game character. Preserve the EXACT same visual style, art style, textures, colors, and level of detail from the original image — do NOT change the aesthetic. Keep the same face, hair, and skin tone faithfully. If only a face or upper body is shown, imagine and generate the rest of the body (legs, feet, full outfit) in a style consistent with what is visible. The character should be in a 3/4 view facing right in a fighting stance — fists raised, feet planted shoulder-width apart, slight forward lean. Show the COMPLETE body from head to feet with nothing cropped. Pure bright green (#00FF00) background — the entire background must be a flat, uniform, vivid green with no gradients or shadows.`;

const REPOSE_CLOTHING_FALLBACK = ` The character MUST be wearing a full fighting outfit — tank top or t-shirt, long pants or martial arts gi, and shoes/boots. Add clothing if the original has none. Keep the outfit style consistent with the character's aesthetic.`;

function syntheticTransformationFallback(prompt: string): string {
  return `This is a benign, non-deceptive artistic transformation of a licensed reference photo into a clearly synthetic game avatar. Do not depict a real event, injury, political message, endorsement, or documentary photograph. Keep the person fully clothed, use realistic adult anatomy, and avoid caricature or exaggeration.\n\n${prompt}${REPOSE_CLOTHING_FALLBACK}`;
}

const UPRIGHT_REPOSE_PROMPT = `Using this character as reference, create the SAME character in a clearly upright heroic standing pose.

Keep the exact 3/4 side-view facing right, the same face, outfit, proportions, and art style.
Keep the same camera distance and full-body framing. Do not shrink the character and do not zoom out.

The pose should be noticeably straighter and taller than the reference:
- stand upright with the torso lifted
- raise the hips
- straighten both legs much more than in the reference
- reduce the knee bend a lot
- keep the feet planted on the ground
- keep the head facing the same direction with no neck twist or sideways turn
- the arms can stay posed naturally, but do not use a boxing or fighting guard

The result should look like a confident upright hero pose, not an attack stance.

Use a solid pure bright green (#00FF00) background with no shadows, floor, or gradients.`;

export async function geminiReposeDetailed(
  photoBase64: string,
  context?: ApiRequestContext,
  promptOverride?: string,
): Promise<GeminiPoseResult> {
  const model = resolveGeminiImageModel({ operation: 'repose' });
  debugInfo(`[GeminiApi] Reposing character with ${model}...`);
  const start = Date.now();

  let rawBase64: string | null = null;

  const prompt = promptOverride?.trim() || REPOSE_BASE + ` Preserve the original clothing/outfit faithfully.`;
  try {
    const result = await callGemini(prompt, photoBase64, 'image/png', undefined, model, context);
    rawBase64 = result.imageBase64;
  } catch (err: any) {
    if (isGeminiContentBlockedError(err)) {
      if (promptOverride?.trim()) {
        debugWarn('[GeminiApi] Official licensed reference declined; skipping a duplicate paid retry.');
        throw err;
      }
      debugWarn('[GeminiApi] Repose declined by the provider, retrying as an explicitly synthetic transformation...');
    } else {
      throw err;
    }
  }

  if (!rawBase64) {
    debugInfo('[GeminiApi] Retrying repose with the safe synthetic-avatar prompt...');
    const result = await callGemini(
      syntheticTransformationFallback(prompt),
      photoBase64,
      'image/png',
      undefined,
      model,
      context,
    );
    rawBase64 = result.imageBase64;
  }

  if (!rawBase64) throw new Error('Gemini repose returned no image');

  debugInfo(`[GeminiApi] Repose raw done in ${((Date.now() - start) / 1000).toFixed(1)}s, cleaning...`);
  const cleaned = await cleanReposedImagePreserveCanvas(rawBase64);
  debugInfo(`[GeminiApi] Repose cleaned in ${((Date.now() - start) / 1000).toFixed(1)}s total`);

  return { rawBase64, cleanedBase64: cleaned };
}

export async function geminiRepose(photoBase64: string, context?: ApiRequestContext): Promise<string> {
  const result = await geminiReposeDetailed(photoBase64, context);
  return result.cleanedBase64;
}

export async function geminiUprightReposeDetailed(
  sideViewBase64: string,
  context?: ApiRequestContext,
): Promise<GeminiPoseResult> {
  const model = resolveGeminiImageModel({ operation: 'upright' });
  debugInfo(`[GeminiApi] Generating upright reference with ${model}...`);
  const start = Date.now();
  const rawBase64 = await generateGeminiImageWithSafetyFallback(UPRIGHT_REPOSE_PROMPT, sideViewBase64, model, context);
  debugInfo(`[GeminiApi] Upright raw done in ${((Date.now() - start) / 1000).toFixed(1)}s, cleaning...`);
  const cleaned = await cleanReposedImagePreserveCanvas(rawBase64);
  debugInfo(`[GeminiApi] Upright cleaned in ${((Date.now() - start) / 1000).toFixed(1)}s total`);
  publishDebugLog('[GeminiApi] Upright reference generated from side view');
  return { rawBase64, cleanedBase64: cleaned };
}

export async function geminiUprightRepose(sideViewBase64: string, context?: ApiRequestContext): Promise<string> {
  const result = await geminiUprightReposeDetailed(sideViewBase64, context);
  return result.cleanedBase64;
}

// ─── Crouch Repose ────────────────────────────────────────────────────

const CROUCH_REPOSE_PROMPT = `Using this fighting character as reference, create the SAME character in an extreme classic 2D fighting-game crouch defensive guard, as if the player is holding the down arrow.

Preserve the EXACT same visual style, art style, textures, colors, and level of detail from the reference image — do NOT change the aesthetic. Keep the same face, hair, skin tone, outfit, and proportions faithfully. The result must look like the same physical person from the reference simply lowered into a crouch. Do NOT redraw as a cartoon, anime, cel-shaded, illustrative, stylized, comic, flat-shaded, or otherwise re-interpreted version. Match the exact rendering technique, shading, linework density, and photographic/painterly feel of the reference — if the reference is photorealistic, the output must be photorealistic; if it is painted, it must stay painted in the same style.

Keep the exact 3/4 side-view facing right.
Keep the same camera distance and full-body framing. Do not shrink the character and do not zoom out.

This must look like a real arcade low hitbox crouch-block position:
- both feet stay planted on the ground
- bend both knees completely, fully folded into a deep full squat
- drop the hips extremely low
- bring the buttocks almost onto the ground, nearly touching the floor
- make the whole body as low as possible without sitting down or lying down
- drop the head and shoulders dramatically below the standing pose
- fold the torso tightly downward into a compact defensive posture
- tuck the elbows in close to the body
- keep the forearms and fists up in a protective guard near the chest and face
- keep the head facing the same direction with no neck twist or sideways turn
- the result should read as an extreme arcade-fighter down-arrow crouch-block / defensive guard, not a medium squat, not a half-crouch, and not a relaxed standing pose

Use a solid pure bright green (#00FF00) background with no shadows, floor, or gradients.`;

interface SilhouetteBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface SilhouetteMetrics extends SilhouetteBounds {
  aspectRatio: number;
  normCenterY: number;
  lowerHalfRatio: number;
}

export interface GeminiCrouchOption {
  id: string;
  label: string;
  imageBase64: string;
  previewBase64?: string;
  rawBase64?: string;
  score: number;
  valid: boolean;
  source: 'gemini';
  details: string;
}

export interface GeminiPoseResult {
  rawBase64: string;
  cleanedBase64: string;
}

function formatSilhouetteMetrics(metrics: SilhouetteMetrics | null): string {
  if (!metrics) return 'null';
  return `bbox=${metrics.w}x${metrics.h}@(${metrics.x},${metrics.y}) aspect=${metrics.aspectRatio.toFixed(3)} centerY=${metrics.normCenterY.toFixed(3)} lowerHalf=${metrics.lowerHalfRatio.toFixed(3)}`;
}

function debugLog(message: string): void {
  debugInfo(message);
  publishDebugLog(message);
}

function debugWarn(message: string): void {
  debugConsoleWarn(message);
  publishDebugLog(message);
}

function summarizePrompt(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').trim().slice(0, 220);
}

async function getImageDimensions(base64: string): Promise<{ width: number; height: number }> {
  const img = await loadAlphaImage(`data:image/png;base64,${base64}`);
  return { width: img.width, height: img.height };
}

async function generateGeminiImageWithSafetyFallback(
  prompt: string,
  imageBase64: string,
  modelOverride?: string,
  context?: ApiRequestContext,
): Promise<string> {
  let rawBase64: string | null = null;

  try {
    const result = await callGemini(prompt, imageBase64, 'image/png', undefined, modelOverride, context);
    rawBase64 = result.imageBase64;
  } catch (err: any) {
    if (isGeminiContentBlockedError(err)) {
      debugWarn('[GeminiApi] Prompt blocked by safety, retrying with clothing...');
      const result = await callGemini(prompt + REPOSE_CLOTHING_FALLBACK, imageBase64, 'image/png', undefined, modelOverride, context);
      rawBase64 = result.imageBase64;
    } else {
      throw err;
    }
  }

  if (!rawBase64) throw new Error('Gemini returned no image');
  return rawBase64;
}

async function getSilhouetteMetrics(base64: string): Promise<SilhouetteMetrics | null> {
  const img = await loadAlphaImage(`data:image/png;base64,${base64}`);
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let weightedY = 0;
  let totalAlpha = 0;
  let lowerHalfAlpha = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha <= 15) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      weightedY += alpha * y;
      totalAlpha += alpha;
    }
  }

  if (maxX < 0 || maxY < 0 || totalAlpha <= 0) return null;

  const boxHeight = maxY - minY + 1;
  const midY = minY + boxHeight / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha <= 15) continue;
      if (y >= midY) lowerHalfAlpha += alpha;
    }
  }

  return {
    x: minX,
    y: minY,
    w: maxX - minX + 1,
    h: boxHeight,
    aspectRatio: (maxX - minX + 1) / boxHeight,
    normCenterY: ((weightedY / totalAlpha) - minY) / boxHeight,
    lowerHalfRatio: lowerHalfAlpha / totalAlpha,
  };
}

function scoreCrouchPose(standing: SilhouetteMetrics | null, crouch: SilhouetteMetrics | null): number {
  if (!standing || !crouch) return 0;
  const aspectGain = crouch.aspectRatio / standing.aspectRatio;
  const centerDrop = crouch.normCenterY - standing.normCenterY;
  const lowerHalfGain = crouch.lowerHalfRatio - standing.lowerHalfRatio;
  const bottomDelta = Math.abs((standing.y + standing.h) - (crouch.y + crouch.h));

  let score = 0;
  score += Math.max(0, Math.min(35, (aspectGain - 1) * 240));
  score += Math.max(0, Math.min(35, centerDrop * 700));
  score += Math.max(0, Math.min(30, lowerHalfGain * 600));
  score += Math.max(0, Math.min(20, 20 - Math.max(0, bottomDelta - 16)));
  return score;
}

function isValidCrouchPose(standing: SilhouetteMetrics | null, crouch: SilhouetteMetrics | null): boolean {
  if (!standing || !crouch) return true;
  const aspectGain = crouch.aspectRatio / standing.aspectRatio;
  const centerDrop = crouch.normCenterY - standing.normCenterY;
  const lowerHalfGain = crouch.lowerHalfRatio - standing.lowerHalfRatio;
  const bottomDelta = Math.abs((standing.y + standing.h) - (crouch.y + crouch.h));
  return aspectGain >= 1.05 && centerDrop >= 0.03 && lowerHalfGain >= 0.03 && bottomDelta <= 16;
}

function describeCrouchOption(
  source: 'gemini',
  metrics: SilhouetteMetrics | null,
  score: number,
  valid: boolean,
): string {
  const verdict = valid ? 'VALID' : 'WEAK';
  return `${source.toUpperCase()}  SCORE ${score.toFixed(1)}  ${verdict}\n${formatSilhouetteMetrics(metrics)}`;
}

function pickBestCrouchOption(options: GeminiCrouchOption[]): GeminiCrouchOption | null {
  if (options.length === 0) return null;
  const sorted = [...options].sort((a, b) => {
    if (a.valid !== b.valid) return a.valid ? -1 : 1;
    return b.score - a.score;
  });
  return sorted[0] ?? null;
}

export async function geminiCrouchReposeOptions(
  sideViewBase64: string,
  normalizationReference?: NormalizationReference,
  standingMetricsBase64 = sideViewBase64,
  context?: ApiRequestContext,
): Promise<GeminiCrouchOption[]> {
  const model = resolveGeminiImageModel({ operation: 'crouch' });
  debugInfo(`[GeminiApi] Generating crouched view with ${model}...`);
  const start = Date.now();
  const inputSize = await getImageDimensions(sideViewBase64);
  const standingBounds = await getSilhouetteMetrics(standingMetricsBase64);
  debugLog(
    `[GeminiApi] Crouch Gemini input image: ${inputSize.width}x${inputSize.height}`,
  );
  debugLog(
    `[GeminiApi] Crouch standing metrics: ${formatSilhouetteMetrics(standingBounds)} ` +
    `reference=${normalizationReference ? `${Math.round(normalizationReference.targetDrawWidth ?? 0)}x${Math.round(normalizationReference.targetDrawHeight ?? 0)} baseline=${(normalizationReference.baselineRatio ?? 0).toFixed(3)}` : 'none'}`,
  );
  const promptVariants = [CROUCH_REPOSE_PROMPT];
  debugInfo('[GeminiApi] Crouch prompt:\n' + CROUCH_REPOSE_PROMPT);
  publishDebugLog(`[GeminiApi] Crouch prompt summary: ${summarizePrompt(CROUCH_REPOSE_PROMPT)}`);
  publishDebugMultiline(
    `[GeminiApi] Crouch prompt lines:\n${CROUCH_REPOSE_PROMPT}`,
  );
  const options: GeminiCrouchOption[] = [];

  for (let i = 0; i < promptVariants.length; i++) {
    const prompt = promptVariants[i];
    try {
      const rawBase64 = await generateGeminiImageWithSafetyFallback(prompt, sideViewBase64, model, context);
      debugLog(`[GeminiApi] Crouch attempt ${i + 1}/${promptVariants.length}: raw done in ${((Date.now() - start) / 1000).toFixed(1)}s, cleaning...`);
      const cleaned = await cleanReposedImagePreserveCanvas(rawBase64);
      const zoomed = await zoomTransparentImageToBottom(cleaned, 0.88);
      const crouchBounds = await getSilhouetteMetrics(cleaned);
      const score = scoreCrouchPose(standingBounds, crouchBounds);
      const valid = isValidCrouchPose(standingBounds, crouchBounds);
      debugLog(
        `[GeminiApi] Crouch attempt ${i + 1}/${promptVariants.length}: ` +
        `${formatSilhouetteMetrics(crouchBounds)} score=${score.toFixed(2)} valid=${valid}`,
      );
      options.push({
        id: `gemini_${i + 1}`,
        label: `GEMINI ${i + 1}`,
        imageBase64: zoomed,
        previewBase64: rawBase64,
        rawBase64,
        score,
        valid,
        source: 'gemini',
        details: describeCrouchOption('gemini', crouchBounds, score, valid),
      });

      if (valid) {
        debugLog(`[GeminiApi] Crouch candidate passed validation (score ${score.toFixed(1)})`);
      } else {
        debugWarn(`[GeminiApi] Flagged weak crouch candidate for manual review (score ${score.toFixed(1)})`);
      }
    } catch (err: any) {
      if (err instanceof ApiSessionChangedError || err instanceof GeminiRequestError) throw err;
      debugWarn(`[GeminiApi] Crouch attempt failed: ${err.message}`);
    }
  }

  debugLog(`[GeminiApi] Crouch repose finished in ${((Date.now() - start) / 1000).toFixed(1)}s total`);
  if (options.length === 0) throw new Error('Gemini crouch repose returned no image');
  return options;
}

export async function geminiCrouchRepose(
  sideViewBase64: string,
  normalizationReference?: NormalizationReference,
  standingMetricsBase64 = sideViewBase64,
  context?: ApiRequestContext,
): Promise<string> {
  const result = await geminiCrouchReposeDetailed(sideViewBase64, normalizationReference, standingMetricsBase64, context);
  return result.cleanedBase64;
}

export async function geminiCrouchReposeDetailed(
  sideViewBase64: string,
  normalizationReference?: NormalizationReference,
  standingMetricsBase64 = sideViewBase64,
  context?: ApiRequestContext,
): Promise<GeminiPoseResult> {
  const options = await geminiCrouchReposeOptions(sideViewBase64, normalizationReference, standingMetricsBase64, context);
  const chosen = pickBestCrouchOption(options);
  if (!chosen) throw new Error('Gemini crouch repose returned no image');
  if (!chosen.valid) {
    debugWarn('[GeminiApi] Falling back to best available crouch candidate');
  } else {
    debugLog(`[GeminiApi] Crouch repose accepted from ${chosen.label}`);
  }
  return {
    rawBase64: chosen.rawBase64 ?? chosen.previewBase64 ?? chosen.imageBase64,
    cleanedBase64: chosen.imageBase64,
  };
}

// ─── Sprite sheets ───────────────────────────────────────────────────

export interface GeminiSpriteResult {
  imageBase64: string;
  rawBase64: string;
  gridCols: number;
  gridRows: number;
  frameCount: number;
  usedScale: number;
}

export class PartialSpriteGenerationError extends Error {
  partialResult?: GeminiSpriteResult;

  constructor(message: string, partialResult?: GeminiSpriteResult) {
    super(message);
    this.name = 'PartialSpriteGenerationError';
    this.partialResult = partialResult;
  }
}

export class GeminiOfficialSpriteQualityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiOfficialSpriteQualityError';
  }
}

const MIRROR_ANIMS = new Set(['high_punch', 'low_punch', 'high_kick', 'low_kick']);
const IDLE_FRAME_DIRECTIONS = [
  'neutral ready guard matching the side-view reference almost exactly',
  'tiny inhale with a barely noticeable shoulder rise and torso lift',
  'very small weight shift forward while keeping both feet planted',
  'settle back toward center guard with hands still high',
  'tiny exhale with a subtle shoulder drop and relaxed guard tension',
  'very small weight shift backward while keeping the same full-body framing',
  'return toward the neutral center guard with only slight breathing motion',
  'neutral ready guard again so the loop connects cleanly back to frame 1',
];

export function geminiSpriteSequenceEndNote(
  animName: string,
  frameCount: number,
  hasTwoRefs: boolean,
  shouldMirror: boolean,
): string {
  if (animName === 'idle') {
    return hasTwoRefs
      ? `- IMAGE 1 shows the START guard (frame 1) and IMAGE 2 shows the required END guard (frame ${frameCount}). Frames 2 through ${frameCount - 1} may show only subtle breathing and weight shift. Frame ${frameCount} must return to IMAGE 2's fighting-ready pose with both fists raised, feet planted, and a silhouette that connects cleanly back to frame 1.`
      : `- Frame 1 starts in a fighting-ready guard with both fists raised and feet planted. Middle frames show only subtle breathing and weight shift. Frame ${frameCount} must return to the same raised guard, silhouette, floor line, and body alignment as frame 1 so the loop closes cleanly.`;
  }
  if (hasTwoRefs) {
    return `- IMAGE 1 (first reference) shows the START pose (frame 1). IMAGE 2 (second reference) shows the END pose (frame ${frameCount}). The animation must smoothly transition between these two poses across all ${frameCount} frames.`;
  }
  if (shouldMirror) {
    return `- Frame 1 is the resting stance. Each subsequent frame progresses the motion further. Frame ${frameCount} is the peak/impact moment of the action. Do NOT show the character returning to stance — only the wind-up through impact.`;
  }
  return `- Frame 1 starts in the base stance. The motion progresses gradually through the middle frames. The final frame returns to or finishes the pose.`;
}

function getMinimumReliableFrames(animName: string): number {
  if (animName === 'idle') return 8;
  if (animName === 'walk') return 12;
  if (animName === 'jump') return 3;
  if (animName === 'hit') return 2;
  if (animName === 'low_punch' || animName === 'low_kick') return 3;
  if (animName === 'ko') return 8;
  if (animName === 'victory') return 6;
  return 1;
}

interface IdleFramingReference extends NormalizationReference {
  widthRatio: number;
  heightRatio: number;
  bottomRatio: number;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

async function buildIdleFramingReference(sideViewBase64: string): Promise<IdleFramingReference> {
  const bbox = await measureOpaqueBoundsFromBase64(sideViewBase64);
  const { width, height } = await getImageDimensions(sideViewBase64);
  const profile = getAnimationProfile('idle');

  if (!bbox || width <= 0 || height <= 0) {
    return {
      targetDrawWidth: Math.round(CELL_W * profile.targetWidthRatio),
      targetDrawHeight: Math.round(CELL_H * profile.targetHeightRatio),
      baselineRatio: profile.baselineRatio,
      widthRatio: profile.targetWidthRatio,
      heightRatio: profile.targetHeightRatio,
      bottomRatio: profile.baselineRatio,
    };
  }

  const widthRatio = bbox.w / width;
  const heightRatio = bbox.h / height;
  const bottomRatio = (bbox.y + bbox.h) / height;

  return {
    targetDrawWidth: Math.round(CELL_W * clampNumber(widthRatio, 0.45, 0.9)),
    targetDrawHeight: Math.round(CELL_H * clampNumber(heightRatio, 0.55, 0.95)),
    baselineRatio: clampNumber(bottomRatio, 0.72, 0.99),
    widthRatio,
    heightRatio,
    bottomRatio,
  };
}

async function validateIdleFrameFraming(
  cleanedBase64: string,
  reference: IdleFramingReference,
): Promise<{ valid: boolean; details: string }> {
  const bbox = await measureOpaqueBoundsFromBase64(cleanedBase64);
  const { width, height } = await getImageDimensions(cleanedBase64);

  if (!bbox || width <= 0 || height <= 0) {
    return { valid: false, details: 'no visible fighter silhouette found' };
  }

  const widthRatio = bbox.w / width;
  const heightRatio = bbox.h / height;
  const bottomRatio = (bbox.y + bbox.h) / height;
  const leftMarginRatio = bbox.x / width;
  const rightMarginRatio = (width - (bbox.x + bbox.w)) / width;
  const topMarginRatio = bbox.y / height;
  const touchesLeft = bbox.x <= 1;
  const touchesRight = bbox.x + bbox.w >= width - 1;
  const touchesTop = bbox.y <= 1;
  const touchesBottom = bbox.y + bbox.h >= height - 1;

  const valid =
    heightRatio >= reference.heightRatio * 0.62 &&
    heightRatio <= Math.min(0.985, reference.heightRatio * 1.32) &&
    widthRatio >= reference.widthRatio * 0.6 &&
    widthRatio <= Math.min(0.96, reference.widthRatio * 1.35) &&
    bottomRatio >= 0.7 &&
    leftMarginRatio >= 0.004 &&
    rightMarginRatio >= 0.004 &&
    topMarginRatio >= 0.004 &&
    !touchesLeft &&
    !touchesRight &&
    !touchesTop &&
    !touchesBottom;

  return {
    valid,
    details:
      `bbox=${bbox.w}x${bbox.h}@(${bbox.x},${bbox.y}) ` +
      `w=${widthRatio.toFixed(3)} h=${heightRatio.toFixed(3)} bottom=${bottomRatio.toFixed(3)} ` +
      `margins=${leftMarginRatio.toFixed(3)}/${topMarginRatio.toFixed(3)}/${rightMarginRatio.toFixed(3)} ` +
      `touch=${Number(touchesLeft)}/${Number(touchesTop)}/${Number(touchesRight)}/${Number(touchesBottom)}`,
  };
}

async function buildIdleFallbackFrame(
  sideViewBase64: string,
  previousFrameBase64: string | undefined,
  reference: IdleFramingReference,
): Promise<{ base64: string; source: 'previous' | 'side_view' }> {
  if (previousFrameBase64) {
    return { base64: previousFrameBase64, source: 'previous' };
  }

  const cleanedSideView = await cleanReposedImagePreserveCanvas(sideViewBase64);
  const normalizedSideView = await normalizeTransparentReposedImage(cleanedSideView, 'idle', reference);
  return { base64: normalizedSideView, source: 'side_view' };
}

async function composeFramesToSheet(frameBase64s: string[], gridCols: number, gridRows: number): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = CELL_W * gridCols;
  canvas.height = CELL_H * gridRows;
  const ctx = canvas.getContext('2d')!;

  const images = await Promise.all(
    frameBase64s.map((base64) => loadAlphaImage(`data:image/png;base64,${base64}`)),
  );

  for (let i = 0; i < images.length; i++) {
    const col = i % gridCols;
    const row = Math.floor(i / gridCols);
    ctx.drawImage(images[i], col * CELL_W, row * CELL_H, CELL_W, CELL_H);
  }

  return canvas.toDataURL('image/png').split(',')[1];
}

async function generateIdleFrameWithGemini(
  prompt: string,
  sideViewBase64: string,
  previousFrameBase64: string | undefined,
  model: string,
  context?: ApiRequestContext,
): Promise<string | null> {
  const extras = previousFrameBase64
    ? [{ data: previousFrameBase64, mime: 'image/png' }]
    : undefined;

  try {
    const result = await callGemini(prompt, sideViewBase64, 'image/png', extras, model, context);
    if (!result.imageBase64) {
      debugWarn(
        `[GeminiApi] idle frame: Gemini returned no image` +
          `${result.finishReason ? ` (finishReason: ${result.finishReason})` : ''}` +
          `${result.text ? ` | text: ${result.text.replace(/\s+/g, ' ').trim().slice(0, 220)}` : ''}`,
      );
    }
    return result.imageBase64;
  } catch (err: any) {
    if (!isGeminiContentBlockedError(err)) {
      throw err;
    }
    const result = await callGemini(prompt + REPOSE_CLOTHING_FALLBACK, sideViewBase64, 'image/png', extras, model, context);
    if (!result.imageBase64) {
      debugWarn(
        `[GeminiApi] idle frame safety retry returned no image` +
          `${result.finishReason ? ` (finishReason: ${result.finishReason})` : ''}` +
          `${result.text ? ` | text: ${result.text.replace(/\s+/g, ' ').trim().slice(0, 220)}` : ''}`,
      );
    }
    return result.imageBase64;
  }
}

function buildIdleFramePrompt(
  frameIndex: number,
  totalFrames: number,
  direction: string,
  hasPreviousFrame: boolean,
  strictAttempt: number,
  reference: IdleFramingReference,
): string {
  const strictLines =
    strictAttempt === 0
      ? []
      : [
          `- CRITICAL: reject any close-up, bust, waist-up, or feet-cropped composition.`,
          `- CRITICAL: copy the entire side-view full-body composition from IMAGE 1 before applying the micro-motion.`,
          `- CRITICAL: if needed, make the fighter slightly smaller instead of cropping any body part.`,
        ];

  return [
    `Generate a single image for frame ${frameIndex + 1} of ${totalFrames} of a classic 2D fighting-game idle loop.`,
    ``,
    `STYLE LOCK (CRITICAL):`,
    `- Preserve the EXACT same visual style, art style, textures, colors, and level of detail from IMAGE 1 — do NOT change the aesthetic.`,
    `- The output must look like the same physical person from IMAGE 1, just in a slightly different pose. Do NOT redraw as a cartoon, anime, cel-shaded, illustrative, comic, watercolour, painted, stylized, or otherwise re-interpreted version.`,
    `- Match the exact rendering technique, shading style, linework density, and photographic/painterly feel of IMAGE 1 — if IMAGE 1 is photorealistic, the output must stay photorealistic; if it is painted, stay in the exact same painted style.`,
    `- Preserve the same face, hair, skin tone, outfit, and proportions faithfully. No clothing changes, no new props, no accessory drift.`,
    ``,
    `REFERENCE RULES:`,
    `- IMAGE 1 is the canonical side-view identity, scale, full-body framing, AND visual style anchor.`,
    hasPreviousFrame
      ? `- IMAGE 2 is the previous accepted idle frame. Stay very close to IMAGE 2 for continuity, but apply the requested micro-change for this frame. If IMAGE 2 has drifted visually from IMAGE 1, trust IMAGE 1 for style.`
      : `- There is no IMAGE 2 for frame 1, so match IMAGE 1 almost exactly.`,
    ``,
    `FRAMING RULES (CRITICAL):`,
    `- Show the COMPLETE fighter from head to feet. No busts, no waist-up crops, no missing shoes, no cropped elbows.`,
    `- Respect the entire side-view framing from IMAGE 1. Do not crop closer than the reference image at any point.`,
    `- Keep the fighter occupying roughly ${Math.round(reference.heightRatio * 100)}% of the image height and ${Math.round(reference.widthRatio * 100)}% of the image width.`,
    `- Keep the feet on the same floor line as IMAGE 1, with the silhouette bottom near ${Math.round(reference.bottomRatio * 100)}% of the image height.`,
    `- No zoom, no camera move, no reframing, no dramatic pose change.`,
    ``,
    `MOTION RULE FOR THIS FRAME:`,
    `- ${direction}.`,
    `- This is a tiny full-body idle motion only: subtle breathing and weight shift, nothing bigger.`,
    ``,
    `OUTPUT RULES:`,
    `- Return exactly one image, not a sprite sheet.`,
    `- Use a solid pure bright green (#00FF00) background with no gradients, shadows, or floor.`,
    ...strictLines,
  ].join('\n');
}

export async function geminiIdleFrameSequence(
  sideViewBase64: string,
  frames: number,
  _maxScale?: number,
  context?: ApiRequestContext,
  modelOverride?: string,
): Promise<GeminiSpriteResult> {
  const model = resolveGeminiImageModel({ operation: 'sprite', animationName: 'idle', modelOverride });
  const frameDirections =
    frames === IDLE_FRAME_DIRECTIONS.length
      ? IDLE_FRAME_DIRECTIONS
      : Array.from({ length: frames }, (_, index) =>
          index === 0 || index === frames - 1
            ? 'neutral ready guard matching the side-view reference almost exactly'
            : `tiny breathing and weight-shift variation for frame ${index + 1}`,
        );
  const gridCols = computeGridCols(frames);
  const gridRows = Math.ceil(frames / gridCols);
  const reference = await buildIdleFramingReference(sideViewBase64);
  const acceptedFrames: string[] = [];
  let previousFrameBase64: string | undefined;
  const start = Date.now();

  debugInfo(`[GeminiApi] Generating idle with ${model} as ${frames} individual frames (${gridCols}x${gridRows})...`);
  debugLog(
    `[GeminiApi] Idle framing reference: target=${Math.round(reference.targetDrawWidth ?? 0)}x${Math.round(reference.targetDrawHeight ?? 0)} ` +
    `baseline=${(reference.baselineRatio ?? 0).toFixed(3)} occupancy=${reference.widthRatio.toFixed(3)}x${reference.heightRatio.toFixed(3)}`,
  );

  for (let frameIndex = 0; frameIndex < frames; frameIndex++) {
    let acceptedFrame: string | null = null;
    let bestCandidate: { base64: string; valid: boolean; details: string } | null = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      const prompt = buildIdleFramePrompt(
        frameIndex,
        frames,
        frameDirections[frameIndex] ?? IDLE_FRAME_DIRECTIONS[frameIndex % IDLE_FRAME_DIRECTIONS.length],
        !!previousFrameBase64,
        attempt,
        reference,
      );
      const rawBase64 = await generateIdleFrameWithGemini(prompt, sideViewBase64, previousFrameBase64, model, context);
      if (!rawBase64) continue;

      const cleaned = await cleanReposedImagePreserveCanvas(rawBase64);
      const validation = await validateIdleFrameFraming(cleaned, reference);
      debugLog(
        `[GeminiApi] Idle frame ${frameIndex + 1}/${frames} attempt ${attempt + 1}/3: ${validation.details} valid=${validation.valid}`,
      );

      if (!bestCandidate) {
        bestCandidate = { base64: cleaned, valid: validation.valid, details: validation.details };
      }

      if (!validation.valid) {
        continue;
      }

      acceptedFrame = await normalizeTransparentReposedImage(cleaned, 'idle', reference);
      previousFrameBase64 = acceptedFrame;
      break;
    }

    if (!acceptedFrame) {
      const fallback = await buildIdleFallbackFrame(sideViewBase64, previousFrameBase64, reference);
      acceptedFrame = fallback.base64;
      previousFrameBase64 = acceptedFrame;
      debugWarn(
        `[GeminiApi] Idle frame ${frameIndex + 1}/${frames}: using ${fallback.source} fallback after 3 rejected attempts` +
          `${bestCandidate ? ` | best=${bestCandidate.details}` : ''}`,
      );
    }

    acceptedFrames.push(acceptedFrame);
  }

  const sheetBase64 = await composeFramesToSheet(acceptedFrames, gridCols, gridRows);
  debugInfo(`[GeminiApi] idle frame-by-frame finished in ${((Date.now() - start) / 1000).toFixed(1)}s`);

  return {
    imageBase64: sheetBase64,
    rawBase64: sheetBase64,
    gridCols,
    gridRows,
    frameCount: frames,
    usedScale: 1,
  };
}

export function geminiOfficialSpritePrompt(
  description: string,
  animationRequirements: string,
): string {
  return [
    `Create an unofficial, clearly AI-generated premium 2.5D arcade animation from the approved reference artwork supplied with this request.`,
    `REFERENCE LOCK (CRITICAL):`,
    `- IMAGE 1 is the canonical identity, face, hair, skin tone, build, outfit, rendering style, starting pose, scale, framing, and floor-line reference.`,
    `- IMAGE 2, when present, is the ending-pose reference and must preserve the same identity and outfit as IMAGE 1.`,
    `- Preserve the recognizable facial structure and every stable visual feature from IMAGE 1 throughout the sheet.`,
    `- The approved character brief below is supplementary wardrobe and art direction. If it conflicts with visible identity or anatomy in IMAGE 1, IMAGE 1 controls.`,
    `- The animation, pose, frame count, grid, and framing requirements below override any neutral pose mentioned in the character description.`,
    `- Every populated cell must contain exactly one anatomically complete character with no duplicate or detached limbs.`,
    ``,
    `APPROVED CHARACTER BRIEF:`,
    description.trim(),
    ``,
    animationRequirements,
  ].join('\n');
}

export async function geminiSpriteSheet(
  characterBase64: string,
  animName: string,
  motion: string,
  frames: number,
  secondaryBase64?: string,
  maxScale?: number,
  normalizationReference?: NormalizationReference,
  context?: ApiRequestContext,
  modelOverride?: string,
  officialDescription?: string,
): Promise<GeminiSpriteResult> {
  const shouldMirror = MIRROR_ANIMS.has(animName);
  const profile = getAnimationProfile(animName);
  const model = resolveGeminiImageModel({ operation: 'sprite', animationName: animName, modelOverride });

  const genFrames = shouldMirror ? Math.ceil(frames / 2) : frames;
  const requestedGrid = computeRequestedSpriteGrid(animName, genFrames);
  const gridCols = requestedGrid.cols;
  const gridRows = requestedGrid.rows;

  const motionDesc = shouldMirror
    ? motion.replace(/then (?:returning|retracting|back) to stance/i, '').replace(/,\s*$/, '').trim()
    : motion;

  const hasTwoRefs = !!secondaryBase64;

  const endNote = geminiSpriteSequenceEndNote(animName, genFrames, hasTwoRefs, shouldMirror);

  const targetHeightPct = Math.round(((normalizationReference?.targetDrawHeight ?? CELL_H * profile.targetHeightRatio) / CELL_H) * 100);
  const targetWidthPct = Math.round(((normalizationReference?.targetDrawWidth ?? CELL_W * profile.targetWidthRatio) / CELL_W) * 100);

  const prompt = [
    `Generate a sprite sheet of this exact character performing: ${motionDesc}.`,
    ``,
    `STRICT LAYOUT RULES:`,
    `- The image must be a single image containing a grid of EXACTLY ${gridCols} columns and ${gridRows} rows.`,
    `- That means EXACTLY ${genFrames} cells total — no more, no fewer.`,
    `- Every cell must be the same size. Every row must have exactly ${gridCols} cells.`,
    ``,
    `ANIMATION RULES:`,
    `- Frames are read left-to-right, top-to-bottom (frame 1 is top-left, frame ${genFrames} is bottom-right).`,
    `- The frames must form a smooth, sequential animation — each frame shows the next step of the motion.`,
    endNote,
    ...(animName === 'idle' ? [
      `- This is a closed idle loop, never a transition into a relaxed neutral pose. Keep both hands in a raised combat guard in every frame.`,
      `- The final frame must visually match the first frame's raised guard closely enough that playback has no posture jump.`,
    ] : []),
    `- The character must face right in every frame.`,
    ...profile.promptRules.map((rule) => `- ${rule}`),
    ``,
    `FRAMING RULES (CRITICAL):`,
    `- EVERY frame MUST show the COMPLETE character from head to feet — never crop or zoom in.`,
    `- The character must be the SAME SIZE in every frame — do NOT zoom in or out between frames.`,
    `- Treat the uploaded reference image as the exact framing template. Match its camera distance, full-body crop, and overall composition; never crop closer than the reference image.`,
    `- Frame the character so they occupy roughly ${targetHeightPct}% of the cell height and at most ${targetWidthPct}% of the cell width.`,
    `- Keep the feet near the same floor line close to the bottom of every cell.`,
    `- Even for subtle animations, maintain the EXACT same camera distance and framing as the reference image.`,
    ``,
    `STYLE RULES (CRITICAL):`,
    `- Preserve the EXACT same visual style, art style, textures, colors, and level of detail from the reference image — do NOT change the aesthetic.`,
    `- Every frame must look like the same physical person from the reference, just in a different pose. Do NOT redraw as a cartoon, anime, cel-shaded, illustrative, comic, watercolour, painted, stylized, or otherwise re-interpreted version.`,
    `- Match the exact rendering technique, shading style, linework density, and photographic/painterly feel of the reference — if the reference is photorealistic, every frame must stay photorealistic; if it is painted, stay in the exact same painted style across every frame.`,
    `- Preserve the same face, hair, skin tone, outfit, and proportions faithfully across every frame. No clothing changes, no new props, no accessory drift between frames.`,
    `- Each frame shows the complete character at the same scale and vertical position.`,
    `- Pure bright green (#00FF00) background in every cell — flat, uniform, vivid green with no gradients, shadows, or ground.`,
  ].join('\n');

  debugInfo(`[GeminiApi] Generating sprite: ${animName} with ${model} (${gridCols}x${gridRows}, ${genFrames} frames${shouldMirror ? ', will mirror to ' + frames : ''})...`);
  const start = Date.now();

  const official = officialDescription?.trim();
  const primaryBase64 = characterBase64;
  const extras = secondaryBase64
    ? [{
      data: secondaryBase64,
      mime: 'image/png',
    }]
    : undefined;
  const minReliableFrames = getMinimumReliableFrames(animName);
  const requiredReliableFrames = official ? genFrames : minReliableFrames;
  const basePrompt = official
    ? geminiOfficialSpritePrompt(official, prompt)
    : prompt;
  const promptVariants = [basePrompt];
  promptVariants.push(
    `${basePrompt}\n- CRITICAL OUTPUT RULE: return exactly one sprite sheet image and no explanatory text.\n- CRITICAL OUTPUT RULE: do not answer with text only, markdown, or notes.\n- CRITICAL OUTPUT RULE: if uncertain, still return the requested sprite sheet image with the exact grid layout.`,
  );
  if (animName === 'jump' || animName === 'hit') {
    promptVariants.push(
      `${basePrompt}\n- CRITICAL: keep every full body centered fully inside its own cell with empty green margin on all sides.\n- CRITICAL: if a pose would cross a cell boundary, make the pose smaller instead of cropping it.\n- CRITICAL: do not include any oversized hero frame, close-up frame, or pose that spans more than one cell.`,
    );
  } else if (animName === 'idle' || animName === 'walk') {
    promptVariants.push(
      `${basePrompt}\n- CRITICAL: every one of the ${genFrames} cells must contain a complete full-body fighter from head to feet.\n- CRITICAL: do not crop or zoom into any middle frame; no half-body, waist-up, or torso-only cells.\n- CRITICAL: keep the same full-body framing in all rows of the sheet; do not switch to closer framing in the middle rows.\n- CRITICAL: if needed, make the fighter slightly smaller so the full body stays visible in every cell with green margin around it.`,
    );
    promptVariants.push(
      `${basePrompt}\n- CRITICAL: preserve the same headroom, visible feet, and full-body crop in every one of the ${genFrames} cells.\n- CRITICAL: this sheet fails if even one cell is bust-only, waist-up, or missing feet.\n- CRITICAL: it is better to make the fighter slightly smaller in every cell than to crop any body part.`,
    );
  } else if (animName === 'ko') {
    promptVariants.push(
      `${basePrompt}\n- CRITICAL: all ${genFrames} cells must contain one complete, self-contained fighter silhouette with green margin around it.\n- CRITICAL: the final downed poses must be compact, diagonal, and bent at the knees so each whole body fits in one cell.\n- CRITICAL: never draw one horizontal body across two neighboring cells and never split torso and legs between cells.`,
    );
  } else if (animName === 'victory') {
    promptVariants.push(
      `${basePrompt}\n- CRITICAL: preserve the full-body camera distance in all ${genFrames} cells.\n- CRITICAL: every celebratory pose must include the complete head, torso, legs, and both feet with green margin on every side.\n- CRITICAL: no close-up, waist-up, torso-only, cropped-foot, or enlarged hero framing.`,
    );
  } else if (animName === 'low_punch' || animName === 'low_kick') {
    promptVariants.push(
      `${basePrompt}\n- CRITICAL: every populated cell must contain exactly one full-body character from head to feet.\n- CRITICAL: do not leave internal cells empty; all ${genFrames} cells must show a valid sequential step of the move.\n- CRITICAL: do not include any oversized close-up pose, merged multi-cell pose, or cropped body.\n- CRITICAL: keep the character low to the ground while still fully contained inside each cell with visible green margin around the silhouette.`,
    );
  }

  let geminiRawBase64: string | null = null;
  let cleaned: CleanSheetResult | null = null;

  for (const attemptPrompt of promptVariants) {
    let rawBase64: string | null = null;

    try {
      const result = await callGemini(
        attemptPrompt,
        primaryBase64,
        'image/png',
        extras,
        model,
        context,
      );
      rawBase64 = result.imageBase64;
      if (!rawBase64) {
        debugWarn(
          `[GeminiApi] ${animName}: Gemini returned no image` +
            `${result.finishReason ? ` (finishReason: ${result.finishReason})` : ''}` +
            `${result.text ? ` | text: ${result.text.replace(/\s+/g, ' ').trim().slice(0, 220)}` : ''}`,
        );
      }
    } catch (err: any) {
      if (isGeminiContentBlockedError(err)) {
        debugWarn(`[GeminiApi] Sprite ${animName} blocked by safety, retrying with clothing note...`);
        const safePrompt = attemptPrompt + `\n\nIMPORTANT: The character must be fully clothed in a fighting outfit (shirt, pants, shoes). Add clothing if needed.`;
        const result = await callGemini(
          safePrompt,
          primaryBase64,
          'image/png',
          extras,
          model,
          context,
        );
        rawBase64 = result.imageBase64;
        if (!rawBase64) {
          debugWarn(
            `[GeminiApi] ${animName}: Gemini safety retry returned no image` +
              `${result.finishReason ? ` (finishReason: ${result.finishReason})` : ''}` +
              `${result.text ? ` | text: ${result.text.replace(/\s+/g, ' ').trim().slice(0, 220)}` : ''}`,
          );
        }
      } else {
        throw err;
      }
    }

    if (!rawBase64) continue;

    const nextCleaned = await cleanSpriteSheet(rawBase64, genFrames, gridCols, gridRows, animName, maxScale, normalizationReference);
    geminiRawBase64 = rawBase64;
    cleaned = nextCleaned;
    if (nextCleaned.frameCount >= requiredReliableFrames) {
      break;
    }

    debugWarn(
      `[GeminiApi] ${animName}: rejected attempt with only ${nextCleaned.frameCount} reliable frames (need ${requiredReliableFrames})`,
    );
  }

  if (!geminiRawBase64 || !cleaned) {
    throw new Error(`Gemini sprite sheet for ${animName} returned no image`);
  }
  if (cleaned.frameCount < requiredReliableFrames) {
    const message = `Gemini sprite sheet for ${animName} only produced ${cleaned.frameCount} reliable frames (need ${requiredReliableFrames})`;
    if (official) throw new GeminiOfficialSpriteQualityError(message);
    throw new PartialSpriteGenerationError(message, {
      imageBase64: cleaned.base64,
      rawBase64: geminiRawBase64,
      gridCols: cleaned.gridCols,
      gridRows: cleaned.gridRows,
      frameCount: cleaned.frameCount,
      usedScale: cleaned.usedScale,
    });
  }

  debugInfo(`[GeminiApi] ${animName} cleaned in ${((Date.now() - start) / 1000).toFixed(1)}s (scale ${cleaned.usedScale.toFixed(2)})`);

  if (shouldMirror) {
    const mirrored = await mirrorCleanFrames(cleaned.base64, cleaned.frameCount, frames, cleaned.gridCols, cleaned.gridRows);
    return {
      imageBase64: mirrored.base64,
      rawBase64: geminiRawBase64,
      gridCols: mirrored.gridCols,
      gridRows: mirrored.gridRows,
      frameCount: mirrored.frameCount,
      usedScale: cleaned.usedScale,
    };
  }

  return {
    imageBase64: cleaned.base64,
    rawBase64: geminiRawBase64,
    gridCols: cleaned.gridCols,
    gridRows: cleaned.gridRows,
    frameCount: cleaned.frameCount,
    usedScale: cleaned.usedScale,
  };
}

// ─── Sheet-then-refine (coherent sheet + per-frame high-res refine) ──

async function splitSheetIntoCells(
  sheetBase64: string,
  gridCols: number,
  gridRows: number,
  frameCount: number,
): Promise<string[]> {
  const img = await loadAlphaImage(`data:image/png;base64,${sheetBase64}`);
  const cellW = Math.round(img.width / gridCols);
  const cellH = Math.round(img.height / gridRows);
  const cells: string[] = [];

  for (let i = 0; i < frameCount; i++) {
    const col = i % gridCols;
    const row = Math.floor(i / gridCols);
    const canvas = document.createElement('canvas');
    canvas.width = cellW;
    canvas.height = cellH;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, col * cellW, row * cellH, cellW, cellH, 0, 0, cellW, cellH);
    cells.push(canvas.toDataURL('image/png').split(',')[1]);
  }
  return cells;
}

async function composeRefinedFramesToSheet(
  frameBase64s: string[],
  gridCols: number,
  gridRows: number,
  options: { padding?: 'green' | 'transparent' } = {},
): Promise<string> {
  const images = await Promise.all(
    frameBase64s.map((b) => loadAlphaImage(`data:image/png;base64,${b}`)),
  );
  const cellW = Math.max(...images.map((img) => img.width));
  const cellH = Math.max(...images.map((img) => img.height));

  const canvas = document.createElement('canvas');
  canvas.width = cellW * gridCols;
  canvas.height = cellH * gridRows;
  const ctx = canvas.getContext('2d')!;
  if (options.padding !== 'transparent') {
    // Fill with pure green so any padding matches Gemini's green background
    // for downstream chroma-key removal in cleanSpriteSheet.
    ctx.fillStyle = '#00FF00';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  for (let i = 0; i < images.length; i++) {
    const col = i % gridCols;
    const row = Math.floor(i / gridCols);
    const img = images[i];
    const dx = col * cellW + Math.round((cellW - img.width) / 2);
    const dy = row * cellH + Math.round((cellH - img.height) / 2);
    ctx.drawImage(img, dx, dy);
  }
  return canvas.toDataURL('image/png').split(',')[1];
}

function buildSheetRefinePrompt(animName: string, motion: string): string {
  const motionSummary = motion.replace(/\s+/g, ' ').trim().slice(0, 160);
  return [
    `Render a single high-fidelity full-resolution image of the pose shown in IMAGE 2, preserving the identity and visual style from IMAGE 1.`,
    ``,
    `CONTEXT:`,
    `- This is one frame of a classic 2D fighting-game "${animName}" animation (${motionSummary}).`,
    `- IMAGE 2 is a lower-resolution reference showing the EXACT pose to replicate at this frame.`,
    `- IMAGE 1 is the canonical identity, outfit, and visual style anchor.`,
    ``,
    `POSE RULE (CRITICAL):`,
    `- Replicate the EXACT pose, silhouette, and framing from IMAGE 2. Same limb positions, same stance, same facing direction, same center of mass, same feet placement.`,
    `- Do NOT reinterpret, smooth, "correct", or alter the pose in any way — render it as-is, just at higher resolution.`,
    `- Do NOT add motion blur, speed lines, trails, or "in-between" interpolation. This is a single static frame.`,
    ``,
    `STYLE LOCK (CRITICAL):`,
    `- Preserve the EXACT same visual style, art style, textures, colors, and level of detail from IMAGE 1 — do NOT change the aesthetic.`,
    `- The output must look like the same physical person from IMAGE 1. Do NOT redraw as a cartoon, anime, cel-shaded, illustrative, comic, watercolour, painted, stylized, or otherwise re-interpreted version.`,
    `- Match the exact rendering technique, shading style, linework density, and photographic/painterly feel of IMAGE 1 — if IMAGE 1 is photorealistic, stay photorealistic; if it is painted, stay in the exact same painted style.`,
    `- Preserve the same face, hair, skin tone, outfit, and proportions faithfully. No clothing changes, no new props, no accessory drift.`,
    ``,
    `FRAMING RULES:`,
    `- Show the COMPLETE character from head to feet. No cropping.`,
    `- The character should occupy roughly the same proportion of the frame as in IMAGE 2. Centered horizontally, feet near the bottom.`,
    ``,
    `OUTPUT RULES:`,
    `- Return exactly one image with pure bright green (#00FF00) background — flat, uniform, vivid green, no gradients, shadows, or ground.`,
    `- No text, no UI, no grids, no multiple frames. Just the single pose at high fidelity.`,
  ].join('\n');
}

export function geminiOfficialRefinePrompt(
  description: string,
  animName: string,
  motion: string,
  frameIndex: number,
  total: number,
  qualityCorrection?: string,
): string {
  const motionSummary = motion.replace(/\s+/g, ' ').trim().slice(0, 180);
  const normalizedCorrection = qualityCorrection?.replace(/\s+/g, ' ').trim().slice(0, 500);
  return [
    `Render one high-fidelity frame of the approved unofficial AI-generated arcade fighter from the supplied reference artwork.`,
    `FRAME CONTEXT:`,
    `- Render frame ${frameIndex + 1} of ${total} for the classic 2D fighting-game "${animName}" animation (${motionSummary}).`,
    `- IMAGE 1 is the canonical identity, face, hair, skin tone, build, outfit, and premium 2.5D rendering-style anchor.`,
    `- IMAGE 2 is the exact pose, framing, facing direction, center of mass, and limb-placement guide for this frame.`,
    ``,
    `POSE AND ANATOMY (CRITICAL):`,
    `- Match IMAGE 2's complete silhouette and pose exactly while preserving the recognizable person and visual design from IMAGE 1.`,
    `- Show exactly one complete character with one head, two arms, two hands, two legs, and two feet. No duplicate, merged, or detached limbs.`,
    `- Keep the same camera distance and full-body framing as IMAGE 2. Do not crop or zoom.`,
    `- Do not add motion blur, trails, speed lines, props, text, logos, scenery, or extra figures.`,
    ``,
    `STYLE AND CONTINUITY:`,
    `- Preserve IMAGE 1's face, hair, skin tone, apparent age, build, outfit, colors, materials, and realistic premium 2.5D rendering consistently.`,
    `- Avoid cartoon, chibi, anime, cel shading, caricature, flat illustration, or documentary photography.`,
    `- The approved character brief below is supplementary wardrobe and art direction. IMAGE 1 controls identity and visible continuity.`,
    ``,
    `APPROVED CHARACTER BRIEF:`,
    description.trim(),
    ...(normalizedCorrection ? [
      ``,
      `QUALITY CORRECTION (CRITICAL):`,
      `- A previous render of this frame failed QA. ${normalizedCorrection}`,
      `- Correct those defects while preserving IMAGE 1's identity and IMAGE 2's pose and animation timing.`,
    ] : []),
    ``,
    `OUTPUT:`,
    `- Return exactly one image with a pure bright green (#00FF00) background, flat and uniform with no shadows, floor, or gradients.`,
    `- Return no explanatory text, UI, grid, or multiple frames.`,
  ].join('\n');
}

const OFFICIAL_SPRITE_REVIEW_ISSUES = [
  'anatomy',
  'complete_body',
  'character_count',
  'scale_framing',
  'appearance_continuity',
  'outfit_continuity',
  'sequence_continuity',
  'animation_fidelity',
  'render_style',
  'render_quality',
  'background',
  'extra_elements',
] as const;

export type GeminiOfficialSpriteReviewIssue = typeof OFFICIAL_SPRITE_REVIEW_ISSUES[number];

export interface GeminiOfficialSpriteReview {
  retry: number[];
  issues: Record<string, GeminiOfficialSpriteReviewIssue[]>;
}

export function geminiOfficialSpriteReviewPrompt(
  description: string,
  animName: string,
  motion: string,
  total: number,
  reviewInstance?: string,
  formatAttempt = 1,
): string {
  const motionSummary = motion.replace(/\s+/g, ' ').trim().slice(0, 220);
  const safeReviewInstance = reviewInstance?.replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
  const continuityFocused = safeReviewInstance?.includes('continuity');
  const wardrobeFocused = safeReviewInstance?.includes('wardrobe');
  return [
    `Inspect IMAGE 1 as a production QA reviewer. It is a contact sheet containing only unofficial, clearly AI-generated arcade artwork based on the approved character brief below.`,
    `Do not identify, name, or compare the avatar to any real person or public figure. Review only the visible game-art quality and continuity.`,
    ``,
    `WRITTEN CHARACTER DESIGN:`,
    description.trim(),
    ``,
    `ANIMATION: "${animName}" (${motionSummary})`,
    `FRAME ORDER: inspect exactly the first ${total} cells, indexed 0 through ${total - 1}, left-to-right and then top-to-bottom. Ignore any empty padding cells after index ${total - 1}.`,
    ``,
    `Reject a frame only for a clear production defect:`,
    `- anatomy: impossible, duplicated, merged, detached, or badly malformed anatomy.`,
    `- complete_body: any head, hand, elbow, knee, leg, or foot is cropped or missing.`,
    `- character_count: the cell contains zero or more than one complete fighter.`,
    `- scale_framing: the fighter's scale, floor line, or camera framing clearly breaks continuity with the other cells.`,
    `- appearance_continuity: face design, hair, skin tone, build, or apparent age clearly changes.`,
    `- outfit_continuity: outfit, colors, materials, footwear, or accessories clearly change.`,
    `- sequence_continuity: neighboring frames or animation phases have an abrupt jump in body proportions, scale, pose progression, facing direction, floor line, or visual treatment.`,
    `- animation_fidelity: the sequence clearly fails to depict the requested action, combat stance, direction, progression, or loop.`,
    `- render_style: the frame becomes cartoon, anime, chibi, cel-shaded, flat illustration, caricature, or otherwise departs from premium realistic 2.5D rendering.`,
    `- render_quality: the frame is visibly blurrier, smeared, unfinished, lower-detail, or more heavily outlined than the rest of the sheet.`,
    `- background: the background is not flat pure bright green or contains a floor, shadow, gradient, or scenery.`,
    `- extra_elements: props, text, logos, UI, motion trails, detached objects, or extra figures appear.`,
    ``,
    `GLOBAL SEQUENCE CHECK (CRITICAL):`,
    `- Judge the sheet both frame-by-frame and as one ordered animation. A group-wide change is a defect even when every isolated frame looks polished.`,
    `- Compare head size, shoulder width, torso build, limb proportions, camera distance, floor line, outfit construction, shading, and edge treatment across the entire sequence.`,
    `- Inventory the visible clothing and accessories across all cells. Establish the expected design from the written description and the majority-consistent frames, then compare both hands and wrists, both shoes, trousers, jacket, shirt, tie, and any jewelry cell-by-cell.`,
    `- A glove, watch, ring, bracelet, prop, changed shoe, changed tie, or altered garment that appears in only some cells is outfit_continuity (and extra_elements when newly invented). Do not excuse it as lighting or motion.`,
    ...(animName === 'walk' && total === 16 ? [
      `- For this 16-frame walk, explicitly compare cells 0-7 against cells 8-15. The phase boundary between cells 7 and 8 must not change the fighter's build, head size, style, scale, guard, or identity design.`,
      `- The fighter must maintain a combat-ready forward walk rather than a casual civilian stroll. The two halves must form one smooth loop.`,
      `- If one half has systematic drift, include every clearly affected frame from that half in retry with the applicable continuity labels. Do not approve the sheet merely because individual cells are anatomically complete.`,
    ] : []),
    ...(continuityFocused ? [
      `- CONTINUITY SPECIALIST PASS: prioritize cross-frame and phase-boundary comparison over isolated local polish. Recheck the whole ordered sequence before returning JSON.`,
    ] : []),
    ...(wardrobeFocused ? [
      `- WARDROBE SPECIALIST PASS: inspect every hand, wrist, foot, lapel, shirt, tie, and garment edge cell-by-cell. Reject every frame where an accessory or clothing detail appears, disappears, or changes color/material relative to the sequence.`,
    ] : []),
    ``,
    `Pose changes required by the animation are not defects. Minor natural lighting variation is not a defect. Retry only clear failures.`,
    `Return exactly one JSON object and no markdown or prose. Use zero-based indices and only the issue labels above:`,
    `{"retry":[3],"issues":{"3":["render_style"]}}`,
    `If all frames pass, return: {"retry":[],"issues":{}}`,
    ...(safeReviewInstance ? [
      ``,
      `REVIEW INSTANCE: ${safeReviewInstance}-${formatAttempt}. Perform this review independently; this label must not appear in the JSON response.`,
      ...(formatAttempt > 1 ? [
        `FORMAT RECOVERY: the preceding response could not be parsed. Reinspect the image and use only the exact issue labels and JSON shape listed above.`,
      ] : []),
    ] : []),
  ].join('\n');
}

export function parseGeminiOfficialSpriteReview(
  responseText: string,
  total: number,
): GeminiOfficialSpriteReview {
  const trimmed = responseText.trim();
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    throw new Error('Gemini official sprite review did not return a JSON object');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  } catch {
    throw new Error('Gemini official sprite review returned malformed JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Gemini official sprite review returned an invalid payload');
  }

  const payload = parsed as { retry?: unknown; issues?: unknown };
  if (!Array.isArray(payload.retry)) {
    throw new Error('Gemini official sprite review omitted the retry array');
  }
  if (!payload.issues || typeof payload.issues !== 'object' || Array.isArray(payload.issues)) {
    throw new Error('Gemini official sprite review omitted the issues object');
  }

  const retry: number[] = [];
  for (const value of payload.retry) {
    if (!Number.isInteger(value) || (value as number) < 0 || (value as number) >= total) {
      throw new Error('Gemini official sprite review returned an invalid frame index');
    }
    if (!retry.includes(value as number)) retry.push(value as number);
  }
  retry.sort((a, b) => a - b);

  const allowedIssues = new Set<string>(OFFICIAL_SPRITE_REVIEW_ISSUES);
  const issuePayload = payload.issues as Record<string, unknown>;
  const issues: Record<string, GeminiOfficialSpriteReviewIssue[]> = {};
  for (const frameIndex of retry) {
    const frameIssues = issuePayload[String(frameIndex)];
    if (!Array.isArray(frameIssues) || frameIssues.length === 0) {
      throw new Error(`Gemini official sprite review omitted issues for frame ${frameIndex}`);
    }
    const normalized: GeminiOfficialSpriteReviewIssue[] = [];
    for (const issue of frameIssues) {
      if (typeof issue !== 'string' || !allowedIssues.has(issue)) {
        throw new Error(`Gemini official sprite review returned an invalid issue for frame ${frameIndex}`);
      }
      const typedIssue = issue as GeminiOfficialSpriteReviewIssue;
      if (!normalized.includes(typedIssue)) normalized.push(typedIssue);
    }
    issues[String(frameIndex)] = normalized;
  }

  return { retry, issues };
}

async function measureGreenBackedCharacterBounds(
  base64: string,
): Promise<{ x: number; y: number; w: number; h: number; imageW: number; imageH: number; widthRatio: number; heightRatio: number } | null> {
  try {
    const cleaned = await cleanReposedImagePreserveCanvas(base64);
    const bbox = await measureOpaqueBoundsFromBase64(cleaned);
    const dims = await getImageDimensions(cleaned);
    if (!bbox || dims.width <= 0 || dims.height <= 0) return null;
    return {
      x: bbox.x,
      y: bbox.y,
      w: bbox.w,
      h: bbox.h,
      imageW: dims.width,
      imageH: dims.height,
      widthRatio: bbox.w / dims.width,
      heightRatio: bbox.h / dims.height,
    };
  } catch {
    return null;
  }
}

async function singleRefineAttempt(
  characterBase64: string,
  cellBase64: string,
  animName: string,
  prompt: string,
  model: string,
  frameIndex: number,
  total: number,
  attemptLabel: string,
  context?: ApiRequestContext,
  officialDescription?: string,
  officialQualityCorrection?: string,
): Promise<string | null> {
  const official = officialDescription?.trim();
  const primaryBase64 = characterBase64;
  const extras = [{ data: cellBase64, mime: 'image/png' }];
  const requestPrompt = official
    ? geminiOfficialRefinePrompt(
      official,
      animName,
      prompt,
      frameIndex,
      total,
      officialQualityCorrection,
    )
    : prompt;
  try {
    const result = await callGemini(requestPrompt, primaryBase64, 'image/png', extras, model, context);
    if (!result.imageBase64) {
      debugWarn(
        `[GeminiApi] Sheet-refine ${animName} ${frameIndex + 1}/${total} ${attemptLabel}: no image returned` +
          `${result.finishReason ? ` (finishReason: ${result.finishReason})` : ''}`,
      );
      return null;
    }
    return result.imageBase64;
  } catch (err: any) {
    if (err instanceof ApiSessionChangedError) throw err;
    if (err instanceof GeminiRequestError && err.retryable) throw err;
    if (err instanceof GeminiRequestError && !err.retryable) throw err;
    if (isGeminiContentBlockedError(err)) {
      debugWarn(
        `[GeminiApi] Sheet-refine ${animName} ${frameIndex + 1}/${total} ${attemptLabel}: safety filter, retrying with clothing note`,
      );
      try {
        const retryResult = await callGemini(
          requestPrompt + REPOSE_CLOTHING_FALLBACK,
          primaryBase64,
          'image/png',
          extras,
          model,
          context,
        );
        return retryResult.imageBase64 ?? null;
      } catch (retryErr: any) {
        if (retryErr instanceof ApiSessionChangedError) throw retryErr;
        if (retryErr instanceof GeminiRequestError) throw retryErr;
        debugWarn(
          `[GeminiApi] Sheet-refine ${animName} ${frameIndex + 1}/${total} ${attemptLabel} safety retry failed: ${retryErr.message}`,
        );
        return null;
      }
    }
    debugWarn(
      `[GeminiApi] Sheet-refine ${animName} ${frameIndex + 1}/${total} ${attemptLabel} failed: ${err.message}`,
    );
    return null;
  }
}

const REFINE_SIZE_MIN_RATIO = 0.75;
const REFINE_SIZE_MAX_RATIO = 1.3;
const LOW_ATTACK_RECOVERY_SIZE_MAX_RATIO = 1.35;
const OFFICIAL_FRAME_EDGE_MARGIN_PX = 3;
const OFFICIAL_FRAMING_RECOVERY_INSET_SCALE = 0.84;
const OFFICIAL_FRAMING_RECOVERY_BOTTOM_MARGIN_RATIO = 0.03;

type OfficialFrameEdge = 'left' | 'right' | 'top' | 'bottom';
type OfficialFrameBounds = {
  x: number;
  y: number;
  w: number;
  h: number;
  imageW: number;
  imageH: number;
};

export function geminiOfficialFramingRecoveryInsetLayout(
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } {
  const insetWidth = Math.max(1, Math.round(width * OFFICIAL_FRAMING_RECOVERY_INSET_SCALE));
  const insetHeight = Math.max(1, Math.round(height * OFFICIAL_FRAMING_RECOVERY_INSET_SCALE));
  const bottomMargin = Math.max(1, Math.round(height * OFFICIAL_FRAMING_RECOVERY_BOTTOM_MARGIN_RATIO));
  return {
    x: Math.round((width - insetWidth) / 2),
    y: Math.max(0, height - insetHeight - bottomMargin),
    width: insetWidth,
    height: insetHeight,
  };
}

async function insetGreenBackedFramingInput(base64: string): Promise<string> {
  const transparentBase64 = await cleanReposedImagePreserveCanvas(base64);
  const image = await loadAlphaImage(`data:image/png;base64,${transparentBase64}`);
  if (!image.width || !image.height) {
    throw new GeminiOfficialSpriteQualityError('Gemini official framing recovery received an empty image');
  }

  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new GeminiOfficialSpriteQualityError('Gemini official framing recovery could not create an inset canvas');
  }

  context.fillStyle = '#00FF00';
  context.fillRect(0, 0, canvas.width, canvas.height);
  const layout = geminiOfficialFramingRecoveryInsetLayout(canvas.width, canvas.height);
  context.drawImage(image, layout.x, layout.y, layout.width, layout.height);
  return canvas.toDataURL('image/png').split(',')[1];
}

export function geminiOfficialFramingRecoveryRestoreLayout(
  recovered: OfficialFrameBounds,
  rejected: OfficialFrameBounds,
): { x: number; y: number; width: number; height: number } {
  const margin = Math.max(
    OFFICIAL_FRAME_EDGE_MARGIN_PX + 1,
    Math.round(Math.min(recovered.imageW, recovered.imageH) * 0.02),
  );
  const desiredScale = Math.min(
    rejected.w / recovered.w,
    rejected.h / recovered.h,
  );
  const maximumScale = Math.min(
    (recovered.imageW - margin * 2) / recovered.w,
    (recovered.imageH - margin * 2) / recovered.h,
  );
  const scale = Math.min(desiredScale, maximumScale);
  const width = Math.max(1, Math.round(recovered.w * scale));
  const height = Math.max(1, Math.round(recovered.h * scale));
  return {
    x: Math.max(margin, Math.min(rejected.x, recovered.imageW - width - margin)),
    y: Math.max(margin, Math.min(rejected.y, recovered.imageH - height - margin)),
    width,
    height,
  };
}

async function restoreRecoveredFrameScale(
  recoveredFrameBase64: string,
  rejectedFrameBase64: string,
): Promise<string> {
  const [transparentRecoveredBase64, recoveredBounds, rejectedBounds] = await Promise.all([
    cleanReposedImagePreserveCanvas(recoveredFrameBase64),
    measureGreenBackedCharacterBounds(recoveredFrameBase64),
    measureGreenBackedCharacterBounds(rejectedFrameBase64),
  ]);
  if (!recoveredBounds || !rejectedBounds) {
    throw new GeminiOfficialSpriteQualityError('Gemini official framing recovery could not restore sequence scale');
  }

  const image = await loadAlphaImage(`data:image/png;base64,${transparentRecoveredBase64}`);
  const canvas = document.createElement('canvas');
  canvas.width = recoveredBounds.imageW;
  canvas.height = recoveredBounds.imageH;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new GeminiOfficialSpriteQualityError('Gemini official framing recovery could not create a restore canvas');
  }

  context.fillStyle = '#00FF00';
  context.fillRect(0, 0, canvas.width, canvas.height);
  const layout = geminiOfficialFramingRecoveryRestoreLayout(recoveredBounds, rejectedBounds);
  context.drawImage(
    image,
    recoveredBounds.x,
    recoveredBounds.y,
    recoveredBounds.w,
    recoveredBounds.h,
    layout.x,
    layout.y,
    layout.width,
    layout.height,
  );
  return canvas.toDataURL('image/png').split(',')[1];
}

export function geminiOfficialFrameFramingValidation(
  bounds: { x: number; y: number; w: number; h: number; imageW: number; imageH: number },
  edgeMargin = OFFICIAL_FRAME_EDGE_MARGIN_PX,
): { ok: boolean; croppedEdges: OfficialFrameEdge[] } {
  const croppedEdges: OfficialFrameEdge[] = [];
  if (bounds.x <= edgeMargin) croppedEdges.push('left');
  if (bounds.x + bounds.w >= bounds.imageW - edgeMargin) croppedEdges.push('right');
  if (bounds.y <= edgeMargin) croppedEdges.push('top');
  if (bounds.y + bounds.h >= bounds.imageH - edgeMargin) croppedEdges.push('bottom');
  return { ok: croppedEdges.length === 0, croppedEdges };
}

export function geminiRefinedFrameSizeValidation(
  animName: string,
  baseHeightRatio: number,
  refinedHeightRatio: number,
  recoveryAttempt = false,
): { ok: boolean; ratio: number; minRatio: number; maxRatio: number } {
  const maxRatio = recoveryAttempt && (animName === 'low_punch' || animName === 'low_kick')
    ? LOW_ATTACK_RECOVERY_SIZE_MAX_RATIO
    : REFINE_SIZE_MAX_RATIO;
  const ratio = baseHeightRatio > 0
    ? refinedHeightRatio / baseHeightRatio
    : Number.POSITIVE_INFINITY;
  return {
    ok: ratio >= REFINE_SIZE_MIN_RATIO && ratio <= maxRatio,
    ratio,
    minRatio: REFINE_SIZE_MIN_RATIO,
    maxRatio,
  };
}

async function refineSheetCell(
  characterBase64: string,
  cellBase64: string,
  animName: string,
  prompt: string,
  model: string,
  frameIndex: number,
  total: number,
  context?: ApiRequestContext,
  officialDescription?: string,
  officialQualityCorrection?: string,
): Promise<string> {
  const start = Date.now();
  const baseBounds = await measureGreenBackedCharacterBounds(cellBase64);

  const validateSize = async (
    candidate: string,
    recoveryAttempt = false,
  ): Promise<{ ok: boolean; reason: string }> => {
    if (!baseBounds) return { ok: true, reason: 'no base bounds to compare against' };
    const bounds = await measureGreenBackedCharacterBounds(candidate);
    if (!bounds) return { ok: false, reason: 'could not measure refined bounds' };
    // Compare PROPORTION of the frame the character occupies, not absolute pixel
    // height. The base sheet cell is ~256px tall and the refined output is
    // ~1024px tall — pixel ratios are meaningless. What matters is that the
    // character fills a similar fraction of the cell in both.
    const validation = geminiRefinedFrameSizeValidation(
      animName,
      baseBounds.heightRatio,
      bounds.heightRatio,
      recoveryAttempt,
    );
    if (!validation.ok) {
      return {
        ok: false,
        reason: `size drift ratio=${validation.ratio.toFixed(2)} ` +
          `allowed=${validation.minRatio.toFixed(2)}-${validation.maxRatio.toFixed(2)} ` +
          `base=${baseBounds.heightRatio.toFixed(2)} refined=${bounds.heightRatio.toFixed(2)}`,
      };
    }
    return { ok: true, reason: `ratio=${validation.ratio.toFixed(2)}` };
  };

  // Attempt 1 — standard prompt
  const first = await singleRefineAttempt(
    characterBase64,
    cellBase64,
    animName,
    prompt,
    model,
    frameIndex,
    total,
    'attempt 1',
    context,
    officialDescription,
    officialQualityCorrection,
  );
  if (first) {
    const check = await validateSize(first);
    if (check.ok) {
      publishDebugLog(
        `[GeminiApi] Sheet-refine ${animName} ${frameIndex + 1}/${total}: ${((Date.now() - start) / 1000).toFixed(1)}s (${check.reason})`,
      );
      return first;
    }
    debugWarn(
      `[GeminiApi] Sheet-refine ${animName} ${frameIndex + 1}/${total}: rejecting attempt 1 — ${check.reason}`,
    );
  }

  // Attempt 2 — harder size prompt
  const sizeCorrection = `Match the silhouette guide's exact vertical and horizontal scale, camera distance, floor line, and framing. Do not zoom out, shrink, crop, or enlarge the fighter.`;
  const stricterPrompt = officialDescription?.trim()
    ? prompt
    : prompt + `\n\nSIZE LOCK (CRITICAL):\n- ${sizeCorrection}`;
  const stricterOfficialCorrection = officialDescription?.trim()
    ? [officialQualityCorrection, sizeCorrection].filter(Boolean).join(' ')
    : undefined;
  const second = await singleRefineAttempt(
    characterBase64,
    cellBase64,
    animName,
    stricterPrompt,
    model,
    frameIndex,
    total,
    'attempt 2 (size-strict)',
    context,
    officialDescription,
    stricterOfficialCorrection,
  );
  if (second) {
    const check = await validateSize(second, true);
    if (check.ok) {
      publishDebugLog(
        `[GeminiApi] Sheet-refine ${animName} ${frameIndex + 1}/${total}: recovered on attempt 2 in ${((Date.now() - start) / 1000).toFixed(1)}s (${check.reason})`,
      );
      return second;
    }
    debugWarn(
      `[GeminiApi] Sheet-refine ${animName} ${frameIndex + 1}/${total}: rejecting attempt 2 — ${check.reason}`,
    );
  }

  if (officialDescription?.trim()) {
    throw new GeminiOfficialSpriteQualityError(
      `Gemini official final render for ${animName} frame ${frameIndex + 1}/${total} failed both validated attempts`,
    );
  }
  debugWarn(`[GeminiApi] Sheet-refine ${animName} ${frameIndex + 1}/${total}: falling back to base sheet cell after 2 attempts`);
  return cellBase64;
}

export function geminiOfficialFramingRecoveryPrompt(
  description: string,
  animName: string,
  motion: string,
  frameIndex: number,
  total: number,
  croppedEdges: OfficialFrameEdge[],
): string {
  const edgeLabel = croppedEdges.join(' and ');
  return [
    geminiOfficialRefinePrompt(
      description,
      animName,
      motion,
      frameIndex,
      total,
      `The previous render touched the ${edgeLabel} image edge and cropped the fighter. Reconstruct the missing contour and keep the complete body inside the canvas.`,
    ),
    ``,
    `FRAMING RECOVERY INPUT (CRITICAL):`,
    `- IMAGE 2 is deliberately reduced and inset on a green canvas. Its smaller scale, centered framing, exact pose, and floor line are mandatory.`,
    `- IMAGE 3 is the previous rejected render, also deliberately reduced and inset. Preserve its otherwise approved face, outfit, materials, pose, and rendering quality.`,
    `- The old ${edgeLabel} canvas edge now appears as a flat cut line inside IMAGE 3. Reconstruct the missing anatomy or clothing across that internal cut line using IMAGE 1 and IMAGE 2.`,
    `- Do not return IMAGE 3 unchanged and do not enlarge the fighter back to its old scale. IMAGE 2 defines the final camera distance and framing.`,
    `- Leave a clearly visible pure-green buffer on all four sides, including at least 5% of the canvas width at the ${edgeLabel} edge.`,
    `- Return one corrected full-body frame only. Do not add, remove, or redesign any body part, clothing detail, prop, shadow, or scenery.`,
  ].join('\n');
}

async function recoverOfficialFrameFraming(
  characterBase64: string,
  poseGuideBase64: string,
  rejectedFrameBase64: string,
  animName: string,
  motion: string,
  model: string,
  frameIndex: number,
  total: number,
  description: string,
  croppedEdges: OfficialFrameEdge[],
  context?: ApiRequestContext,
): Promise<string> {
  const prompt = geminiOfficialFramingRecoveryPrompt(
    description,
    animName,
    motion,
    frameIndex,
    total,
    croppedEdges,
  );
  const [insetPoseGuideBase64, insetRejectedFrameBase64] = await Promise.all([
    insetGreenBackedFramingInput(poseGuideBase64),
    insetGreenBackedFramingInput(rejectedFrameBase64),
  ]);
  const result = await callGemini(
    prompt,
    characterBase64,
    'image/png',
    [
      { data: insetPoseGuideBase64, mime: 'image/png' },
      { data: insetRejectedFrameBase64, mime: 'image/png' },
    ],
    model,
    context,
  );
  if (!result.imageBase64) {
    throw new GeminiOfficialSpriteQualityError(
      `Gemini official ${animName} frame ${frameIndex + 1}/${total} framing recovery returned no image`,
    );
  }
  const restoredFrameBase64 = await restoreRecoveredFrameScale(
    result.imageBase64,
    rejectedFrameBase64,
  );

  const [rejectedBounds, restoredBounds] = await Promise.all([
    measureGreenBackedCharacterBounds(rejectedFrameBase64),
    measureGreenBackedCharacterBounds(restoredFrameBase64),
  ]);
  if (!rejectedBounds || !restoredBounds) {
    throw new GeminiOfficialSpriteQualityError(
      `Gemini official ${animName} frame ${frameIndex + 1}/${total} framing recovery could not be measured`,
    );
  }
  const sizeValidation = geminiRefinedFrameSizeValidation(
    animName,
    rejectedBounds.heightRatio,
    restoredBounds.heightRatio,
    true,
  );
  if (!sizeValidation.ok) {
    throw new GeminiOfficialSpriteQualityError(
      `Gemini official ${animName} frame ${frameIndex + 1}/${total} framing recovery changed scale ` +
      `(ratio ${sizeValidation.ratio.toFixed(2)}, allowed ${sizeValidation.minRatio.toFixed(2)}-${sizeValidation.maxRatio.toFixed(2)})`,
    );
  }
  return restoredFrameBase64;
}

const OFFICIAL_REVIEW_CORRECTIONS: Record<GeminiOfficialSpriteReviewIssue, string> = {
  anatomy: 'Restore plausible adult anatomy with exactly two correctly attached arms, hands, legs, and feet.',
  complete_body: 'Render the complete head-to-toe body with green margin around every extremity.',
  character_count: 'Render exactly one complete fighter and no duplicate figure or detached body part.',
  scale_framing: 'Match the silhouette guide scale, camera distance, floor line, and full-body framing exactly.',
  appearance_continuity: 'Match the written synthetic face design, hair, skin tone, build, and apparent age exactly.',
  outfit_continuity: 'Match the written outfit, colors, materials, footwear, and accessories exactly.',
  sequence_continuity: 'Match adjacent frames and the full sequence in body proportions, scale, floor line, facing direction, pose progression, and visual treatment with no phase-boundary jump.',
  animation_fidelity: 'Depict the requested combat animation and ordered motion phase accurately while preserving a fighting-ready stance and a smooth loop.',
  render_style: 'Use premium realistic 2.5D game rendering with dimensional materials and shading; no cartoon, anime, cel shading, caricature, or flat illustration.',
  render_quality: 'Match the other frames in sharpness, detail, dimensional shading, material definition, and restrained edge treatment.',
  background: 'Use only a flat pure bright green background with no floor, shadow, gradient, or scenery.',
  extra_elements: 'Remove every prop, logo, word, UI element, motion trail, detached object, and extra figure.',
};

export function geminiOfficialReviewCorrection(
  review: GeminiOfficialSpriteReview,
  frameIndex: number,
  animName?: string,
  total?: number,
): string {
  const issues = review.issues[String(frameIndex)] ?? [];
  const corrections = issues
    .map((issue) => OFFICIAL_REVIEW_CORRECTIONS[issue])
    .join(' ');
  if (
    animName === 'idle' &&
    total !== undefined &&
    frameIndex === total - 1 &&
    issues.includes('animation_fidelity')
  ) {
    return [
      corrections,
      `This is the closing idle-loop frame: return to IMAGE 1's fighting-ready guard with both fists raised, feet planted, and the same silhouette, floor line, and body alignment as frame 1. Do not lower either arm or finish in a relaxed neutral pose.`,
    ].filter(Boolean).join(' ');
  }
  return corrections;
}

export function geminiOfficialCorrectionUsesCanonicalPoseGuide(
  review: GeminiOfficialSpriteReview,
  animName: string,
  frameIndex: number,
  total: number,
): boolean {
  return animName === 'idle' &&
    frameIndex === total - 1 &&
    (review.issues[String(frameIndex)] ?? []).includes('animation_fidelity');
}

function mergeOfficialSpriteReviews(
  reviews: GeminiOfficialSpriteReview[],
): GeminiOfficialSpriteReview {
  const retry = [...new Set(reviews.flatMap((review) => review.retry))].sort((a, b) => a - b);
  const issues: Record<string, GeminiOfficialSpriteReviewIssue[]> = {};
  for (const frameIndex of retry) {
    issues[String(frameIndex)] = [...new Set(reviews.flatMap(
      (review) => review.issues[String(frameIndex)] ?? [],
    ))];
  }
  return { retry, issues };
}

async function reviewOfficialRefinedCells(
  refinedCells: string[],
  description: string,
  animName: string,
  motion: string,
  reviewInstance: string,
  context?: ApiRequestContext,
): Promise<GeminiOfficialSpriteReview> {
  const total = refinedCells.length;
  const gridCols = computeGridCols(total);
  const gridRows = Math.ceil(total / gridCols);
  const contactSheet = await composeRefinedFramesToSheet(refinedCells, gridCols, gridRows);

  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const prompt = geminiOfficialSpriteReviewPrompt(
        description,
        animName,
        motion,
        total,
        reviewInstance,
        attempt,
      );
      const result = await callGemini(
        prompt,
        contactSheet,
        'image/png',
        undefined,
        OFFICIAL_GEMINI_REVIEW_MODEL,
        context,
        ['TEXT'],
      );
      const review = parseGeminiOfficialSpriteReview(result.text, total);
      publishDebugLog(
        `[GeminiApi] Official ${animName} visual QA ${review.retry.length === 0 ? 'passed' : `rejected frames ${review.retry.map((idx) => idx + 1).join(', ')}`}`,
      );
      return review;
    } catch (error) {
      if (
        error instanceof ApiSessionChangedError ||
        error instanceof GeminiRequestError ||
        isGeminiContentBlockedError(error)
      ) throw error;
      lastError = error;
      if (attempt < 2) {
        debugWarn(`[GeminiApi] Official ${animName} visual QA response was invalid; retrying once`);
      }
    }
  }

  if (lastError instanceof GeminiRequestError) throw lastError;
  const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new GeminiOfficialSpriteQualityError(
    `Gemini official ${animName} visual QA did not return a valid verdict${detail}`,
  );
}

export function geminiOfficialPoseGuideCells(
  animName: string,
  frames: number,
  officialDescription: string | undefined,
  poseMasterId: string | undefined,
  poseGuideBase64s: string[] | undefined,
): string[] | null {
  const hasPoseMasterInput = poseMasterId !== undefined || poseGuideBase64s !== undefined;
  if (!hasPoseMasterInput) return null;
  if (!officialDescription?.trim()) {
    throw new GeminiOfficialSpriteQualityError('Official pose guides require an approved character brief');
  }
  if (animName !== 'jump') {
    throw new GeminiOfficialSpriteQualityError('The supplied official pose master is not approved for this animation');
  }
  if (!poseMasterId?.trim() || !Array.isArray(poseGuideBase64s)) {
    throw new GeminiOfficialSpriteQualityError('Official pose master metadata is incomplete');
  }
  if (
    poseGuideBase64s.length !== frames ||
    poseGuideBase64s.some((value) => typeof value !== 'string' || value.length < 32)
  ) {
    throw new GeminiOfficialSpriteQualityError(
      `Official pose master ${poseMasterId} does not contain the expected ${frames} frames`,
    );
  }
  return [...poseGuideBase64s];
}

export async function geminiSheetRefined(
  characterBase64: string,
  animName: string,
  motion: string,
  frames: number,
  secondaryBase64?: string,
  maxScale?: number,
  normalizationReference?: NormalizationReference,
  options?: {
    enableBgRemoval?: boolean;
    officialPoseMasterId?: string;
    officialPoseGuideBase64s?: string[];
  },
  context?: ApiRequestContext,
  modelOverride?: string,
  officialDescription?: string,
): Promise<GeminiSpriteResult> {
  const start = Date.now();
  const official = officialDescription?.trim();
  const renderModel = resolveGeminiImageModel({ operation: 'sprite', animationName: animName, modelOverride });
  // Pro is excellent at final-frame detail but unreliable at strict multi-cell
  // layouts. Use Flash only as the pose/coherence scaffold; every visible
  // Champion frame is still rendered independently by Pro.
  const scaffoldModel = renderModel.toLowerCase().includes('pro')
    ? DEFAULT_GEMINI_IMAGE_MODEL
    : renderModel;
  const shouldMirror = MIRROR_ANIMS.has(animName);

  const suppliedPoseGuides = geminiOfficialPoseGuideCells(
    animName,
    frames,
    official,
    options?.officialPoseMasterId,
    options?.officialPoseGuideBase64s,
  );

  // Step 1: coherent base sheet — fixes pose sequence + style across all frames.
  let sheetCells: string[];
  if (suppliedPoseGuides) {
    sheetCells = suppliedPoseGuides;
    debugInfo(
      `[GeminiApi] Sheet-refine ${animName}: using ${sheetCells.length} immutable pose guides ` +
      `from ${options?.officialPoseMasterId}; skipping generated scaffold (final frames: ${renderModel})...`,
    );
  } else if (official && animName === 'walk' && frames === 16 && !shouldMirror) {
    debugInfo(
      `[GeminiApi] Sheet-refine ${animName}: generating pose scaffold with ${scaffoldModel} ` +
      `(final frames: ${renderModel})...`,
    );
    const phaseMotions = [
      `${motion}. Generate frames 1 through 8 of a 16-frame seamless cycle: begin at a clear forward-leg contact pose, pass through the balanced mid-step, and finish just before the opposite-leg contact. Keep both fists raised in a consistent combat guard and the upper body ready throughout. Do not return to the starting contact pose in this half.`,
      `${motion}. Generate frames 9 through 16 of a 16-frame seamless cycle: begin at the opposite-leg contact pose, pass through the balanced return step, and finish at the original forward-leg contact so the full 16-frame loop closes cleanly. Keep both fists raised in the same combat guard and preserve the exact body proportions, framing, and floor line established by the first half.`,
    ];
    sheetCells = [];
    for (let phaseIndex = 0; phaseIndex < phaseMotions.length; phaseIndex++) {
      const phasePrimary = phaseIndex === 0 ? characterBase64 : sheetCells[7];
      const phaseEndGuide = phaseIndex === 0 ? undefined : sheetCells[0];
      const phaseSheet = await geminiSpriteSheet(
        phasePrimary,
        animName,
        phaseMotions[phaseIndex],
        8,
        phaseEndGuide,
        maxScale,
        normalizationReference,
        context,
        scaffoldModel,
        official,
      );
      const phaseCells = await splitSheetIntoCells(
        phaseSheet.imageBase64,
        phaseSheet.gridCols,
        phaseSheet.gridRows,
        8,
      );
      if (phaseCells.length !== 8) {
        throw new GeminiOfficialSpriteQualityError(
          `Gemini official walk scaffold phase ${phaseIndex + 1}/2 produced ${phaseCells.length} reliable frames (need 8)`,
        );
      }
      sheetCells.push(...phaseCells);
      publishDebugLog(
        `[GeminiApi] Sheet-refine walk: phase ${phaseIndex + 1}/2 produced 8/8 scaffold cells`,
      );
    }
  } else {
    debugInfo(
      `[GeminiApi] Sheet-refine ${animName}: generating pose scaffold with ${scaffoldModel} ` +
      `(final frames: ${renderModel})...`,
    );
    const scaffoldEndGuide = official && animName === 'idle'
      ? characterBase64
      : secondaryBase64;
    const sheet = await geminiSpriteSheet(
      characterBase64,
      animName,
      motion,
      frames,
      scaffoldEndGuide,
      maxScale,
      normalizationReference,
      context,
      scaffoldModel,
      officialDescription,
    );
    debugLog(
      `[GeminiApi] Sheet-refine ${animName}: base sheet done in ${((Date.now() - start) / 1000).toFixed(1)}s ` +
      `(${sheet.frameCount} frames, ${sheet.gridCols}x${sheet.gridRows})`,
    );

    // Attack sheets generate a half-sequence; refining before mirroring preserves
    // the intended 4 paid keyframes -> 7 playback frames contract.
    const refineFrameCount = shouldMirror ? Math.ceil(frames / 2) : sheet.frameCount;
    sheetCells = await splitSheetIntoCells(
      sheet.imageBase64,
      sheet.gridCols,
      sheet.gridRows,
      refineFrameCount,
    );
    const sheetDims = await getImageDimensions(sheet.imageBase64);
    publishDebugLog(
      `[GeminiApi] Sheet-refine ${animName}: split base sheet ${sheetDims.width}x${sheetDims.height} into ${sheetCells.length} cells`,
    );
  }

  // Step 3: refine each cell at full Gemini resolution. Pro runs sequentially
  // so one fighter cannot burst through Google's rolling spend-rate window.
  const refinePrompt = officialDescription?.trim()
    ? motion
    : buildSheetRefinePrompt(animName, motion);
  const refineStart = Date.now();
  const refinedCells: string[] = [];
  if (renderModel.toLowerCase().includes('pro')) {
    for (let idx = 0; idx < sheetCells.length; idx++) {
      refinedCells.push(await refineSheetCell(
        characterBase64,
        sheetCells[idx],
        animName,
        refinePrompt,
        renderModel,
        idx,
        sheetCells.length,
        context,
        officialDescription,
      ));
    }
  } else {
    const concurrency = 3;
    for (let start = 0; start < sheetCells.length; start += concurrency) {
      const batch = sheetCells.slice(start, start + concurrency);
      const batchResults = await Promise.all(batch.map((cellBase64, offset) =>
        refineSheetCell(
          characterBase64,
          cellBase64,
          animName,
          refinePrompt,
          renderModel,
          start + offset,
          sheetCells.length,
          context,
          officialDescription,
        ),
      ));
      refinedCells.push(...batchResults);
    }
  }
  debugLog(
    `[GeminiApi] Sheet-refine ${animName}: all ${refinedCells.length} refines done in ${((Date.now() - refineStart) / 1000).toFixed(1)}s`,
  );

  if (official) {
    const initialReview = mergeOfficialSpriteReviews([
      await reviewOfficialRefinedCells(
        refinedCells,
        official,
        animName,
        motion,
        'initial-local',
        context,
      ),
      await reviewOfficialRefinedCells(
        refinedCells,
        official,
        animName,
        motion,
        'initial-continuity',
        context,
      ),
      await reviewOfficialRefinedCells(
        refinedCells,
        official,
        animName,
        motion,
        'initial-wardrobe',
        context,
      ),
    ]);
    if (initialReview.retry.length > 0) {
      debugInfo(
        `[GeminiApi] Official ${animName} QA: rerendering ${initialReview.retry.length}/${refinedCells.length} rejected frames with ${renderModel}...`,
      );
      for (const frameIndex of initialReview.retry) {
        const poseGuide = geminiOfficialCorrectionUsesCanonicalPoseGuide(
          initialReview,
          animName,
          frameIndex,
          sheetCells.length,
        )
          ? characterBase64
          : sheetCells[frameIndex];
        refinedCells[frameIndex] = await refineSheetCell(
          characterBase64,
          poseGuide,
          animName,
          refinePrompt,
          renderModel,
          frameIndex,
          sheetCells.length,
          context,
          official,
          geminiOfficialReviewCorrection(
            initialReview,
            frameIndex,
            animName,
            sheetCells.length,
          ),
        );
      }

      const finalReview = await reviewOfficialRefinedCells(
        refinedCells,
        official,
        animName,
        motion,
        'post-correction',
        context,
      );
      if (finalReview.retry.length > 0) {
        throw new GeminiOfficialSpriteQualityError(
          `Gemini official ${animName} visual QA still rejected frames ${finalReview.retry.map((idx) => idx + 1).join(', ')} after selective rerender`,
        );
      }
    }

    const framingRecovery: Array<{ frameIndex: number; croppedEdges: OfficialFrameEdge[] }> = [];
    for (let frameIndex = 0; frameIndex < refinedCells.length; frameIndex++) {
      const bounds = await measureGreenBackedCharacterBounds(refinedCells[frameIndex]);
      if (!bounds) {
        throw new GeminiOfficialSpriteQualityError(
          `Gemini official ${animName} frame ${frameIndex + 1}/${refinedCells.length} could not be measured for complete-body framing`,
        );
      }
      const validation = geminiOfficialFrameFramingValidation(bounds);
      if (!validation.ok) {
        framingRecovery.push({ frameIndex, croppedEdges: validation.croppedEdges });
      }
    }

    if (framingRecovery.length > 0) {
      debugInfo(
        `[GeminiApi] Official ${animName} framing gate: selectively rerendering ${framingRecovery.map(({ frameIndex, croppedEdges }) =>
          `${frameIndex + 1} (${croppedEdges.join('/')})`,
        ).join(', ')}`,
      );
      for (const { frameIndex, croppedEdges } of framingRecovery) {
        refinedCells[frameIndex] = await recoverOfficialFrameFraming(
          characterBase64,
          sheetCells[frameIndex],
          refinedCells[frameIndex],
          animName,
          motion,
          renderModel,
          frameIndex,
          sheetCells.length,
          official,
          croppedEdges,
          context,
        );

        const recoveredBounds = await measureGreenBackedCharacterBounds(refinedCells[frameIndex]);
        const recoveredValidation = recoveredBounds
          ? geminiOfficialFrameFramingValidation(recoveredBounds)
          : null;
        if (!recoveredValidation?.ok) {
          throw new GeminiOfficialSpriteQualityError(
            `Gemini official ${animName} frame ${frameIndex + 1}/${refinedCells.length} still touches an image edge after selective framing recovery`,
          );
        }
      }

      const framingReview = await reviewOfficialRefinedCells(
        refinedCells,
        official,
        animName,
        motion,
        'post-framing-recovery',
        context,
      );
      if (framingReview.retry.length > 0) {
        throw new GeminiOfficialSpriteQualityError(
          `Gemini official ${animName} visual QA rejected frames ${framingReview.retry.map((idx) => idx + 1).join(', ')} after framing recovery`,
        );
      }
    }
  }

  const outputFrameCount = shouldMirror ? frames : refinedCells.length;
  const outputGridCols = computeGridCols(outputFrameCount);
  const outputGridRows = Math.ceil(outputFrameCount / outputGridCols);
  const rawOutputCells = shouldMirror
    ? expandMirroredSequence(refinedCells, outputFrameCount)
    : refinedCells;

  // Step 4: compose the refined frames into a sheet at Gemini-native resolution (green bg).
  //         This is the "raw" version — what Save RAW downloads.
  const rawSheetBase64 = await composeRefinedFramesToSheet(
    rawOutputCells,
    outputGridCols,
    outputGridRows,
  );
  const rawDims = await getImageDimensions(rawSheetBase64);

  // Step 5: per-frame cleanup. Runs BiRefNet AND chroma-key flood-fill on each
  //         cell and unions the alpha masks. BiRefNet sometimes erroneously eats
  //         face pixels (low-contrast highlights it confuses with bg); chroma
  //         flood-fill from edges can never punch interior holes — together they
  //         cover each other's blind spots.
  const cleanedUniqueCells = options?.enableBgRemoval === false
    ? refinedCells
    : await cleanCellsWithUnionMasks(refinedCells, animName, context);
  // Step 6-7: normalize paid attack keyframes before expanding the mirrored
  // playback sequence. The critical-frame filters intentionally cap attacks at
  // four generated keyframes; running them after 4 -> 7 expansion would trim a
  // valid sequence back to four frames.
  let cleaned: CleanSheetResult;
  if (shouldMirror) {
    const uniqueGridCols = computeGridCols(cleanedUniqueCells.length);
    const uniqueGridRows = Math.ceil(cleanedUniqueCells.length / uniqueGridCols);
    const uniqueSheetBase64 = await composeRefinedFramesToSheet(
      cleanedUniqueCells,
      uniqueGridCols,
      uniqueGridRows,
      { padding: 'transparent' },
    );
    const normalizedUnique = await cleanSpriteSheet(
      uniqueSheetBase64,
      cleanedUniqueCells.length,
      uniqueGridCols,
      uniqueGridRows,
      animName,
      maxScale,
      normalizationReference,
    );
    if (official && normalizedUnique.frameCount < cleanedUniqueCells.length) {
      throw new GeminiOfficialSpriteQualityError(
        `Gemini refined sprite sheet for ${animName} only produced ${normalizedUnique.frameCount} reliable keyframes ` +
        `(need ${cleanedUniqueCells.length})`,
      );
    }
    const mirrored = await mirrorCleanFrames(
      normalizedUnique.base64,
      normalizedUnique.frameCount,
      outputFrameCount,
      normalizedUnique.gridCols,
      normalizedUnique.gridRows,
    );
    cleaned = { ...mirrored, usedScale: normalizedUnique.usedScale };
  } else {
    const displaySheetBase64 = await composeRefinedFramesToSheet(
      cleanedUniqueCells,
      outputGridCols,
      outputGridRows,
      { padding: 'transparent' },
    );
    cleaned = await cleanSpriteSheet(
      displaySheetBase64,
      outputFrameCount,
      outputGridCols,
      outputGridRows,
      animName,
      maxScale,
      normalizationReference,
    );
  }

  debugInfo(
    `[GeminiApi] Sheet-refine ${animName}: total ${((Date.now() - start) / 1000).toFixed(1)}s ` +
    `(raw ${rawDims.width}x${rawDims.height}, cleaned ${cleaned.frameW * cleaned.gridCols}x${cleaned.frameH * cleaned.gridRows})`,
  );

  const result: GeminiSpriteResult = {
    imageBase64: cleaned.base64,
    rawBase64: rawSheetBase64,
    gridCols: cleaned.gridCols,
    gridRows: cleaned.gridRows,
    frameCount: cleaned.frameCount,
    usedScale: cleaned.usedScale,
  };
  const minimumFrames = official ? outputFrameCount : Math.min(
    outputFrameCount,
    getMinimumReliableFrames(animName),
  );
  if (cleaned.frameCount < minimumFrames) {
    const message = `Gemini refined sprite sheet for ${animName} only produced ${cleaned.frameCount} reliable frames (need ${minimumFrames})`;
    if (official) throw new GeminiOfficialSpriteQualityError(message);
    throw new PartialSpriteGenerationError(message, result);
  }
  return result;
}

// Combines the chroma and DNN masks to recover foreground details without
// reviving transparent chroma RGB as a green fringe.
async function unionMasksPreserveForeground(
  chromaResult: string,
  birefnetResult: string,
): Promise<string> {
  const chromaImg = await loadAlphaImage(`data:image/png;base64,${chromaResult}`);
  const birefnetImg = await loadAlphaImage(`data:image/png;base64,${birefnetResult}`);

  const canvas = document.createElement('canvas');
  canvas.width = chromaImg.width;
  canvas.height = chromaImg.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(chromaImg, 0, 0);

  const birefCanvas = document.createElement('canvas');
  birefCanvas.width = chromaImg.width;
  birefCanvas.height = chromaImg.height;
  const birefCtx = birefCanvas.getContext('2d')!;
  // Resize BiRefNet output to match chroma's resolution if needed (fal might
  // return a different size; bilinear scale of an alpha mask is acceptable).
  birefCtx.drawImage(birefnetImg, 0, 0, chromaImg.width, chromaImg.height);

  const chromaData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const birefData = birefCtx.getImageData(0, 0, birefCanvas.width, birefCanvas.height);

  unionForegroundMasks(chromaData.data, birefData.data, canvas.width, canvas.height);
  decontaminateGreenEdges(chromaData.data, canvas.width, canvas.height);

  ctx.putImageData(chromaData, 0, 0);
  return canvas.toDataURL('image/png').split(',')[1];
}

// Cleans every refined cell using DNN segmentation and the chroma-key
// flood-fill, unioned. Requests run in bounded batches; fal failures try the
// Freepik DNN before a frame is allowed to fall back to chroma alone.
async function cleanCellsWithUnionMasks(
  cellBase64s: string[],
  animName: string,
  context?: ApiRequestContext,
): Promise<string[]> {
  const provider = getConfiguredBgRemovalProvider();
  const start = Date.now();
  if (provider === 'none') {
    debugLog(`[GeminiApi] Sheet-refine ${animName}: bg-removal disabled (provider=none) — chroma-key only`);
    return Promise.all(cellBase64s.map((c) => cleanReposedImagePreserveCanvas(c)));
  }

  debugLog(`[GeminiApi] Sheet-refine ${animName}: cleaning ${cellBase64s.length} frames via chroma+${provider} union (with pre-neutralize)...`);

  let dnnOk = 0;
  const cleaned: string[] = [];
  const concurrency = 3;
  for (let startIndex = 0; startIndex < cellBase64s.length; startIndex += concurrency) {
    const batch = cellBase64s.slice(startIndex, startIndex + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (rawGreenCell, batchIndex) => {
        const idx = startIndex + batchIndex;
        // Pre-correction: neutralize green ambient bounce on character pixels
        // BEFORE we segment. Both chroma and DNN removal work better on a cell
        // where skin highlights aren't tinted green. The chroma background
        // itself stays intact, so chroma-key still has something to flood-fill.
        let neutralizedCell: string;
        try {
          neutralizedCell = await neutralizeGreenSpillForSegmentation(rawGreenCell);
        } catch (err: any) {
          debugWarn(
            `[GeminiApi] Sheet-refine ${animName} pre-neutralize failed frame ${idx + 1}/${cellBase64s.length}: ${err.message} — using raw cell`,
          );
          neutralizedCell = rawGreenCell;
        }

        let chromaCleaned: string;
        try {
          chromaCleaned = await cleanReposedImagePreserveCanvas(neutralizedCell);
        } catch (err: any) {
          debugWarn(`[GeminiApi] Sheet-refine ${animName} chroma failed frame ${idx + 1}/${cellBase64s.length}: ${err.message}`);
          return neutralizedCell;
        }

        try {
          const birefnetResult = await removeBackgroundWithConfiguredProvider(neutralizedCell, context);
          if (!birefnetResult) {
            debugWarn(
              `[GeminiApi] Sheet-refine ${animName} ${provider} returned null frame ${idx + 1}/${cellBase64s.length} — chroma only`,
            );
            return chromaCleaned;
          }
          dnnOk += 1;
          return unionMasksPreserveForeground(chromaCleaned, birefnetResult);
        } catch (err: any) {
          if (err instanceof ApiSessionChangedError) throw err;
          debugWarn(
            `[GeminiApi] Sheet-refine ${animName} ${provider} failed frame ${idx + 1}/${cellBase64s.length} (${err.message}) — chroma only`,
          );
          return chromaCleaned;
        }
      }),
    );
    cleaned.push(...batchResults);
  }

  debugLog(
    `[GeminiApi] Sheet-refine ${animName}: cleanup done in ${((Date.now() - start) / 1000).toFixed(1)}s ` +
    `(${dnnOk}/${cellBase64s.length} unioned with ${provider}, ${cellBase64s.length - dnnOk} chroma-only)`,
  );
  return cleaned;
}

// ─── Stage backgrounds ──────────────────────────────────────────────

export interface GeminiStageBackgroundRequest {
  stageLabel: string;
  stageBlurb: string;
  fighterOneName?: string;
  fighterTwoName?: string;
  fighterOneStyle?: string;
  fighterTwoStyle?: string;
  sourceImage?: { data: string; mime: string };
  sourceMode?: 'inspire' | 'transform-scene';
  referenceImages?: { data: string; mime: string }[];
}

export async function geminiStageBackground(
  req: GeminiStageBackgroundRequest,
  context?: ApiRequestContext,
): Promise<{ imageBase64: string; prompt: string }> {
  const model = resolveGeminiImageModel({ operation: 'stage' });
  const prompt: string[] = [
    `Create a dramatic arcade fighting game stage background for a versus match.`,
    `Theme: ${req.stageLabel}. ${req.stageBlurb}`,
  ];

  if (req.fighterOneName && req.fighterTwoName && req.fighterOneStyle && req.fighterTwoStyle) {
    prompt.push(
      `Fighter one: ${req.fighterOneName} (${req.fighterOneStyle}).`,
      `Fighter two: ${req.fighterTwoName} (${req.fighterTwoStyle}).`,
    );
  }

  prompt.push('');

  if (req.sourceImage && req.sourceMode === 'transform-scene') {
    prompt.push(
      `SOURCE IMAGE RULES:`,
      `- The uploaded image is the actual place to transform into the arena.`,
      `- Preserve the location's recognizable layout, architecture, major props, floor lines, horizon, and camera perspective.`,
      `- Reinterpret the place into polished stylized 2D fighting-game background art, not a raw photo.`,
      `- Do NOT ignore the supplied scene and replace it with a generic stage.`,
      `- If the original photo does not show enough walkable foreground, extend the same location naturally toward the camera so the arena has a proper playable floor.`,
      `- Remove or simplify any visible people so the final scene contains no foreground characters.`,
      '',
    );
  }

  if (req.referenceImages?.length) {
    prompt.push(
      `REFERENCE USAGE RULES:`,
      `- Use any extra reference photos only to borrow color palette, fashion cues, attitude, and world-building inspiration.`,
      `- Do NOT place the referenced people or any fighters in the scene.`,
      '',
    );
  }

  prompt.push(
    `COMPOSITION RULES:`,
    `- Produce a single widescreen 16:9 arena background.`,
    `- Side-on camera suitable for a 2D fighting game match.`,
    `- Leave the center lane visually readable for two fighters standing and moving.`,
    `- The lower 25-35% of the image must read as continuous playable floor, ground, dock, street, platform, or arena surface from left to right.`,
    `- Include a clear floor or ground plane along the bottom of the image with enough visible depth below the fighters.`,
    `- Keep the middle-lower lane free of blocking props so the fighters do not look cramped or cut off.`,
    `- Rich layered background depth, strong atmosphere, and cinematic lighting.`,
    `- No text, no logos, no UI, no watermarks, no speech bubbles.`,
    `- No foreground characters, no crowd close-ups blocking the arena.`,
    ``,
    `STYLE RULES:`,
    `- High-quality stylized game art with bold silhouettes and readable background shapes.`,
    `- The stage should feel handcrafted, viral, and slightly exaggerated rather than generic concept art.`,
  );

  const finalPrompt = prompt.join('\n');

  debugInfo(`[GeminiApi] Generating stage background with ${model}: ${req.stageLabel}...`);
  const result = await callGemini(
    finalPrompt,
    req.sourceImage?.data,
    req.sourceImage?.mime ?? 'image/png',
    req.referenceImages,
    model,
    context,
  );
  if (!result.imageBase64) throw new Error('Gemini stage background returned no image');

  return {
    imageBase64: result.imageBase64,
    prompt: finalPrompt,
  };
}
