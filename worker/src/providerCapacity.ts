import type { Env, GenerationJobOperation, QualityTier } from './types';
import { configuredGeminiTransport } from './geminiTransport';

export const GEMINI_PRO_IMAGE_MODEL = 'gemini-3-pro-image';
export const GEMINI_FLASH_IMAGE_MODEL = 'gemini-3.1-flash-image';

export type ApprovedGeminiModel =
  | typeof GEMINI_PRO_IMAGE_MODEL
  | typeof GEMINI_FLASH_IMAGE_MODEL;

export interface ProviderCapacityWindow {
  provider: 'gemini';
  model: ApprovedGeminiModel;
  reason: 'daily_quota_exhausted';
  retryAtEpoch: number;
}

export interface ProviderDailyQuotaSignal {
  provider: 'gemini';
  model: ApprovedGeminiModel;
  retryAfterSeconds: number;
}

const DAILY_QUOTA_FAILURE_MARKER = 'provider_daily_quota_exhausted:';
const DEFAULT_RETRY_AFTER_SECONDS = 24 * 60 * 60;
const MIN_RETRY_AFTER_SECONDS = 60;
const MAX_RETRY_AFTER_SECONDS = 48 * 60 * 60;

interface ProviderCapacityRow {
  provider: string;
  model: string;
  reason: string;
  retry_at_epoch: number;
}

function capacityTable(env: Env): 'provider_capacity_windows' | 'provider_meterkey_capacity_windows' {
  const transport = configuredGeminiTransport(env);
  if (!transport) throw new Error('Gemini transport is not configured');
  return transport === 'meterkey'
    ? 'provider_meterkey_capacity_windows'
    : 'provider_capacity_windows';
}

export function isApprovedGeminiModel(model: unknown): model is ApprovedGeminiModel {
  return model === GEMINI_PRO_IMAGE_MODEL || model === GEMINI_FLASH_IMAGE_MODEL;
}

function boundedRetryAfterSeconds(value: unknown): number {
  const parsed = typeof value === 'number' && Number.isFinite(value)
    ? Math.ceil(value)
    : DEFAULT_RETRY_AFTER_SECONDS;
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(MIN_RETRY_AFTER_SECONDS, parsed));
}

export function requiredGeminiModelsForGeneration(
  operation: GenerationJobOperation,
  tier: QualityTier,
): ApprovedGeminiModel[] {
  if (operation === 'fighter_retry_source') return [GEMINI_PRO_IMAGE_MODEL];
  if (operation === 'fighter_generation') {
    return tier === 'champion'
      ? [GEMINI_PRO_IMAGE_MODEL]
      : [GEMINI_PRO_IMAGE_MODEL, GEMINI_FLASH_IMAGE_MODEL];
  }
  return [tier === 'champion' ? GEMINI_PRO_IMAGE_MODEL : GEMINI_FLASH_IMAGE_MODEL];
}

export function parseProviderDailyQuotaSignal(detail: string): ProviderDailyQuotaSignal | null {
  try {
    const payload = JSON.parse(detail) as Record<string, unknown>;
    if (
      payload.code !== 'provider_daily_quota_exhausted' ||
      payload.provider !== 'gemini' ||
      !isApprovedGeminiModel(payload.model) ||
      typeof payload.retryAfterSeconds !== 'number' ||
      !Number.isFinite(payload.retryAfterSeconds) ||
      payload.retryAfterSeconds <= 0
    ) return null;
    return {
      provider: 'gemini',
      model: payload.model,
      retryAfterSeconds: boundedRetryAfterSeconds(payload.retryAfterSeconds),
    };
  } catch {
    return null;
  }
}

function capacityWindowFromRow(row: ProviderCapacityRow | null): ProviderCapacityWindow | null {
  if (
    !row ||
    row.provider !== 'gemini' ||
    !isApprovedGeminiModel(row.model) ||
    row.reason !== 'daily_quota_exhausted' ||
    !Number.isFinite(row.retry_at_epoch)
  ) return null;
  return {
    provider: 'gemini',
    model: row.model,
    reason: 'daily_quota_exhausted',
    retryAtEpoch: row.retry_at_epoch,
  };
}

export async function recordProviderDailyQuota(
  env: Env,
  signal: ProviderDailyQuotaSignal,
  nowMs = Date.now(),
): Promise<ProviderCapacityWindow> {
  const retryAtEpoch = Math.floor(nowMs / 1_000) + boundedRetryAfterSeconds(signal.retryAfterSeconds);
  const table = capacityTable(env);
  const row = await env.DB.prepare(`
    INSERT INTO ${table} (
      provider, model, reason, retry_at_epoch
    ) VALUES ('gemini', ?, 'daily_quota_exhausted', ?)
    ON CONFLICT(provider, model) DO UPDATE SET
      reason = excluded.reason,
      retry_at_epoch = MAX(${table}.retry_at_epoch, excluded.retry_at_epoch),
      updated_at = datetime('now')
    RETURNING provider, model, reason, retry_at_epoch
  `).bind(signal.model, retryAtEpoch).first<ProviderCapacityRow>();
  const window = capacityWindowFromRow(row);
  if (!window) throw new Error('Could not persist the Gemini daily capacity window');
  return window;
}

export async function activeGenerationCapacity(
  env: Env,
  operation: GenerationJobOperation,
  tier: QualityTier,
  nowMs = Date.now(),
): Promise<ProviderCapacityWindow | null> {
  const nowEpoch = Math.floor(nowMs / 1_000);
  const table = capacityTable(env);
  for (const model of requiredGeminiModelsForGeneration(operation, tier)) {
    const row = await env.DB.prepare(`
      SELECT provider, model, reason, retry_at_epoch
      FROM ${table}
      WHERE provider = 'gemini' AND model = ? AND retry_at_epoch > ?
      LIMIT 1
    `).bind(model, nowEpoch).first<ProviderCapacityRow>();
    const window = capacityWindowFromRow(row);
    if (window) return window;
  }
  return null;
}

export function providerDailyQuotaFailureMessage(window: ProviderCapacityWindow): string {
  return `${DAILY_QUOTA_FAILURE_MARKER}${JSON.stringify({
    provider: window.provider,
    model: window.model,
    retryAtEpoch: window.retryAtEpoch,
  })}`;
}

export function parseProviderDailyQuotaFailure(message: string): ProviderCapacityWindow | null {
  const markerIndex = message.indexOf(DAILY_QUOTA_FAILURE_MARKER);
  if (markerIndex < 0) return null;
  try {
    const payload = JSON.parse(message.slice(markerIndex + DAILY_QUOTA_FAILURE_MARKER.length)) as Record<string, unknown>;
    if (
      payload.provider !== 'gemini' ||
      !isApprovedGeminiModel(payload.model) ||
      typeof payload.retryAtEpoch !== 'number' ||
      !Number.isInteger(payload.retryAtEpoch) ||
      payload.retryAtEpoch <= 0
    ) return null;
    return {
      provider: 'gemini',
      model: payload.model,
      reason: 'daily_quota_exhausted',
      retryAtEpoch: payload.retryAtEpoch,
    };
  } catch {
    return null;
  }
}
