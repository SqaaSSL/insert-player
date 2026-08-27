import { ApiSessionChangedError } from './ApiClient';

export const APPROVED_GEMINI_IMAGE_MODELS = [
  'gemini-3-pro-image',
  'gemini-3.1-flash-image',
] as const;

export type ApprovedGeminiImageModel = typeof APPROVED_GEMINI_IMAGE_MODELS[number];

export function isApprovedGeminiImageModel(model: string | null | undefined): model is ApprovedGeminiImageModel {
  return APPROVED_GEMINI_IMAGE_MODELS.some((approved) => approved === model);
}

interface ParsedGeminiErrorBody {
  code: string | null;
  message: string;
  retryAfterMs: number | null;
  quotaMetrics: string[];
  quotaIds: string[];
}

export interface GeminiRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  spendBaseDelayMs?: number;
  spendMaxDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
  onRetry?: (details: { attempt: number; delayMs: number; error: GeminiRequestError }) => void;
}

export class GeminiRequestError extends Error {
  readonly model: string | null;
  readonly status: number;
  readonly code: string | null;
  readonly retryAfterMs: number | null;
  readonly retryable: boolean;
  readonly spendRateLimited: boolean;
  readonly dailyQuotaExhausted: boolean;

  constructor(params: {
    message: string;
    model?: string | null;
    status: number;
    code?: string | null;
    retryAfterMs?: number | null;
    retryable?: boolean;
    spendRateLimited?: boolean;
    dailyQuotaExhausted?: boolean;
  }) {
    super(params.message);
    this.name = 'GeminiRequestError';
    this.model = params.model ?? null;
    this.status = params.status;
    this.code = params.code ?? null;
    this.retryAfterMs = params.retryAfterMs ?? null;
    this.retryable = params.retryable ?? false;
    this.spendRateLimited = params.spendRateLimited ?? false;
    this.dailyQuotaExhausted = params.dailyQuotaExhausted ?? false;
  }
}

const NON_RETRYABLE_CAPACITY_CODES = new Set([
  'provider_session_spend_limit',
  'daily_cap_exceeded',
  'monthly_cap_exceeded',
  'provider_request_not_dispatched',
  'provider_request_outcome_unknown',
]);

const RETRYABLE_STATUSES = new Set([0, 408, 425, 429, 500, 502, 503, 504]);

function parseDurationMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)s$/i);
  if (!match) return null;
  const milliseconds = Number(match[1]) * 1_000;
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? Math.ceil(milliseconds) : null;
}

export function parseRetryAfterMs(value: string | null, nowMs = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return null;
  return Math.max(0, dateMs - nowMs);
}

function parseGeminiErrorBody(body: string): ParsedGeminiErrorBody {
  try {
    const parsed = JSON.parse(body) as {
      code?: unknown;
      error?: {
        code?: unknown;
        status?: unknown;
        message?: unknown;
        details?: Array<Record<string, unknown>>;
      };
    };
    const error = parsed.error ?? {};
    const rawCode = typeof parsed.code === 'string'
      ? parsed.code
      : typeof error.status === 'string'
        ? error.status
        : typeof error.code === 'string'
          ? error.code
          : null;
    const retryInfo = error.details?.find((detail) =>
      String(detail['@type'] ?? '').endsWith('google.rpc.RetryInfo'),
    );
    const quotaMetrics: string[] = [];
    const quotaIds: string[] = [];
    for (const detail of error.details ?? []) {
      if (!String(detail['@type'] ?? '').endsWith('google.rpc.QuotaFailure')) continue;
      const violations = detail.violations;
      if (!Array.isArray(violations)) continue;
      for (const violation of violations) {
        if (!violation || typeof violation !== 'object') continue;
        const record = violation as Record<string, unknown>;
        if (typeof record.quotaMetric === 'string') quotaMetrics.push(record.quotaMetric);
        if (typeof record.quotaId === 'string') quotaIds.push(record.quotaId);
      }
    }
    return {
      code: rawCode,
      message: typeof error.message === 'string' ? error.message : body,
      retryAfterMs: parseDurationMs(retryInfo?.retryDelay),
      quotaMetrics,
      quotaIds,
    };
  } catch {
    return { code: null, message: body, retryAfterMs: null, quotaMetrics: [], quotaIds: [] };
  }
}

export function geminiErrorFromResponse(
  model: string,
  response: Response,
  body: string,
  nowMs = Date.now(),
): GeminiRequestError {
  const parsed = parseGeminiErrorBody(body);
  const upstreamOutcome = response.headers.get('X-Insert-Player-Upstream-Outcome')?.trim().toLowerCase();
  const code = upstreamOutcome === 'unknown'
    ? 'provider_request_outcome_unknown'
    : upstreamOutcome === 'not-dispatched'
      ? 'provider_request_not_dispatched'
      : parsed.code?.toLowerCase() ?? null;
  const message = parsed.message.trim() || `HTTP ${response.status}`;
  const retryAfterMs = Math.max(
    parseRetryAfterMs(response.headers.get('Retry-After'), nowMs) ?? 0,
    parsed.retryAfterMs ?? 0,
  ) || null;
  const capacityMessage = `${code ?? ''} ${message}`.toLowerCase();
  const nonRetryableCapacity =
    (code ? NON_RETRYABLE_CAPACITY_CODES.has(code) : false) ||
    capacityMessage.includes('provider session call limit') ||
    capacityMessage.includes('provider session spend limit');
  const spendRateLimited =
    capacityMessage.includes('spend-based rate limit') ||
    capacityMessage.includes('spending rate');
  const dailyQuotaExhausted = response.status === 429 && (
    parsed.quotaMetrics.some((metric) => metric.endsWith('/generate_requests_per_model_per_day')) ||
    parsed.quotaIds.some((quotaId) => quotaId.toLowerCase().includes('requestsperday')) ||
    capacityMessage.includes('generate_requests_per_model_per_day')
  );

  return new GeminiRequestError({
    message: `${model} ${response.status}: ${message.slice(0, 300)}`,
    model,
    status: response.status,
    code,
    retryAfterMs,
    retryable: RETRYABLE_STATUSES.has(response.status) && !nonRetryableCapacity && !dailyQuotaExhausted,
    spendRateLimited,
    dailyQuotaExhausted,
  });
}

export function geminiNetworkError(model: string, error: unknown): GeminiRequestError {
  if (error instanceof ApiSessionChangedError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  return new GeminiRequestError({
    message: `${model} network error: ${message}`,
    model,
    status: 0,
    retryable: true,
  });
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function retryGeminiRequest<T>(
  operation: () => Promise<T>,
  options: GeminiRetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 5);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 1_000);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? 60_000);
  const spendBaseDelayMs = Math.max(baseDelayMs, options.spendBaseDelayMs ?? 60_000);
  const spendMaxDelayMs = Math.max(spendBaseDelayMs, options.spendMaxDelayMs ?? 5 * 60_000);
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ApiSessionChangedError) throw error;
      if (!(error instanceof GeminiRequestError) || !error.retryable || attempt >= maxAttempts) {
        throw error;
      }

      const retryIndex = attempt - 1;
      const exponential = error.spendRateLimited
        ? Math.min(spendMaxDelayMs, spendBaseDelayMs * (2 ** retryIndex))
        : Math.min(maxDelayMs, baseDelayMs * (2 ** retryIndex));
      const jitter = 0.75 + Math.min(1, Math.max(0, random())) * 0.5;
      const retryAfterLimitMs = error.spendRateLimited ? spendMaxDelayMs : maxDelayMs;
      const boundedRetryAfterMs = Math.min(error.retryAfterMs ?? 0, retryAfterLimitMs);
      const delayMs = Math.max(boundedRetryAfterMs, Math.ceil(exponential * jitter));
      options.onRetry?.({ attempt: attempt + 1, delayMs, error });
      await sleep(delayMs);
    }
  }
}

export class RequestStartPacer {
  private readonly nextStartByKey = new Map<string, number>();
  private readonly queueByKey = new Map<string, Promise<void>>();

  constructor(
    private readonly sleep: (delayMs: number) => Promise<void> = defaultSleep,
    private readonly now: () => number = Date.now,
  ) {}

  async wait(key: string, minimumIntervalMs: number): Promise<void> {
    if (minimumIntervalMs <= 0) return;
    const previous = this.queueByKey.get(key) ?? Promise.resolve();
    const scheduled = previous.catch(() => {}).then(async () => {
      const delayMs = Math.max(0, (this.nextStartByKey.get(key) ?? 0) - this.now());
      if (delayMs > 0) await this.sleep(delayMs);
      this.nextStartByKey.set(key, this.now() + minimumIntervalMs);
    });
    this.queueByKey.set(key, scheduled);
    try {
      await scheduled;
    } finally {
      if (this.queueByKey.get(key) === scheduled) this.queueByKey.delete(key);
    }
  }
}
