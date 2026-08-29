import {
  hashPhoto,
  getCachedMeta,
  setCachedMeta,
  getCachedSprite,
  setCachedSprite,
  getAllSpritesForHash,
  getAllSpriteVersionsForHash,
  getActiveSpriteCacheScope,
  CACHE_VERSION,
  type CachedMeta,
  type CachedFailedAnimationArtifact,
  type CachedSprite,
} from './SpriteCache';
import { geminiReposeDetailed, geminiUprightReposeDetailed, geminiCrouchRepose, geminiCrouchReposeDetailed, geminiSpriteSheet, geminiSheetRefined, geminiIdleFrameSequence, PartialSpriteGenerationError } from './GeminiApi';
import { CELL_H, CELL_W, cleanSpriteSheet, mirrorCleanFrames, computeGridCols, measureOpaqueBoundsFromBase64, type NormalizationReference } from './SpritePostProcess';
import { getAnimationProfile, JUMP_ANIMATION_MOTION } from './AnimationProfiles';
import { debugInfo, debugWarn, publishDebugLog } from './DebugLog';
import { getConfiguredBgRemovalProvider, removeBackgroundWithConfiguredProvider } from './BackgroundRemovalService';
import {
  ApiSessionChangedError,
  captureApiRequestContext,
  type ApiRequestContext,
} from './ApiClient';
import type { QualityTier } from './QualityTiers';
import { detectImageMime } from './ImageFile.ts';

// Sprite generation mode, applies to ALL animations (not just idle anymore).
// - 'sheet_refined' (default): sheet establishes coherent pose + style, then each
//   frame is re-rendered at full Gemini resolution using the side-view as style
//   anchor and the sheet cell as pose anchor. Highest quality, ~9× API cost/anim.
// - 'sheet': single grid generation. Fast, coherent, but low per-frame resolution.
// - 'frame_sequence': idle-only per-frame generation with previous-frame continuity.
//   Falls back to 'sheet' for non-idle animations (frame_sequence doesn't build
//   sheets, only the idle pipeline does).
export type SpriteGenerationMode = 'sheet_refined' | 'sheet' | 'frame_sequence';

/** @deprecated alias kept for pre-existing call sites; use SpriteGenerationMode. */
export type IdleGenerationMode = SpriteGenerationMode;

interface TierConfig {
  spriteMode: SpriteGenerationMode;
  geminiAnimModelOverride: string;
  enableDnnBgRemoval: boolean;
}

const TIER_CONFIGS: Record<QualityTier, TierConfig> = {
  rookie: {
    spriteMode: 'sheet',
    geminiAnimModelOverride: 'gemini-3.1-flash-image',
    enableDnnBgRemoval: false,
  },
  contender: {
    spriteMode: 'sheet_refined',
    geminiAnimModelOverride: 'gemini-3.1-flash-image',
    enableDnnBgRemoval: true,
  },
  champion: {
    spriteMode: 'sheet_refined',
    geminiAnimModelOverride: 'gemini-3-pro-image',
    enableDnnBgRemoval: true,
  },
};

const QUALITY_TIER_RANK: Record<QualityTier, number> = {
  rookie: 1,
  contender: 2,
  champion: 3,
};

function maxQualityTier(a: QualityTier | undefined, b: QualityTier): QualityTier {
  if (!a) return b;
  return QUALITY_TIER_RANK[a] >= QUALITY_TIER_RANK[b] ? a : b;
}

export type PipelineStatus =
  | { stage: 'hashing' }
  | { stage: 'cached'; photoHash: string }
  | { stage: 'converting_side_view' }
  | { stage: 'converting_upright_view' }
  | { stage: 'converting_crouch_view' }
  | { stage: 'generating_sprites'; animation: string; current: number; total: number }
  | { stage: 'sprite_ready'; animation: string; photoHash: string; current: number; total: number }
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
  { name: 'idle',       motion: 'idle fighting stance with very subtle weight shifting and breathing sway, fists raised, feet planted — the character barely moves, just alive and ready', frames: 8, duration: 2,   loop: true,  base: 'standing' },
  { name: 'walk',       motion: 'walking forward to the right cycle, fighting game walk',                                          frames: 16, duration: 1.5, loop: true,  base: 'standing' },
  { name: 'high_punch', motion: 'quick grounded standing jab punch extending the lead arm forward while both feet stay planted, then retracting to stance', frames: 7, duration: 1.0, loop: false, base: 'standing' },
  { name: 'high_kick',  motion: 'powerful grounded standing roundhouse kick swinging the right leg in a high arc while the support foot stays planted, then returning to stance', frames: 7, duration: 1.2, loop: false, base: 'standing' },
  { name: 'low_punch',  motion: 'quick low jab punch from an extreme low-profile crouch, extending the right arm forward while staying low throughout, with hips dropped very low and thighs near-parallel to the ground, then retracting', frames: 7, duration: 1.0, loop: false, base: 'crouched' },
  { name: 'low_kick',   motion: 'low grounded sweep kick extending the right leg along the floor from an extreme low-profile crouch while staying low throughout, with hips dropped very low and thighs near-parallel to the ground, then retracting', frames: 7, duration: 1.2, loop: false, base: 'crouched' },
  { name: 'jump',       motion: JUMP_ANIMATION_MOTION, frames: 4, duration: 1.5, loop: false, base: 'standing' },
  { name: 'crouch',     motion: 'transitioning from standing fighting stance down into an extreme low-profile crouch with visibly dropped hips, bent knees, thighs near-parallel to the ground, a tightly compressed torso, and a much lower head position by the final frame, while keeping the head facing the same direction', frames: 4, duration: 1.2, loop: false, base: 'crouched' },
  { name: 'hit',        motion: 'four clear hit-reaction key poses: impact, recoil, stagger, and grounded recovery without falling or becoming airborne', frames: 4,  duration: 1.0, loop: false, base: 'standing' },
  { name: 'ko',         motion: 'eight clear key poses of falling backward into a compact knocked-out pose that stays fully inside each frame, ending diagonally on the ground with bent knees', frames: 8, duration: 2, loop: false, base: 'standing' },
  { name: 'victory',    motion: 'big arcade-style victory celebration with an unmistakably triumphant winning pose: chest lifted, shoulders back, chin up, one or both arms raised or pumping in triumph, then settling into a proud champion hold facing right', frames: 8, duration: 1.8, loop: false, base: 'standing' },
];

const CRITICAL_ANIMATION_NAMES = new Set(['jump', 'hit']);
const MIRRORED_ANIMATION_NAMES = new Set(['high_punch', 'low_punch', 'high_kick', 'low_kick']);
const spriteMaintenanceInflight = new Map<string, Promise<number>>();
export const SPRITE_PROCESSING_VERSION = 5;

function isCriticalAnimation(name: string): boolean { return CRITICAL_ANIMATION_NAMES.has(name); }

function getMinimumReliableFrameCount(name: string): number {
  if (name === 'idle') return 8;
  if (name === 'walk') return 12;
  if (name === 'jump') return 3;
  if (name === 'hit') return 2;
  if (name === 'low_punch' || name === 'low_kick') return 3;
  if (name === 'ko') return 8;
  if (name === 'victory') return 6;
  return 1;
}

function getAnimationDefinition(name: string): AnimDef {
  const anim = ANIMATIONS.find((entry) => entry.name === name);
  if (!anim) throw new Error(`Unknown animation: ${name}`);
  return anim;
}

function clearFailedAnimationArtifact(meta: CachedMeta, animationName: string): boolean {
  if (!meta.failedAnimationArtifacts?.[animationName]) return false;
  const nextArtifacts = { ...(meta.failedAnimationArtifacts ?? {}) };
  delete nextArtifacts[animationName];
  meta.failedAnimationArtifacts = Object.keys(nextArtifacts).length > 0 ? nextArtifacts : null;
  meta.updatedAt = Date.now();
  return true;
}

function storeFailedAnimationArtifact(
  meta: CachedMeta,
  animationName: string,
  artifact: CachedFailedAnimationArtifact,
): void {
  meta.failedAnimationArtifacts = {
    ...(meta.failedAnimationArtifacts ?? {}),
    [animationName]: artifact,
  };
  meta.updatedAt = Date.now();
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

async function reposeWithGemini(
  photoBase64: string,
  context: ApiRequestContext,
): Promise<{ rawBase64: string; cleanedBase64: string }> {
  return geminiReposeDetailed(photoBase64, context);
}

async function crouchReposeWithGemini(
  sideViewBase64: string,
  normalizationReference?: NormalizationReference,
  context?: ApiRequestContext,
): Promise<string> {
  return geminiCrouchRepose(sideViewBase64, normalizationReference, sideViewBase64, context);
}

async function uprightReposeWithGemini(
  sideViewBase64: string,
  context: ApiRequestContext,
): Promise<{ rawBase64: string; cleanedBase64: string }> {
  return geminiUprightReposeDetailed(sideViewBase64, context);
}

async function tryApiBgRemoval(base64: string, context: ApiRequestContext): Promise<Blob | null> {
  try {
    const provider = getConfiguredBgRemovalProvider();
    debugInfo(`[Pipeline] Trying ${provider} background removal for display version...`);
    const cleaned = await removeBackgroundWithConfiguredProvider(base64, context);
    if (!cleaned) {
      debugInfo(`[Pipeline] ${provider} background removal skipped`);
      return null;
    }
    debugInfo(`[Pipeline] ${provider} bg removal succeeded`);
    return base64ToBlob(cleaned, 'image/png');
  } catch (err: any) {
    if (err instanceof ApiSessionChangedError) throw err;
    const provider = getConfiguredBgRemovalProvider();
    debugWarn(`[Pipeline] ${provider} bg removal failed:`, err.message);
    return null;
  }
}

async function generateSpriteWithGemini(
  characterBase64: string,
  anim: AnimDef,
  secondaryBase64?: string,
  maxScale?: number,
  normalizationReference?: NormalizationReference,
  spriteMode: SpriteGenerationMode = 'sheet_refined',
  enableDnnBgRemoval = true,
  context?: ApiRequestContext,
  modelOverride?: string,
): Promise<{ blob: Blob; rawBlob: Blob; frameCount: number; frameW: number; frameH: number; usedScale: number }> {
  const effectiveMode: SpriteGenerationMode = spriteMode === 'frame_sequence' && anim.name !== 'idle'
    ? 'sheet'
    : spriteMode;
  const modeMessage = `[Pipeline] ${anim.name} generation mode: ${effectiveMode}${effectiveMode !== spriteMode ? ` (requested ${spriteMode}, frame_sequence only supported for idle)` : ''}`;
  debugInfo(modeMessage);
  publishDebugLog(modeMessage);

  let result;
  if (effectiveMode === 'frame_sequence') {
    result = await geminiIdleFrameSequence(characterBase64, anim.frames, maxScale, context, modelOverride);
  } else if (effectiveMode === 'sheet_refined') {
    result = await geminiSheetRefined(characterBase64, anim.name, anim.motion, anim.frames, secondaryBase64, maxScale, normalizationReference, {
      enableBgRemoval: enableDnnBgRemoval,
    }, context, modelOverride);
  } else {
    result = await geminiSpriteSheet(
      characterBase64,
      anim.name,
      anim.motion,
      anim.frames,
      secondaryBase64,
      maxScale,
      normalizationReference,
      context,
      modelOverride,
    );
  }
  const rawBlob = base64ToBlob(result.rawBase64 || result.imageBase64, 'image/png');
  const blob = base64ToBlob(result.imageBase64, 'image/png');
  const { width: sheetW, height: sheetH } = await measureImage(blob);
  const frameW = Math.round(sheetW / result.gridCols);
  const frameH = Math.round(sheetH / result.gridRows);
  return { blob, rawBlob, frameCount: result.frameCount, frameW, frameH, usedScale: result.usedScale };
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
    ownerScope: sprite.ownerScope,
    photoHash,
    animationName: anim.name,
    qualityTier: sprite.qualityTier,
    pngBlob: blob,
    rawPngBlob: sprite.rawPngBlob,
    frameWidth: frameW,
    frameHeight: frameH,
    frameCount: finalFrameCount,
    processingVersion: SPRITE_PROCESSING_VERSION,
    createdAt: Date.now(),
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
  debugInfo(message);
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
  context: ApiRequestContext = captureApiRequestContext(),
): Promise<{ inputBase64: string; cleanedBase64: string }> {
  if (meta.uprightViewBlob && meta.uprightViewRawBlob) {
    const message = `[Pipeline] Reusing cached upright reference for ${meta.photoHash.slice(0, 8)}`;
    debugInfo(message);
    publishDebugLog(message);
    return {
      inputBase64: await blobToBase64Util(meta.uprightViewRawBlob),
      cleanedBase64: await blobToBase64Util(meta.uprightViewBlob),
    };
  }

  if (meta.uprightViewBlob && !meta.uprightViewRawBlob) {
    const message = `[Pipeline] Upright reference missing raw source, regenerating for ${meta.photoHash.slice(0, 8)}`;
    debugInfo(message);
    publishDebugLog(message);
  }

  onStatus?.({ stage: 'converting_upright_view' });
  const message = `[Pipeline] Generating upright reference from side view for ${meta.photoHash.slice(0, 8)}`;
  debugInfo(message);
  publishDebugLog(message);

  const uprightView = await uprightReposeWithGemini(sideViewInputBase64, context);
  meta.uprightViewRawBlob = base64ToBlob(uprightView.rawBase64, 'image/png');
  meta.uprightViewBlob = base64ToBlob(uprightView.cleanedBase64, 'image/png');
  meta.updatedAt = Date.now();
  await setCachedMeta(meta);

  return {
    inputBase64: uprightView.rawBase64,
    cleanedBase64: uprightView.cleanedBase64,
  };
}

export async function ensurePlayableSpritesUpToDate(photoHash: string): Promise<number> {
  const ownerScope = getActiveSpriteCacheScope();
  const operationKey = `${ownerScope}:${photoHash}`;
  const existing = spriteMaintenanceInflight.get(operationKey);
  if (existing) return existing;

  const promise = (async () => {
    const meta = await getCachedMeta(photoHash, ownerScope);
    const sprites = await getAllSpritesForHash(photoHash, ownerScope);
    if (sprites.length === 0) return 0;

    let crouchSpriteNormalizationReference: NormalizationReference | undefined;
    if (meta?.sideViewBlob) {
      const sideViewBase64 = await blobToBase64Util(meta.sideViewBlob);
      const crouchSourceBase64 = meta.uprightViewBlob
        ? await blobToBase64Util(meta.uprightViewBlob)
        : sideViewBase64;
      const crouchNormalizationReference = await getCrouchNormalizationReference(crouchSourceBase64);
      crouchSpriteNormalizationReference = getCrouchSpriteNormalizationReference(crouchNormalizationReference);
    }

    const animationOrder = new Map(ANIMATIONS.map((animation, index) => [animation.name, index]));
    sprites.sort((a, b) =>
      (animationOrder.get(a.animationName) ?? Number.MAX_SAFE_INTEGER) -
      (animationOrder.get(b.animationName) ?? Number.MAX_SAFE_INTEGER),
    );

    let upgraded = 0;
    for (const sprite of sprites) {
      if ((sprite.processingVersion ?? 0) >= SPRITE_PROCESSING_VERSION) continue;
      if (!sprite.rawPngBlob) continue;

      const anim = ANIMATIONS.find((entry) => entry.name === sprite.animationName);
      if (!anim) continue;

      try {
        const rebuilt = await rebuildSpriteFromRawBlob(
          photoHash,
          sprite,
          anim,
          isCrouchFamilyAnimation(anim) ? crouchSpriteNormalizationReference : undefined,
        );
        await setCachedSprite(rebuilt);
        upgraded += 1;
        debugInfo(`[SpriteRepair] ${anim.name}: upgraded cached sprite for ${photoHash.slice(0, 8)}`);
      } catch (err: any) {
        debugWarn(`[SpriteRepair] ${anim.name}: failed to upgrade ${photoHash.slice(0, 8)}: ${err.message}`);
      }
    }

    return upgraded;
  })().finally(() => {
    spriteMaintenanceInflight.delete(operationKey);
  });

  spriteMaintenanceInflight.set(operationKey, promise);
  return promise;
}

export async function ensureCriticalAnimationsUpToDate(photoHash: string): Promise<void> {
  await ensurePlayableSpritesUpToDate(photoHash);
}

export async function warmCriticalAnimationUpgrades(photoHashes: string[]): Promise<void> {
  for (const photoHash of photoHashes) {
    try {
      await ensurePlayableSpritesUpToDate(photoHash);
    } catch (err: any) {
      debugWarn(`[SpriteRepair] Warm repair failed for ${photoHash.slice(0, 8)}: ${err.message}`);
    }
  }
}

// ─── Main pipeline ──────────────────────────────────────────────────

export async function processCharacter(
  photoFile: File,
  onStatus: StatusCallback,
  characterName = 'Fighter',
  options?: { tier?: QualityTier; apiContext?: ApiRequestContext },
): Promise<string> {
  const ownerScope = getActiveSpriteCacheScope();
  const apiContext = options?.apiContext ?? captureApiRequestContext();
  try {
    const qualityTier = options?.tier ?? 'contender';
    const tierConfig = TIER_CONFIGS[qualityTier];
    onStatus({ stage: 'hashing' });
    const photoHash = await hashPhoto(photoFile);
    const photoBlob = new Blob([await photoFile.arrayBuffer()], { type: photoFile.type });

    const existingMeta = await getCachedMeta(photoHash, ownerScope);
    if (existingMeta?.status === 'ready' && existingMeta.version === CACHE_VERSION) {
      const sprites = await getAllSpriteVersionsForHash(photoHash, ownerScope);
      const requestedTierSprites = sprites.filter((sprite) => sprite.qualityTier === qualityTier);
      const requestedTierAnimations = new Set(requestedTierSprites.map((sprite) => sprite.animationName));
      if (requestedTierAnimations.size >= ANIMATIONS.length) {
        let dirty = false;
        if (!existingMeta.originalPhotoBlob) { existingMeta.originalPhotoBlob = photoBlob; dirty = true; }
        if (characterName && characterName !== 'Fighter') { existingMeta.characterName = characterName; dirty = true; }
        if (dirty) await setCachedMeta(existingMeta);
        onStatus({ stage: 'cached', photoHash });
        return photoHash;
      }
    }

    const meta: CachedMeta = (existingMeta && existingMeta.version === CACHE_VERSION) ? existingMeta : {
      ownerScope,
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
      qualityTier,
      status: 'pending',
      animationsReady: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    if (!meta.originalPhotoBlob) meta.originalPhotoBlob = photoBlob;
    meta.qualityTier = maxQualityTier(meta.qualityTier, qualityTier);
    if (meta.sideViewRawBlob === undefined) meta.sideViewRawBlob = null;
    if (meta.uprightViewBlob === undefined) meta.uprightViewBlob = null;
    if (meta.uprightViewRawBlob === undefined) meta.uprightViewRawBlob = null;
    if (meta.crouchViewRawBlob === undefined) meta.crouchViewRawBlob = null;
    if (characterName && characterName !== 'Fighter') meta.characterName = characterName;

    // ── Step 1: Repose to fighting stance (standing) ──
    let sideViewBase64: string;
    let sideViewInputBase64: string;

    if (meta.sideViewBlob) {
      sideViewBase64 = await blobToBase64Util(meta.sideViewBlob);
      sideViewInputBase64 = meta.sideViewRawBlob
        ? await blobToBase64Util(meta.sideViewRawBlob)
        : sideViewBase64;
    } else {
      const photoBase64 = await blobToBase64Util(photoFile);
      onStatus({ stage: 'converting_side_view' });
      const sideView = await reposeWithGemini(photoBase64, apiContext);
      sideViewBase64 = sideView.cleanedBase64;
      sideViewInputBase64 = sideView.rawBase64;

      meta.sideViewBlob = base64ToBlob(sideViewBase64, 'image/png');
      meta.sideViewRawBlob = base64ToBlob(sideViewInputBase64, 'image/png');
      meta.sideViewCleanBlob = await tryApiBgRemoval(sideViewBase64, apiContext);
      meta.updatedAt = Date.now();
      await setCachedMeta(meta);
    }

    const uprightView = await ensureUprightView(meta, sideViewInputBase64, onStatus, apiContext);
    const crouchSourceBase64 = uprightView.cleanedBase64;
    const crouchSourceInputBase64 = uprightView.inputBase64;

    const crouchNormalizationReference = await getCrouchNormalizationReference(crouchSourceBase64);
    const crouchSpriteNormalizationReference = getCrouchSpriteNormalizationReference(crouchNormalizationReference);

    // ── Step 1b: Generate crouched side view ──
    let crouchViewBase64: string;
    let crouchViewInputBase64: string;

    if (meta.crouchViewBlob) {
      crouchViewBase64 = await blobToBase64Util(meta.crouchViewBlob);
      crouchViewInputBase64 = meta.crouchViewRawBlob
        ? await blobToBase64Util(meta.crouchViewRawBlob)
        : crouchViewBase64;
    } else {
      onStatus({ stage: 'converting_crouch_view' });
      const crouchView = await geminiCrouchReposeDetailed(
        crouchSourceInputBase64,
        crouchNormalizationReference,
        crouchSourceInputBase64,
        apiContext,
      );
      crouchViewBase64 = crouchView.cleanedBase64;
      crouchViewInputBase64 = crouchView.rawBase64;

      meta.crouchViewBlob = base64ToBlob(crouchViewBase64, 'image/png');
      meta.crouchViewRawBlob = base64ToBlob(crouchViewInputBase64, 'image/png');
      meta.crouchViewCleanBlob = await tryApiBgRemoval(crouchViewBase64, apiContext);
      meta.updatedAt = Date.now();
      await setCachedMeta(meta);
    }

    // ── Step 2: Generate sprite sheets ──
    meta.status = 'sprites_generating';
    await setCachedMeta(meta);

    const total = ANIMATIONS.length;

    for (let i = 0; i < ANIMATIONS.length; i++) {
      const anim = ANIMATIONS[i];

      if (meta.animationsReady.includes(anim.name)) {
        const cached = await getCachedSprite(photoHash, anim.name, qualityTier, ownerScope);
        if (cached && cached.qualityTier === qualityTier) continue;
      }

      onStatus({ stage: 'generating_sprites', animation: anim.name, current: i + 1, total });

      const baseImage = anim.base === 'crouched' ? crouchViewInputBase64 : sideViewBase64;
      const secondaryImage = anim.name === 'crouch' ? crouchViewInputBase64 : undefined;
      const primaryImage = anim.name === 'crouch' ? crouchSourceInputBase64 : baseImage;
      const normalizationReference = isCrouchFamilyAnimation(anim) ? crouchSpriteNormalizationReference : undefined;
      let spriteResult: { blob: Blob; rawBlob?: Blob; frameCount: number; frameW: number; frameH: number; usedScale?: number };

      try {
        spriteResult = await generateSpriteWithGemini(
          primaryImage,
          anim,
          secondaryImage,
          undefined,
          normalizationReference,
          tierConfig.spriteMode,
          tierConfig.enableDnnBgRemoval,
          apiContext,
          tierConfig.geminiAnimModelOverride,
        );
      } catch (err: any) {
        if (err instanceof PartialSpriteGenerationError && err.partialResult) {
          const partialBlob = base64ToBlob(err.partialResult.imageBase64, 'image/png');
          const partialRawBlob = base64ToBlob(err.partialResult.rawBase64, 'image/png');
          const { width: partialSheetW, height: partialSheetH } = await measureImage(partialBlob);
          storeFailedAnimationArtifact(meta, anim.name, {
            pngBlob: partialBlob,
            rawPngBlob: partialRawBlob,
            frameWidth: Math.round(partialSheetW / err.partialResult.gridCols),
            frameHeight: Math.round(partialSheetH / err.partialResult.gridRows),
            frameCount: err.partialResult.frameCount,
            reason: err.message,
            mode: tierConfig.spriteMode,
            createdAt: Date.now(),
          });
          await setCachedMeta(meta);
        }
        debugWarn(`[Pipeline] Gemini sprite ${anim.name} failed without changing provider:`, err.message);
        throw err;
      }

      debugInfo(`[Pipeline] ${anim.name}: ${spriteResult.frameCount} frames, frame ${spriteResult.frameW}x${spriteResult.frameH}`);

      await setCachedSprite({
        ownerScope,
        photoHash,
        animationName: anim.name,
        qualityTier,
        pngBlob: spriteResult.blob,
        rawPngBlob: spriteResult.rawBlob,
        frameWidth: spriteResult.frameW,
        frameHeight: spriteResult.frameH,
        frameCount: spriteResult.frameCount,
        processingVersion: SPRITE_PROCESSING_VERSION,
        createdAt: Date.now(),
      });

      clearFailedAnimationArtifact(meta, anim.name);
      if (!meta.animationsReady.includes(anim.name)) meta.animationsReady.push(anim.name);
      meta.qualityTier = maxQualityTier(meta.qualityTier, qualityTier);
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

  const allSprites = await getAllSpriteVersionsForHash(photoHash, meta.ownerScope);
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
      debugWarn(`[Rebuild] ${sprite.animationName}: no rawPngBlob, skipping`);
      rebuilt++;
      continue;
    }

    const anim = ANIMATIONS.find((a) => a.name === sprite.animationName);
    if (!anim) {
      debugWarn(`[Rebuild] ${sprite.animationName}: unknown animation, skipping`);
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
      debugInfo(`[Rebuild] ${anim.name}: re-processed ${rebuiltSprite.frameCount} frames (${rebuiltSprite.frameWidth}x${rebuiltSprite.frameHeight})`);
    } catch (err: any) {
      rebuilt++;
      onStatus({ stage: 'sprite_ready', animation: anim.name, photoHash, current: rebuilt, total });
      debugWarn(`[Rebuild] ${anim.name}: failed to re-process, keeping existing sprite: ${err.message}`);
    }
  }

  meta.updatedAt = Date.now();
  await setCachedMeta(meta);

  onStatus({ stage: 'done', photoHash });
  debugInfo(`[Rebuild] Done: ${rebuilt}/${total} sprites re-processed`);
}

export async function retryAnimation(
  photoHash: string,
  animationName: string,
  onStatus: StatusCallback,
  options?: {
    spriteMode?: SpriteGenerationMode;
    idleMode?: SpriteGenerationMode;
    tier?: QualityTier;
    ownerScope?: string;
    apiContext?: ApiRequestContext;
  },
): Promise<void> {
  const apiContext = options?.apiContext ?? captureApiRequestContext();
  const meta = await getCachedMeta(photoHash, options?.ownerScope);
  if (!meta) throw new Error('Character not found');
  const qualityTier = options?.tier ?? meta.qualityTier ?? 'contender';
  const tierConfig = TIER_CONFIGS[qualityTier];

  const anim = getAnimationDefinition(animationName);

  if (!meta.sideViewBlob) throw new Error('No side view image found — cannot regenerate');

  const sideViewBase64 = await blobToBase64Util(meta.sideViewBlob);
  const sideViewInputBase64 = meta.sideViewRawBlob
    ? await blobToBase64Util(meta.sideViewRawBlob)
    : sideViewBase64;
  let crouchSourceBase64 = sideViewBase64;
  let crouchSourceInputBase64 = sideViewInputBase64;
  if (isCrouchFamilyAnimation(anim)) {
    if (!meta.uprightViewBlob || !meta.crouchViewBlob) {
      throw new Error('Canonical upright and crouch sources are required; retry the missing source first');
    }
    crouchSourceBase64 = await blobToBase64Util(meta.uprightViewBlob);
    crouchSourceInputBase64 = meta.uprightViewRawBlob
      ? await blobToBase64Util(meta.uprightViewRawBlob)
      : crouchSourceBase64;
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
  const spriteMode: SpriteGenerationMode = options?.spriteMode ?? options?.idleMode ?? tierConfig.spriteMode;

  if (isCrouchFamilyAnimation(anim)) {
    const message =
      `[Retry] ${anim.name}: using crouch reference ` +
      `${crouchNormalizationReference ? `${crouchNormalizationReference.targetDrawWidth}x${crouchNormalizationReference.targetDrawHeight}` : 'none'} ` +
      `spriteBaseline=${crouchSpriteNormalizationReference?.baselineRatio?.toFixed(3) ?? 'none'}`;
    debugInfo(message);
    publishDebugLog(message);
  }

  const spriteResult = await generateSpriteWithGemini(
    primaryImage,
    anim,
    secondaryImage,
    undefined,
    isCrouchFamilyAnimation(anim) ? crouchSpriteNormalizationReference : undefined,
    spriteMode,
    tierConfig.enableDnnBgRemoval,
    apiContext,
    tierConfig.geminiAnimModelOverride,
  ).catch(async (err: any) => {
    if (err instanceof PartialSpriteGenerationError && err.partialResult) {
      const partialBlob = base64ToBlob(err.partialResult.imageBase64, 'image/png');
      const partialRawBlob = base64ToBlob(err.partialResult.rawBase64, 'image/png');
      const { width: partialSheetW, height: partialSheetH } = await measureImage(partialBlob);
      storeFailedAnimationArtifact(meta, anim.name, {
        pngBlob: partialBlob,
        rawPngBlob: partialRawBlob,
        frameWidth: Math.round(partialSheetW / err.partialResult.gridCols),
        frameHeight: Math.round(partialSheetH / err.partialResult.gridRows),
        frameCount: err.partialResult.frameCount,
        reason: err.message,
        mode: spriteMode,
        createdAt: Date.now(),
      });
      await setCachedMeta(meta);
    }
    throw err;
  });

  await setCachedSprite({
    ownerScope: meta.ownerScope,
    photoHash,
    animationName: anim.name,
    qualityTier,
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
  clearFailedAnimationArtifact(meta, anim.name);
  meta.qualityTier = maxQualityTier(meta.qualityTier, qualityTier);
  meta.updatedAt = Date.now();
  await setCachedMeta(meta);

  onStatus({ stage: 'sprite_ready', animation: anim.name, photoHash, current: 1, total: 1 });
  onStatus({ stage: 'done', photoHash });
  debugInfo(`[Retry] ${anim.name}: regenerated ${spriteResult.frameCount} frames (${spriteResult.frameW}x${spriteResult.frameH})`);
}

export async function upgradeFighter(
  photoHash: string,
  toTier: QualityTier,
  onStatus: StatusCallback,
  apiContext: ApiRequestContext = captureApiRequestContext(),
): Promise<void> {
  const meta = await getCachedMeta(photoHash);
  if (!meta) throw new Error('Character not found');

  for (let i = 0; i < ANIMATIONS.length; i++) {
    const anim = ANIMATIONS[i];
    onStatus({ stage: 'generating_sprites', animation: anim.name, current: i + 1, total: ANIMATIONS.length });
    await retryAnimation(photoHash, anim.name, () => {}, {
      tier: toTier,
      ownerScope: meta.ownerScope,
      apiContext,
    });
    onStatus({ stage: 'sprite_ready', animation: anim.name, photoHash, current: i + 1, total: ANIMATIONS.length });
  }

  meta.qualityTier = maxQualityTier(meta.qualityTier, toTier);
  meta.updatedAt = Date.now();
  await setCachedMeta(meta);
  onStatus({ stage: 'done', photoHash });
}

export async function retrySideView(
  photoHash: string,
  onStatus: StatusCallback,
  apiContext: ApiRequestContext = captureApiRequestContext(),
): Promise<void> {
  const meta = await getCachedMeta(photoHash);
  if (!meta) throw new Error('Character not found');
  if (!meta.originalPhotoBlob) throw new Error('No original photo found');

  onStatus({ stage: 'converting_side_view' });

  const photoBase64 = await blobToBase64Util(meta.originalPhotoBlob);
  const sideView = await reposeWithGemini(photoBase64, apiContext);

  meta.sideViewBlob = base64ToBlob(sideView.cleanedBase64, 'image/png');
  meta.sideViewRawBlob = base64ToBlob(sideView.rawBase64, 'image/png');
  meta.uprightViewBlob = null;
  meta.uprightViewRawBlob = null;
  meta.sideViewCleanBlob = await tryApiBgRemoval(sideView.cleanedBase64, apiContext);
  meta.updatedAt = Date.now();
  await setCachedMeta(meta);

  onStatus({ stage: 'done', photoHash });
  debugInfo(`[RetrySideView] Regenerated side view for ${photoHash.slice(0, 8)}`);
}

export async function retryUprightView(
  photoHash: string,
  onStatus: StatusCallback,
  apiContext: ApiRequestContext = captureApiRequestContext(),
): Promise<void> {
  const meta = await getCachedMeta(photoHash);
  if (!meta) throw new Error('Character not found');
  if (!meta.sideViewBlob) throw new Error('No side view found — retry the side view first');

  const sideViewBase64 = await blobToBase64Util(meta.sideViewBlob);
  const sideViewInputBase64 = meta.sideViewRawBlob
    ? await blobToBase64Util(meta.sideViewRawBlob)
    : sideViewBase64;

  onStatus({ stage: 'converting_upright_view' });
  const uprightView = await uprightReposeWithGemini(sideViewInputBase64, apiContext);

  meta.uprightViewBlob = base64ToBlob(uprightView.cleanedBase64, 'image/png');
  meta.uprightViewRawBlob = base64ToBlob(uprightView.rawBase64, 'image/png');
  meta.updatedAt = Date.now();
  await setCachedMeta(meta);

  onStatus({ stage: 'done', photoHash });
  debugInfo(`[RetryUprightView] Regenerated upright view for ${photoHash.slice(0, 8)}`);
}

export async function retryCrouchView(
  photoHash: string,
  onStatus: StatusCallback,
  apiContext: ApiRequestContext = captureApiRequestContext(),
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
  const uprightView = await ensureUprightView(meta, sideViewInputBase64, onStatus, apiContext);
  const crouchSourceBase64 = uprightView.cleanedBase64;
  const crouchSourceInputBase64 = uprightView.inputBase64;
  const crouchSourceLabel = meta.uprightViewRawBlob ? 'upright(raw)' : 'upright(clean)';
  const crouchNormalizationReference = await getCrouchNormalizationReference(crouchSourceBase64);
  const message =
    `[RetryCrouchView] ${photoHash.slice(0, 8)} source=${crouchSourceLabel} metricsSource=${crouchSourceInputBase64 === sideViewInputBase64 ? sideInputLabel : 'upright(raw)'} reference=` +
    `${crouchNormalizationReference ? `${crouchNormalizationReference.targetDrawWidth}x${crouchNormalizationReference.targetDrawHeight} baseline=${crouchNormalizationReference.baselineRatio?.toFixed(3)}` : 'none'}`;
  debugInfo(message);
  publishDebugLog(message);
  const crouchView = await geminiCrouchReposeDetailed(
    crouchSourceInputBase64,
    crouchNormalizationReference,
    crouchSourceInputBase64,
    apiContext,
  );
  const crouchViewBase64 = crouchView.cleanedBase64;

  meta.crouchViewBlob = base64ToBlob(crouchViewBase64, 'image/png');
  meta.crouchViewRawBlob = base64ToBlob(crouchView.rawBase64, 'image/png');
  meta.crouchViewCleanBlob = await tryApiBgRemoval(crouchViewBase64, apiContext);
  meta.updatedAt = Date.now();
  await setCachedMeta(meta);

  onStatus({ stage: 'done', photoHash });
  debugInfo(`[RetryCrouchView] Regenerated crouch view for ${photoHash.slice(0, 8)}`);
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
  return new Blob([bytes], { type: detectImageMime(bytes) ?? mime });
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
