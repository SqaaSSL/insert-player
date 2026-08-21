import type { Env } from './types';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const SITEVERIFY_TIMEOUT_MS = 10_000;
const DEFAULT_ACTION = 'anonymous_rookie';
const MAX_TOKEN_LENGTH = 4096;

interface TurnstileSiteverifyResponse {
  success?: boolean;
  action?: string;
  hostname?: string;
  'error-codes'?: string[];
}

function json(data: unknown, status: number): Response {
  return Response.json(data, { status });
}

function configuredHostnames(env: Env): Set<string> {
  return new Set(
    (env.TURNSTILE_HOSTNAMES ?? '')
      .split(',')
      .map((hostname) => hostname.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function turnstileIsRequired(env: Env): boolean {
  return env.ENVIRONMENT === 'production' || env.TURNSTILE_REQUIRED === 'true';
}

export function anonymousRookieIsEnabled(env: Env): boolean {
  return env.ANONYMOUS_ROOKIE_ENABLED !== 'false';
}

export function turnstileConfigurationStatus(env: Env): 'configured' | 'disabled' | 'misconfigured' {
  if (!turnstileIsRequired(env)) return 'disabled';
  const action = (env.TURNSTILE_ACTION ?? DEFAULT_ACTION).trim();
  if (!env.TURNSTILE_SECRET_KEY || !action || configuredHostnames(env).size === 0) {
    return 'misconfigured';
  }
  return 'configured';
}

function configurationError(): Response {
  return json({
    authorized: false,
    error: 'Human verification is temporarily unavailable',
    code: 'turnstile_not_configured',
  }, 503);
}

function anonymousRookieDisabledError(): Response {
  return json({
    authorized: false,
    error: 'Anonymous Rookie generation is disabled in this environment',
    code: 'anonymous_rookie_disabled',
  }, 403);
}

function verificationError(code = 'turnstile_failed'): Response {
  return json({
    authorized: false,
    error: 'Human verification failed. Please try again.',
    code,
  }, 403);
}

export async function enforceAnonymousRookieTurnstile(
  request: Request,
  env: Env,
  tokenValue: unknown,
): Promise<Response | null> {
  if (!anonymousRookieIsEnabled(env)) return anonymousRookieDisabledError();
  if (!turnstileIsRequired(env)) return null;
  if (turnstileConfigurationStatus(env) !== 'configured') return configurationError();

  const token = typeof tokenValue === 'string' ? tokenValue.trim() : '';
  if (!token || token.length > MAX_TOKEN_LENGTH) return verificationError('turnstile_required');

  const form = new URLSearchParams({
    secret: env.TURNSTILE_SECRET_KEY as string,
    response: token,
  });
  const remoteIp = request.headers.get('CF-Connecting-IP')?.trim();
  if (remoteIp) form.set('remoteip', remoteIp);

  let result: TurnstileSiteverifyResponse;
  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    });
    if (!response.ok) return verificationError();
    result = await response.json() as TurnstileSiteverifyResponse;
  } catch {
    return verificationError();
  }

  const expectedAction = (env.TURNSTILE_ACTION ?? DEFAULT_ACTION).trim();
  const hostname = result.hostname?.trim().toLowerCase() ?? '';
  if (
    result.success !== true ||
    result.action !== expectedAction ||
    !configuredHostnames(env).has(hostname)
  ) {
    return verificationError();
  }

  return null;
}
