import Phaser from 'phaser';
import {
  AURA_ANIMATION_NAMES,
  AURA_LOADABLE_ANIMATION_NAMES,
  type AuraAnimationName,
} from '../../services/FighterAssetPacks.ts';
import { getAllSpritesForHash } from '../../services/SpriteCache.ts';
import { debugInfo, debugWarn } from '../../services/DebugLog.ts';

export interface LoadedAuraAnimation {
  name: AuraAnimationName;
  textureKey: string;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
}

export interface LoadedAuraAnimationPack {
  animations: ReadonlyMap<AuraAnimationName, LoadedAuraAnimation>;
  complete: boolean;
  textureKeys: readonly string[];
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

function templateZeroCanaryEnabled(): boolean {
  return import.meta.env.DEV
    && typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('auraCanary') === 'template-zero';
}

interface TemplateZeroCanaryDefinition {
  name: AuraAnimationName;
  path: string;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
}

const TEMPLATE_ZERO_CANARIES: readonly TemplateZeroCanaryDefinition[] = [
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

async function loadTemplateZeroCanary(
  scene: Phaser.Scene,
  spriteKey: string,
  definition: TemplateZeroCanaryDefinition,
): Promise<LoadedAuraAnimation> {
  const response = await fetch(definition.path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Template Zero Aura canary failed (${response.status})`);
  const image = await blobToImage(await response.blob());
  const key = textureKey(spriteKey, definition.name);
  if (scene.textures.exists(key)) scene.textures.remove(key);
  scene.textures.addSpriteSheet(key, image, {
    frameWidth: definition.frameWidth,
    frameHeight: definition.frameHeight,
    endFrame: definition.frameCount - 1,
  });
  return {
    name: definition.name,
    textureKey: key,
    frameWidth: definition.frameWidth,
    frameHeight: definition.frameHeight,
    frameCount: definition.frameCount,
  };
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
): Promise<LoadedAuraAnimationPack | null> {
  const cached = photoHash ? await getAllSpritesForHash(photoHash) : [];
  if (!isCurrent()) return null;
  const byName = new Map(cached.map((sprite) => [sprite.animationName, sprite]));
  const animations = new Map<AuraAnimationName, LoadedAuraAnimation>();
  const textureKeys: string[] = [];

  for (const name of AURA_LOADABLE_ANIMATION_NAMES) {
    const sprite = byName.get(name);
    if (!sprite || sprite.frameWidth <= 0 || sprite.frameHeight <= 0 || sprite.frameCount <= 0) continue;
    try {
      const image = await blobToImage(sprite.pngBlob);
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
      textureKeys.push(key);
    } catch (error) {
      debugWarn(
        `[AuraSpriteLoader] ${name} could not be loaded:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  if (templateZeroCanaryEnabled()) {
    for (const definition of TEMPLATE_ZERO_CANARIES) {
      if (animations.has(definition.name)) continue;
      try {
        const canary = await loadTemplateZeroCanary(scene, spriteKey, definition);
        if (!isCurrent()) return null;
        animations.set(canary.name, canary);
        textureKeys.push(canary.textureKey);
        debugInfo(`[AuraSpriteLoader] Template Zero ${canary.name} canary enabled for "${spriteKey}"`);
      } catch (error) {
        debugWarn(
          `[AuraSpriteLoader] Template Zero ${definition.name} canary could not be loaded:`,
          error instanceof Error ? error.message : error,
        );
      }
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
