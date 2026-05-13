import type { CachedMeta } from '../../services/SpriteCache.ts';

export const ANIM_LABELS: Record<string, string> = {
  idle: 'IDLE',
  walk: 'WALK',
  high_punch: 'PUNCH',
  low_punch: 'C.PUNCH',
  high_kick: 'KICK',
  low_kick: 'C.KICK',
  jump: 'JUMP',
  crouch: 'CROUCH',
  hit: 'HIT',
  ko: 'K.O.',
  victory: 'WIN',
};

export function animLabel(name: string): string {
  return ANIM_LABELS[name] ?? name.toUpperCase();
}

export type SourceKey = 'original' | 'side' | 'upright' | 'crouch';

export const SOURCE_VIEWS: ReadonlyArray<readonly [SourceKey, string]> = [
  ['original', 'Original'],
  ['side', 'Side View'],
  ['upright', 'Upright'],
  ['crouch', 'Crouch'],
];

export type PreviewSelection =
  | { kind: 'source'; source: SourceKey }
  | { kind: 'animation'; animationName: string };

export interface PreviewSpriteLike {
  blob: Blob;
  rawBlob?: Blob;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  failed?: boolean;
  reason?: string;
}

export function getSourceBlob(meta: CachedMeta | null, source: SourceKey): Blob | null {
  if (!meta) return null;
  switch (source) {
    case 'original':
      return meta.originalPhotoBlob;
    case 'side':
      return meta.sideViewBlob;
    case 'upright':
      return meta.uprightViewBlob;
    case 'crouch':
      return meta.crouchViewBlob;
  }
}
