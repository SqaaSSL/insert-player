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

const OFFICIAL_JUMP_MASTER: OfficialPoseMaster = {
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

const OFFICIAL_HIT_MASTER: OfficialPoseMaster = {
  id: 'arcade-qa-pose-atlas-2026-v1:hit',
  animationName: 'hit',
  frames: [
    {
      objectKey: 'official-pose-masters/arcade-qa-pose-atlas-2026-v1/hit/01-de94f9925665.png',
      sha256: 'de94f992566508fc157f0f2193bbdbaaca424c0bec504bff1081721f5208b019',
    },
    {
      objectKey: 'official-pose-masters/arcade-qa-pose-atlas-2026-v1/hit/02-13c7ec55fae2.png',
      sha256: '13c7ec55fae2a7f74817b4d151eb7bc269c00d551b2a21e1b7e3df3027f90cec',
    },
    {
      objectKey: 'official-pose-masters/arcade-qa-pose-atlas-2026-v1/hit/03-bba63c2b9096.png',
      sha256: 'bba63c2b90964c72c1914e6e692ebf8a51440f96f27e006547a9b3a67479e91e',
    },
    {
      objectKey: 'official-pose-masters/arcade-qa-pose-atlas-2026-v1/hit/04-03a3a1f265ca.png',
      sha256: '03a3a1f265caeca732d38afcb66d5588ea2f75006f5dd734df29ba7071eccbb5',
    },
  ],
};

const OFFICIAL_KO_MASTER: OfficialPoseMaster = {
  id: 'arcade-qa-pose-atlas-2026-v1:ko',
  animationName: 'ko',
  frames: [
    {
      objectKey: 'official-pose-masters/arcade-qa-pose-atlas-2026-v1/ko/01-0f81b4e02847.png',
      sha256: '0f81b4e02847db60c72d8986ddbf9475ae55bea4fe43ed693962da75e8d3899a',
    },
    {
      objectKey: 'official-pose-masters/arcade-qa-pose-atlas-2026-v1/ko/02-36f325760c0d.png',
      sha256: '36f325760c0d6de9017cf9bb8c93fccec6a3516993d7339993fa28bb4cf85113',
    },
    {
      objectKey: 'official-pose-masters/arcade-qa-pose-atlas-2026-v1/ko/03-2ece8fbb4780.png',
      sha256: '2ece8fbb4780c766531a3c79f52d48a5d84b716924b9b893b9c2fcdf2805cc79',
    },
    {
      objectKey: 'official-pose-masters/arcade-qa-pose-atlas-2026-v1/ko/04-73fdaa6bad95.png',
      sha256: '73fdaa6bad955b94535492f8985b006adb0a0b46eff2fac8a7385b9a744254cb',
    },
    {
      objectKey: 'official-pose-masters/arcade-qa-pose-atlas-2026-v1/ko/05-98c4b8ed1f89.png',
      sha256: '98c4b8ed1f8929d7f4047e64874e8c2968e705ca0c33925ad523a4e543769e76',
    },
    {
      objectKey: 'official-pose-masters/arcade-qa-pose-atlas-2026-v1/ko/06-4802bc91b89e.png',
      sha256: '4802bc91b89e9dba4b872eeed6536148dd7a1957894914eee50e0212c5c2868f',
    },
    {
      objectKey: 'official-pose-masters/arcade-qa-pose-atlas-2026-v1/ko/07-4fc73dc553b5.png',
      sha256: '4fc73dc553b5a9c056fde1db61556b6c1132f010ba6ec72f0e7a88838430fde4',
    },
    {
      objectKey: 'official-pose-masters/arcade-qa-pose-atlas-2026-v1/ko/08-2e11f1f7e0bb.png',
      sha256: '2e11f1f7e0bb5a4723d9dec63f6caf899ca3861e4bd64f0b1c1e40b33bd653e9',
    },
  ],
};

const OFFICIAL_VICTORY_MASTER: OfficialPoseMaster = {
  id: 'arcade-qa-pose-atlas-2026-v1:victory',
  animationName: 'victory',
  frames: [
    {
      objectKey: 'official-pose-masters/arcade-qa-pose-atlas-2026-v1/victory/01-5173b86d633e.png',
      sha256: '5173b86d633ed2cd7e0d069ab5237eb71c0814db79f6ffb14fb7177c9ece56d2',
    },
    {
      objectKey: 'official-pose-masters/arcade-qa-pose-atlas-2026-v1/victory/02-d3bc9f41d386.png',
      sha256: 'd3bc9f41d3868b54e2a316df1a7afa04a6adc4c937cbe499f52fc9fe17df6978',
    },
    {
      objectKey: 'official-pose-masters/arcade-qa-pose-atlas-2026-v1/victory/03-962180a093dc.png',
      sha256: '962180a093dc9fbc7b0b82c6dee993ab305d4f1f48522d3233c171295ecaeb9c',
    },
    {
      objectKey: 'official-pose-masters/arcade-qa-pose-atlas-2026-v1/victory/04-28e9a27d9dcd.png',
      sha256: '28e9a27d9dcd160f4742ed109ddcd5a1455505cc2084e94adf1606860af8c97d',
    },
    {
      objectKey: 'official-pose-masters/arcade-qa-pose-atlas-2026-v1/victory/05-c612d907b214.png',
      sha256: 'c612d907b21433daa53133f3093a8efcc1aabe948c3b57324284b17bec319ea4',
    },
    {
      objectKey: 'official-pose-masters/arcade-qa-pose-atlas-2026-v1/victory/06-4e3fbb466505.png',
      sha256: '4e3fbb4665050a7b8c54f2b0b05fc6ffaafdf7dce0c759f4597583b9493694db',
    },
    {
      objectKey: 'official-pose-masters/arcade-qa-pose-atlas-2026-v1/victory/07-d50d1d153090.png',
      sha256: 'd50d1d153090f33cd6598cbdecbc967f13a4bbe7fd4213f4d8f9305d4bb01fda',
    },
    {
      objectKey: 'official-pose-masters/arcade-qa-pose-atlas-2026-v1/victory/08-4bf24dc10608.png',
      sha256: '4bf24dc10608aeedeed0c3833b777d335646e99ccce3a848e7cffa3f5090ae9d',
    },
  ],
};

const OFFICIAL_POSE_MASTERS = new Map<string, OfficialPoseMaster>([
  [OFFICIAL_JUMP_MASTER.animationName, OFFICIAL_JUMP_MASTER],
  [OFFICIAL_HIT_MASTER.animationName, OFFICIAL_HIT_MASTER],
  [OFFICIAL_KO_MASTER.animationName, OFFICIAL_KO_MASTER],
  [OFFICIAL_VICTORY_MASTER.animationName, OFFICIAL_VICTORY_MASTER],
]);

export function officialPoseMasterFor(
  animationName: string,
  tier: QualityTier,
  officialDescription: string | undefined,
): OfficialPoseMaster | null {
  if (tier !== 'champion' || !officialDescription?.trim()) return null;
  return OFFICIAL_POSE_MASTERS.get(animationName) ?? null;
}
