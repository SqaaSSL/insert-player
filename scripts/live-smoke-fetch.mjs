const RETRYABLE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInteger(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithTransientNetworkRetry({
  fetchImpl,
  target,
  init = {},
  timeoutMs,
  maxAttempts = 3,
  baseDelayMs = 250,
  sleepImpl = defaultSleep,
}) {
  const method = String(init.method ?? 'GET').toUpperCase();
  const retryable = RETRYABLE_METHODS.has(method) && !init.signal;
  const attempts = retryable ? positiveInteger(maxAttempts, 3) : 1;
  const delayMs = nonNegativeInteger(baseDelayMs, 250);
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchImpl(target, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await sleepImpl(delayMs * attempt);
    }
  }

  throw lastError;
}
