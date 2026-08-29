import type { QualityTier } from './types';

export interface OfficialPoseMasterFrame {
  objectKey: string;
  sha256: string;
}

export interface OfficialPoseMaster {
  id: string;
  animationName: string;
  frames: readonly OfficialPoseMasterFrame[];
}

const PLAYER_ONE_JUMP_MASTER: OfficialPoseMaster = {
  id: 'arcade-qa-pose-atlas-2026-v1:jump',
  animationName: 'jump',
  frames: [
    {
      objectKey: 'official-pose-masters/arcade-qa-pose-atlas-2026-v1/jump/01-98db8a1f138f.png',
      sha256: '98db8a1f138f19e8ae9dc484aae60395fe4c3c4beffe587336e25400a33a3904',
    },
    {
      objectKey: 'official-pose-masters/arcade-qa-pose-atlas-2026-v1/jump/02-781b3376209a.png',
      sha256: '781b3376209a8a1a2cbc12f290cf32446d0dc7d67d94c0347433923c7e369801',
    },
    {
      objectKey: 'official-pose-masters/arcade-qa-pose-atlas-2026-v1/jump/03-08f46afaa557.png',
      sha256: '08f46afaa557c19f22c387a8a7b4fb1726ad3d402ff11752d2f2f437bb9589da',
    },
    {
      objectKey: 'official-pose-masters/arcade-qa-pose-atlas-2026-v1/jump/04-4c7aa66534fa.png',
      sha256: '4c7aa66534fa698ac0666d440a0037f8fbfc8524ea43f989a3d9764d69cb7c49',
    },
  ],
};

export function officialPoseMasterFor(
  animationName: string,
  tier: QualityTier,
  officialDescription: string | undefined,
): OfficialPoseMaster | null {
  if (tier !== 'champion' || !officialDescription?.trim()) return null;
  return animationName === PLAYER_ONE_JUMP_MASTER.animationName
    ? PLAYER_ONE_JUMP_MASTER
    : null;
}
