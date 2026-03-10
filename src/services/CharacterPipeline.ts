import {
  hashPhoto,
  getCachedMeta,
  setCachedMeta,
  getCachedSprite,
  setCachedSprite,
  getAllSpritesForHash,
  CACHE_VERSION,
  type CachedMeta,
} from './SpriteCache';
import { geminiRepose, geminiCrouchRepose, geminiSpriteSheet } from './GeminiApi';
import { cleanSpriteSheet, mirrorCleanFrames, computeGridCols } from './SpritePostProcess';
import { ludoAnimateSprite } from './LudoApi';
import { freepikImageToFightingStance, freepikRemoveBackground, blobToBase64 } from './FreepikApi';
import { prepareBaseImage } from './ImagePrep';

export type PipelineProvider = 'gemini' | 'ludo';

export type PipelineStatus =
  | { stage: 'hashing' }
  | { stage: 'cached'; photoHash: string }
  | { stage: 'converting_side_view' }
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
  { name: 'low_punch',  motion: 'quick crouching jab punch from a deep low stance, extending the right arm forward while staying crouched throughout, then retracting', frames: 7, duration: 1.0, loop: false, base: 'crouched' },
  { name: 'low_kick',   motion: 'low crouching sweep kick extending the right leg along the ground from a deep crouched stance while staying low throughout, then retracting', frames: 7, duration: 1.2, loop: false, base: 'crouched' },
  { name: 'jump',       motion: 'jump anticipation into airborne jump pose then landing, with the character staying the same size in frame and not physically traveling upward inside the frame', frames: 8, duration: 1.5, loop: false, base: 'standing' },
  { name: 'crouch',     motion: 'transitioning from standing fighting stance down into a deep low crouch with visibly dropped hips, bent knees, and a much shorter silhouette by the final frame', frames: 4, duration: 1.2, loop: false, base: 'crouched' },
  { name: 'hit',        motion: 'recoiling from impact, pain reaction, staggering backward',                                       frames: 8,  duration: 1.0, loop: false, base: 'standing' },
  { name: 'ko',         motion: 'falling to the ground, knocked out, collapsing backward',                                         frames: 16, duration: 2,   loop: false, base: 'standing' },
];

let activeProvider: PipelineProvider = 'gemini';

export function setProvider(p: PipelineProvider) { activeProvider = p; }
export function getProvider(): PipelineProvider { return activeProvider; }

async function fetchImageAsBlob(url: string): Promise<Blob> {
  const proxied = `/proxy/image?url=${encodeURIComponent(url)}`;
  const res = await fetch(proxied);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  return res.blob();
}

// ─── Plan A: Gemini (repose + sprite sheets) ────────────────────────

async function reposeWithGemini(photoBase64: string): Promise<string> {
  return geminiRepose(photoBase64);
}

async function crouchReposeWithGemini(sideViewBase64: string): Promise<string> {
  return geminiCrouchRepose(sideViewBase64);
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
): Promise<{ blob: Blob; rawBlob: Blob; frameCount: number; frameW: number; frameH: number; usedScale: number }> {
  const result = await geminiSpriteSheet(characterBase64, anim.name, anim.motion, anim.frames, secondaryBase64, maxScale);
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
      sideViewCleanBlob: null,
      crouchViewBlob: null,
      crouchViewCleanBlob: null,
      noBgBlob: null,
      characterName,
      status: 'pending',
      animationsReady: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    if (!meta.originalPhotoBlob) meta.originalPhotoBlob = photoBlob;
    if (characterName && characterName !== 'Fighter') meta.characterName = characterName;

    // ── Step 1: Repose to fighting stance (standing) ──
    let provider = activeProvider;
    let sideViewBase64: string;

    if (meta.sideViewBlob) {
      sideViewBase64 = await blobToBase64(meta.sideViewBlob);
    } else {
      const photoBase64 = await blobToBase64(photoFile);

      if (provider === 'gemini') {
        try {
          onStatus({ stage: 'converting_side_view' });
          sideViewBase64 = await reposeWithGemini(photoBase64);
        } catch (err: any) {
          console.warn(`[Pipeline] Gemini repose failed, falling back to Freepik+Ludo:`, err.message);
          onStatus({ stage: 'falling_back', reason: `Gemini repose failed: ${err.message}` });
          provider = 'ludo';
          sideViewBase64 = await reposeWithFreepik(photoBase64, onStatus);
        }
      } else {
        sideViewBase64 = await reposeWithFreepik(photoBase64, onStatus);
      }

      meta.sideViewBlob = base64ToBlob(sideViewBase64, 'image/png');
      meta.sideViewCleanBlob = await tryFreepikBgRemoval(sideViewBase64);
      meta.updatedAt = Date.now();
      await setCachedMeta(meta);
    }

    // ── Step 1b: Generate crouched side view ──
    let crouchViewBase64: string;

    if (meta.crouchViewBlob) {
      crouchViewBase64 = await blobToBase64(meta.crouchViewBlob);
    } else if (provider === 'gemini') {
      try {
        onStatus({ stage: 'converting_crouch_view' });
        crouchViewBase64 = await crouchReposeWithGemini(sideViewBase64);
      } catch (err: any) {
        console.warn(`[Pipeline] Gemini crouch repose failed, using standing view as fallback:`, err.message);
        crouchViewBase64 = sideViewBase64;
      }

      meta.crouchViewBlob = base64ToBlob(crouchViewBase64, 'image/png');
      meta.crouchViewCleanBlob = await tryFreepikBgRemoval(crouchViewBase64);
      meta.updatedAt = Date.now();
      await setCachedMeta(meta);
    } else {
      crouchViewBase64 = sideViewBase64;
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

      const baseImage = anim.base === 'crouched' ? crouchViewBase64 : sideViewBase64;
      const secondaryImage = anim.name === 'crouch' ? crouchViewBase64 : undefined;
      const primaryImage = anim.name === 'crouch' ? sideViewBase64 : baseImage;
      let spriteResult: { blob: Blob; rawBlob?: Blob; frameCount: number; frameW: number; frameH: number; usedScale?: number };

      if (provider === 'gemini') {
        try {
          spriteResult = await generateSpriteWithGemini(primaryImage, anim, secondaryImage);
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

    const rawBase64 = await blobToBase64Util(sprite.rawPngBlob);
    const shouldMirror = ['high_punch', 'low_punch', 'high_kick', 'low_kick'].includes(anim.name);
    const genFrames = shouldMirror ? Math.ceil(anim.frames / 2) : anim.frames;
    const gridCols = computeGridCols(genFrames);
    const gridRows = Math.ceil(genFrames / gridCols);

    const cleaned = await cleanSpriteSheet(rawBase64, genFrames, gridCols, gridRows, anim.name);
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

    await setCachedSprite({
      photoHash,
      animationName: anim.name,
      pngBlob: blob,
      rawPngBlob: sprite.rawPngBlob,
      frameWidth: frameW,
      frameHeight: frameH,
      frameCount: finalFrameCount,
      createdAt: sprite.createdAt,
    });

    rebuilt++;
    onStatus({ stage: 'sprite_ready', animation: anim.name, photoHash, current: rebuilt, total });
    console.log(`[Rebuild] ${anim.name}: re-processed ${finalFrameCount} frames (${frameW}x${frameH})`);
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

  const anim = ANIMATIONS.find(a => a.name === animationName);
  if (!anim) throw new Error(`Unknown animation: ${animationName}`);

  if (!meta.sideViewBlob) throw new Error('No side view image found — cannot regenerate');

  const sideViewBase64 = await blobToBase64Util(meta.sideViewBlob);
  const crouchViewBase64 = meta.crouchViewBlob
    ? await blobToBase64Util(meta.crouchViewBlob)
    : sideViewBase64;

  onStatus({ stage: 'generating_sprites', animation: anim.name, current: 1, total: 1 });

  const baseImage = anim.base === 'crouched' ? crouchViewBase64 : sideViewBase64;
  const secondaryImage = anim.name === 'crouch' ? crouchViewBase64 : undefined;
  const primaryImage = anim.name === 'crouch' ? sideViewBase64 : baseImage;

  const spriteResult = await generateSpriteWithGemini(primaryImage, anim, secondaryImage);

  await setCachedSprite({
    photoHash,
    animationName: anim.name,
    pngBlob: spriteResult.blob,
    rawPngBlob: spriteResult.rawBlob,
    frameWidth: spriteResult.frameW,
    frameHeight: spriteResult.frameH,
    frameCount: spriteResult.frameCount,
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
  const sideViewBase64 = await reposeWithGemini(photoBase64);

  meta.sideViewBlob = base64ToBlob(sideViewBase64, 'image/png');
  meta.sideViewCleanBlob = await tryFreepikBgRemoval(sideViewBase64);
  meta.updatedAt = Date.now();
  await setCachedMeta(meta);

  onStatus({ stage: 'done', photoHash });
  console.log(`[RetrySideView] Regenerated side view for ${photoHash.slice(0, 8)}`);
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
  const crouchViewBase64 = await crouchReposeWithGemini(sideViewBase64);

  meta.crouchViewBlob = base64ToBlob(crouchViewBase64, 'image/png');
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
