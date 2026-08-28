import {
  SIGNATURE_STAGE_THEMES,
  type StageTheme,
} from '../../game/match/StageConfig.ts';
import type { CachedStageBackground } from '../../services/SpriteCache.ts';

export type GalleryGlobalStageTheme = StageTheme & { assetPath: string };

export type GalleryStageEntry =
  | {
      scope: 'global';
      key: string;
      theme: GalleryGlobalStageTheme;
    }
  | {
      scope: 'owned';
      key: string;
      stage: CachedStageBackground;
    };

function hasAssetPath(stage: StageTheme): stage is GalleryGlobalStageTheme {
  return typeof stage.assetPath === 'string' && stage.assetPath.length > 0;
}

export const GLOBAL_GALLERY_STAGES = SIGNATURE_STAGE_THEMES.filter(hasAssetPath);

export function buildGalleryStageEntries(
  ownedStages: CachedStageBackground[],
): GalleryStageEntry[] {
  return [
    ...GLOBAL_GALLERY_STAGES.map((theme): GalleryStageEntry => ({
      scope: 'global',
      key: `global:${theme.id}`,
      theme,
    })),
    ...ownedStages.map((stage): GalleryStageEntry => ({
      scope: 'owned',
      key: `owned:${stage.stageKey}`,
      stage,
    })),
  ];
}

export function clampGalleryStageIndex(index: number, ownedStageCount: number): number {
  const total = GLOBAL_GALLERY_STAGES.length + ownedStageCount;
  return Math.min(Math.max(0, index), Math.max(0, total - 1));
}
