import { describe, expect, it } from 'vitest';
import {
  GEMINI_FLASH_IMAGE_MODEL,
  GEMINI_PRO_IMAGE_MODEL,
  isOfficialArcadeImageProviderContract,
  OFFICIAL_ARCADE_IMAGE_PROVIDER_CONTRACT,
} from './ImageProviderContract';

describe('official Arcade image-provider contract', () => {
  it('pins every image-generation step to the approved Gemini models', () => {
    expect(OFFICIAL_ARCADE_IMAGE_PROVIDER_CONTRACT).toEqual({
      schemaVersion: 1,
      allowedGenerationProviders: ['gemini'],
      sourceModels: {
        side: GEMINI_PRO_IMAGE_MODEL,
        upright: GEMINI_PRO_IMAGE_MODEL,
        crouch: GEMINI_PRO_IMAGE_MODEL,
      },
      championAnimation: {
        scaffoldModel: GEMINI_FLASH_IMAGE_MODEL,
        renderModel: GEMINI_PRO_IMAGE_MODEL,
        reviewModel: GEMINI_PRO_IMAGE_MODEL,
      },
      fallbackPolicy: 'fail-closed',
    });
    expect(isOfficialArcadeImageProviderContract(OFFICIAL_ARCADE_IMAGE_PROVIDER_CONTRACT)).toBe(true);
  });

  it('rejects another provider, model, or fallback policy', () => {
    const provider = structuredClone(OFFICIAL_ARCADE_IMAGE_PROVIDER_CONTRACT) as Record<string, unknown>;
    provider.allowedGenerationProviders = ['fal'];
    expect(isOfficialArcadeImageProviderContract(provider)).toBe(false);

    const model = {
      ...OFFICIAL_ARCADE_IMAGE_PROVIDER_CONTRACT,
      championAnimation: {
        ...OFFICIAL_ARCADE_IMAGE_PROVIDER_CONTRACT.championAnimation,
        renderModel: 'flux-2-pro',
      },
    };
    expect(isOfficialArcadeImageProviderContract(model)).toBe(false);

    const fallback = {
      ...OFFICIAL_ARCADE_IMAGE_PROVIDER_CONTRACT,
      fallbackPolicy: 'automatic',
    };
    expect(isOfficialArcadeImageProviderContract(fallback)).toBe(false);
  });
});
