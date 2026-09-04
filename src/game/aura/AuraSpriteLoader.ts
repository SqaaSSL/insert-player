import Phaser from 'phaser';
import {
  AURA_ANIMATION_NAMES,
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

async function loadTemplateZeroCanary(
  scene: Phaser.Scene,
  spriteKey: string,
): Promise<LoadedAuraAnimation> {
  const response = await fetch('/assets/aura/template-zero/aura_six_seven.png', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Template Zero Aura canary failed (${response.status})`);
  const image = await blobToImage(await response.blob());
  const key = textureKey(spriteKey, 'aura_six_seven');
  if (scene.textures.exists(key)) scene.textures.remove(key);
  scene.textures.addSpriteSheet(key, image, {
    frameWidth: 192,
    frameHeight: 256,
    endFrame: 7,
  });
  return {
    name: 'aura_six_seven',
    textureKey: key,
    frameWidth: 192,
    frameHeight: 256,
    frameCount: 8,
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

  for (const name of AURA_ANIMATION_NAMES) {
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

  if (templateZeroCanaryEnabled() && !animations.has('aura_six_seven')) {
    try {
      const canary = await loadTemplateZeroCanary(scene, spriteKey);
      if (!isCurrent()) return null;
      animations.set(canary.name, canary);
      textureKeys.push(canary.textureKey);
      debugInfo(`[AuraSpriteLoader] Template Zero canary enabled for "${spriteKey}"`);
    } catch (error) {
      debugWarn(
        '[AuraSpriteLoader] Template Zero canary could not be loaded:',
        error instanceof Error ? error.message : error,
      );
    }
  }

  if (animations.size === 0) return null;
  debugInfo(
    `[AuraSpriteLoader] Loaded ${animations.size}/${AURA_ANIMATION_NAMES.length} performances for "${spriteKey}"`,
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
