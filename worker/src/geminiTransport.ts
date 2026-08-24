import type { Env } from './types';

export type GeminiTransport = 'google-direct' | 'meterkey';

export interface GeminiTransportStatus {
  transport: GeminiTransport | null;
  configured: boolean;
  error: string | null;
}

const METERKEY_BASE_PATH = '/';
const APPROVED_METERKEY_ORIGINS = new Set(['https://meter.hilo.cx']);

export function configuredGeminiTransport(env: Env): GeminiTransport | null {
  const configured = env.GEMINI_TRANSPORT?.trim();
  if (configured === 'google-direct' || configured === 'meterkey') return configured;
  // Unit tests and local development created before transport selection remain
  // direct by default. Deployed sandbox/production configs must always pin it.
  if (!env.ENVIRONMENT || env.ENVIRONMENT === 'development') return 'google-direct';
  return null;
}

export function meterkeyBaseUrl(raw: string | undefined): URL | null {
  if (!raw?.trim()) return null;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || url.search
      || url.hash
      || !APPROVED_METERKEY_ORIGINS.has(url.origin)
      || (url.pathname !== '' && url.pathname !== METERKEY_BASE_PATH)
    ) return null;
    url.pathname = METERKEY_BASE_PATH;
    return url;
  } catch {
    return null;
  }
}

export function geminiTransportStatus(env: Env): GeminiTransportStatus {
  const transport = configuredGeminiTransport(env);
  if (!transport) {
    return {
      transport: null,
      configured: false,
      error: 'GEMINI_TRANSPORT must be google-direct or meterkey',
    };
  }
  if (transport === 'google-direct') {
    return env.GEMINI_API_KEY?.trim()
      ? { transport, configured: true, error: null }
      : { transport, configured: false, error: 'GEMINI_API_KEY is not configured' };
  }
  if (!env.METERKEY_API_KEY?.trim()) {
    return { transport, configured: false, error: 'METERKEY_API_KEY is not configured' };
  }
  if (!meterkeyBaseUrl(env.METERKEY_BASE_URL)) {
    return { transport, configured: false, error: 'METERKEY_BASE_URL must be the approved bare HTTPS origin' };
  }
  return { transport, configured: true, error: null };
}

export function geminiEstimatedCostCents(env: Env, model: string): number | null {
  const transport = configuredGeminiTransport(env);
  if (model === 'gemini-3.1-flash-image') return transport === 'meterkey' ? 9 : 8;
  if (model === 'gemini-3-pro-image') return transport === 'meterkey' ? 17 : 15;
  return null;
}
