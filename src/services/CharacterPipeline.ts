import {
  hashPhoto,
  getCachedMeta,
  setCachedMeta,
  getCachedSprite,
  setCachedSprite,
  getAllSpritesForHash,
  CACHE_VERSION,
  type CachedMeta,
  type CachedSprite,
} from './SpriteCache';
import { geminiReposeDetailed, geminiUprightReposeDetailed, geminiCrouchRepose, geminiCrouchReposeDetailed, geminiSpriteSheet } from './GeminiApi';
import { CELL_H, CELL_W, cleanSpriteSheet, mirrorCleanFrames, computeGridCols, measureOpaqueBoundsFromBase64, type NormalizationReference } from './SpritePostProcess';
import { getAnimationProfile } from './AnimationProfiles';
import { publishDebugLog } from './DebugLog';
import { ludoAnimateSprite } from './LudoApi';
import { freepikImageToFightingStance, freepikRemoveBackground, blobToBase64 } from './FreepikApi';
import { prepareBaseImage } from './ImagePrep';

export type PipelineProvider = 'gemini' | 'ludo';

export type PipelineStatus =
  | { stage: 'hashing' }
  | { stage: 'cached'; photoHash: string }
  | { stage: 'converting_side_view' }
  | { stage: 'converting_upright_view' }
  | { stage: 'converting_crouch_view' }
  | { stage: 'converting_side_view_polling'; taskId: string }
  | { stage: 'preparing_base' }
  | { stage: 'generating_sprites'; animation: string; current: number; total: number }
  | { stage: 'sprite_ready'; animation: string; photoHash: string; current: number; total: number }
  | { stage: 'falling_back'; reason: string }
  | { stage: 'done'; photoHash: string }
  | { stage: 'error'; message: string };

export type StatusCallback = (status: PipelineStatus) => void;

type AnimBase = 'standing' | 'crouched';

interface AnimDef {
  name: string;
  motion: string;
  frames: number;
  duration: number;
  loop: boolean;
  base: AnimBase;
}

const ANIMATIONS: AnimDef[] = [
  { name: 'idle',       motion: 'idle fighting stance with very subtle weight shifting and breathing sway, fists raised, feet planted — the character barely moves, just alive and ready', frames: 16, duration: 2,   loop: true,  base: 'standing' },
  { name: 'walk',       motion: 'walking forward to the right cycle, fighting game walk',                                          frames: 16, duration: 1.5, loop: true,  base: 'standing' },
  { name: 'high_punch', motion: 'quick grounded standing jab punch extending the lead arm forward while both feet stay planted, then retracting to stance', frames: 7, duration: 1.0, loop: false, base: 'standing' },
  { name: 'high_kick',  motion: 'powerful grounded standing roundhouse kick swinging the right leg in a high arc while the support foot stays planted, then returning to stance', frames: 7, duration: 1.2, loop: false, base: 'standing' },
  { name: 'low_punch',  motion: 'quick low jab punch from an extreme low-profile crouch, extending the right arm forward while staying low throughout, with hips dropped very low and thighs near-parallel to the ground, then retracting', frames: 7, duration: 1.0, loop: false, base: 'crouched' },
  { name: 'low_kick',   motion: 'low grounded sweep kick extending the right leg along the floor from an extreme low-profile crouch while staying low throughout, with hips dropped very low and thighs near-parallel to the ground, then retracting', frames: 7, duration: 1.2, loop: false, base: 'crouched' },
  { name: 'jump',       motion: 'four clear jump key poses: grounded anticipation, airborne lift-off, apex airborne pose, and grounded landing recovery, with the character staying the same size in frame and not physically traveling upward inside the frame', frames: 4, duration: 1.5, loop: false, base: 'standing' },
  { name: 'crouch',     motion: 'transitioning from standing fighting stance down into an extreme low-profile crouch with visibly dropped hips, bent knees, thighs near-parallel to the ground, a tightly compressed torso, and a much lower head position by the final frame, while keeping the head facing the same direction', frames: 4, duration: 1.2, loop: false, base: 'crouched' },
  { name: 'hit',        motion: 'four clear hit-reaction key poses: impact, recoil, stagger, and grounded recovery without falling or becoming airborne', frames: 4,  duration: 1.0, loop: false, base: 'standing' },
  { name: 'ko',         motion: 'falling to the ground, knocked out, collapsing backward',                                         frames: 16, duration: 2,   loop: false, base: 'standing' },
  { name: 'victory',    motion: 'big arcade-style victory celebration with an unmistakably triumphant winning pose: chest lifted, shoulders back, chin up, one or both arms raised or pumping in triumph, then settling into a proud champion hold facing right', frames: 8, duration: 1.8, loop: false, base: 'standing' },
];

let activeProvider: PipelineProvider = 'gemini';
const CRITICAL_ANIMATION_NAMES = new Set(['jump', 'hit']);
const MIRRORED_ANIMATION_NAMES = new Set(['high_punch', 'low_punch', 'high_kick', 'low_kick']);
const criticalSpriteMaintenanceInflight = new Map<string, Promise<void>>();
export const SPRITE_PROCESSING_VERSION = 2;

export function setProvider(p: PipelineProvider) { activeProvider = p; }
export function getProvider(): PipelineProvider { return activeProvider; }
function isCriticalAnimation(name: string): boolean { return CRITICAL_ANIMATION_NAMES.has(name); }

function getMinimumReliableFrameCount(name: string): number {
  if (name === 'jump') return 3;
  if (name === 'hit') return 2;
  if (name === 'low_punch' || name === 'low_kick') return 3;
  return 1;
}

function getAnimationDefinition(name: string): AnimDef {
  const anim = ANIMATIONS.find((entry) => entry.name === name);
  if (!anim) throw new Error(`Unknown animation: ${name}`);
  return anim;
}

function getGenerationFrameCount(anim: AnimDef, cachedSprite?: CachedSprite): number {
  if (!cachedSprite || !isCriticalAnimation(anim.name)) {
    return anim.frames;
  }
  const currentVersion = cachedSprite.processingVersion ?? 0;
  if (currentVersion >= SPRITE_PROCESSING_VERSION) {
    return anim.frames;
  }
  return Math.max(anim.frames, cachedSprite.frameCount);
}

async function fetchImageAsBlob(url: string): Promise<Blob> {
  const proxied = `/proxy/image?url=${encodeURIComponent(url)}`;
  const res = await fetch(proxied);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  return res.blob();
}

// ─── Plan A: Gemini (repose + sprite sheets) ────────────────────────

async function reposeWithGemini(photoBase64: string): Promise<{ rawBase64: string; cleanedBase64: string }> {
  return geminiReposeDetailed(photoBase64);
}

async function crouchReposeWithGemini(
  sideViewBase64: string,
  normalizationReference?: NormalizationReference,
): Promise<string> {
  return geminiCrouchRepose(sideViewBase64, normalizationReference);
}

async function uprightReposeWithGemini(
  sideViewBase64: string,
): Promise<{ rawBase64: string; cleanedBase64: string }> {
  return geminiUprightReposeDetailed(sideViewBase64);
}

async function tryFreepikBgRemoval(base64: string): Promise<Blob | null> {
  try {
    console.log('[Pipeline] Trying Freepik background removal for display version...');
    const cleaned = await freepikRemoveBackground(base64);
    console.log('[Pipeline] Freepik bg removal succeeded');
    return base64ToBlob(cleaned, 'image/png');
  } catch (err: any) {
    console.warn('[Pipeline] Freepik bg removal failed:', err.message);
    return null;
  }
}

async function generateSpriteWithGemini(
  characterBase64: string,
  anim: AnimDef,
  secondaryBase64?: string,
  maxScale?: number,
  normalizationReference?: NormalizationReference,
): Promise<{ blob: Blob; rawBlob: Blob; frameCount: number; frameW: number; frameH: number; usedScale: number }> {
  const result = await geminiSpriteSheet(characterBase64, anim.name, anim.motion, anim.frames, secondaryBase64, maxScale, normalizationReference);
  const rawBlob = base64ToBlob(result.rawBase64 || result.imageBase64, 'image/png');
  const blob = base64ToBlob(result.imageBase64, 'image/png');
  const { width: sheetW, height: sheetH } = await measureImage(blob);
  const frameW = Math.round(sheetW / result.gridCols);
  const frameH = Math.round(sheetH / result.gridRows);
  return { blob, rawBlob, frameCount: result.frameCount, frameW, frameH, usedScale: result.usedScale };
}

// ─── Plan B: Freepik + Ludo (legacy fallback) ───────────────────────

async function reposeWithFreepik(photoBase64: string, onStatus: StatusCallback): Promise<string> {
  onStatus({ stage: 'converting_side_view' });
  const sideViewUrl = await freepikImageToFightingStance(photoBase64);
  const sideViewBlob = await fetchImageAsBlob(sideViewUrl);
  let sideViewBase64 = await blobToBase64(sideViewBlob);

  onStatus({ stage: 'preparing_base' });
  sideViewBase64 = await prepareBaseImage(sideViewBase64);
  return sideViewBase64;
}

async function generateSpriteWithLudo(
  characterBase64: string,
  anim: AnimDef,
): Promise<{ blob: Blob; frameCount: number; frameW: number; frameH: number }> {
  const FACING = 'character facing right throughout, 3/4 view, ';
  const result = await ludoAnimateSprite({
    motion_prompt: `${FACING}${anim.motion}`,
    initial_image: `data:image/png;base64,${characterBase64}`,
    loop: anim.loop,
    crop: true,
    frames: anim.frames as any,
    frame_size: 256,
    margin_ratio_mode: 'none',
    image_type: 'sprite',
    model: 'standard',
    duration: anim.duration as any,
    augment_prompt: true,
  });

  const blob = await fetchImageAsBlob(result.spritesheet_url);
  const { width: sheetW, height: sheetH } = await measureImage(blob);
  const gridCols = Math.round(Math.sqrt(result.num_frames));
  const gridRows = Math.ceil(result.num_frames / gridCols);
  const frameW = Math.round(sheetW / gridCols);
  const frameH = Math.round(sheetH / gridRows);

  return { blob, frameCount: result.num_frames, frameW, frameH };
}

async function rebuildSpriteFromRawBlob(
  photoHash: string,
  sprite: CachedSprite,
  anim: AnimDef,
  normalizationReference?: NormalizationReference,
): Promise<CachedSprite> {
  if (!sprite.rawPngBlob) {
    throw new Error(`No raw sprite data for ${anim.name}`);
  }

  const rawBase64 = await blobToBase64Util(sprite.rawPngBlob);
  const shouldMirror = MIRRORED_ANIMATION_NAMES.has(anim.name);
  const generationFrames = getGenerationFrameCount(anim, sprite);
  const genFrames = shouldMirror ? Math.ceil(generationFrames / 2) : generationFrames;
  const gridCols = computeGridCols(genFrames);
  const gridRows = Math.ceil(genFrames / gridCols);

  const cleaned = await cleanSpriteSheet(rawBase64, genFrames, gridCols, gridRows, anim.name, undefined, normalizationReference);
  if (cleaned.frameCount < getMinimumReliableFrameCount(anim.name)) {
    throw new Error(`Cleaned ${anim.name} sprite has only ${cleaned.frameCount} reliable frames`);
  }
  let finalBase64: string;
  let finalFrameCount: number;
  let finalGridCols: number;
  let finalGridRows: number;

  if (shouldMirror) {
    const mirrored = await mirrorCleanFrames(cleaned.base64, cleaned.frameCount, anim.frames, cleaned.gridCols, cleaned.gridRows);
    finalBase64 = mirrored.base64;
    finalFrameCount = mirrored.frameCount;
    finalGridCols = mirrored.gridCols;
    finalGridRows = mirrored.gridRows;
  } else {
    finalBase64 = cleaned.base64;
    finalFrameCount = cleaned.frameCount;
    finalGridCols = cleaned.gridCols;
    finalGridRows = cleaned.gridRows;
  }

  const blob = base64ToBlob(finalBase64, 'image/png');
  const { width: sheetW, height: sheetH } = await measureImage(blob);
  const frameW = Math.round(sheetW / finalGridCols);
  const frameH = Math.round(sheetH / finalGridRows);

  return {
    photoHash,
    animationName: anim.name,
    pngBlob: blob,
    rawPngBlob: sprite.rawPngBlob,
    frameWidth: frameW,
    frameHeight: frameH,
    frameCount: finalFrameCount,
    processingVersion: SPRITE_PROCESSING_VERSION,
    createdAt: sprite.createdAt,
  };
}

function isCrouchFamilyAnimation(anim: AnimDef): boolean {
  return anim.name === 'crouch' || anim.base === 'crouched';
}

async function getCrouchNormalizationReference(sideViewBase64: string): Promise<NormalizationReference | undefined> {
  const standingBounds = await measureOpaqueBoundsFromBase64(sideViewBase64);
  if (!standingBounds) return undefined;

  const standingProfile = getAnimationProfile('idle');
  const standingScale = Math.min(
    (CELL_H * standingProfile.targetHeightRatio) / standingBounds.h,
    (CELL_W * standingProfile.targetWidthRatio) / standingBounds.w,
  );
  const normalizedStandingW = standingBounds.w * standingScale;
  const normalizedStandingH = standingBounds.h * standingScale;

  const reference = {
    targetDrawHeight: Math.round(normalizedStandingH * 0.94),
    targetDrawWidth: Math.round(normalizedStandingW * 1.16),
    baselineRatio: 0.98,
  };
  const message =
    `[Pipeline] Crouch normalization reference: standing=${standingBounds.w}x${standingBounds.h}@(${standingBounds.x},${standingBounds.y}) ` +
    `normalizedStanding=${Math.round(normalizedStandingW)}x${Math.round(normalizedStandingH)} ` +
    `target=${reference.targetDrawWidth}x${reference.targetDrawHeight} baseline=${reference.baselineRatio.toFixed(3)}`;
  console.log(message);
  publishDebugLog(message);
  return reference;
}

function getCrouchSpriteNormalizationReference(
  reference?: NormalizationReference,
): NormalizationReference | undefined {
  if (!reference?.baselineRatio) return undefined;
  return { baselineRatio: reference.baselineRatio };
}

async function ensureUprightView(
  meta: CachedMeta,
  sideViewInputBase64: string,
  onStatus?: StatusCallback,
): Promise<{ inputBase64: string; cleanedBase64: string }> {
  if (meta.uprightViewBlob && meta.uprightViewRawBlob) {
    const message = `[Pipeline] Reusing cached upright reference for ${meta.photoHash.slice(0, 8)}`;
    console.log(message);
    publishDebugLog(message);
    return {
      inputBase64: await blobToBase64Util(meta.uprightViewRawBlob),
      cleanedBase64: await blobToBase64Util(meta.uprightViewBlob),
    };
  }

  if (meta.uprightViewBlob && !meta.uprightViewRawBlob) {
    const message = `[Pipeline] Upright reference missing raw source, regenerating for ${meta.photoHash.slice(0, 8)}`;
    console.log(message);
    publishDebugLog(message);
  }

  onStatus?.({ stage: 'converting_upright_view' });
  const message = `[Pipeline] Generating upright reference from side view for ${meta.photoHash.slice(0, 8)}`;
  console.log(message);
  publishDebugLog(message);

  const uprightView = await uprightReposeWithGemini(sideViewInputBase64);
  meta.uprightViewRawBlob = base64ToBlob(uprightView.rawBase64, 'image/png');
  meta.uprightViewBlob = base64ToBlob(uprightView.cleanedBase64, 'image/png');
  meta.updatedAt = Date.now();
  await setCachedMeta(meta);

  return {
    inputBase64: uprightView.rawBase64,
    cleanedBase64: uprightView.cleanedBase64,
  };
}

export async function ensureCriticalAnimationsUpToDate(photoHash: string): Promise<void> {
  const existing = criticalSpriteMaintenanceInflight.get(photoHash);
  if (existing) return existing;

  const promise = (async () => {
    const sprites = await getAllSpritesForHash(photoHash);
    if (sprites.length === 0) return;

    for (const animName of CRITICAL_ANIMATION_NAMES) {
      const sprite = sprites.find((entry) => entry.animationName === animName);
      if (!sprite) continue;
      if ((sprite.processingVersion ?? 0) >= SPRITE_PROCESSING_VERSION) continue;
      if (!sprite.rawPngBlob) continue;

      try {
        const rebuilt = await rebuildSpriteFromRawBlob(photoHash, sprite, getAnimationDefinition(animName));
        await setCachedSprite(rebuilt);
        console.log(`[CriticalRepair] ${animName}: upgraded cached sprite for ${photoHash.slice(0, 8)}`);
      } catch (err: any) {
        console.warn(`[CriticalRepair] ${animName}: failed to upgrade ${photoHash.slice(0, 8)}: ${err.message}`);
      }
    }
  })().finally(() => {
    criticalSpriteMaintenanceInflight.delete(photoHash);
  });

  criticalSpriteMaintenanceInflight.set(photoHash, promise);
  return promise;
}

export async function warmCriticalAnimationUpgrades(photoHashes: string[]): Promise<void> {
  for (const photoHash of photoHashes) {
    try {
      await ensureCriticalAnimationsUpToDate(photoHash);
    } catch (err: any) {
      console.warn(`[CriticalRepair] Warm repair failed for ${photoHash.slice(0, 8)}: ${err.message}`);
    }
  }
}

// ─── Main pipeline ──────────────────────────────────────────────────

export async function processCharacter(
  photoFile: File,
  onStatus: StatusCallback,
  characterName = 'Fighter',
): Promise<string> {
  try {
    onStatus({ stage: 'hashing' });
    const photoHash = await hashPhoto(photoFile);
    const photoBlob = new Blob([await photoFile.arrayBuffer()], { type: photoFile.type });

    const existingMeta = await getCachedMeta(photoHash);
    if (existingMeta?.status === 'ready' && existingMeta.version === CACHE_VERSION) {
      const sprites = await getAllSpritesForHash(photoHash);
      if (sprites.length >= ANIMATIONS.length) {
        let dirty = false;
        if (!existingMeta.originalPhotoBlob) { existingMeta.originalPhotoBlob = photoBlob; dirty = true; }
        if (characterName && characterName !== 'Fighter') { existingMeta.characterName = characterName; dirty = true; }
        if (dirty) await setCachedMeta(existingMeta);
        onStatus({ stage: 'cached', photoHash });
        return photoHash;
      }
    }

    const meta: CachedMeta = (existingMeta && existingMeta.version === CACHE_VERSION) ? existingMeta : {
      photoHash,
      version: CACHE_VERSION,
      originalPhotoBlob: photoBlob,
      sideViewBlob: null,
      sideViewRawBlob: null,
      uprightViewBlob: null,
      uprightViewRawBlob: null,
      sideViewCleanBlob: null,
      crouchViewBlob: null,
      crouchViewRawBlob: null,
      crouchViewCleanBlob: null,
      noBgBlob: null,
      characterName,
      status: 'pending',
      animationsReady: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    if (!meta.originalPhotoBlob) meta.originalPhotoBlob = photoBlob;
    if (meta.sideViewRawBlob === undefined) meta.sideViewRawBlob = null;
    if (meta.uprightViewBlob === undefined) meta.uprightViewBlob = null;
    if (meta.uprightViewRawBlob === undefined) meta.uprightViewRawBlob = null;
    if (meta.crouchViewRawBlob === undefined) meta.crouchViewRawBlob = null;
    if (characterName && characterName !== 'Fighter') meta.characterName = characterName;

    // ── Step 1: Repose to fighting stance (standing) ──
    let provider = activeProvider;
    let sideViewBase64: string;
    let sideViewInputBase64: string;

    if (meta.sideViewBlob) {
      sideViewBase64 = await blobToBase64(meta.sideViewBlob);
      sideViewInputBase64 = meta.sideViewRawBlob
        ? await blobToBase64Util(meta.sideViewRawBlob)
        : sideViewBase64;
    } else {
      const photoBase64 = await blobToBase64(photoFile);

      if (provider === 'gemini') {
        try {
          onStatus({ stage: 'converting_side_view' });
          const sideView = await reposeWithGemini(photoBase64);
          sideViewBase64 = sideView.cleanedBase64;
          sideViewInputBase64 = sideView.rawBase64;
        } catch (err: any) {
          console.warn(`[Pipeline] Gemini repose failed, falling back to Freepik+Ludo:`, err.message);
          onStatus({ stage: 'falling_back', reason: `Gemini repose failed: ${err.message}` });
          provider = 'ludo';
          sideViewBase64 = await reposeWithFreepik(photoBase64, onStatus);
          sideViewInputBase64 = sideViewBase64;
        }
      } else {
        sideViewBase64 = await reposeWithFreepik(photoBase64, onStatus);
        sideViewInputBase64 = sideViewBase64;
      }

      meta.sideViewBlob = base64ToBlob(sideViewBase64, 'image/png');
      meta.sideViewRawBlob = base64ToBlob(sideViewInputBase64, 'image/png');
      meta.sideViewCleanBlob = await tryFreepikBgRemoval(sideViewBase64);
      meta.updatedAt = Date.now();
      await setCachedMeta(meta);
    }

    let crouchSourceBase64 = sideViewBase64;
    let crouchSourceInputBase64 = sideViewInputBase64;
    if (provider === 'gemini') {
      try {
        const uprightView = await ensureUprightView(meta, sideViewInputBase64, onStatus);
        crouchSourceBase64 = uprightView.cleanedBase64;
        crouchSourceInputBase64 = uprightView.inputBase64;
      } catch (err: any) {
        const message = `[Pipeline] Upright reference generation failed, using side view: ${err.message}`;
        console.warn(message);
        publishDebugLog(message);
        crouchSourceBase64 = sideViewBase64;
        crouchSourceInputBase64 = sideViewInputBase64;
      }
    }

    const crouchNormalizationReference = await getCrouchNormalizationReference(crouchSourceBase64);
    const crouchSpriteNormalizationReference = getCrouchSpriteNormalizationReference(crouchNormalizationReference);

    // ── Step 1b: Generate crouched side view ──
    let crouchViewBase64: string;
    let crouchViewInputBase64: string;

    if (meta.crouchViewBlob) {
      crouchViewBase64 = await blobToBase64(meta.crouchViewBlob);
      crouchViewInputBase64 = meta.crouchViewRawBlob
        ? await blobToBase64Util(meta.crouchViewRawBlob)
        : crouchViewBase64;
    } else if (provider === 'gemini') {
      try {
        onStatus({ stage: 'converting_crouch_view' });
        const crouchView = await geminiCrouchReposeDetailed(crouchSourceInputBase64, crouchNormalizationReference, crouchSourceInputBase64);
        crouchViewBase64 = crouchView.cleanedBase64;
        crouchViewInputBase64 = crouchView.rawBase64;
      } catch (err: any) {
        console.warn(`[Pipeline] Gemini crouch repose failed, using standing view as fallback:`, err.message);
        crouchViewBase64 = crouchSourceBase64;
        crouchViewInputBase64 = crouchSourceInputBase64;
      }

      meta.crouchViewBlob = base64ToBlob(crouchViewBase64, 'image/png');
      meta.crouchViewRawBlob = base64ToBlob(crouchViewInputBase64, 'image/png');
      meta.crouchViewCleanBlob = await tryFreepikBgRemoval(crouchViewBase64);
      meta.updatedAt = Date.now();
      await setCachedMeta(meta);
    } else {
      crouchViewBase64 = sideViewBase64;
      crouchViewInputBase64 = sideViewInputBase64;
    }

    // ── Step 2: Generate sprite sheets ──
    meta.status = 'sprites_generating';
    await setCachedMeta(meta);

    const total = ANIMATIONS.length;

    for (let i = 0; i < ANIMATIONS.length; i++) {
      const anim = ANIMATIONS[i];

      if (meta.animationsReady.includes(anim.name)) {
        const cached = await getCachedSprite(photoHash, anim.name);
        if (cached) continue;
      }

      onStatus({ stage: 'generating_sprites', animation: anim.name, current: i + 1, total });

      const baseImage = anim.base === 'crouched' ? crouchViewInputBase64 : sideViewBase64;
      const secondaryImage = anim.name === 'crouch' ? crouchViewInputBase64 : undefined;
      const primaryImage = anim.name === 'crouch' ? crouchSourceInputBase64 : baseImage;
      const normalizationReference = isCrouchFamilyAnimation(anim) ? crouchSpriteNormalizationReference : undefined;
      let spriteResult: { blob: Blob; rawBlob?: Blob; frameCount: number; frameW: number; frameH: number; usedScale?: number };

      if (provider === 'gemini') {
        try {
          spriteResult = await generateSpriteWithGemini(primaryImage, anim, secondaryImage, undefined, normalizationReference);
        } catch (err: any) {
          console.warn(`[Pipeline] Gemini sprite ${anim.name} failed, falling back to Ludo:`, err.message);
          if (i === 0) {
            onStatus({ stage: 'falling_back', reason: `Gemini sprites failed: ${err.message}` });
            provider = 'ludo';
          }
          spriteResult = await generateSpriteWithLudo(primaryImage, anim);
        }
      } else {
        spriteResult = await generateSpriteWithLudo(primaryImage, anim);
      }

      console.log(`[Pipeline] ${anim.name}: ${spriteResult.frameCount} frames, frame ${spriteResult.frameW}x${spriteResult.frameH}`);

      await setCachedSprite({
        photoHash,
        animationName: anim.name,
        pngBlob: spriteResult.blob,
        rawPngBlob: spriteResult.rawBlob,
        frameWidth: spriteResult.frameW,
        frameHeight: spriteResult.frameH,
        frameCount: spriteResult.frameCount,
        processingVersion: SPRITE_PROCESSING_VERSION,
        createdAt: Date.now(),
      });

      meta.animationsReady.push(anim.name);
      meta.updatedAt = Date.now();
      await setCachedMeta(meta);

      onStatus({ stage: 'sprite_ready', animation: anim.name, photoHash, current: i + 1, total });
    }

    meta.status = 'ready';
    meta.updatedAt = Date.now();
    await setCachedMeta(meta);

    onStatus({ stage: 'done', photoHash });
    return photoHash;

  } catch (err: any) {
    onStatus({ stage: 'error', message: err.message });
    throw err;
  }
}

export async function rebuildCharacter(
  photoHash: string,
  onStatus: StatusCallback,
): Promise<void> {
  const meta = await getCachedMeta(photoHash);
  if (!meta) throw new Error('Character not found');

  const allSprites = await getAllSpritesForHash(photoHash);
  // Process idle first so we can capture its scale for crouch-based animations
  const animOrder = ANIMATIONS.map(a => a.name);
  const sprites = allSprites.sort((a, b) => {
    const ai = animOrder.indexOf(a.animationName);
    const bi = animOrder.indexOf(b.animationName);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
  const total = sprites.length;
  let rebuilt = 0;
  let crouchNormalizationReference: NormalizationReference | undefined;
  let crouchSpriteNormalizationReference: NormalizationReference | undefined;
  if (meta.sideViewBlob) {
    const sideViewBase64 = await blobToBase64Util(meta.sideViewBlob);
    const crouchSourceBase64 = meta.uprightViewBlob
      ? await blobToBase64Util(meta.uprightViewBlob)
      : sideViewBase64;
    crouchNormalizationReference = await getCrouchNormalizationReference(crouchSourceBase64);
    crouchSpriteNormalizationReference = getCrouchSpriteNormalizationReference(crouchNormalizationReference);
  }

  for (const sprite of sprites) {
    if (!sprite.rawPngBlob) {
      console.warn(`[Rebuild] ${sprite.animationName}: no rawPngBlob, skipping`);
      rebuilt++;
      continue;
    }

    const anim = ANIMATIONS.find((a) => a.name === sprite.animationName);
    if (!anim) {
      console.warn(`[Rebuild] ${sprite.animationName}: unknown animation, skipping`);
      rebuilt++;
      continue;
    }

    onStatus({ stage: 'generating_sprites', animation: anim.name, current: rebuilt + 1, total });

    try {
        const rebuiltSprite = await rebuildSpriteFromRawBlob(
          photoHash,
          sprite,
          anim,
          isCrouchFamilyAnimation(anim) ? crouchSpriteNormalizationReference : undefined,
        );
      await setCachedSprite(rebuiltSprite);

      rebuilt++;
      onStatus({ stage: 'sprite_ready', animation: anim.name, photoHash, current: rebuilt, total });
      console.log(`[Rebuild] ${anim.name}: re-processed ${rebuiltSprite.frameCount} frames (${rebuiltSprite.frameWidth}x${rebuiltSprite.frameHeight})`);
    } catch (err: any) {
      rebuilt++;
      onStatus({ stage: 'sprite_ready', animation: anim.name, photoHash, current: rebuilt, total });
      console.warn(`[Rebuild] ${anim.name}: failed to re-process, keeping existing sprite: ${err.message}`);
    }
  }

  // Also regenerate clean meta blobs if missing
  if (meta.sideViewBlob && !meta.sideViewCleanBlob) {
    const sideBase64 = await blobToBase64Util(meta.sideViewBlob);
    meta.sideViewCleanBlob = await tryFreepikBgRemoval(sideBase64);
  }
  if (meta.crouchViewBlob && !meta.crouchViewCleanBlob) {
    const crouchBase64 = await blobToBase64Util(meta.crouchViewBlob);
    meta.crouchViewCleanBlob = await tryFreepikBgRemoval(crouchBase64);
  }

  meta.updatedAt = Date.now();
  await setCachedMeta(meta);

  onStatus({ stage: 'done', photoHash });
  console.log(`[Rebuild] Done: ${rebuilt}/${total} sprites re-processed`);
}

export async function retryAnimation(
  photoHash: string,
  animationName: string,
  onStatus: StatusCallback,
): Promise<void> {
  const meta = await getCachedMeta(photoHash);
  if (!meta) throw new Error('Character not found');

  const anim = getAnimationDefinition(animationName);

  if (!meta.sideViewBlob) throw new Error('No side view image found — cannot regenerate');

  const sideViewBase64 = await blobToBase64Util(meta.sideViewBlob);
  const sideViewInputBase64 = meta.sideViewRawBlob
    ? await blobToBase64Util(meta.sideViewRawBlob)
    : sideViewBase64;
  let crouchSourceBase64 = sideViewBase64;
  let crouchSourceInputBase64 = sideViewInputBase64;
  if (isCrouchFamilyAnimation(anim)) {
    try {
      const uprightView = await ensureUprightView(meta, sideViewInputBase64, onStatus);
      crouchSourceBase64 = uprightView.cleanedBase64;
      crouchSourceInputBase64 = uprightView.inputBase64;
    } catch (err: any) {
      const fallbackMessage = `[Retry] ${anim.name}: upright generation failed, using side view: ${err.message}`;
      console.warn(fallbackMessage);
      publishDebugLog(fallbackMessage);
    }
  } else if (meta.uprightViewBlob) {
    crouchSourceBase64 = await blobToBase64Util(meta.uprightViewBlob);
    crouchSourceInputBase64 = meta.uprightViewRawBlob
      ? await blobToBase64Util(meta.uprightViewRawBlob)
      : crouchSourceBase64;
  }
  const crouchViewBase64 = meta.crouchViewBlob
    ? await blobToBase64Util(meta.crouchViewBlob)
    : sideViewBase64;
  const crouchViewInputBase64 = meta.crouchViewRawBlob
    ? await blobToBase64Util(meta.crouchViewRawBlob)
    : crouchViewBase64;
  const crouchNormalizationReference = await getCrouchNormalizationReference(crouchSourceBase64);
  const crouchSpriteNormalizationReference = getCrouchSpriteNormalizationReference(crouchNormalizationReference);

  onStatus({ stage: 'generating_sprites', animation: anim.name, current: 1, total: 1 });

  const baseImage = anim.base === 'crouched' ? crouchViewInputBase64 : sideViewBase64;
  const secondaryImage = anim.name === 'crouch' ? crouchViewInputBase64 : undefined;
  const primaryImage = anim.name === 'crouch' ? crouchSourceInputBase64 : baseImage;

  if (isCrouchFamilyAnimation(anim)) {
    const message =
      `[Retry] ${anim.name}: using crouch reference ` +
      `${crouchNormalizationReference ? `${crouchNormalizationReference.targetDrawWidth}x${crouchNormalizationReference.targetDrawHeight}` : 'none'} ` +
      `spriteBaseline=${crouchSpriteNormalizationReference?.baselineRatio?.toFixed(3) ?? 'none'}`;
    console.log(message);
    publishDebugLog(message);
  }

  const spriteResult = await generateSpriteWithGemini(
    primaryImage,
    anim,
    secondaryImage,
    undefined,
    isCrouchFamilyAnimation(anim) ? crouchSpriteNormalizationReference : undefined,
  );

  await setCachedSprite({
    photoHash,
    animationName: anim.name,
    pngBlob: spriteResult.blob,
    rawPngBlob: spriteResult.rawBlob,
    frameWidth: spriteResult.frameW,
    frameHeight: spriteResult.frameH,
    frameCount: spriteResult.frameCount,
    processingVersion: SPRITE_PROCESSING_VERSION,
    createdAt: Date.now(),
  });

  if (!meta.animationsReady.includes(anim.name)) {
    meta.animationsReady.push(anim.name);
  }
  meta.updatedAt = Date.now();
  await setCachedMeta(meta);

  onStatus({ stage: 'sprite_ready', animation: anim.name, photoHash, current: 1, total: 1 });
  onStatus({ stage: 'done', photoHash });
  console.log(`[Retry] ${anim.name}: regenerated ${spriteResult.frameCount} frames (${spriteResult.frameW}x${spriteResult.frameH})`);
}

export async function retrySideView(
  photoHash: string,
  onStatus: StatusCallback,
): Promise<void> {
  const meta = await getCachedMeta(photoHash);
  if (!meta) throw new Error('Character not found');
  if (!meta.originalPhotoBlob) throw new Error('No original photo found');

  onStatus({ stage: 'converting_side_view' });

  const photoBase64 = await blobToBase64Util(meta.originalPhotoBlob);
  const sideView = await reposeWithGemini(photoBase64);

  meta.sideViewBlob = base64ToBlob(sideView.cleanedBase64, 'image/png');
  meta.sideViewRawBlob = base64ToBlob(sideView.rawBase64, 'image/png');
  meta.uprightViewBlob = null;
  meta.uprightViewRawBlob = null;
  meta.sideViewCleanBlob = await tryFreepikBgRemoval(sideView.cleanedBase64);
  meta.updatedAt = Date.now();
  await setCachedMeta(meta);

  onStatus({ stage: 'done', photoHash });
  console.log(`[RetrySideView] Regenerated side view for ${photoHash.slice(0, 8)}`);
}

export async function retryUprightView(
  photoHash: string,
  onStatus: StatusCallback,
): Promise<void> {
  const meta = await getCachedMeta(photoHash);
  if (!meta) throw new Error('Character not found');
  if (!meta.sideViewBlob) throw new Error('No side view found — retry the side view first');

  const sideViewBase64 = await blobToBase64Util(meta.sideViewBlob);
  const sideViewInputBase64 = meta.sideViewRawBlob
    ? await blobToBase64Util(meta.sideViewRawBlob)
    : sideViewBase64;

  onStatus({ stage: 'converting_upright_view' });
  const uprightView = await uprightReposeWithGemini(sideViewInputBase64);

  meta.uprightViewBlob = base64ToBlob(uprightView.cleanedBase64, 'image/png');
  meta.uprightViewRawBlob = base64ToBlob(uprightView.rawBase64, 'image/png');
  meta.updatedAt = Date.now();
  await setCachedMeta(meta);

  onStatus({ stage: 'done', photoHash });
  console.log(`[RetryUprightView] Regenerated upright view for ${photoHash.slice(0, 8)}`);
}

export async function retryCrouchView(
  photoHash: string,
  onStatus: StatusCallback,
): Promise<void> {
  const meta = await getCachedMeta(photoHash);
  if (!meta) throw new Error('Character not found');
  if (!meta.sideViewBlob) throw new Error('No side view found — retry the side view first');

  onStatus({ stage: 'converting_crouch_view' });

  const sideViewBase64 = await blobToBase64Util(meta.sideViewBlob);
  const sideViewInputBase64 = meta.sideViewRawBlob
    ? await blobToBase64Util(meta.sideViewRawBlob)
    : sideViewBase64;
  const sideInputLabel = meta.sideViewRawBlob ? 'side(raw)' : 'side(clean)';
  let crouchSourceBase64 = sideViewBase64;
  let crouchSourceInputBase64 = sideViewInputBase64;
  let crouchSourceLabel = sideInputLabel;
  try {
    const uprightView = await ensureUprightView(meta, sideViewInputBase64, onStatus);
    crouchSourceBase64 = uprightView.cleanedBase64;
    crouchSourceInputBase64 = uprightView.inputBase64;
    crouchSourceLabel = meta.uprightViewRawBlob ? 'upright(raw)' : 'upright(clean)';
  } catch (err: any) {
    const fallbackMessage = `[RetryCrouchView] Upright generation failed, using side view: ${err.message}`;
    console.warn(fallbackMessage);
    publishDebugLog(fallbackMessage);
  }
  const crouchNormalizationReference = await getCrouchNormalizationReference(crouchSourceBase64);
  const message =
    `[RetryCrouchView] ${photoHash.slice(0, 8)} source=${crouchSourceLabel} metricsSource=${crouchSourceInputBase64 === sideViewInputBase64 ? sideInputLabel : 'upright(raw)'} reference=` +
    `${crouchNormalizationReference ? `${crouchNormalizationReference.targetDrawWidth}x${crouchNormalizationReference.targetDrawHeight} baseline=${crouchNormalizationReference.baselineRatio?.toFixed(3)}` : 'none'}`;
  console.log(message);
  publishDebugLog(message);
  const crouchView = await geminiCrouchReposeDetailed(crouchSourceInputBase64, crouchNormalizationReference, crouchSourceInputBase64);
  const crouchViewBase64 = crouchView.cleanedBase64;

  meta.crouchViewBlob = base64ToBlob(crouchViewBase64, 'image/png');
  meta.crouchViewRawBlob = base64ToBlob(crouchView.rawBase64, 'image/png');
  meta.crouchViewCleanBlob = await tryFreepikBgRemoval(crouchViewBase64);
  meta.updatedAt = Date.now();
  await setCachedMeta(meta);

  onStatus({ stage: 'done', photoHash });
  console.log(`[RetryCrouchView] Regenerated crouch view for ${photoHash.slice(0, 8)}`);
}

async function blobToBase64Util(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export async function loadSpritesForHash(photoHash: string): Promise<Map<string, { blob: Blob; frameCount: number }>> {
  const sprites = await getAllSpritesForHash(photoHash);
  const map = new Map<string, { blob: Blob; frameCount: number }>();
  for (const s of sprites) {
    map.set(s.animationName, { blob: s.pngBlob, frameCount: s.frameCount });
  }
  return map;
}

export function getAnimationList(): AnimDef[] {
  return ANIMATIONS;
}

function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function measureImage(blob: Blob): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve({ width: img.width, height: img.height }); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to measure image')); };
    img.src = url;
  });
}
