type TokenGetter = () => Promise<string | null>;

let tokenGetter: TokenGetter | null = null;
let authRevision = 0;

export interface ApiRequestContext {
  readonly authRevision: number;
  readonly tokenGetter: TokenGetter | null;
  readonly providerSessionId: string | null;
}

export class ApiSessionChangedError extends Error {
  constructor() {
    super('Your account changed while this operation was running. Please retry.');
    this.name = 'ApiSessionChangedError';
  }
}

export function configureApiAuth(getToken: TokenGetter | null): void {
  tokenGetter = getToken;
  authRevision += 1;
}

export function captureApiRequestContext(): ApiRequestContext {
  return Object.freeze({
    authRevision,
    tokenGetter,
    providerSessionId: null,
  });
}

export function withProviderSession(
  context: ApiRequestContext,
  sessionId: string | null | undefined,
): ApiRequestContext {
  return Object.freeze({
    ...context,
    providerSessionId: sessionId ?? null,
  });
}

export function assertApiRequestContextCurrent(context: ApiRequestContext): void {
  if (context.authRevision !== authRevision || context.tokenGetter !== tokenGetter) {
    throw new ApiSessionChangedError();
  }
}

export async function runWithProviderSession<T>(
  sessionId: string | null | undefined,
  action: (context: ApiRequestContext) => Promise<T>,
  baseContext: ApiRequestContext = captureApiRequestContext(),
): Promise<T> {
  assertApiRequestContextCurrent(baseContext);
  return action(withProviderSession(baseContext, sessionId));
}

function configuredApiBase(): string {
  return String(import.meta.env.VITE_API_BASE_URL ?? '').trim().replace(/\/+$/, '');
}

export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const base = configuredApiBase();
  if (!base) return path;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}

function browserBaseUrl(): string | undefined {
  return typeof window === 'undefined' ? undefined : window.location.href;
}

function originOf(url: string, base?: string): string | null {
  try {
    return new URL(url, base).origin;
  } catch {
    return null;
  }
}

function shouldAttachAuth(targetUrl: string): boolean {
  const targetOrigin = originOf(targetUrl, browserBaseUrl());
  if (!targetOrigin) return false;

  const apiBase = configuredApiBase();
  const apiOrigin = apiBase
    ? originOf(apiBase, browserBaseUrl())
    : originOf('/', browserBaseUrl());
  return Boolean(apiOrigin && targetOrigin === apiOrigin);
}

export async function apiFetch(
  input: string,
  init: RequestInit = {},
  context: ApiRequestContext = captureApiRequestContext(),
): Promise<Response> {
  assertApiRequestContextCurrent(context);
  const targetUrl = apiUrl(input);
  const headers = new Headers(init.headers);
  const attachesAuth = shouldAttachAuth(targetUrl);
  const token = attachesAuth ? await context.tokenGetter?.() : null;
  assertApiRequestContextCurrent(context);
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (context.providerSessionId && attachesAuth && !headers.has('X-ASF-Provider-Session')) {
    headers.set('X-ASF-Provider-Session', context.providerSessionId);
  }
  const response = await fetch(targetUrl, {
    ...init,
    headers,
  });
  assertApiRequestContextCurrent(context);
  return response;
}
