import Phaser from 'phaser';
import {
  AURA_ANIMATION_NAMES,
  AURA_LOADABLE_ANIMATION_NAMES,
  type AuraAnimationName,
} from '../../services/FighterAssetPacks.ts';
import { getAllSpritesForHash, getCachedMeta } from '../../services/SpriteCache.ts';
import { debugInfo, debugWarn } from '../../services/DebugLog.ts';
import type { AuraDemoPerformer } from './AuraDemoPerformers.ts';
import { builtinAuraPerformerForCachedMeta, isAuraBuiltinPerformerId, type AuraBuiltinPerformerId } from '../../services/AuraBuiltinPerformers.ts';
import {
  auraAtlasContentHash, auraIdleReference, calibrateAuraAtlas, measureAuraAtlas,
  type AuraAnimationCalibration, type AuraAtlasGeometry,
} from './AuraPoseCalibration.ts';
import { AURA_POSE_TEMPLATES } from './AuraPoseTemplates.ts';
import { ADDITIONAL_AURA_BUILTIN_ASSETS } from './AuraBuiltinAssets.ts';

export interface LoadedAuraAnimation {
  name: AuraAnimationName;
  textureKey: string;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  calibration?: AuraAnimationCalibration;
}

export interface LoadedAuraAnimationPack {
  animations: ReadonlyMap<AuraAnimationName, LoadedAuraAnimation>;
  complete: boolean;
  textureKeys: readonly string[];
  demoTint?: number;
}

function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load Aura sprite image'));
    };
    image.src = url;
  });
}

function textureKey(spriteKey: string, animationName: AuraAnimationName): string {
  return `${spriteKey}_${animationName}`;
}

type AuraCanaryId = 'template-zero' | AuraBuiltinPerformerId;

/**
 * The reviewed bundled performances belong to their matching official Arcade
 * identity, in either seat. Never infer identity from a display name or fill
 * an unrelated/private character with another person's moves. Canonical
 * Arcade cache keys include the public manifest id; require its cached public
 * metadata to agree before selecting this presentation-only supplement.
 */
async function bundledArcadeSubject(photoHash: string | null): Promise<AuraBuiltinPerformerId | null> {
  if (!photoHash?.startsWith('arcade:')) return null;
  const meta = await getCachedMeta(photoHash);
  return meta?.photoHash === photoHash ? builtinAuraPerformerForCachedMeta(meta) : null;
}

function requestedAuraCanary(): AuraCanaryId | null {
  if (!import.meta.env.DEV || typeof window === 'undefined') return null;
  const requested = new URLSearchParams(window.location.search).get('auraCanary');
  return requested === 'template-zero' || isAuraBuiltinPerformerId(requested) ? requested : null;
}

interface LocalAuraCanaryDefinition {
  contentHash?: string;
  name: AuraAnimationName;
  path: string;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
}

const TEMPLATE_ZERO_CANARIES: readonly LocalAuraCanaryDefinition[] = [
  {
    name: 'aura_unbothered',
    path: '/assets/aura/template-zero/aura_unbothered.png',
    frameWidth: 192,
    frameHeight: 256,
    frameCount: 8,
  },
  {
    name: 'aura_six_seven',
    path: '/assets/aura/template-zero/aura_six_seven.png',
    frameWidth: 192,
    frameHeight: 256,
    frameCount: 8,
  },
  {
    name: 'aura_mog_check',
    path: '/assets/aura/template-zero/aura_mog_check.png',
    frameWidth: 192,
    frameHeight: 256,
    frameCount: 8,
  },
  {
    name: 'aura_glide',
    path: '/assets/aura/template-zero/aura_glide.png',
    frameWidth: 192,
    frameHeight: 256,
    frameCount: 8,
  },
  {
    name: 'aura_floor_worm',
    path: '/assets/aura/template-zero/aura_floor_worm.png',
    frameWidth: 384,
    frameHeight: 256,
    frameCount: 8,
  },
  {
    name: 'aura_one_leg',
    path: '/assets/aura/template-zero/aura_one_leg.png',
    frameWidth: 256,
    frameHeight: 256,
    frameCount: 8,
  },
  {
    name: 'aura_shrug',
    path: '/assets/aura/template-zero/aura_shrug.png',
    frameWidth: 192,
    frameHeight: 256,
    frameCount: 8,
  },
];

const DONALD_TRUMP_CANARIES: readonly LocalAuraCanaryDefinition[] = [
  {
    name: 'aura_unbothered',
    path: '/assets/aura/donald-trump/aura_unbothered.png',
    frameWidth: 192,
    frameHeight: 256,
    frameCount: 8,
  },
  {
    name: 'aura_six_seven',
    path: '/assets/aura/donald-trump/aura_six_seven.png',
    frameWidth: 192,
    frameHeight: 256,
    frameCount: 8,
  },
  {
    name: 'aura_mog_check',
    path: '/assets/aura/donald-trump/aura_mog_check.png',
    frameWidth: 192,
    frameHeight: 256,
    frameCount: 8,
  },
  {
    name: 'aura_glide',
    path: '/assets/aura/donald-trump/aura_glide.png',
    frameWidth: 192,
    frameHeight: 256,
    frameCount: 8,
  },
  {
    name: 'aura_floor_worm',
    path: '/assets/aura/donald-trump/aura_floor_worm.png',
    frameWidth: 384,
    frameHeight: 256,
    frameCount: 8,
  },
  {
    name: 'aura_one_leg',
    path: '/assets/aura/donald-trump/aura_one_leg.png',
    frameWidth: 256,
    frameHeight: 256,
    frameCount: 8,
  },
  {
    name: 'aura_shrug',
    path: '/assets/aura/donald-trump/aura_shrug.png',
    frameWidth: 192,
    frameHeight: 256,
    frameCount: 8,
  },
];

function definitionsForBuiltin(subject: AuraBuiltinPerformerId): readonly LocalAuraCanaryDefinition[] {
  return subject === 'donald-trump' ? DONALD_TRUMP_CANARIES : ADDITIONAL_AURA_BUILTIN_ASSETS[subject];
}

function localCanariesFor(
  canaryId: AuraCanaryId | null,
  spriteKey: string,
): readonly LocalAuraCanaryDefinition[] {
  if (canaryId === 'template-zero') return TEMPLATE_ZERO_CANARIES;
  // A real-character canary replaces P1 only so identity QA can happen next
  // to an untouched opponent instead of accidentally cloning the subject.
  if (isAuraBuiltinPerformerId(canaryId) && spriteKey === 'fighter_p1') return definitionsForBuiltin(canaryId);
  return [];
}

async function loadLocalAuraCanary(
  scene: Phaser.Scene,
  spriteKey: string,
  definition: LocalAuraCanaryDefinition,
  canaryId: AuraCanaryId,
  isCurrent: () => boolean,
): Promise<{ animation: LoadedAuraAnimation; geometry: AuraAtlasGeometry } | null> {
  const response = await fetch(definition.path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${canaryId} Aura canary failed (${response.status})`);
  const blob = await response.blob();
  if (!isCurrent()) return null;
  const contentHash = await auraAtlasContentHash(blob);
  const template = AURA_POSE_TEMPLATES[definition.name];
  const expectedHash = definition.contentHash
    ?? (canaryId === 'donald-trump' ? template.trumpSha256 : template.templateSha256);
  if (contentHash !== expectedHash) throw new Error(`${canaryId} ${definition.name} bundled asset hash mismatch`);
  const image = await blobToImage(blob);
  const geometry = measureAuraAtlas(image, definition, contentHash);
  if (!isCurrent()) return null;
  const key = textureKey(spriteKey, definition.name);
  if (scene.textures.exists(key)) scene.textures.remove(key);
  scene.textures.addSpriteSheet(key, image, {
    frameWidth: definition.frameWidth,
    frameHeight: definition.frameHeight,
    endFrame: definition.frameCount - 1,
  });
  return { geometry, animation: {
    name: definition.name,
    textureKey: key,
    frameWidth: definition.frameWidth,
    frameHeight: definition.frameHeight,
    frameCount: definition.frameCount,
  } };
}

/**
 * Aura assets deliberately bypass the combat atlas. They are presentation
 * overrides, so adding a seasonal move cannot change FighterState codes or
 * deterministic online simulation.
 */
export async function loadAuraAnimationPack(
  scene: Phaser.Scene,
  spriteKey: string,
  photoHash: string | null,
  isCurrent: () => boolean = () => true,
  demo?: AuraDemoPerformer,
): Promise<LoadedAuraAnimationPack | null> {
  const cached = photoHash ? await getAllSpritesForHash(photoHash) : [];
  if (!isCurrent()) return null;
  const byName = new Map(cached.map((sprite) => [sprite.animationName, sprite]));
  const animations = new Map<AuraAnimationName, LoadedAuraAnimation>();
  const geometryByName = new Map<AuraAnimationName, AuraAtlasGeometry>();
  const textureKeys: string[] = [];

  for (const name of AURA_LOADABLE_ANIMATION_NAMES) {
    const sprite = byName.get(name);
    if (!sprite || sprite.frameWidth <= 0 || sprite.frameHeight <= 0 || sprite.frameCount <= 0) continue;
    try {
      const image = await blobToImage(sprite.pngBlob);
      const geometry = measureAuraAtlas(image, {
        name, frameWidth: sprite.frameWidth, frameHeight: sprite.frameHeight, frameCount: sprite.frameCount,
      }, await auraAtlasContentHash(sprite.pngBlob));
      if (!isCurrent()) return null;
      const key = textureKey(spriteKey, name);
      if (scene.textures.exists(key)) scene.textures.remove(key);
      scene.textures.addSpriteSheet(key, image, {
        frameWidth: sprite.frameWidth,
        frameHeight: sprite.frameHeight,
        endFrame: sprite.frameCount - 1,
      });
      animations.set(name, {
        name,
        textureKey: key,
        frameWidth: sprite.frameWidth,
        frameHeight: sprite.frameHeight,
        frameCount: sprite.frameCount,
      });
      geometryByName.set(name, geometry);
      textureKeys.push(key);
    } catch (error) {
      debugWarn(
        `[AuraSpriteLoader] ${name} could not be loaded:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  // Explicit offline casts use their own reviewed bundles in either seat.
  // They work in production and never fill or overwrite an owned pack.
  const builtin = !photoHash ? demo : undefined;
  const canaryId = builtin?.id ?? requestedAuraCanary();
  // Remote/current cached Aura assets always lead. An official character may
  // supplement missing moves from its own reviewed bundled set; this does not
  // edit its cloud manifest, paid entitlement, cache pointers or combat pack.
  const officialSubject = !canaryId ? await bundledArcadeSubject(photoHash) : null;
  if (!isCurrent()) return null;
  const localSubject = officialSubject ?? canaryId;
  const localDefinitions = builtin
    ? builtin.id === 'template-zero' ? TEMPLATE_ZERO_CANARIES : definitionsForBuiltin(builtin.id)
    : officialSubject ? definitionsForBuiltin(officialSubject) : localCanariesFor(canaryId, spriteKey);
  if (localSubject) {
    for (const definition of localDefinitions) {
      const replacesCachedAnimation = animations.has(definition.name);
      if (replacesCachedAnimation && (officialSubject || canaryId === 'template-zero')) continue;
      try {
        const loaded = await loadLocalAuraCanary(scene, spriteKey, definition, localSubject, isCurrent);
        if (!loaded || !isCurrent()) return null;
        const { animation: canary, geometry } = loaded;
        animations.set(canary.name, canary);
        geometryByName.set(canary.name, geometry);
        if (!replacesCachedAnimation) textureKeys.push(canary.textureKey);
        debugInfo(`[AuraSpriteLoader] ${localSubject} ${canary.name} ${officialSubject ? 'official bundled performance' : 'canary'} enabled for "${spriteKey}"`);
      } catch (error) {
        debugWarn(
          `[AuraSpriteLoader] ${localSubject} ${definition.name} bundled performance could not be loaded:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  const idleReference = auraIdleReference(geometryByName.get('aura_unbothered'));
  for (const [name, animation] of animations) {
    const geometry = geometryByName.get(name);
    if (!geometry) continue;
    try {
      animation.calibration = calibrateAuraAtlas(geometry, idleReference);
      if (animation.calibration.audit?.verdict === 'shape-mismatch') {
        debugWarn(`[AuraSpriteLoader] ${name}: scale registered; shape review still required for frames`,
          animation.calibration.audit.shapeMismatchFrameIndices);
      }
    } catch (error) {
      // A clipped or corrupt known pose must not silently acquire a fit-clamp.
      debugWarn(`[AuraSpriteLoader] ${name}: unsafe pose registration`, error);
      animations.delete(name);
      if (scene.textures.exists(animation.textureKey)) scene.textures.remove(animation.textureKey);
      const index = textureKeys.indexOf(animation.textureKey);
      if (index >= 0) textureKeys.splice(index, 1);
    }
  }

  if (animations.size === 0) return null;
  debugInfo(
    `[AuraSpriteLoader] Loaded ${animations.size}/${AURA_LOADABLE_ANIMATION_NAMES.length} performances and reactions for "${spriteKey}"`,
  );
  return {
    animations,
    complete: AURA_ANIMATION_NAMES.every((name) => animations.has(name)),
    textureKeys,
    ...(builtin ? { demoTint: builtin.tint } : {}),
  };
}

export function destroyLoadedAuraAnimationPack(
  scene: Phaser.Scene,
  pack: LoadedAuraAnimationPack | null | undefined,
): void {
  if (!pack) return;
  for (const key of pack.textureKeys) {
    if (scene.textures.exists(key)) scene.textures.remove(key);
  }
}
