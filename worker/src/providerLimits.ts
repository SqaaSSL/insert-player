export type ProviderName = 'gemini' | 'ludo' | 'freepik' | 'runway' | 'fal' | 'pixcli';

export const PROVIDER_REQUEST_BODY_LIMITS: Record<ProviderName, number> = {
  gemini: 48 * 1024 * 1024,
  ludo: 24 * 1024 * 1024,
  freepik: 24 * 1024 * 1024,
  runway: 24 * 1024 * 1024,
  fal: 24 * 1024 * 1024,
  pixcli: 24 * 1024 * 1024,
};

export const PROVIDER_RESPONSE_BODY_LIMITS: Record<ProviderName, number> = {
  gemini: 96 * 1024 * 1024,
  ludo: 32 * 1024 * 1024,
  freepik: 32 * 1024 * 1024,
  runway: 16 * 1024 * 1024,
  fal: 32 * 1024 * 1024,
  pixcli: 32 * 1024 * 1024,
};
