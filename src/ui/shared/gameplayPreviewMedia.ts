import { getAuraCanvasSize } from '../../game/aura/AuraViewport.ts';
import { COMBAT_PREVIEW_MEDIA, type CombatPreviewMedia } from './combatPreviewPlayback.ts';

export type GameplayPreviewMode = 'aura' | 'fight' | 'rush';
export interface GameplayPreviewMedia extends CombatPreviewMedia {
  width: number;
  height: number;
  name: string;
  description: string;
}

const auraDescription = 'Real Aura gameplay: Trump and Lamine take turns, hit four coloured note lanes, earn Aura and perform moves beside their input history.';
const AURA_GAMEPLAY_MEDIA = {
  landscape: {
    src: '/assets/play-mode-aura-landscape-v2.mp4',
    poster: '/assets/play-mode-aura-landscape-poster-v2.webp',
    actionTime: 1,
    width: 1024, height: 576, name: 'Aura', description: auraDescription,
  },
  portrait: {
    src: '/assets/play-mode-aura-portrait-v2.mp4',
    poster: '/assets/play-mode-aura-portrait-poster-v2.webp',
    actionTime: 1,
    width: 432, height: 768, name: 'Aura', description: auraDescription,
  },
} as const satisfies Record<string, GameplayPreviewMedia>;
const COMBAT_GAMEPLAY_MEDIA = {
  fight: { ...COMBAT_PREVIEW_MEDIA.fight, width: 960, height: 540, name: 'Fight',
    description: 'Real Fight gameplay: two fighters exchange attacks, with health bars and round timer.' },
  rush: { ...COMBAT_PREVIEW_MEDIA.rush, width: 960, height: 540, name: 'Rush',
    description: 'Real Rush gameplay: a player and CPU ally clear Side Street together.' },
} as const satisfies Record<string, GameplayPreviewMedia>;

/** Select the same screen shape as the game, before the single video loads. */
export function gameplayPreviewMedia(mode: GameplayPreviewMode, viewportWidth: number, viewportHeight: number): GameplayPreviewMedia {
  if (mode !== 'aura') return COMBAT_GAMEPLAY_MEDIA[mode];
  return AURA_GAMEPLAY_MEDIA[getAuraCanvasSize(viewportWidth, viewportHeight).portrait ? 'portrait' : 'landscape'];
}
