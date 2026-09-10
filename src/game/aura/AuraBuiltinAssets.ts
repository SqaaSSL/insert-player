import type { AuraAnimationName } from '../../services/FighterAssetPacks.ts';

export interface AuraBuiltinAsset {
  name: AuraAnimationName;
  path: string;
  contentHash: string;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  referenceBodyHeight: number;
  referenceRootY: number;
}

/** Individually generated and visually reviewed official performances.
 * Exact bytes and alpha-32 standing references: artifacts/aura-animation-canary/official-roster-v1.
 * Shrug is optional; these bundles contain all six core performances.
 */
export const ADDITIONAL_AURA_BUILTIN_ASSETS = {
  "rosalia-v2": [
    {
      "name": "aura_unbothered",
      "path": "/assets/aura/rosalia-v2/aura_unbothered.png",
      "contentHash": "c9ed0656e844dc71d5b1d2b3d43d7fb0740bbc37762b3cf94899797a49ffafba",
      "frameWidth": 192,
      "frameHeight": 256,
      "frameCount": 8,
      "referenceBodyHeight": 219.5,
      "referenceRootY": 240
    },
    {
      "name": "aura_six_seven",
      "path": "/assets/aura/rosalia-v2/aura_six_seven.png",
      "contentHash": "ebc7f7c88319b4e20450da598a239f40bdd004bba8b2849bc498656d22b538f2",
      "frameWidth": 192,
      "frameHeight": 256,
      "frameCount": 8,
      "referenceBodyHeight": 231,
      "referenceRootY": 239
    },
    {
      "name": "aura_mog_check",
      "path": "/assets/aura/rosalia-v2/aura_mog_check.png",
      "contentHash": "26854014f14656af65ecd3db8534c1b038773111511ca07dd6e19cf1e8c23f24",
      "frameWidth": 192,
      "frameHeight": 256,
      "frameCount": 8,
      "referenceBodyHeight": 233,
      "referenceRootY": 239
    },
    {
      "name": "aura_glide",
      "path": "/assets/aura/rosalia-v2/aura_glide.png",
      "contentHash": "dfd10d4caaa90065ec54c6514c8a6c82ad9709ddb2b8897e113847b4284a32c8",
      "frameWidth": 192,
      "frameHeight": 256,
      "frameCount": 8,
      "referenceBodyHeight": 225,
      "referenceRootY": 239.5
    },
    {
      "name": "aura_floor_worm",
      "path": "/assets/aura/rosalia-v2/aura_floor_worm.png",
      "contentHash": "5ee9c4f7d6cc2a70024c8aeb87aa0f13711ae3f88f9f2fb61bb6dd4870da2487",
      "frameWidth": 384,
      "frameHeight": 256,
      "frameCount": 8,
      "referenceBodyHeight": 215.5,
      "referenceRootY": 239
    },
    {
      "name": "aura_one_leg",
      "path": "/assets/aura/rosalia-v2/aura_one_leg.png",
      "contentHash": "ae647c4c2baadfb8d8c188a58afb4abb6e4895c34cd267bd201f1132ae09f941",
      "frameWidth": 256,
      "frameHeight": 256,
      "frameCount": 8,
      "referenceBodyHeight": 222.5,
      "referenceRootY": 239
    }
  ],
  "lamine-yamal": [
    {
      "name": "aura_unbothered",
      "path": "/assets/aura/lamine-yamal/aura_unbothered.png",
      "contentHash": "3e3068db970b31ec92cc49380e5636c35af8a5170069699bb7fd6ab2c02de14d",
      "frameWidth": 192,
      "frameHeight": 256,
      "frameCount": 8,
      "referenceBodyHeight": 220,
      "referenceRootY": 240
    },
    {
      "name": "aura_six_seven",
      "path": "/assets/aura/lamine-yamal/aura_six_seven.png",
      "contentHash": "e38620ab609d105e9ef75bd1386fbaebcdd040f951e6856ef8432fea388d14d0",
      "frameWidth": 192,
      "frameHeight": 256,
      "frameCount": 8,
      "referenceBodyHeight": 230.5,
      "referenceRootY": 239
    },
    {
      "name": "aura_mog_check",
      "path": "/assets/aura/lamine-yamal/aura_mog_check.png",
      "contentHash": "c39349ddf249fd937eb8cfe805576381a88c5849e6409a5119d99865e8cdd722",
      "frameWidth": 192,
      "frameHeight": 256,
      "frameCount": 8,
      "referenceBodyHeight": 227,
      "referenceRootY": 239
    },
    {
      "name": "aura_glide",
      "path": "/assets/aura/lamine-yamal/aura_glide.png",
      "contentHash": "60a5e212612671cb58d7edc13f8afcac2d9a1ab649cc3eb08debf09fbb20a4e9",
      "frameWidth": 192,
      "frameHeight": 256,
      "frameCount": 8,
      "referenceBodyHeight": 224,
      "referenceRootY": 239.5
    },
    {
      "name": "aura_floor_worm",
      "path": "/assets/aura/lamine-yamal/aura_floor_worm.png",
      "contentHash": "be01725e78f1d74bc036732fbaaf2a9da436120da91ec3b342c1966bd16fb666",
      "frameWidth": 384,
      "frameHeight": 256,
      "frameCount": 8,
      "referenceBodyHeight": 208.5,
      "referenceRootY": 239
    },
    {
      "name": "aura_one_leg",
      "path": "/assets/aura/lamine-yamal/aura_one_leg.png",
      "contentHash": "c7407308ed9d1b2bcf02eea4f1501c338d79f1eb78863b1d7a4bb344c4f0d732",
      "frameWidth": 256,
      "frameHeight": 256,
      "frameCount": 8,
      "referenceBodyHeight": 226.5,
      "referenceRootY": 239
    }
  ]
} as const satisfies Record<'rosalia-v2' | 'lamine-yamal', readonly AuraBuiltinAsset[]>;
