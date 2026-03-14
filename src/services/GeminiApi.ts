import { cleanReposedImage, cleanSpriteSheet, mirrorCleanFrames, computeGridCols, type CleanSheetResult } from './SpritePostProcess';
import { getAnimationProfile } from './AnimationProfiles';

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

// ─── Repose ──────────────────────────────────────────────────────────

const REPOSE_BASE = `Using this photo as reference, create a full-body fighting game character. Preserve the EXACT same visual style, art style, textures, colors, and level of detail from the original image — do NOT change the aesthetic. Keep the same face, hair, and skin tone faithfully. If only a face or upper body is shown, imagine and generate the rest of the body (legs, feet, full outfit) in a style consistent with what is visible. The character should be in a 3/4 view facing right in a fighting stance — fists raised, feet planted shoulder-width apart, slight forward lean. Show the COMPLETE body from head to feet with nothing cropped. Pure bright green (#00FF00) background — the entire background must be a flat, uniform, vivid green with no gradients or shadows.`;

const REPOSE_CLOTHING_FALLBACK = ` The character MUST be wearing a full fighting outfit — tank top or t-shirt, long pants or martial arts gi, and shoes/boots. Add clothing if the original has none. Keep the outfit style consistent with the character's aesthetic.`;

export async function geminiRepose(photoBase64: string): Promise<string> {
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
  const cleaned = await cleanReposedImage(rawBase64, 'idle');
  console.log(`[GeminiApi] Repose cleaned in ${((Date.now() - start) / 1000).toFixed(1)}s total`);

  return cleaned;
}

// ─── Crouch Repose ────────────────────────────────────────────────────

const CROUCH_REPOSE_PROMPT = `Using this fighting character as reference, create the SAME character in a DEEP CROUCH position. This is NOT a standing pose — the character's knees must be bent at roughly 90 degrees, hips dropped very low, torso leaning forward, head at roughly HALF the height of the standing version. Think of a Street Fighter crouch block: the character is ducking under a high punch. Fists still raised near the chin, but everything is compressed downward. The character's overall silhouette height should be approximately 55-65% of the standing version. Same 3/4 view facing right. Preserve the EXACT same visual style, art style, textures, colors, outfit, face, hair, skin tone. Show the COMPLETE body from head to feet with nothing cropped. Pure bright green (#00FF00) background — the entire background must be a flat, uniform, vivid green with no gradients or shadows.`;

export async function geminiCrouchRepose(sideViewBase64: string): Promise<string> {
  console.log('[GeminiApi] Generating crouched view...');
  const start = Date.now();

  let rawBase64: string | null = null;

  try {
    const result = await callGemini(CROUCH_REPOSE_PROMPT, sideViewBase64);
    rawBase64 = result.imageBase64;
  } catch (err: any) {
    if (err.message.includes('IMAGE_SAFETY')) {
      console.warn('[GeminiApi] Crouch repose blocked by safety, retrying with clothing...');
      const result = await callGemini(CROUCH_REPOSE_PROMPT + REPOSE_CLOTHING_FALLBACK, sideViewBase64);
      rawBase64 = result.imageBase64;
    } else {
      throw err;
    }
  }

  if (!rawBase64) throw new Error('Gemini crouch repose returned no image');

  console.log(`[GeminiApi] Crouch repose raw done in ${((Date.now() - start) / 1000).toFixed(1)}s, cleaning...`);
  const cleaned = await cleanReposedImage(rawBase64, 'crouch');
  console.log(`[GeminiApi] Crouch repose cleaned in ${((Date.now() - start) / 1000).toFixed(1)}s total`);

  return cleaned;
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
  return 1;
}

export async function geminiSpriteSheet(
  characterBase64: string,
  animName: string,
  motion: string,
  frames: number,
  secondaryBase64?: string,
  maxScale?: number,
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

  const targetHeightPct = Math.round(profile.targetHeightRatio * 100);
  const targetWidthPct = Math.round(profile.targetWidthRatio * 100);

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

    const nextCleaned = await cleanSpriteSheet(rawBase64, genFrames, gridCols, gridRows, animName, maxScale);
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
