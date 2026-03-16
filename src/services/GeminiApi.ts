import { CELL_H, CELL_W, cleanReposedImagePreserveCanvas, cleanSpriteSheet, mirrorCleanFrames, computeGridCols, zoomTransparentImageToBottom, type CleanSheetResult, type NormalizationReference } from './SpritePostProcess';
import { getAnimationProfile } from './AnimationProfiles';
import { publishDebugLog, publishDebugMultiline } from './DebugLog';

const GEMINI_BASE = '/proxy/gemini/v1beta/models';
const MODEL = 'gemini-3.1-flash-image-preview';

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

interface GeminiResponse {
  candidates?: Array<{
    content: { parts: GeminiPart[] };
    finishReason?: string;
  }>;
  error?: { code: number; message: string };
}

async function callGemini(prompt: string, imageBase64?: string, mimeType = 'image/png', extraImages?: { data: string; mime: string }[]): Promise<{ text: string; imageBase64: string | null; imageMime: string | null }> {
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

  const res = await fetch(`${GEMINI_BASE}/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: reqParts }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini ${res.status}: ${body.slice(0, 300)}`);
  }

  const json: GeminiResponse = await res.json();
  const candidate = json.candidates?.[0];
  if (!candidate) {
    console.error('[GeminiApi] No candidates. Full response:', JSON.stringify(json).slice(0, 500));
    throw new Error('Gemini returned no candidates');
  }

  const resParts = candidate.content?.parts;
  if (!resParts || !Array.isArray(resParts)) {
    const reason = candidate.finishReason || 'unknown';
    console.error(`[GeminiApi] No parts in response. finishReason: ${reason}`, JSON.stringify(candidate).slice(0, 500));
    throw new Error(`Gemini returned no content (finishReason: ${reason})`);
  }

  let text = '';
  let imageData: { data: string; mimeType: string } | null = null;

  for (const part of resParts) {
    if (part.text) text += part.text;
    if (part.inlineData) imageData = part.inlineData;
  }

  return {
    text,
    imageBase64: imageData?.data ?? null,
    imageMime: imageData?.mimeType ?? null,
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

export async function geminiReposeDetailed(photoBase64: string): Promise<GeminiPoseResult> {
  console.log('[GeminiApi] Reposing character...');
  const start = Date.now();

  let rawBase64: string | null = null;

  try {
    const prompt = REPOSE_BASE + ` Preserve the original clothing/outfit faithfully.`;
    const result = await callGemini(prompt, photoBase64);
    rawBase64 = result.imageBase64;
  } catch (err: any) {
    if (err.message.includes('IMAGE_SAFETY')) {
      console.warn('[GeminiApi] Repose blocked by safety filter, retrying with clothing...');
    } else {
      throw err;
    }
  }

  if (!rawBase64) {
    console.log('[GeminiApi] Retrying repose with added clothing...');
    const result = await callGemini(REPOSE_BASE + REPOSE_CLOTHING_FALLBACK, photoBase64);
    rawBase64 = result.imageBase64;
  }

  if (!rawBase64) throw new Error('Gemini repose returned no image');

  console.log(`[GeminiApi] Repose raw done in ${((Date.now() - start) / 1000).toFixed(1)}s, cleaning...`);
  const cleaned = await cleanReposedImagePreserveCanvas(rawBase64);
  console.log(`[GeminiApi] Repose cleaned in ${((Date.now() - start) / 1000).toFixed(1)}s total`);

  return { rawBase64, cleanedBase64: cleaned };
}

export async function geminiRepose(photoBase64: string): Promise<string> {
  const result = await geminiReposeDetailed(photoBase64);
  return result.cleanedBase64;
}

export async function geminiUprightReposeDetailed(sideViewBase64: string): Promise<GeminiPoseResult> {
  console.log('[GeminiApi] Generating upright reference...');
  const start = Date.now();
  const rawBase64 = await generateGeminiImageWithSafetyFallback(UPRIGHT_REPOSE_PROMPT, sideViewBase64);
  console.log(`[GeminiApi] Upright raw done in ${((Date.now() - start) / 1000).toFixed(1)}s, cleaning...`);
  const cleaned = await cleanReposedImagePreserveCanvas(rawBase64);
  console.log(`[GeminiApi] Upright cleaned in ${((Date.now() - start) / 1000).toFixed(1)}s total`);
  publishDebugLog('[GeminiApi] Upright reference generated from side view');
  return { rawBase64, cleanedBase64: cleaned };
}

export async function geminiUprightRepose(sideViewBase64: string): Promise<string> {
  const result = await geminiUprightReposeDetailed(sideViewBase64);
  return result.cleanedBase64;
}

// ─── Crouch Repose ────────────────────────────────────────────────────

const CROUCH_REPOSE_PROMPT = `Using this fighting character as reference, create the SAME character in an extreme classic 2D fighting-game crouch defensive guard, as if the player is holding the down arrow.

Keep the exact 3/4 side-view facing right, the same face, outfit, proportions, and art style.
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
- the result should read as an extreme Street Fighter down-arrow crouch-block / defensive guard, not a medium squat, not a half-crouch, and not a relaxed standing pose

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
  console.log(message);
  publishDebugLog(message);
}

function debugWarn(message: string): void {
  console.warn(message);
  publishDebugLog(message);
}

function summarizePrompt(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').trim().slice(0, 220);
}

async function getImageDimensions(base64: string): Promise<{ width: number; height: number }> {
  const img = await loadAlphaImage(`data:image/png;base64,${base64}`);
  return { width: img.width, height: img.height };
}

async function generateGeminiImageWithSafetyFallback(prompt: string, imageBase64: string): Promise<string> {
  let rawBase64: string | null = null;

  try {
    const result = await callGemini(prompt, imageBase64);
    rawBase64 = result.imageBase64;
  } catch (err: any) {
    if (err.message.includes('IMAGE_SAFETY')) {
      console.warn('[GeminiApi] Prompt blocked by safety, retrying with clothing...');
      const result = await callGemini(prompt + REPOSE_CLOTHING_FALLBACK, imageBase64);
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
): Promise<GeminiCrouchOption[]> {
  console.log('[GeminiApi] Generating crouched view...');
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
  console.log('[GeminiApi] Crouch prompt:\n' + CROUCH_REPOSE_PROMPT);
  publishDebugLog(`[GeminiApi] Crouch prompt summary: ${summarizePrompt(CROUCH_REPOSE_PROMPT)}`);
  publishDebugMultiline(
    `[GeminiApi] Crouch prompt lines:\n${CROUCH_REPOSE_PROMPT}`,
  );
  const options: GeminiCrouchOption[] = [];

  for (let i = 0; i < promptVariants.length; i++) {
    const prompt = promptVariants[i];
    try {
      const rawBase64 = await generateGeminiImageWithSafetyFallback(prompt, sideViewBase64);
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
): Promise<string> {
  const result = await geminiCrouchReposeDetailed(sideViewBase64, normalizationReference, standingMetricsBase64);
  return result.cleanedBase64;
}

export async function geminiCrouchReposeDetailed(
  sideViewBase64: string,
  normalizationReference?: NormalizationReference,
  standingMetricsBase64 = sideViewBase64,
): Promise<GeminiPoseResult> {
  const options = await geminiCrouchReposeOptions(sideViewBase64, normalizationReference, standingMetricsBase64);
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

const MIRROR_ANIMS = new Set(['high_punch', 'low_punch', 'high_kick', 'low_kick']);

function getMinimumReliableFrames(animName: string): number {
  if (animName === 'jump') return 3;
  if (animName === 'hit') return 2;
  if (animName === 'low_punch' || animName === 'low_kick') return 3;
  return 1;
}

export async function geminiSpriteSheet(
  characterBase64: string,
  animName: string,
  motion: string,
  frames: number,
  secondaryBase64?: string,
  maxScale?: number,
  normalizationReference?: NormalizationReference,
): Promise<GeminiSpriteResult> {
  const shouldMirror = MIRROR_ANIMS.has(animName);
  const profile = getAnimationProfile(animName);

  const genFrames = shouldMirror ? Math.ceil(frames / 2) : frames;
  const gridCols = computeGridCols(genFrames);
  const gridRows = Math.ceil(genFrames / gridCols);

  const motionDesc = shouldMirror
    ? motion.replace(/then (?:returning|retracting|back) to stance/i, '').replace(/,\s*$/, '').trim()
    : motion;

  const hasTwoRefs = !!secondaryBase64;

  let endNote: string;
  if (hasTwoRefs) {
    endNote = `- IMAGE 1 (first reference) shows the START pose (frame 1). IMAGE 2 (second reference) shows the END pose (frame ${genFrames}). The animation must smoothly transition between these two poses across all ${genFrames} frames.`;
  } else if (shouldMirror) {
    endNote = `- Frame 1 is the resting stance. Each subsequent frame progresses the motion further. Frame ${genFrames} is the peak/impact moment of the action. Do NOT show the character returning to stance — only the wind-up through impact.`;
  } else {
    endNote = `- Frame 1 starts in the base stance. The motion progresses gradually through the middle frames. The final frame returns to or finishes the pose.`;
  }

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
    `- The character must face right in every frame.`,
    ...profile.promptRules.map((rule) => `- ${rule}`),
    ``,
    `FRAMING RULES (CRITICAL):`,
    `- EVERY frame MUST show the COMPLETE character from head to feet — never crop or zoom in.`,
    `- The character must be the SAME SIZE in every frame — do NOT zoom in or out between frames.`,
    `- Frame the character so they occupy roughly ${targetHeightPct}% of the cell height and at most ${targetWidthPct}% of the cell width.`,
    `- Keep the feet near the same floor line close to the bottom of every cell.`,
    `- Even for subtle animations, maintain the EXACT same camera distance and framing as the reference image.`,
    ``,
    `STYLE RULES:`,
    `- Preserve the exact same visual style, proportions, colors, and textures of the reference character — do NOT change the art style.`,
    `- Each frame shows the complete character at the same scale and vertical position.`,
    `- Pure bright green (#00FF00) background in every cell — flat, uniform, vivid green with no gradients, shadows, or ground.`,
  ].join('\n');

  console.log(`[GeminiApi] Generating sprite: ${animName} (${gridCols}x${gridRows}, ${genFrames} frames${shouldMirror ? ', will mirror to ' + frames : ''})...`);
  const start = Date.now();

  const extras = secondaryBase64 ? [{ data: secondaryBase64, mime: 'image/png' }] : undefined;
  const minReliableFrames = getMinimumReliableFrames(animName);
  const promptVariants = [prompt];
  if (animName === 'jump' || animName === 'hit') {
    promptVariants.push(
      `${prompt}\n- CRITICAL: keep every full body centered fully inside its own cell with empty green margin on all sides.\n- CRITICAL: if a pose would cross a cell boundary, make the pose smaller instead of cropping it.\n- CRITICAL: do not include any oversized hero frame, close-up frame, or pose that spans more than one cell.`,
    );
  } else if (animName === 'low_punch' || animName === 'low_kick') {
    promptVariants.push(
      `${prompt}\n- CRITICAL: every populated cell must contain exactly one full-body character from head to feet.\n- CRITICAL: do not leave internal cells empty; all ${genFrames} cells must show a valid sequential step of the move.\n- CRITICAL: do not include any oversized close-up pose, merged multi-cell pose, or cropped body.\n- CRITICAL: keep the character low to the ground while still fully contained inside each cell with visible green margin around the silhouette.`,
    );
  }

  let geminiRawBase64: string | null = null;
  let cleaned: CleanSheetResult | null = null;

  for (const attemptPrompt of promptVariants) {
    let rawBase64: string | null = null;

    try {
      const result = await callGemini(attemptPrompt, characterBase64, 'image/png', extras);
      rawBase64 = result.imageBase64;
    } catch (err: any) {
      if (err.message.includes('IMAGE_SAFETY')) {
        console.warn(`[GeminiApi] Sprite ${animName} blocked by safety, retrying with clothing note...`);
        const safePrompt = attemptPrompt + `\n\nIMPORTANT: The character must be fully clothed in a fighting outfit (shirt, pants, shoes). Add clothing if needed.`;
        const result = await callGemini(safePrompt, characterBase64, 'image/png', extras);
        rawBase64 = result.imageBase64;
      } else {
        throw err;
      }
    }

    if (!rawBase64) continue;

    const nextCleaned = await cleanSpriteSheet(rawBase64, genFrames, gridCols, gridRows, animName, maxScale, normalizationReference);
    geminiRawBase64 = rawBase64;
    cleaned = nextCleaned;
    if (nextCleaned.frameCount >= minReliableFrames) {
      break;
    }

    console.warn(
      `[GeminiApi] ${animName}: rejected attempt with only ${nextCleaned.frameCount} reliable frames (need ${minReliableFrames})`,
    );
  }

  if (!geminiRawBase64 || !cleaned) {
    throw new Error(`Gemini sprite sheet for ${animName} returned no image`);
  }
  if (cleaned.frameCount < minReliableFrames) {
    throw new Error(`Gemini sprite sheet for ${animName} only produced ${cleaned.frameCount} reliable frames`);
  }

  console.log(`[GeminiApi] ${animName} cleaned in ${((Date.now() - start) / 1000).toFixed(1)}s (scale ${cleaned.usedScale.toFixed(2)})`);

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

export async function geminiStageBackground(req: GeminiStageBackgroundRequest): Promise<{ imageBase64: string; prompt: string }> {
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

  console.log(`[GeminiApi] Generating stage background: ${req.stageLabel}...`);
  const result = await callGemini(
    finalPrompt,
    req.sourceImage?.data,
    req.sourceImage?.mime ?? 'image/png',
    req.referenceImages,
  );
  if (!result.imageBase64) throw new Error('Gemini stage background returned no image');

  return {
    imageBase64: result.imageBase64,
    prompt: finalPrompt,
  };
}
