export const GEMINI_FLASH_IMAGE_MODEL = 'gemini-3.1-flash-image';
export const GEMINI_PRO_IMAGE_MODEL = 'gemini-3-pro-image';

export const OFFICIAL_ARCADE_IMAGE_PROVIDER_CONTRACT = {
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
} as const;

export type OfficialArcadeImageProviderContract = typeof OFFICIAL_ARCADE_IMAGE_PROVIDER_CONTRACT;

export function isOfficialArcadeImageProviderContract(
  value: unknown,
): value is OfficialArcadeImageProviderContract {
  if (!value || typeof value !== 'object') return false;
  const contract = value as Record<string, unknown>;
  const providers = contract.allowedGenerationProviders;
  const sourceModels = contract.sourceModels as Record<string, unknown> | null;
  const championAnimation = contract.championAnimation as Record<string, unknown> | null;
  return contract.schemaVersion === OFFICIAL_ARCADE_IMAGE_PROVIDER_CONTRACT.schemaVersion
    && Array.isArray(providers)
    && providers.length === 1
    && providers[0] === 'gemini'
    && sourceModels?.side === GEMINI_PRO_IMAGE_MODEL
    && sourceModels.upright === GEMINI_PRO_IMAGE_MODEL
    && sourceModels.crouch === GEMINI_PRO_IMAGE_MODEL
    && championAnimation?.scaffoldModel === GEMINI_FLASH_IMAGE_MODEL
    && championAnimation.renderModel === GEMINI_PRO_IMAGE_MODEL
    && championAnimation.reviewModel === GEMINI_PRO_IMAGE_MODEL
    && contract.fallbackPolicy === 'fail-closed';
}
